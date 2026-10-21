// biome-ignore-all lint/complexity/useLiteralKeys: indexed YAML objects require bracket access under noPropertyAccessFromIndexSignature
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";

import { parse } from "yaml";

import { fleetSchemaVersion, gatewayRuntimeEnv, runtimeEnvNameProblem } from "./fleet-contract";

// The one implementation of the fleet contract. CI runs it over this checkout (`mise run fleet`);
// the reconciler runs the same code on the host, bundled by Pulumi (fleet-validator.ts), over the
// extracted release: --root names that release and --python the system interpreter that parses
// Dodo's Python there. The rules here are generic; everything they check that is specific to this
// fleet (which profile is the owner console, the reviewed MCP URLs and tools, where each
// credential may go, the hand-off plugin's contract) is the `policy` in profiles/fleet.yaml.
const cli = parseArguments(process.argv.slice(2));
const repositoryRoot = cli.root ?? resolve(import.meta.dir, "../..");
const pythonCommand = cli.python ?? "python3";
const profilesRoot = join(repositoryRoot, "profiles");
const sharedSkillsRoot = join(repositoryRoot, "shared", "skills");
const sharedMcpServersRoot = join(repositoryRoot, "shared", "mcp-servers");
const fleetPath = join(profilesRoot, "fleet.yaml");
const dodoSkillsRoot = "/var/lib/hermes/.dodo-deployment/dodo-skills";
const ravenSkillsRoot = "/var/lib/hermes/.dodo-deployment/raven-skills";
const hermesSkillsRoot = "/var/lib/hermes/.dodo-deployment/hermes-skills";
const profilePlatforms = ["cli", "api_server", "slack", "cron"] as const;
const configurableToolsets = new Set([
  "browser",
  "clarify",
  "code_execution",
  "computer_use",
  "connections",
  "context_engine",
  "cronjob",
  "delegation",
  "discord",
  "discord_admin",
  "file",
  "homeassistant",
  "image_gen",
  "kanban",
  "memory",
  "session_search",
  "skills",
  "spotify",
  "stt",
  "terminal",
  "todo",
  "tts",
  "video",
  "video_gen",
  "vision",
  "web",
  "x_search",
  "yuanbao",
]);
const knownLeafToolsets = new Set([
  ...configurableToolsets,
  "bot_room",
  "desktop_ui",
  "feishu_doc",
  "feishu_drive",
  "project",
  "search",
  "setup",
]);
// Toolsets a Slack-reachable surface may select. Anything that executes code, touches files,
// schedules work, or reaches other platforms stays off Slack. Delegation is allowed only with the
// pinned, capped delegation block (validateDelegation): children never gain a tool their parent
// lacks (tools/delegate_tool_toolsets.py:76-80).
const slackSafeToolsets = new Set([
  "clarify",
  "delegation",
  "memory",
  "session_search",
  "skills",
  "todo",
  "vision",
  "web",
]);
// The owner console (policy.owner_console) may also select the host terminal and file tools on its
// Slack surface, and a repository write skill.
const ownerSlackToolsets = new Set(["file", "terminal"]);
// Toolsets that expose one user's history or memory to another user of the same profile.
const personalToolsets = new Set(["memory", "session_search"]);
const hostSlashCommands = new Set(["help", "new", "whoami"]);
// Matches no real channel, so the adapter drops every event that is not a 1:1 DM.
const dmOnlyChannelSentinel = "C0000000000";
const slackUserIdPattern = /^[UW][A-Z0-9]{8,}$/;
const slackChannelIdPattern = /^[CG][A-Z0-9]{8,}$/;
const maxTurnsLimit = 50;
// A Slack gateway that more than one person can reach runs shorter.
const sharedGatewayMaxTurnsLimit = 25;
const runBudgetSecondsLimit = 900;
// The delegation block a profile that selects `delegation` must carry. Children run on the pinned
// model with the parent's provider and credentials (provider, base_url, and api_key are refused),
// at most three at a time, each within its own iteration cap and inactivity timeout, never nested,
// never orchestrating, never auto-approving, and with only the MCP servers a narrowed toolsets
// list names (hermes_cli/config_defaults.py:1304-1394).
const delegationKeys = [
  "child_timeout_seconds",
  "inherit_mcp_toolsets",
  "max_concurrent_children",
  "max_iterations",
  "max_spawn_depth",
  "model",
  "orchestrator_enabled",
  "subagent_auto_approve",
];
const maxDelegationChildren = 3;
const delegationModelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const maxConcurrentSessionsLimit = 8;
const ravenSkillPathPattern = /^plugins\/[a-z][a-z0-9-]*\/skills\/[a-z][a-z0-9-]*$/;
const hermesSkillPathPattern = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const skillNamePattern = /^[a-z][a-z0-9-]*$/;
const toolsetNamePattern = /^[a-z][a-z0-9_-]*$/;
const mcpNamePattern = /^[a-z][a-z0-9_-]*$/;
// Exact names only: Hermes treats an entry containing *, ? or [ as a glob
// (tools/mcp_tool_schema.py:243-251).
const mcpToolNamePattern = /^[A-Za-z0-9_.:/-]+$/;
// The surface entry that keeps every MCP server off a surface (hermes_cli/tools_config.py:678-690).
const noMcpSentinel = "no_mcp";
// Hermes resolves a surface entry as a toolset first and passes only unknown names through as MCP
// servers (hermes_cli/tools_config.py:576-627), and `all` resolves to every toolset
// (toolsets.py:387-388). A server named `slack` would also tell the model it has Slack tools
// (gateway/session.py:240). The extra names are v0.21.5's composite and bundled plugin toolsets.
const reservedMcpServerNames = new Set([
  ...knownLeafToolsets,
  ...profilePlatforms,
  "a2a",
  "all",
  "coding",
  "debugging",
  "google_meet",
  "safe",
  noMcpSentinel,
]);
const reservedMcpServerPrefix = "hermes-";
// Server keys Dodo supports. Everything else Hermes reads (enabled, lazy, transport, ssl_verify,
// auth, oauth, client_cert, ...) is refused.
const mcpServerRequiredKeys = [
  "elicitation",
  "sampling",
  "strict_redirect_headers",
  "tools",
  "trust",
  "url",
];
const mcpServerOptionalKeys = ["headers", "lifecycle", "timeout"];
// A stdio server (policy.stdio_servers) runs a root-owned wrapper or one of Dodo's own servers with
// the profile's name as its last argument. No cwd or headers, and env only where the policy pins it:
// each reads the profile's credentials itself.
const mcpStdioServerRequiredKeys = [
  "args",
  "command",
  "elicitation",
  "lifecycle",
  "sampling",
  "tools",
  "trust",
];
const mcpStdioServerOptionalKeys = ["env", "timeout"];
// Dodo's own stdio servers: reviewed standard-library Python in shared/mcp-servers/<name>/server.py,
// one per policy.stdio_servers entry without a command, which the reconciler deploys root-owned in
// the release tree. Hermes starts one as
// `/usr/bin/python3 -I <release>/shared/mcp-servers/<name>/server.py <profile>`: the system
// interpreter in isolated mode, never the hermes-owned venv. Nothing else may be spawned as a server.
const dodoMcpServerCommand = "/usr/bin/python3";
const dodoMcpServerRoot = "/var/lib/hermes/.dodo-deployment/current/shared/mcp-servers";
// The standard-library modules a Dodo server may import. No subprocess: a server never spawns one.
const dodoMcpServerModules = new Set([
  "base64",
  "collections",
  "contextlib",
  "dataclasses",
  "datetime",
  "json",
  "os",
  "re",
  "shutil",
  "sqlite3",
  "stat",
  "sys",
  "tempfile",
  "time",
  "typing",
  "urllib",
  "zipfile",
]);
// os is allowed for files, but it also starts processes. A Dodo server may not name these as an
// attribute or a from-import, or call getattr, which could reach them by a computed name.
const dodoMcpServerProcessNames =
  /^(?:system|popen|fork|forkpty|startfile|posix_spawnp?|exec[lv]p?e?|spawn[lv]p?e?)$/;
// Hermes resolves ${VAR} in a stdio server's config once and respawns it with the same values
// (tools/mcp_tool_config.py:362-385, tools/mcp_tool_server_run.py:309-347), so a wrapper re-reads
// its token on every spawn, and max_lifetime_seconds bounds how long one spawn keeps a token.
// Installation tokens expire after 60 minutes and the broker refreshes every 15, so a spawn may
// live at most 30 minutes.
const mcpStdioMaxLifetimeMaximum = 1800;
const mcpHeaderNamePattern = /^[A-Za-z0-9-]+$/;
// One reference to a declared runtime_env name, optionally after an authorization scheme. Hermes
// interpolates ${...} in every string of a server's config from the profile's own secret scope
// (tools/mcp_tool_config.py:284-298) and sends the headers as written
// (tools/mcp_tool_transport.py:530-549).
const mcpHeaderValuePattern = /^(?:[A-Za-z][A-Za-z-]* )?\$\{([A-Z][A-Z0-9_]*)\}$/;
const authorizationSchemePattern = /^[A-Za-z][A-Za-z-]*$/;
const mcpTimeoutLimit = 300;
const mcpMaxLifetimeMinimum = 60;
const mcpMaxLifetimeMaximum = 86400;
// Toolsets that can send model-chosen data to a model-chosen host: web_extract, vision_analyze's
// URL download (tools/vision_tools.py:126-132, :162-194), the browser, and anything that runs
// code. A surface that names an MCP server selects none of them (principle 6).
const egressToolsets = new Set(["browser", "code_execution", "terminal", "vision", "web"]);
// What a profile that reads client personal data (policy.personal_data_profiles) may select.
const personalDataToolsets = new Set(["skills", "todo"]);
const directMessageTargetPattern = /^slack:D[A-Z0-9]{8,}$/;
// manage_connections adds newly connected MCP servers to a session past its surface's allowlist
// (agent/inline_tool_executors.py:193-211, tools/connectors/mcp.py:340-372).
const connectionsToolset = "connections";
// Scheduled jobs (schema 5). A job id is also its name, because Hermes resolves a job reference by
// id and then by case-insensitive name (cron/jobs.py:1878-1893).
const cronJobIdPattern = /^[a-z][a-z0-9-]{2,62}$/;
// A Slack channel, a thread in a channel, or a DM conversation. User IDs are refused: the cron path
// hands the live adapter `user:U…`, which it cannot open (plugins/platforms/slack/adapter.py:1975-1986).
const deliveryTargetPattern = /^slack:(?:C[A-Z0-9]{8,}(?::\d{10}\.\d{6})?|D[A-Z0-9]{8,})$/;
const localDelivery = "local";
const cronJobRequiredKeys = ["deliver", "failure_deliver", "id", "name", "schedule"];
const cronJobOptionalKeys = [
  "enabled_toolsets",
  "monitor_script",
  "no_agent",
  "prompt",
  "script",
  "skills",
];
// Hermes drops these from every cron run (cron/scheduler.py:445-466); a job never names them.
const cronDroppedToolsets = new Set(["clarify", "cronjob", "messaging"]);
// Minute, hour, day of month, month, day of week: digits only, no names, macros, or seconds.
const cronFieldRanges: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];
const cronScriptNamePattern = /^[a-z0-9][a-z0-9-]*\.(?:py|sh)$/;
// A .py script's reviewed data: <name>.json beside the <name>.py a job runs. Hermes runs only the
// files a job names, so the data file is never executed.
const cronScriptDataPattern = /^([a-z0-9][a-z0-9-]*)\.json$/;
// Hermes runs a .py script with its own venv interpreter, which has third-party packages
// (cron/scheduler_script.py:303-320), so Dodo allows this reviewed standard-library subset only.
// subprocess starts git, openssl, and package managers.
const cronScriptModules = new Set([
  "argparse",
  "base64",
  "collections",
  "contextlib",
  "dataclasses",
  "datetime",
  "functools",
  "hashlib",
  "hmac",
  "http",
  "io",
  "itertools",
  "json",
  "logging",
  "os",
  "pathlib",
  "re",
  "shlex",
  "shutil",
  "subprocess",
  "sys",
  "tempfile",
  "textwrap",
  "time",
  "typing",
  "urllib",
  "uuid",
  "zoneinfo",
]);
// A job worker's script also imports hermes_cli, to take and complete its own Kanban tasks.
const jobWorkerScriptModules = new Set([...cronScriptModules, "hermes_cli"]);
const cronScriptForbiddenTokens = ["__import__", "importlib", "runpy"];
// Builtins that run code from a string, which would import past the module check.
const cronScriptForbiddenCalls = new Set(["compile", "eval", "exec"]);
// Lists a script's syntax in ast.walk order, so every import statement counts wherever it appears.
// Only Python's own parser reads Python reliably; this validator still applies its own rules to the
// result.
const scriptSyntaxProgram = `
import ast, json, sys
try:
    tree = ast.parse(open(sys.argv[1], encoding="utf-8").read(), filename=sys.argv[1])
except SyntaxError as error:
    print(json.dumps({"error": error.msg + (f" at line {error.lineno}" if error.lineno else "")}))
    raise SystemExit
except ValueError as error:  # invalid UTF-8 (UnicodeDecodeError) or a null byte
    print(json.dumps({"error": str(error)}))
    raise SystemExit
nodes = []
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        nodes.append({"imports": [alias.name for alias in node.names]})
    elif isinstance(node, ast.ImportFrom):
        nodes.append({"relative": True} if node.level or node.module is None else {"imports": [node.module], "names": [alias.name for alias in node.names]})
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        nodes.append({"call": node.func.id})
    elif isinstance(node, ast.Attribute):
        nodes.append({"names": [node.attr]})
print(json.dumps({"nodes": nodes}))
`;
// An outbound-only Slack profile holds the team bot token without the app token: Hermes
// delivers its cron output but cannot open Socket Mode for it, so nobody can message it.
const slackOutboundGateway = "slack_outbound";
// The whole slack block of an outbound-only profile that delivers to Slack: link previews off.
const outboundSlackBlock = { unfurl_links: false, unfurl_media: false };
// Toolsets that can read a profile's .env or a script's environment. The file tool refuses .env
// (agent/file_safety.py:311, :343-390); terminal does not, and terminal.env_passthrough also feeds
// terminal and execute_code children (tools/env_passthrough.py:1-5).
const environmentReadingToolsets = ["code_execution", "terminal"];
const envPassthroughNamePattern = /^[A-Z][A-Z0-9_]*$/;
// Toolsets that run code or touch files. file tools and execute_code run in the
// terminal's environment (tools/file_tools.py:306-320, tools/code_execution_tool.py:743-744), which
// is always the local backend: a plain hermes process on the host.
const executionToolsets = new Set(["code_execution", "file", "terminal"]);
// Plugins and Kanban workers. Hermes switches a plugin toolset on for every platform unless
// known_plugin_toolsets lists it there (hermes_cli/tools_config.py:538-545), so the reconciler lists
// every declared one and the profile selects it only where the fleet says. These are the bundled
// plugins that register toolsets at v0.21.5 (plugins/spotify/__init__.py:31,
// plugins/platforms/a2a/tools.py:359, plugins/google_meet/__init__.py:50); no profile selects them.
const bundledPluginToolsets = new Set(["a2a", "google_meet", "spotify"]);
// The raw board tools let the model pick any assignee, workspace, skills, and model
// (tools/kanban_tools.py:1013-1069); a hand-off goes only through the policy's hand-off plugin.
const kanbanToolset = "kanban";
// Everything a Kanban worker may select besides its own MCP servers. Nobody answers a clarify in a
// `chat -q` run, and cronjob, delegation, browser, vision, and the rest would reach past the task.
const workerToolsets = new Set(["code_execution", "file", "skills", "terminal", "todo"]);
const pluginNamePattern = /^[a-z][a-z0-9-]*$/;
const pluginIdentifierPattern = /^[a-z][a-z0-9_]*$/;
const pluginManifestKeys = ["description", "kind", "name", "provides_tools", "version"];
const hookPluginManifestKeys = ["description", "kind", "name", "provides_hooks", "version"];
const pluginFiles = ["__init__.py", "plugin.yaml"];
// A hook plugin registers no tools, only callbacks (hermes_cli/plugins.py:108-115, :912-914). The only
// one is every Kanban worker's guard (policy.worker_guard): a pre_tool_call hook that keeps the
// Kanban tools Hermes gives a worker on its own task (hermes_cli/plugins.py:1852-1906,
// tools/kanban_tools.py:83-102).
const pluginHooks = new Set(["pre_tool_call"]);
const workerGuardDeclaration = { hooks: ["pre_tool_call"] };
const workerGuardFiles = ["__init__.py", "plugin.yaml"];
// The hooks a hand-off plugin may declare next to its tools. pre_gateway_dispatch takes bot posts
// before authorization, so declaring it makes the plugin's profile accept exactly the policy's
// bot_mention_patterns.
const handoffHooks = new Set(["pre_gateway_dispatch", "pre_tool_call"]);
const gatewayDispatchHook = "pre_gateway_dispatch";
const handoffWorkersFile = "workers.json";
const handoffToolPattern = /^handoff_[a-z][a-z0-9_]*$/;
const workerRuntimeSeconds = [60, 3600] as const;
const workerMaxRetries = 2;
// A worker runs `hermes -p <worker> --cli chat -q` (hermes_cli/kanban_db_dispatch.py:2620-2707).
// The approval gate takes approvals.single_query_mode there, but approvals.mode defaults to smart,
// an auxiliary model's verdict (hermes_cli/config_defaults.py:1655-1659,
// hermes_cli/cli_single_query.py:445-458, tools/approval_context.py:280-298).
const workerApprovals = { mode: "manual", single_query_mode: "deny" };
// The notifier uploads files a finished task names, under the subscriber profile's media policy
// (gateway/kanban_watchers.py:146-200, gateway/kanban_watchers_notifier.py:594-615, :754-756,
// gateway/media_policy.py:26-61). Strict without recent files limits it to Hermes's caches and the
// Kanban attachment directories (gateway/platforms/base.py:838-868, :1106-1145).
const strictMediaGateway = { strict: true, trust_recent_files: false };
// Claims run in the launch profile's gateway; an absent dispatch_profiles lets it claim a task for any
// profile, a present list only those (hermes_cli/kanban_db_dispatch.py:1633-1704). The other two
// would auto-start review cards and decompose triage cards with a side model
// (hermes_cli/config_defaults.py:1865-1867, :1907-1909). One task per worker at a time
// (hermes_cli/kanban_db_dispatch.py:2320-2335, read at gateway/kanban_watchers_dispatcher.py:117),
// which bounds each worker's cost and is what the hand-off plugin's queue limits assume.
const kanbanConfigKeys = [
  "auto_decompose",
  "dispatch_profiles",
  "max_in_progress_per_profile",
  "review_dispatch",
];
const semverPattern = /^\d+\.\d+\.\d+$/;
const forbiddenNames = new Set([
  ".env",
  "auth.json",
  "mcp-tokens",
  "memories",
  "sessions",
  "logs",
  "workspace",
  "plans",
  "home",
  "local",
]);
const forbiddenFilePatterns = [/^(?:state|hermes_state|response_store)\.db/];
const forbiddenDirectoryPatterns = [/_cache$/];
const secretPatterns = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bghs_[A-Za-z0-9._-]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\blin_api_[A-Za-z0-9]{20,}\b/,
  /\bphx_[A-Za-z0-9]{20,}\b/,
  /\bsntry[su]_[A-Za-z0-9_=-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

type Platform = (typeof profilePlatforms)[number];
type PlatformToolsets = Record<Platform, string[]>;

// A tool plugin declares {toolset, tools} (the hand-off plugin also its hooks); a hook plugin
// declares {hooks}.
interface PluginDeclaration {
  readonly hooks?: string[];
  readonly toolset?: string;
  readonly tools?: string[];
}

interface KanbanWorker {
  readonly handoff_tool: string;
  // A job worker's tasks are taken by this no_agent cron job of its own, never the dispatcher.
  readonly job?: string;
  readonly max_retries: number;
  readonly max_runtime_seconds: number;
}

interface ProfileBase {
  readonly brokered_env: string[];
  readonly cron: string[];
  readonly delivery_targets: string[];
  readonly desired_state: "installed" | "present";
  readonly dodo_skills: string[];
  readonly gateway: false | "slack" | "slack_outbound";
  readonly hermes_skills: string[];
  readonly kanban_worker: false | KanbanWorker;
  readonly mcp_servers: Record<string, unknown>;
  readonly name: string;
  readonly platform_toolsets: PlatformToolsets;
  readonly plugins: Record<string, PluginDeclaration>;
  readonly raven_skills: string[];
  readonly runtime_env: string[];
  readonly source: string;
  readonly terminal_home_mode: "auto" | "profile" | "real";
}

interface DefaultProfile extends ProfileBase {
  readonly desired_state: "present";
  readonly gateway: false;
  readonly name: "default";
}

interface FleetProfile extends ProfileBase {
  readonly alias: true;
  readonly desired_state: "installed";
}

interface FleetManifest {
  readonly default_profile: DefaultProfile;
  readonly profiles: FleetProfile[];
}

// The fleet's policy (profiles/fleet.yaml `policy`): everything specific to this fleet that the
// generic rules check against.
interface CredentialPolicy {
  readonly profiles: readonly string[];
  // Sent only as its server's one header, `Authorization: <header> ${NAME}`, to these URLs.
  readonly header?: string;
  readonly urls: readonly string[];
  // Reaches only scripts, through terminal.env_passthrough.
  readonly script: boolean;
  // The gateway key it duplicates for scripts, which Hermes never forwards.
  readonly copy_of?: string;
}

interface McpServerPolicy {
  readonly url: string;
  readonly tools: readonly string[];
  readonly writes: readonly string[];
  readonly writers: readonly string[];
  readonly restricted: readonly string[];
}

interface StdioServerPolicy {
  readonly name: string;
  // A root-owned wrapper; without one, Dodo's own server in shared/mcp-servers/<name>/server.py.
  readonly command?: string;
  readonly brokeredCredential?: string;
  readonly credentials: readonly string[];
  readonly toolCredentials: Readonly<Record<string, string>>;
  readonly profiles?: readonly string[];
  readonly tools: readonly string[];
  readonly restricted: readonly string[];
  readonly workersOnly: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly workerEnv?: Readonly<Record<string, string>>;
}

interface FleetPolicy {
  readonly ownerConsole: string;
  readonly personalDataProfiles: ReadonlySet<string>;
  readonly modelFreeProfiles: ReadonlySet<string>;
  readonly repositoryWriteSkills: ReadonlySet<string>;
  readonly timezone: string;
  readonly restrictedPaths: Readonly<Record<string, readonly string[]>>;
  readonly handoff: {
    readonly plugin: string;
    readonly profile: string;
    readonly tools: readonly string[];
    readonly hooks: readonly string[];
    readonly botMentionPatterns: readonly string[];
  };
  readonly workerGuard: string;
  readonly brokeredCredentials: ReadonlySet<string>;
  readonly credentials: Readonly<Record<string, CredentialPolicy>>;
  readonly mcpServers: readonly McpServerPolicy[];
  readonly stdioServers: readonly StdioServerPolicy[];
}

// Set from profiles/fleet.yaml before any profile is validated.
let policy: FleetPolicy;

function stringList(value: unknown, description: string, pattern?: RegExp): string[] {
  assertUniqueStrings(value, description, pattern);
  return value;
}

function stringMap(value: unknown, description: string): Record<string, string> {
  assertPlainObject(value, description);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      fail(`${description} ${key} must be a string.`);
    }
  }
  return value as Record<string, string>;
}

function assertSubset(value: readonly string[], of: readonly string[], description: string): void {
  const outside = value.filter((item) => !of.includes(item));
  if (outside.length > 0) {
    fail(`${description} names ${outside.join(", ")}, which it does not list.`);
  }
}

function deleteTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => tool.startsWith("delete_"));
}

function parsePolicy(value: unknown): FleetPolicy {
  assertPlainObject(value, "Fleet policy");
  assertExactKeys(
    value,
    [
      "brokered_credentials",
      "credentials",
      "handoff",
      "mcp_servers",
      "model_free_profiles",
      "owner_console",
      "personal_data_profiles",
      "repository_write_skills",
      "restricted_paths",
      "stdio_servers",
      "timezone",
      "worker_guard",
    ],
    "Fleet policy",
  );
  const name = (item: unknown, description: string): string => {
    if (typeof item !== "string" || !skillNamePattern.test(item)) {
      fail(`${description} must be a lower-case name.`);
    }
    return item;
  };
  const ownerConsole = name(value["owner_console"], "policy.owner_console");
  const workerGuard = name(value["worker_guard"], "policy.worker_guard");
  if (
    typeof value["timezone"] !== "string" ||
    !/^[A-Za-z]+(?:\/[A-Za-z_]+)+$/.test(value["timezone"])
  ) {
    fail("policy.timezone must be an IANA zone name.");
  }
  const restrictedPaths = value["restricted_paths"];
  assertPlainObject(restrictedPaths, "policy.restricted_paths");
  for (const [path, users] of Object.entries(restrictedPaths)) {
    stringList(users, `policy.restricted_paths ${path}`);
  }
  const handoff = value["handoff"];
  assertPlainObject(handoff, "policy.handoff");
  assertExactKeys(
    handoff,
    ["bot_mention_patterns", "hooks", "plugin", "profile", "tools"],
    "policy.handoff",
  );
  const handoffTools = stringList(
    handoff["tools"],
    "policy.handoff.tools",
    pluginIdentifierPattern,
  );
  if (handoffTools.length === 0) {
    fail("policy.handoff.tools must list the plugin's own tools.");
  }
  const hooks = stringList(handoff["hooks"], "policy.handoff.hooks");
  if (hooks.some((hook) => !handoffHooks.has(hook))) {
    fail(`policy.handoff.hooks may name only ${[...handoffHooks].join(", ")}.`);
  }
  const botMentionPatterns = stringList(
    handoff["bot_mention_patterns"],
    "policy.handoff.bot_mention_patterns",
  );
  if (hooks.includes(gatewayDispatchHook) !== botMentionPatterns.length > 0) {
    fail(
      `policy.handoff.bot_mention_patterns lists the bot posts ${gatewayDispatchHook} takes, ` +
        "exactly when the plugin declares that hook.",
    );
  }

  const brokeredCredentials = new Set(
    stringList(value["brokered_credentials"], "policy.brokered_credentials", /^[A-Z][A-Z0-9_]+$/),
  );

  const mcpServers: McpServerPolicy[] = [];
  const servers = value["mcp_servers"];
  if (!Array.isArray(servers)) {
    fail("policy.mcp_servers must be a list.");
  }
  for (const entry of servers as unknown[]) {
    assertPlainObject(entry, "policy.mcp_servers entry");
    const url = entry["url"];
    const description = `policy.mcp_servers ${String(url)}`;
    const keys = Object.keys(entry);
    const optional = ["restricted", "writers", "writes"];
    if (
      !keys.includes("url") ||
      !keys.includes("tools") ||
      keys.some((key) => key !== "url" && key !== "tools" && !optional.includes(key))
    ) {
      fail(`${description} must contain url and tools and may contain ${optional.join(", ")}.`);
    }
    assertHttpsServerUrl(url, description);
    if (mcpServers.some((server) => server.url === url)) {
      fail(`${description} is listed twice.`);
    }
    const tools = stringList(entry["tools"], `${description} tools`, mcpToolNamePattern);
    const writes = stringList(entry["writes"] ?? [], `${description} writes`, mcpToolNamePattern);
    const writers = stringList(entry["writers"] ?? [], `${description} writers`, skillNamePattern);
    const restricted = stringList(
      entry["restricted"] ?? [],
      `${description} restricted`,
      mcpToolNamePattern,
    );
    if (tools.length === 0 || deleteTools(tools).length > 0) {
      fail(`${description} tools must list at least one tool and no delete_* tool.`);
    }
    assertSubset(writes, tools, `${description} writes`);
    assertSubset(restricted, tools, `${description} restricted`);
    if (writes.length > 0 !== writers.length > 0) {
      fail(`${description} lists writes and the writers that may load them together.`);
    }
    mcpServers.push({ url: url as string, tools, writes, writers, restricted });
  }

  const stdioServers: StdioServerPolicy[] = [];
  const stdio = value["stdio_servers"];
  assertPlainObject(stdio, "policy.stdio_servers");
  for (const [serverName, entry] of Object.entries(stdio)) {
    const description = `policy.stdio_servers ${serverName}`;
    name(serverName, description);
    assertPlainObject(entry, description);
    const keys = Object.keys(entry);
    const allowed = [
      "brokered_credential",
      "command",
      "credentials",
      "env",
      "profiles",
      "restricted",
      "tool_credentials",
      "tools",
      "worker_env",
      "workers_only",
    ];
    if (!keys.includes("tools") || keys.some((key) => !allowed.includes(key))) {
      fail(`${description} must contain tools and may contain ${allowed.join(", ")}.`);
    }
    const command = entry["command"];
    if (
      command !== undefined &&
      (typeof command !== "string" || !/^\/[A-Za-z0-9._/-]+$/.test(command))
    ) {
      fail(`${description} command must be an absolute path.`);
    }
    const tools = stringList(entry["tools"], `${description} tools`, mcpToolNamePattern);
    if (tools.length === 0 || deleteTools(tools).length > 0) {
      fail(`${description} tools must list at least one tool and no delete_* tool.`);
    }
    const restricted = stringList(entry["restricted"] ?? [], `${description} restricted`);
    assertSubset(restricted, tools, `${description} restricted`);
    const brokered = entry["brokered_credential"];
    if (
      brokered !== undefined &&
      (typeof brokered !== "string" || !brokeredCredentials.has(brokered))
    ) {
      fail(`${description} brokered_credential must be one of policy.brokered_credentials.`);
    }
    const toolCredentials = stringMap(
      entry["tool_credentials"] ?? {},
      `${description} tool_credentials`,
    );
    assertSubset(Object.keys(toolCredentials), tools, `${description} tool_credentials`);
    if ("workers_only" in entry && typeof entry["workers_only"] !== "boolean") {
      fail(`${description} workers_only must be a boolean.`);
    }
    stdioServers.push({
      name: serverName,
      ...(typeof command === "string" ? { command } : {}),
      ...(typeof brokered === "string" ? { brokeredCredential: brokered } : {}),
      credentials: stringList(entry["credentials"] ?? [], `${description} credentials`),
      toolCredentials,
      ...("profiles" in entry
        ? { profiles: stringList(entry["profiles"], `${description} profiles`, skillNamePattern) }
        : {}),
      tools,
      restricted,
      workersOnly: entry["workers_only"] === true,
      ...("env" in entry ? { env: stringMap(entry["env"], `${description} env`) } : {}),
      ...("worker_env" in entry
        ? { workerEnv: stringMap(entry["worker_env"], `${description} worker_env`) }
        : {}),
    });
  }
  if (
    new Set(stdioServers.map((server) => server.command).filter(Boolean)).size !==
    stdioServers.filter((server) => server.command !== undefined).length
  ) {
    fail("policy.stdio_servers lists a command twice.");
  }

  const credentials: Record<string, CredentialPolicy> = {};
  const declared = value["credentials"];
  assertPlainObject(declared, "policy.credentials");
  for (const [credential, entry] of Object.entries(declared)) {
    const description = `policy.credentials ${credential}`;
    const problem = runtimeEnvNameProblem(credential, brokeredCredentials);
    if (problem !== undefined) {
      fail(`${description}: ${problem}.`);
    }
    assertPlainObject(entry, description);
    const keys = Object.keys(entry);
    const allowed = ["copy_of", "header", "profiles", "script", "urls"];
    if (!keys.includes("profiles") || keys.some((key) => !allowed.includes(key))) {
      fail(`${description} must contain profiles and may contain ${allowed.join(", ")}.`);
    }
    const header = entry["header"];
    const urls = stringList(entry["urls"] ?? [], `${description} urls`);
    const script = entry["script"] ?? false;
    if (typeof script !== "boolean") {
      fail(`${description} script must be a boolean.`);
    }
    if (header !== undefined) {
      if (
        typeof header !== "string" ||
        !authorizationSchemePattern.test(header) ||
        urls.length === 0 ||
        script
      ) {
        fail(
          `${description}: a header credential names its scheme and URLs, and is no script credential.`,
        );
      }
      assertSubset(
        urls,
        mcpServers.map((server) => server.url),
        `${description} urls`,
      );
    } else if (urls.length > 0) {
      fail(`${description} lists urls only with a header scheme.`);
    }
    const copyOf = entry["copy_of"];
    if (
      copyOf !== undefined &&
      (!script ||
        typeof copyOf !== "string" ||
        !Object.values(gatewayRuntimeEnv).flat().includes(copyOf))
    ) {
      fail(`${description} copy_of names a gateway key, on a script credential.`);
    }
    const readers = stdioServers.filter(
      (server) =>
        server.credentials.includes(credential) ||
        Object.values(server.toolCredentials).includes(credential),
    );
    if (header === undefined && !script && readers.length === 0) {
      fail(`${description} is no header or script credential, so a stdio server must read it.`);
    }
    credentials[credential] = {
      profiles: stringList(entry["profiles"], `${description} profiles`, skillNamePattern),
      ...(typeof header === "string" ? { header } : {}),
      urls,
      script,
      ...(typeof copyOf === "string" ? { copy_of: copyOf } : {}),
    };
  }
  for (const server of stdioServers) {
    const unknown = [...server.credentials, ...Object.values(server.toolCredentials)].filter(
      (credential) => !Object.hasOwn(credentials, credential),
    );
    if (unknown.length > 0) {
      fail(
        `policy.stdio_servers ${server.name} reads ${unknown.join(", ")}, which policy.credentials does not list.`,
      );
    }
  }

  return {
    ownerConsole,
    personalDataProfiles: new Set(
      stringList(
        value["personal_data_profiles"],
        "policy.personal_data_profiles",
        skillNamePattern,
      ),
    ),
    modelFreeProfiles: new Set(
      stringList(value["model_free_profiles"], "policy.model_free_profiles", skillNamePattern),
    ),
    repositoryWriteSkills: new Set(
      stringList(
        value["repository_write_skills"],
        "policy.repository_write_skills",
        skillNamePattern,
      ),
    ),
    timezone: value["timezone"] as string,
    restrictedPaths: restrictedPaths as Record<string, string[]>,
    handoff: {
      plugin: name(handoff["plugin"], "policy.handoff.plugin"),
      profile: name(handoff["profile"], "policy.handoff.profile"),
      tools: handoffTools,
      hooks,
      botMentionPatterns,
    },
    workerGuard,
    brokeredCredentials,
    credentials,
    mcpServers,
    stdioServers,
  };
}

// Every profile the policy names exists in the fleet.
function validatePolicyProfiles(names: ReadonlySet<string>): void {
  const named = [
    policy.ownerConsole,
    policy.handoff.profile,
    ...policy.personalDataProfiles,
    ...policy.modelFreeProfiles,
    ...Object.values(policy.credentials).flatMap((credential) => credential.profiles),
    ...policy.mcpServers.flatMap((server) => server.writers),
    ...policy.stdioServers.flatMap((server) => server.profiles ?? []),
  ];
  const unknown = [...new Set(named.filter((name) => !names.has(name)))];
  if (unknown.length > 0) {
    fail(`The fleet policy names profiles the fleet does not declare: ${unknown.join(", ")}.`);
  }
}

function parseArguments(argv: readonly string[]): { root?: string; python?: string } {
  const result: { root?: string; python?: string } = {};
  for (const argument of argv) {
    const match = /^--(root|python)=(\/.+)$/.exec(argument);
    if (match?.[1] === undefined || match[2] === undefined || match[1] in result) {
      console.error(
        "usage: validate-fleet.ts [--root=/absolute/release] [--python=/absolute/python3]",
      );
      process.exit(2);
    }
    result[match[1] as "root" | "python"] = match[2];
  }
  return result;
}

function fail(message: string): never {
  throw new Error(message);
}

// Hermes reads YAML with PyYAML, which implements YAML 1.1 (on, off, yes, and no are booleans), so
// the validator reads every YAML file the same way.
function readYaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"), { version: "1.1" });
}

function assertPlainObject(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${description} must be an object.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], description: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || wanted.some((key, index) => actual[index] !== key)) {
    fail(`${description} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function assertUniqueStrings(
  value: unknown,
  description: string,
  pattern?: RegExp,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${description} must be an array of strings.`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${description} must not contain duplicates.`);
  }
  if (pattern !== undefined && value.some((item) => !pattern.test(item))) {
    fail(`${description} contains an invalid value.`);
  }
}

function walkFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      fail(`Symlinks are not allowed in distributed content: ${relative(repositoryRoot, path)}`);
    }
    if (entry.isDirectory()) {
      result.push(...walkFiles(path));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}

function validateNoSecretsOrRuntimeData(root: string): void {
  for (const path of walkFiles(root)) {
    const relativePath = relative(root, path);
    const parts = normalize(relativePath).split(/[/\\]/);
    const hasRuntimePath =
      parts.some((part) => forbiddenNames.has(part)) ||
      parts.some((part) => forbiddenDirectoryPatterns.some((pattern) => pattern.test(part))) ||
      forbiddenFilePatterns.some((pattern) => pattern.test(basename(path)));
    if (hasRuntimePath && basename(path) !== ".gitignore") {
      fail(`Runtime-owned path cannot be distributed: ${relative(repositoryRoot, path)}`);
    }
    // Binary assets (skill PNGs) decode with replacement characters, which are dropped before the
    // credential scan so an invalid byte cannot split a credential-shaped value. The reconciler's
    // validate_content does the same. Keep the two in step.
    const content = readFileSync(path, "utf8");
    const scanned = content.replaceAll("\ufffd", "");
    for (const pattern of secretPatterns) {
      if (pattern.test(scanned)) {
        fail(`Credential-shaped content found in ${relative(repositoryRoot, path)}.`);
      }
    }
    // Only a restricted path's reviewed users may name it (a README only describes them).
    const repositoryPath = relative(repositoryRoot, path).split(/[/\\]/).join("/");
    for (const [restricted, users] of Object.entries(policy.restrictedPaths)) {
      if (
        content.includes(restricted) &&
        basename(path) !== "README.md" &&
        !users.includes(repositoryPath)
      ) {
        fail(`${repositoryPath} names ${restricted}; only ${users.join(", ")} may.`);
      }
    }
  }
}

function validateSkill(path: string): void {
  const content = readFileSync(path, "utf8");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (frontmatter?.[1] === undefined) {
    fail(`Skill is missing YAML frontmatter: ${relative(repositoryRoot, path)}`);
  }
  const metadata: unknown = parse(frontmatter[1], { version: "1.1" });
  assertPlainObject(metadata, `Frontmatter in ${relative(repositoryRoot, path)}`);
  const { description, name } = metadata;
  const expectedName = basename(dirname(path));
  if (name !== expectedName) {
    fail(`Skill ${relative(repositoryRoot, path)} must declare name: ${expectedName}.`);
  }
  if (typeof description !== "string" || description.trim().length < 20) {
    fail(`Skill ${expectedName} needs a useful description.`);
  }
}

// A surface may also name the profile's own MCP servers, its own plugin toolsets, or `no_mcp`.
function validatePlatformToolsets(
  value: unknown,
  profileName: string,
  mcpServerNames: ReadonlySet<string>,
  pluginToolsets: ReadonlySet<string>,
): PlatformToolsets {
  assertPlainObject(value, `platform_toolsets for ${profileName}`);
  assertExactKeys(value, [...profilePlatforms], `platform_toolsets for ${profileName}`);
  for (const platform of profilePlatforms) {
    assertUniqueStrings(value[platform], `${profileName}.${platform} toolsets`, toolsetNamePattern);
    for (const toolset of value[platform]) {
      if (toolset === kanbanToolset) {
        fail(
          `Profile ${profileName} must not select ${kanbanToolset}; hand-offs go only through ` +
            `${policy.handoff.plugin}.`,
        );
      }
      if (bundledPluginToolsets.has(toolset)) {
        fail(`Profile ${profileName} must not select the bundled plugin toolset ${toolset}.`);
      }
      if (toolset === noMcpSentinel || mcpServerNames.has(toolset) || pluginToolsets.has(toolset)) {
        continue;
      }
      if (!configurableToolsets.has(toolset)) {
        fail(
          `Profile ${profileName} selects ${toolset}, which is not a supported toolset, one ` +
            `of its MCP servers, or one of its plugin toolsets.`,
        );
      }
      if (toolset === connectionsToolset) {
        fail(
          `Profile ${profileName} must not select ${connectionsToolset}; it bypasses the MCP allowlist.`,
        );
      }
    }
  }
  return value as PlatformToolsets;
}

// Built-in toolsets only, without MCP server names and the no_mcp sentinel.
function nativeToolsets(toolsets: string[]): string[] {
  return toolsets.filter((toolset) => configurableToolsets.has(toolset));
}

// Hermes accepts http and https (tools/mcp_tool_errors.py:168-188); Dodo requires https with a host.
// User info, a fragment, whitespace, or `$` could carry a value Hermes would interpolate or send
// elsewhere. A query is fine: every server URL is an exact URL the policy reviews.
function assertHttpsServerUrl(value: unknown, description: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^https:\/\/[^/\\]/.test(value) ||
    /[\s$#@\\]/.test(value) ||
    !URL.canParse(value)
  ) {
    fail(`${description} must be an https URL without credentials, fragment, or $.`);
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname === "") {
    fail(`${description} must be an https URL without credentials, fragment, or $.`);
  }
}

// The keys a remote and a stdio server share: exact tools, utilities and server-driven requests off,
// an explicit trust level, and optional timeout and lifecycle bounds.
function validateMcpServerCommon(
  server: Record<string, unknown>,
  description: string,
  maxLifetimeMaximum: number,
): string[] {
  // An absent trust means full (tools/mcp_tool_registration.py:36-45), so it must be explicit.
  if (server["trust"] !== "untrusted" && server["trust"] !== "full") {
    fail(`${description} trust must be untrusted or full.`);
  }
  const tools = server["tools"];
  assertPlainObject(tools, `${description} tools`);
  assertExactKeys(tools, ["include", "prompts", "resources"], `${description} tools`);
  assertUniqueStrings(tools["include"], `${description} tools.include`, mcpToolNamePattern);
  if (tools["include"].length === 0) {
    fail(`${description} must include at least one exact tool.`);
  }
  // Resource and prompt utilities are registered whatever include says
  // (tools/mcp_tool_registration.py:150-176, :394-408).
  if (tools["resources"] !== false || tools["prompts"] !== false) {
    fail(`${description} must set tools.resources: false and tools.prompts: false.`);
  }
  // Both default on (tools/mcp_tool_server_run.py:266-276); sampling lets the server drive the model.
  for (const key of ["sampling", "elicitation"]) {
    const block = server[key];
    assertPlainObject(block, `${description} ${key}`);
    assertExactKeys(block, ["enabled"], `${description} ${key}`);
    if (block["enabled"] !== false) {
      fail(`${description} must set ${key}.enabled: false.`);
    }
  }
  if ("timeout" in server) {
    assertBoundedInteger(server["timeout"], mcpTimeoutLimit, `${description} timeout`);
  }
  if ("lifecycle" in server) {
    const lifecycle = server["lifecycle"];
    assertPlainObject(lifecycle, `${description} lifecycle`);
    assertExactKeys(lifecycle, ["max_lifetime_seconds"], `${description} lifecycle`);
    const seconds = lifecycle["max_lifetime_seconds"];
    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < mcpMaxLifetimeMinimum ||
      seconds > maxLifetimeMaximum
    ) {
      fail(
        `${description} lifecycle.max_lifetime_seconds must be an integer between ` +
          `${mcpMaxLifetimeMinimum} and ${maxLifetimeMaximum}.`,
      );
    }
  }
  return tools["include"];
}

// The policy entry a stdio server's command and arguments run: a wrapper started with the profile's
// own name, or a Dodo server started by the system interpreter in isolated mode from the live
// release with the profile's own name. Undefined for anything else.
function stdioServerContract(
  server: Record<string, unknown>,
  profileName: string,
): StdioServerPolicy | undefined {
  const command = server["command"];
  const args = JSON.stringify(server["args"]);
  return policy.stdioServers.find((entry) =>
    entry.command !== undefined
      ? command === entry.command && args === JSON.stringify([profileName])
      : command === dodoMcpServerCommand &&
        args ===
          JSON.stringify(["-I", `${dodoMcpServerRoot}/${entry.name}/server.py`, profileName]),
  );
}

// A stdio server: one the policy lists, started with the profile's own name so it reads that
// profile's credentials, exposing a subset of its tools. Only a server whose policy pins an env
// block takes one, and a workers_only server runs only in a Kanban worker.
function validateMcpStdioServer(
  server: Record<string, unknown>,
  description: string,
  profileName: string,
  runtimeEnv: readonly string[],
  brokeredEnv: readonly string[],
  isWorker: boolean,
): void {
  const keys = Object.keys(server);
  if (
    mcpStdioServerRequiredKeys.some((key) => !keys.includes(key)) ||
    keys.some(
      (key) =>
        !mcpStdioServerRequiredKeys.includes(key) && !mcpStdioServerOptionalKeys.includes(key),
    )
  ) {
    fail(
      `${description} is a stdio server and must contain ${mcpStdioServerRequiredKeys.join(", ")} ` +
        `and may contain ${mcpStdioServerOptionalKeys.join(", ")}.`,
    );
  }
  const contract = stdioServerContract(server, profileName);
  if (contract === undefined) {
    fail(
      `${description} must run a server in the fleet policy's stdio_servers: its command with ` +
        `args [${profileName}], or ${dodoMcpServerCommand} with args [-I, ` +
        `${dodoMcpServerRoot}/<name>/server.py, ${profileName}] for a Dodo server.`,
    );
  }
  if (
    contract.command === undefined &&
    !lstatSync(join(sharedMcpServersRoot, contract.name, "server.py"), {
      throwIfNoEntry: false,
    })?.isFile()
  ) {
    fail(
      `${description} runs shared/mcp-servers/${contract.name}/server.py, which does not exist.`,
    );
  }
  if (contract.workersOnly && !isWorker) {
    fail(`${description} runs a server that reads a Kanban task; only a Kanban worker may run it.`);
  }
  if (contract.profiles !== undefined && !contract.profiles.includes(profileName)) {
    fail(`${description} runs a server that only ${contract.profiles.join(", ")} may run.`);
  }
  const pinnedEnv =
    contract.workerEnv !== undefined && isWorker ? contract.workerEnv : contract.env;
  if (
    "env" in server
      ? pinnedEnv === undefined || canonicalJson(server["env"]) !== canonicalJson(pinnedEnv)
      : pinnedEnv !== undefined
  ) {
    fail(
      pinnedEnv === undefined
        ? `${description} must not set env; the server reads its credential itself.`
        : `${description} env must be exactly ${JSON.stringify(pinnedEnv)}.`,
    );
  }
  const include = validateMcpServerCommon(server, description, mcpStdioMaxLifetimeMaximum);
  const outside = include.filter((tool) => !contract.tools.includes(tool));
  if (outside.length > 0) {
    fail(`${description} includes tools the server does not expose: ${outside.join(", ")}.`);
  }
  if (
    contract.brokeredCredential !== undefined &&
    !brokeredEnv.includes(contract.brokeredCredential)
  ) {
    fail(`${description} needs ${contract.brokeredCredential} in the profile's brokered_env.`);
  }
  const needed = [
    ...contract.credentials,
    ...Object.entries(contract.toolCredentials)
      .filter(([tool]) => include.includes(tool))
      .map(([, name]) => name),
  ];
  const undeclared = needed.filter((name) => !runtimeEnv.includes(name));
  if (undeclared.length > 0) {
    fail(`${description} needs ${undeclared.join(", ")} in the profile's runtime_env.`);
  }
}

// A remote server or a stdio server the policy lists, each with a closed set of keys.
function validateMcpServers(
  value: unknown,
  profileName: string,
  runtimeEnv: readonly string[],
  brokeredEnv: readonly string[],
  isWorker: boolean,
): Record<string, unknown> {
  assertPlainObject(value, `mcp_servers for ${profileName}`);
  for (const [name, server] of Object.entries(value)) {
    const description = `Profile ${profileName} MCP server ${name}`;
    if (!mcpNamePattern.test(name)) {
      fail(`Profile ${profileName} has an invalid MCP server name: ${name}.`);
    }
    if (reservedMcpServerNames.has(name) || name.startsWith(reservedMcpServerPrefix)) {
      fail(`${description}: the name is reserved for a Hermes toolset, platform, or sentinel.`);
    }
    assertPlainObject(server, description);
    const keys = Object.keys(server);
    if (keys.includes("command")) {
      validateMcpStdioServer(server, description, profileName, runtimeEnv, brokeredEnv, isWorker);
      continue;
    }
    if (
      mcpServerRequiredKeys.some((key) => !keys.includes(key)) ||
      keys.some(
        (key) => !mcpServerRequiredKeys.includes(key) && !mcpServerOptionalKeys.includes(key),
      )
    ) {
      fail(
        `${description} must contain ${mcpServerRequiredKeys.join(", ")} and may contain ` +
          `${mcpServerOptionalKeys.join(", ")}.`,
      );
    }
    assertHttpsServerUrl(server["url"], `${description} url`);
    // Without it a cross-origin redirect keeps every configured header except Authorization, and a
    // rejected Streamable HTTP connect falls back to SSE (tools/mcp_tool_errors.py:265-301,
    // tools/mcp_tool_transport.py:549-586).
    if (server["strict_redirect_headers"] !== true) {
      fail(`${description} must set strict_redirect_headers: true.`);
    }
    if ("headers" in server) {
      const headers = server["headers"];
      assertPlainObject(headers, `${description} headers`);
      for (const [header, headerValue] of Object.entries(headers)) {
        const reference =
          typeof headerValue === "string" ? mcpHeaderValuePattern.exec(headerValue) : null;
        if (!mcpHeaderNamePattern.test(header) || reference?.[1] === undefined) {
          fail(
            `${description} header ${header} must be exactly \${NAME} or <scheme> \${NAME}; ` +
              "literal values are not allowed.",
          );
        }
        if (!runtimeEnv.includes(reference[1])) {
          fail(
            `${description} header ${header} references ${reference[1]}, which runtime_env does not declare.`,
          );
        }
      }
    }
    validateMcpServerCommon(server, description, mcpMaxLifetimeMaximum);
  }
  return value;
}

// Surface rules. Every surface names its MCP servers or no_mcp, because a surface that
// names none receives every enabled server, including ones added at runtime or by a plugin
// (hermes_cli/tools_config.py:414-432, :678-690; cron/scheduler.py:469-484).
function validateMcpSurfaces(
  profile: DefaultProfile | FleetProfile,
  platformToolsets: PlatformToolsets,
  config: Record<string, unknown>,
  ownerSlackId: string,
): void {
  const servers = profile.mcp_servers as Record<string, Record<string, unknown>>;
  const named = new Set<string>();
  for (const platform of profilePlatforms) {
    const selected = platformToolsets[platform];
    const surfaceServers = selected.filter((toolset) => Object.hasOwn(servers, toolset));
    const hasNoMcp = selected.includes(noMcpSentinel);
    if (surfaceServers.length === 0 && !hasNoMcp) {
      fail(
        `Profile ${profile.name} ${platform} surface must name its MCP servers or ${noMcpSentinel}; ` +
          "otherwise Hermes adds every enabled server.",
      );
    }
    if (surfaceServers.length > 0 && hasNoMcp) {
      fail(
        `Profile ${profile.name} ${platform} surface combines ${noMcpSentinel} with MCP servers.`,
      );
    }
    for (const server of surfaceServers) {
      named.add(server);
    }
    if (surfaceServers.length === 0) {
      continue;
    }
    // Code runs only where nobody can message the profile (validateExecutionReach). There the owner
    // accepts that a terminal or execute_code next to MCP data has the network.
    const egress = selected.filter(
      (toolset) =>
        egressToolsets.has(toolset) &&
        !(profile.gateway !== "slack" && executionToolsets.has(toolset)),
    );
    if (
      egress.length > 0 &&
      !(platform === "slack" && isOwnerOnlySlackProfile(profile, config, ownerSlackId))
    ) {
      fail(
        `Profile ${profile.name} ${platform} surface names MCP servers next to ${egress.join(", ")}; ` +
          "a surface that reads MCP data must not have an egress toolset.",
      );
    }
    if (platform === "slack" && profile.gateway === "slack") {
      const slack = config["slack"] as Record<string, unknown>;
      if (slack["unfurl_links"] !== false || slack["unfurl_media"] !== false) {
        fail(
          `Profile ${profile.name} names MCP servers on Slack and must set slack.unfurl_links ` +
            "and slack.unfurl_media to false.",
        );
      }
    }
  }
  const unused = Object.keys(servers).filter((server) => !named.has(server));
  if (unused.length > 0) {
    fail(
      `Profile ${profile.name} declares MCP servers that no surface names: ${unused.join(", ")}.`,
    );
  }
}

// Whether teammates can start the profile's runs: a Slack gateway other than the owner console.
function teammatesReach(
  profile: DefaultProfile | FleetProfile,
  config: Record<string, unknown>,
  ownerSlackId: string,
): boolean {
  return profile.gateway === "slack" && !isOwnerOnlySlackProfile(profile, config, ownerSlackId);
}

// What a profile may load from its MCP servers: never a delete_* tool; from a remote server only a
// tool the policy reviews for that exact URL, and a write tool only where the policy lists the
// profile as a writer; and no restricted tool where teammates can start a run. Every server may be
// trusted, so no write waits for an approval click (owner decision): the boundary is this list, the
// key's scope, and the credential rules, not the prompt.
function validateReviewedMcpServers(
  profile: DefaultProfile | FleetProfile,
  config: Record<string, unknown>,
  ownerSlackId: string,
): void {
  const reachable = teammatesReach(profile, config, ownerSlackId);
  for (const [name, value] of Object.entries(profile.mcp_servers)) {
    const server = value as Record<string, unknown>;
    const description = `Profile ${profile.name} MCP server ${name}`;
    const include = (server["tools"] as Record<string, unknown>)["include"] as string[];
    const deletes = deleteTools(include);
    if (deletes.length > 0) {
      fail(`${description} must not include delete tools: ${deletes.join(", ")}.`);
    }
    let restricted: readonly string[];
    if ("command" in server) {
      restricted = stdioServerContract(server, profile.name)?.restricted ?? [];
    } else {
      const url = server["url"] as string;
      const entry = policy.mcpServers.find((reviewed) => reviewed.url === url);
      if (entry === undefined) {
        fail(
          `${description} url ${url} is not a reviewed server in the fleet policy's mcp_servers.`,
        );
      }
      const outside = include.filter((tool) => !entry.tools.includes(tool));
      if (outside.length > 0) {
        fail(
          `${description} includes tools the policy does not review for ${url}: ${outside.join(", ")}.`,
        );
      }
      const writes = include.filter((tool) => entry.writes.includes(tool));
      if (writes.length > 0 && !entry.writers.includes(profile.name)) {
        fail(
          `${description} writes through ${url} (${writes.join(", ")}), which only ` +
            `${entry.writers.join(", ")} may.`,
        );
      }
      restricted = entry.restricted;
    }
    const loaded = include.filter((tool) => restricted.includes(tool));
    if (loaded.length > 0 && reachable) {
      fail(
        `${description} loads ${loaded.join(", ")}, which a profile teammates can message never ` +
          "loads.",
      );
    }
  }
}

// Where each credential a profile declares may go (policy.credentials): only into the profiles the
// policy lists; a header credential only as its server's one header, `Authorization: <scheme>
// ${NAME}`, to its URLs, and some server sends it; a script credential only to scripts, through
// terminal.env_passthrough; any other only to the stdio server that reads it.
function validateCredentials(
  profile: DefaultProfile | FleetProfile,
  config: Record<string, unknown>,
): void {
  const terminal = config["terminal"];
  const passthrough =
    terminal !== null && typeof terminal === "object"
      ? (((terminal as Record<string, unknown>)["env_passthrough"] ?? []) as unknown[])
      : [];
  const servers = Object.entries(profile.mcp_servers) as [string, Record<string, unknown>][];
  for (const name of profile.runtime_env) {
    const credential = Object.hasOwn(policy.credentials, name)
      ? policy.credentials[name]
      : undefined;
    if (credential === undefined) {
      fail(
        `Profile ${profile.name} runtime_env: ${name} is not in the fleet policy's credentials.`,
      );
    }
    if (!credential.profiles.includes(profile.name)) {
      fail(
        `Profile ${profile.name} runtime_env: ${name} belongs only to ${credential.profiles.join(", ")}.`,
      );
    }
    if (
      credential.copy_of !== undefined &&
      !(gatewayRuntimeEnv[String(profile.gateway)] ?? []).includes(credential.copy_of)
    ) {
      fail(
        `Profile ${profile.name} runtime_env: ${name} is the script copy of ${credential.copy_of} ` +
          "and needs a gateway that holds that key.",
      );
    }
    if (credential.script && !passthrough.includes(name)) {
      fail(
        `Profile ${profile.name} declares the script credential ${name} and must pass it in ` +
          "terminal.env_passthrough.",
      );
    }
    if (!credential.script && passthrough.includes(name)) {
      fail(`Profile ${profile.name} terminal.env_passthrough must not pass ${name}.`);
    }
    const reference = `\${${name}}`;
    let sent = false;
    for (const [serverName, server] of servers) {
      const headers = (server["headers"] ?? {}) as Record<string, unknown>;
      const carries = Object.values(headers).some(
        (headerValue) => typeof headerValue === "string" && headerValue.includes(reference),
      );
      if (!carries) {
        continue;
      }
      if (
        credential.header === undefined ||
        typeof server["url"] !== "string" ||
        !credential.urls.includes(server["url"]) ||
        Object.keys(headers).length !== 1 ||
        headers["Authorization"] !== `${credential.header} ${reference}`
      ) {
        fail(
          credential.header === undefined
            ? `Profile ${profile.name} MCP server ${serverName} must not send ${name}.`
            : `Profile ${profile.name} MCP server ${serverName} may send ${name} only as its one ` +
                `header, Authorization: ${credential.header} ${reference}, to ` +
                `${credential.urls.join(" or ")}.`,
        );
      }
      sent = true;
    }
    if (credential.header !== undefined && !sent) {
      fail(
        `Profile ${profile.name} declares ${name} but no MCP server sends it to ` +
          `${credential.urls.join(" or ")}.`,
      );
    }
    if (credential.header === undefined && !credential.script) {
      const reader = servers.some(([, server]) => {
        const contract = stdioServerContract(server, profile.name);
        const include = (server["tools"] as Record<string, unknown>)["include"] as string[];
        return (
          contract !== undefined &&
          (contract.credentials.includes(name) ||
            Object.entries(contract.toolCredentials).some(
              ([tool, needed]) => needed === name && include.includes(tool),
            ))
        );
      });
      if (!reader) {
        fail(
          `Profile ${profile.name} declares ${name}, which only a stdio server reads, but runs no ` +
            "server that reads it.",
        );
      }
    }
  }
}

// A profile whose runs read client personal data (policy.personal_data_profiles) delivers only to
// DMs, and no surface selects anything but skills, todo, no_mcp, and its own MCP servers: no web,
// vision, browser, terminal, file, code_execution, delegation, memory, or session_search.
function validatePersonalDataProfile(
  profile: DefaultProfile | FleetProfile,
  platformToolsets: PlatformToolsets,
): void {
  if (!policy.personalDataProfiles.has(profile.name)) {
    return;
  }
  const description = `Profile ${profile.name} reads client personal data and`;
  const shared = profile.delivery_targets.filter(
    (target) => !directMessageTargetPattern.test(target),
  );
  if (shared.length > 0) {
    fail(`${description} may deliver only to Slack DMs (slack:D…), not ${shared.join(", ")}.`);
  }
  const servers = new Set(Object.keys(profile.mcp_servers));
  for (const platform of profilePlatforms) {
    const extra = platformToolsets[platform].filter(
      (toolset) =>
        toolset !== noMcpSentinel && !personalDataToolsets.has(toolset) && !servers.has(toolset),
    );
    if (extra.length > 0) {
      fail(
        `${description} its ${platform} surface may select only ` +
          `${[...personalDataToolsets].join(", ")}, ${noMcpSentinel}, and its own MCP servers, ` +
          `not ${extra.join(", ")}.`,
      );
    }
  }
}

// The owner exception to the egress rule holds only while the policy's owner console is a DM-only
// Slack profile whose single allowed user is the fleet's owner.
function isOwnerOnlySlackProfile(
  profile: DefaultProfile | FleetProfile,
  config: Record<string, unknown>,
  ownerSlackId: string,
): boolean {
  const slack = config["slack"];
  return (
    profile.name === policy.ownerConsole &&
    profile.gateway === "slack" &&
    slack !== null &&
    typeof slack === "object" &&
    !("group_allow_from" in slack) &&
    JSON.stringify((slack as Record<string, unknown>)["allowed_channels"]) ===
      JSON.stringify([dmOnlyChannelSentinel]) &&
    JSON.stringify((slack as Record<string, unknown>)["allow_from"]) ===
      JSON.stringify([ownerSlackId])
  );
}

// A Kanban worker keeps kanban out of the list: the dispatcher appends it to the worker's toolsets,
// but the CLI subtracts agent.disabled_toolsets last, which would take kanban_complete away
// (model_tools.py:314-339, hermes_cli/cli_init_mixin.py:207-212).
function expectedDisabledToolsets(platformToolsets: PlatformToolsets, isWorker = false): string[] {
  const enabled = new Set(Object.values(platformToolsets).flat());
  return [...knownLeafToolsets]
    .filter((toolset) => !enabled.has(toolset) && !(isWorker && toolset === kanbanToolset))
    .sort();
}

function assertBoundedInteger(value: unknown, maximum: number, description: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    fail(`${description} must be an integer between 1 and ${maximum}.`);
  }
}

function validateDelegation(value: unknown, profileName: string): void {
  const description = `delegation config for ${profileName}`;
  assertPlainObject(value, description);
  assertExactKeys(value, delegationKeys, description);
  if (typeof value["model"] !== "string" || !delegationModelPattern.test(value["model"])) {
    fail(`${description}: model must pin a model id.`);
  }
  assertBoundedInteger(
    value["max_iterations"],
    sharedGatewayMaxTurnsLimit,
    `delegation.max_iterations for ${profileName}`,
  );
  assertBoundedInteger(
    value["max_concurrent_children"],
    maxDelegationChildren,
    `delegation.max_concurrent_children for ${profileName}`,
  );
  assertBoundedInteger(
    value["child_timeout_seconds"],
    runBudgetSecondsLimit,
    `delegation.child_timeout_seconds for ${profileName}`,
  );
  if (
    value["max_spawn_depth"] !== 1 ||
    value["orchestrator_enabled"] !== false ||
    value["subagent_auto_approve"] !== false ||
    value["inherit_mcp_toolsets"] !== false
  ) {
    fail(
      `${description} must set max_spawn_depth: 1, orchestrator_enabled: false, ` +
        "subagent_auto_approve: false, and inherit_mcp_toolsets: false.",
    );
  }
}

function assertSlackIds(value: unknown, pattern: RegExp, description: string): string[] {
  assertUniqueStrings(value, description, pattern);
  if (value.length === 0) {
    fail(`${description} must not be empty.`);
  }
  return value;
}

// Host-wide Slack policy. Under Hermes multiplexing, slash-command gating and the
// unauthorized-DM behavior are read only from the default profile's config.
function validateHostGatewayPolicy(config: Record<string, unknown>): void {
  const slack = config["slack"];
  assertPlainObject(slack, "Host slack policy in the default profile");
  assertExactKeys(
    slack,
    [
      "allow_admin_from",
      "group_allow_admin_from",
      "group_user_allowed_commands",
      "unauthorized_dm_behavior",
      "user_allowed_commands",
    ],
    "Host slack policy in the default profile",
  );
  assertSlackIds(slack["allow_admin_from"], slackUserIdPattern, "slack.allow_admin_from");
  assertSlackIds(
    slack["group_allow_admin_from"],
    slackUserIdPattern,
    "slack.group_allow_admin_from",
  );
  for (const key of ["user_allowed_commands", "group_user_allowed_commands"]) {
    const commands = slack[key];
    assertUniqueStrings(commands, `slack.${key}`);
    if (commands.some((command) => !hostSlashCommands.has(command))) {
      fail(`slack.${key} may only grant: ${[...hostSlashCommands].join(", ")}.`);
    }
  }
  if (slack["unauthorized_dm_behavior"] !== "ignore") {
    fail("slack.unauthorized_dm_behavior must be ignore so non-members get no response.");
  }
  assertBoundedInteger(
    config["max_concurrent_sessions"],
    maxConcurrentSessionsLimit,
    "max_concurrent_sessions",
  );
}

// Returns whether the profile is personal: DM-only with exactly one allowed user.
function validateSlackGatewayConfig(
  config: Record<string, unknown>,
  platformToolsets: PlatformToolsets,
  profileName: string,
  takesBotPosts: boolean,
  ownerOnly: boolean,
): boolean {
  const slack = config["slack"];
  assertPlainObject(slack, `slack config for ${profileName}`);
  const keys = Object.keys(slack);
  const required = ["allow_bots", "allow_from", "require_mention"];
  const optional = ["allowed_channels", "group_allow_from"];
  // The hand-off plugin's pre_gateway_dispatch hook takes bot posts that mention nobody and have no
  // user: the adapter lets them through only as bot posts matching a mention pattern, and
  // authorization drops every other post without a listed user.
  if (takesBotPosts) {
    required.push("mention_patterns");
  }
  // A gateway may switch link previews off. Hermes promotes these keys of the root slack block into
  // the adapter's extra settings (gateway/config_loader.py:226-242), which every chat.postMessage
  // then carries (plugins/platforms/slack/adapter.py:89-100, :2283).
  optional.push("unfurl_links", "unfurl_media");
  for (const key of ["unfurl_links", "unfurl_media"]) {
    if (key in slack && typeof slack[key] !== "boolean") {
      fail(`slack.${key} for ${profileName} must be a boolean.`);
    }
  }
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    fail(
      `slack config for ${profileName} must contain ${required.join(", ")} and may contain ` +
        `${optional.join(", ")}.`,
    );
  }
  const directUsers = assertSlackIds(
    slack["allow_from"],
    slackUserIdPattern,
    `${profileName}.slack.allow_from`,
  );
  if (takesBotPosts) {
    if (
      slack["allow_bots"] !== "all" ||
      JSON.stringify(slack["mention_patterns"]) !==
        JSON.stringify(policy.handoff.botMentionPatterns)
    ) {
      fail(
        `Profile ${profileName} takes bot posts through ${policy.handoff.plugin}'s hook and must ` +
          "set allow_bots: all and mention_patterns to exactly the policy's bot_mention_patterns.",
      );
    }
  } else if (slack["allow_bots"] !== "none") {
    fail(`Profile ${profileName} must not accept messages from other bots.`);
  }
  if (slack["require_mention"] !== true) {
    fail(`Profile ${profileName} must require an explicit mention in channels.`);
  }

  const channelFacing = "group_allow_from" in slack;
  if (channelFacing) {
    assertSlackIds(
      slack["group_allow_from"],
      slackUserIdPattern,
      `${profileName}.slack.group_allow_from`,
    );
    // A channel-facing gateway names the channels it answers in. Without the list it answers an
    // allowed user's mention in every channel its app is invited to
    // (plugins/platforms/slack/adapter.py:4063-4068, :6253-6260).
    if (!("allowed_channels" in slack)) {
      fail(
        `Channel-facing profile ${profileName} must list the channels it answers in ` +
          "slack.allowed_channels.",
      );
    }
    if ("allowed_channels" in slack) {
      const channels = assertSlackIds(
        slack["allowed_channels"],
        slackChannelIdPattern,
        `${profileName}.slack.allowed_channels`,
      );
      if (channels.includes(dmOnlyChannelSentinel)) {
        fail(
          `Channel-facing profile ${profileName} must list real channels in ` +
            `slack.allowed_channels, not the DM-only sentinel ${dmOnlyChannelSentinel}.`,
        );
      }
    }
  } else if (
    JSON.stringify(slack["allowed_channels"]) !== JSON.stringify([dmOnlyChannelSentinel])
  ) {
    fail(
      `DM-only profile ${profileName} must set slack.allowed_channels to ` +
        `[${dmOnlyChannelSentinel}] so channel events are dropped.`,
    );
  }

  // MCP servers and no_mcp are governed by validateMcpSurfaces; these rules cover built-in toolsets.
  const slackToolsets = nativeToolsets(platformToolsets.slack);
  if (slackToolsets.length === 0) {
    fail(`Slack gateway profile ${profileName} must select at least one slack toolset.`);
  }
  const unsafe = slackToolsets.filter(
    (toolset) => !slackSafeToolsets.has(toolset) && !(ownerOnly && ownerSlackToolsets.has(toolset)),
  );
  if (unsafe.length > 0) {
    fail(`Profile ${profileName} exposes unsafe toolsets to Slack: ${unsafe.join(", ")}.`);
  }
  if (platformToolsets.cron.some((toolset) => toolset !== noMcpSentinel)) {
    fail(`Slack gateway profile ${profileName} must not select cron toolsets.`);
  }

  // Memory and session search are only safe when exactly one person can reach the profile.
  const personal = !channelFacing && directUsers.length === 1;
  const memory = config["memory"];
  assertPlainObject(memory, `memory config for ${profileName}`);
  assertExactKeys(
    memory,
    ["memory_enabled", "user_profile_enabled"],
    `memory config for ${profileName}`,
  );
  if (typeof memory["memory_enabled"] !== "boolean") {
    fail(`memory.memory_enabled for ${profileName} must be a boolean.`);
  }
  if (typeof memory["user_profile_enabled"] !== "boolean") {
    fail(`memory.user_profile_enabled for ${profileName} must be a boolean.`);
  }
  if (!personal) {
    const shared = slackToolsets.filter((toolset) => personalToolsets.has(toolset));
    if (shared.length > 0) {
      fail(`Shared profile ${profileName} must not expose ${shared.join(", ")} to Slack.`);
    }
    if (memory["memory_enabled"] !== false || memory["user_profile_enabled"] !== false) {
      fail(`Shared profile ${profileName} must disable memory and user profiles.`);
    }
  }

  const approvals = config["approvals"];
  assertPlainObject(approvals, `approvals config for ${profileName}`);
  assertExactKeys(approvals, ["mode"], `approvals config for ${profileName}`);
  if (approvals["mode"] !== "manual") {
    fail(`Slack gateway profile ${profileName} must use manual approvals.`);
  }
  return personal;
}

function validateProfileShape(value: unknown, isDefault: boolean): DefaultProfile | FleetProfile {
  assertPlainObject(value, isDefault ? "Default fleet profile" : "Fleet profile");
  const keys = [
    "brokered_env",
    "cron",
    "delivery_targets",
    "desired_state",
    "dodo_skills",
    "gateway",
    "hermes_skills",
    "kanban_worker",
    "mcp_servers",
    "name",
    "platform_toolsets",
    "plugins",
    "raven_skills",
    "runtime_env",
    "source",
    "terminal_home_mode",
  ];
  assertExactKeys(value, isDefault ? keys : [...keys, "alias"], `Profile ${String(value["name"])}`);
  // The default profile is the one Hermes launches and never installs; every other is installed.
  if (value["desired_state"] !== (isDefault ? "present" : "installed")) {
    fail(
      `Profile ${String(value["name"])} must have desired_state: ` +
        `${isDefault ? "present" : "installed"}.`,
    );
  }
  return value as unknown as DefaultProfile | FleetProfile;
}

// Names of the non-Slack credentials a profile holds in <profile>/.env; values never enter Git.
function validateRuntimeEnv(profile: DefaultProfile | FleetProfile): void {
  assertUniqueStrings(profile.runtime_env, `${profile.name}.runtime_env`);
  for (const name of profile.runtime_env) {
    const problem = runtimeEnvNameProblem(name, policy.brokeredCredentials);
    if (problem !== undefined) {
      fail(`Profile ${profile.name} runtime_env: ${problem}.`);
    }
  }
  // Hermes loads the launch profile's .env into the process environment of the multiplexed
  // gateway (agent/secret_scope.py:1-10), and the dashboard unit loads it too.
  if (profile.desired_state === "present" && profile.runtime_env.length !== 0) {
    fail(
      "The default profile's .env is process-global in the gateway and dashboard; " +
        "it must not hold capability credentials.",
    );
  }
}

// The credentials the host's root-owned broker mints into the profile's .env. The broker
// writes only to profiles that declare them and removes them from every other .env.
function validateBrokeredEnv(profile: DefaultProfile | FleetProfile): void {
  const unknown = profile.brokered_env.filter((name) => !policy.brokeredCredentials.has(name));
  if (unknown.length > 0) {
    fail(
      `Profile ${profile.name} brokered_env: ${unknown.join(", ")} is not minted by the broker; ` +
        `it mints ${[...policy.brokeredCredentials].join(", ")}.`,
    );
  }
  if (profile.brokered_env.length === 0) {
    return;
  }
  // The launch profile's .env is process-global in the gateway and the dashboard
  // (agent/secret_scope.py:1-10).
  if (profile.desired_state === "present") {
    fail("The default profile's .env is process-global; it must not hold brokered credentials.");
  }
  // A terminal in the same profile can read the token from .env. Code runs only where nobody can
  // message the profile (validateExecutionReach), and the owner accepts that risk there.
  // A brokered credential exists only for the stdio server that reads it, or, in a model-free
  // profile, for its scripts (validateModelFreeProfile).
  if (policy.modelFreeProfiles.has(profile.name)) {
    return;
  }
  const servers = Object.values(profile.mcp_servers) as Record<string, unknown>[];
  for (const name of profile.brokered_env) {
    const consumer = servers.find(
      (server) => stdioServerContract(server, profile.name)?.brokeredCredential === name,
    );
    if (consumer === undefined) {
      fail(
        `Profile ${profile.name} declares ${name} in brokered_env but no MCP server runs the ` +
          "wrapper or Dodo server that reads it.",
      );
    }
  }
}

// `cron` lists the ids of the jobs a profile ships. Jobs run only in profiles without Slack ingress
// (gateway false or slack_outbound), and the default profile ships none.
function validateCronDeclaration(profile: DefaultProfile | FleetProfile): void {
  assertUniqueStrings(profile.cron, `${profile.name}.cron`, cronJobIdPattern);
  if (profile.cron.length > 0) {
    if (profile.desired_state === "present" || profile.gateway === "slack") {
      fail(
        `Profile ${profile.name} cannot ship cron jobs; jobs run only in named profiles ` +
          "without Slack ingress.",
      );
    }
  }
  assertUniqueStrings(
    profile.delivery_targets,
    `${profile.name}.delivery_targets`,
    deliveryTargetPattern,
  );
  // Delivering to Slack needs the profile's own bot token: cron never borrows another profile's
  // adapter (cron/scheduler_provider.py:535-544), and without a live one it posts through the
  // standalone sender with the profile's scoped token (cron/scheduler_delivery.py:1344-1398,
  // plugins/platforms/slack/adapter.py:6545-6602). Only an outbound-only profile holds one without
  // Slack ingress.
  if (profile.delivery_targets.length > 0 && profile.gateway !== slackOutboundGateway) {
    fail(
      `Profile ${profile.name} declares delivery_targets and must declare gateway: ` +
        `${slackOutboundGateway}; only an outbound-only profile can deliver cron output to Slack.`,
    );
  }
}

// Five space-separated fields of `*`, `*/n`, `a`, `a-b`, or `a-b/n`, comma lists allowed, digits
// only, within the field's range, with 1 <= n <= the field's maximum. Hermes also accepts
// intervals, one-shots, natural phrases, named days, and a seconds field (cron/jobs.py:772-845);
// a reviewed schedule is a plain expression.
function isFiveFieldCron(schedule: unknown): boolean {
  if (typeof schedule !== "string") {
    return false;
  }
  const fields = schedule.split(" ");
  return (
    fields.length === cronFieldRanges.length &&
    fields.every((field, index) => {
      const [low, high] = cronFieldRanges[index] as readonly [number, number];
      return field.split(",").every((item) => {
        const match = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(item);
        if (match?.[1] === undefined) {
          return false;
        }
        const [base, step] = [match[1], match[2]];
        if (step !== undefined && (Number(step) < 1 || Number(step) > high || /^\d+$/.test(base))) {
          return false;
        }
        if (base === "*") {
          return true;
        }
        const [start, end = start] = base.split("-").map(Number) as [number, number?];
        return low <= start && start <= end && end <= high;
      });
    })
  );
}

function scriptImportProblem(
  path: string,
  modules: ReadonlySet<string> = cronScriptModules,
  processNames?: RegExp,
): string | undefined {
  const content = readFileSync(path, "utf8");
  const token = cronScriptForbiddenTokens.find((forbidden) => content.includes(forbidden));
  if (token !== undefined) {
    return `uses ${token}`;
  }
  let syntax: {
    error?: string;
    nodes?: { imports?: string[]; names?: string[]; relative?: boolean; call?: string }[];
  };
  try {
    syntax = JSON.parse(
      execFileSync(pythonCommand, ["-I", "-c", scriptSyntaxProgram, path], {
        encoding: "utf8",
        timeout: 30_000,
      }),
    ) as typeof syntax;
  } catch (error) {
    // A tooling failure (python3 missing, crashed, or timed out), not a problem with the profile.
    fail(
      `Could not check ${path} with python3 (pinned in mise.toml): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (syntax.error !== undefined) {
    return `is not valid Python (${syntax.error})`;
  }
  for (const node of syntax.nodes ?? []) {
    if (node.relative === true) {
      return "uses a relative import";
    }
    if (node.call !== undefined && cronScriptForbiddenCalls.has(node.call)) {
      return `calls ${node.call}`;
    }
    if (processNames !== undefined && node.call === "getattr") {
      return "calls getattr";
    }
    const process =
      processNames === undefined
        ? undefined
        : (node.names ?? []).find((name) => processNames.test(name));
    if (process !== undefined) {
      return `uses ${process}, which starts a process`;
    }
    const refused = (node.imports ?? []).find((module) => !modules.has(module.split(".")[0] ?? ""));
    if (refused !== undefined) {
      return `imports ${refused}, which is not in the reviewed standard-library list`;
    }
  }
  return undefined;
}

// The jobs a profile ships in cron/jobs.json and the scripts they run. Hermes imports the store by
// job id without create_job's checks (hermes_cli/profile_distribution.py:406-431,
// cron/job_definition.py:21-70), so every invariant is enforced here.
function validateCronJobs(
  profile: DefaultProfile | FleetProfile,
  directory: string,
  platformToolsets: PlatformToolsets,
  selectedSkillNames: readonly string[],
): void {
  const cronDirectory = join(directory, "cron");
  const scriptsDirectory = join(directory, "scripts");
  if (profile.cron.length === 0) {
    if (existsSync(cronDirectory) || existsSync(scriptsDirectory)) {
      fail(`Profile ${profile.name} ships no cron jobs and must not contain cron/ or scripts/.`);
    }
    return;
  }
  const description = `Profile ${profile.name} cron/jobs.json`;
  const cronEntries =
    existsSync(cronDirectory) && lstatSync(cronDirectory).isDirectory()
      ? readdirSync(cronDirectory)
      : [];
  if (
    cronEntries.length !== 1 ||
    cronEntries[0] !== "jobs.json" ||
    !lstatSync(join(cronDirectory, "jobs.json")).isFile()
  ) {
    fail(`Profile ${profile.name} cron/ must contain exactly jobs.json.`);
  }
  const store: unknown = JSON.parse(readFileSync(join(cronDirectory, "jobs.json"), "utf8"));
  assertPlainObject(store, description);
  assertExactKeys(store, ["jobs"], description);
  const jobs = store["jobs"];
  if (!Array.isArray(jobs)) {
    fail(`${description} jobs must be a list.`);
  }
  const ids = jobs.map((job: unknown) =>
    job !== null && typeof job === "object" ? (job as Record<string, unknown>)["id"] : undefined,
  );
  if (
    ids.length !== profile.cron.length ||
    new Set(ids).size !== ids.length ||
    profile.cron.some((id) => !ids.includes(id))
  ) {
    fail(`${description} job ids must equal the profile's fleet cron list.`);
  }
  // A job worker's tasks are taken by a reviewed script, never by a model.
  const workerJob = profile.kanban_worker === false ? undefined : profile.kanban_worker.job;
  if (
    workerJob !== undefined &&
    !jobs.some(
      (job: unknown) =>
        job !== null &&
        typeof job === "object" &&
        (job as Record<string, unknown>)["id"] === workerJob &&
        (job as Record<string, unknown>)["no_agent"] === true,
    )
  ) {
    fail(`${description} job ${workerJob} takes Kanban tasks and must be no_agent.`);
  }

  const cronSurface = new Set(platformToolsets.cron);
  const mcpServerNames = new Set(Object.keys(profile.mcp_servers));
  const names = new Set<string>();
  const referencedScripts = new Set<string>();
  for (const value of jobs as unknown[]) {
    assertPlainObject(value, description);
    const job = value;
    const jobDescription = `${description} job ${String(job["id"])}`;
    const keys = Object.keys(job);
    if (
      cronJobRequiredKeys.some((key) => !keys.includes(key)) ||
      keys.some((key) => !cronJobRequiredKeys.includes(key) && !cronJobOptionalKeys.includes(key))
    ) {
      fail(
        `${jobDescription} must contain ${cronJobRequiredKeys.join(", ")} and may contain ` +
          `${cronJobOptionalKeys.join(", ")}.`,
      );
    }
    const name = job["name"];
    if (typeof name !== "string" || name.trim() === "" || names.has(name.toLowerCase())) {
      fail(`${jobDescription} needs a non-empty name unique within the profile, ignoring case.`);
    }
    names.add(name.toLowerCase());
    if (!isFiveFieldCron(job["schedule"])) {
      fail(`${jobDescription} schedule must be a five-field cron expression with numeric fields.`);
    }
    for (const lane of ["deliver", "failure_deliver"]) {
      const target = job[lane];
      if (
        target !== localDelivery &&
        !(typeof target === "string" && profile.delivery_targets.includes(target))
      ) {
        fail(`${jobDescription} ${lane} must be ${localDelivery} or one of its delivery_targets.`);
      }
    }
    if ("no_agent" in job && typeof job["no_agent"] !== "boolean") {
      fail(`${jobDescription} no_agent must be a boolean.`);
    }
    if (job["no_agent"] === true) {
      // A script-only job runs no model (cron/scheduler.py:1483-1535); Hermes refuses a monitor on
      // one and needs its script (cron/jobs.py:1690-1708).
      if (!("script" in job)) {
        fail(`${jobDescription} sets no_agent and must name a script.`);
      }
      const extra = ["enabled_toolsets", "monitor_script", "prompt", "skills"].filter(
        (key) => key in job,
      );
      if (extra.length > 0) {
        fail(`${jobDescription} sets no_agent and must not set ${extra.join(", ")}.`);
      }
    } else {
      if (typeof job["prompt"] !== "string" || job["prompt"].trim() === "") {
        fail(`${jobDescription} runs the model and needs a non-empty prompt.`);
      }
      // An empty list means "use platform_toolsets.cron" (cron/scheduler.py:501-506), and a list
      // without no_mcp or a server name receives every enabled MCP server (:469-484).
      const toolsets = job["enabled_toolsets"];
      assertUniqueStrings(toolsets, `${jobDescription} enabled_toolsets`, toolsetNamePattern);
      if (toolsets.length === 0) {
        fail(`${jobDescription} enabled_toolsets must not be empty.`);
      }
      const outside = toolsets.filter(
        (toolset) =>
          cronDroppedToolsets.has(toolset) ||
          (toolset !== noMcpSentinel && !cronSurface.has(toolset)),
      );
      if (outside.length > 0) {
        fail(
          `${jobDescription} enabled_toolsets must be a subset of platform_toolsets.cron plus ` +
            `${noMcpSentinel}: ${outside.join(", ")}.`,
        );
      }
      const servers = toolsets.filter((toolset) => mcpServerNames.has(toolset));
      if (toolsets.includes(noMcpSentinel) === servers.length > 0) {
        fail(
          `${jobDescription} enabled_toolsets must name its MCP servers or ${noMcpSentinel}, ` +
            "not both.",
        );
      }
    }
    if ("skills" in job) {
      assertUniqueStrings(job["skills"], `${jobDescription} skills`);
      const unknown = job["skills"].filter((skill) => !selectedSkillNames.includes(skill));
      if (unknown.length > 0) {
        fail(`${jobDescription} uses skills the profile does not select: ${unknown.join(", ")}.`);
      }
    }
    // Hermes resolves scripts relative to the profile's scripts/ (cron/scheduler_script.py:257-300).
    for (const key of ["script", "monitor_script"]) {
      if (!(key in job)) {
        continue;
      }
      const script = job[key];
      if (
        typeof script !== "string" ||
        !cronScriptNamePattern.test(script) ||
        !existsSync(join(scriptsDirectory, script))
      ) {
        fail(`${jobDescription} ${key} must name a file in the profile's scripts/.`);
      }
      referencedScripts.add(script);
    }
  }

  if (!existsSync(scriptsDirectory)) {
    return;
  }
  if (!lstatSync(scriptsDirectory).isDirectory()) {
    fail(`Profile ${profile.name} scripts must be a directory.`);
  }
  for (const entry of readdirSync(scriptsDirectory)) {
    const path = join(scriptsDirectory, entry);
    const data = cronScriptDataPattern.exec(entry);
    if (data !== null) {
      if (!lstatSync(path).isFile() || !referencedScripts.has(`${data[1]}.py`)) {
        fail(
          `Profile ${profile.name} scripts/${entry} must be the data file of a .py script a job ` +
            "runs.",
        );
      }
      try {
        JSON.parse(readFileSync(path, "utf8"));
      } catch {
        fail(`Profile ${profile.name} scripts/${entry} is not valid JSON.`);
      }
      continue;
    }
    if (!cronScriptNamePattern.test(entry) || !lstatSync(path).isFile()) {
      fail(`Profile ${profile.name} scripts/${entry} must be a .py or .sh file with a plain name.`);
    }
    if (!referencedScripts.has(entry)) {
      fail(`Profile ${profile.name} scripts/${entry} is not used by any job.`);
    }
    const takesTasks = jobs.some(
      (job: unknown) =>
        job !== null &&
        typeof job === "object" &&
        (job as Record<string, unknown>)["id"] === workerJob &&
        (job as Record<string, unknown>)["script"] === entry,
    );
    const problem = entry.endsWith(".py")
      ? scriptImportProblem(path, takesTasks ? jobWorkerScriptModules : cronScriptModules)
      : undefined;
    if (problem !== undefined) {
      fail(`Profile ${profile.name} scripts/${entry} ${problem}.`);
    }
  }
}

// The toolsets a profile selects that can read its .env (and every other profile's: all run as hermes).
function selectedEnvironmentReaders(platformToolsets: PlatformToolsets): string[] {
  const selected = new Set(Object.values(platformToolsets).flat());
  return environmentReadingToolsets.filter((toolset) => selected.has(toolset));
}

// terminal.env_passthrough forwards declared credentials from the profile's own .env into
// its cron scripts (cron/scheduler_script.py:371; tools/env_passthrough.py:147-167,
// tools/environments/local.py:288-300). The same list reaches terminal and execute_code children,
// so it is allowed only where the model can start neither, and never next to Slack ingress.
function validateEnvPassthrough(
  profile: DefaultProfile | FleetProfile,
  value: unknown,
  platformToolsets: PlatformToolsets,
): void {
  const description = `Profile ${profile.name} terminal.env_passthrough`;
  assertUniqueStrings(value, description, envPassthroughNamePattern);
  if (value.length === 0) {
    fail(`${description} must not be empty; omit it instead.`);
  }
  if (profile.gateway === "slack") {
    fail(`${description}: a profile with Slack ingress passes no credentials to scripts.`);
  }
  const reading = selectedEnvironmentReaders(platformToolsets);
  if (reading.length > 0) {
    fail(
      `${description}: the profile selects ${reading.join(", ")}, which would receive the same ` +
        "credentials.",
    );
  }
  for (const name of value) {
    // Hermes drops a provider, tool, or messaging key from the list with only a warning
    // (tools/env_passthrough.py:74-83, :86-115).
    if (Object.values(gatewayRuntimeEnv).flat().includes(name)) {
      fail(
        `${description}: Hermes refuses to forward ${name} to scripts; store the same token under ` +
          "a script credential with copy_of in the fleet policy and pass that.",
      );
    }
    // A model-free profile also passes the broker's tokens to its scripts.
    const brokeredForScript =
      policy.modelFreeProfiles.has(profile.name) && profile.brokered_env.includes(name);
    if (!profile.runtime_env.includes(name) && !brokeredForScript) {
      fail(`${description} passes ${name}, which runtime_env does not declare.`);
    }
    // A script credential and a model-tool credential stay apart: a key an MCP server sends is
    // never also handed to a script, and the reverse.
    const reference = `\${${name}}`;
    const server = Object.entries(profile.mcp_servers).find(([, value]) =>
      Object.values(((value as Record<string, unknown>)["headers"] ?? {}) as object).some(
        (headerValue) => typeof headerValue === "string" && headerValue.includes(reference),
      ),
    );
    if (server !== undefined) {
      fail(`${description} passes ${name}, which MCP server ${server[0]} sends as a header.`);
    }
  }
  // Scripts read private data with these credentials; their output must not reach a model that can
  // send it anywhere (principle 6).
  const egress = platformToolsets.cron.filter((toolset) => egressToolsets.has(toolset));
  if (egress.length > 0) {
    fail(
      `${description}: the cron surface selects ${egress.join(", ")}; a profile whose scripts ` +
        "hold credentials must not have an egress toolset on cron.",
    );
  }
}

// A profile that runs no model (policy.model_free_profiles): its only work is reviewed no_agent
// scripts, so it has no MCP servers, plugins, skills, or Kanban worker, every surface selects only
// no_mcp, and it passes its brokered credentials to its scripts.
function validateModelFreeProfile(
  profile: DefaultProfile | FleetProfile,
  directory: string,
  platformToolsets: PlatformToolsets,
  terminal: Record<string, unknown>,
): void {
  if (!policy.modelFreeProfiles.has(profile.name)) {
    return;
  }
  const description = `Model-free profile ${profile.name}`;
  if (profile.gateway !== false && profile.gateway !== slackOutboundGateway) {
    fail(`${description} must not have Slack ingress (gateway false or ${slackOutboundGateway}).`);
  }
  const selecting = profilePlatforms.filter(
    (platform) => JSON.stringify(platformToolsets[platform]) !== JSON.stringify([noMcpSentinel]),
  );
  if (selecting.length > 0) {
    fail(
      `${description} runs no model, so every surface selects only ${noMcpSentinel}; ` +
        `${selecting.join(", ")} selects more.`,
    );
  }
  if (
    Object.keys(profile.mcp_servers).length > 0 ||
    Object.keys(profile.plugins).length > 0 ||
    profile.kanban_worker !== false ||
    profile.dodo_skills.length + profile.raven_skills.length + profile.hermes_skills.length > 0
  ) {
    fail(`${description} has no MCP servers, plugins, skills, or Kanban worker.`);
  }
  const passthrough = Array.isArray(terminal["env_passthrough"])
    ? (terminal["env_passthrough"] as string[])
    : [];
  const unpassed = profile.brokered_env.filter((name) => !passthrough.includes(name));
  if (unpassed.length > 0) {
    fail(
      `${description} declares ${unpassed.join(", ")} in brokered_env and must pass it to its ` +
        "scripts in terminal.env_passthrough.",
    );
  }
  if (profile.cron.length === 0) {
    fail(`${description} ships at least one no_agent job.`);
  }
  const store = JSON.parse(readFileSync(join(directory, "cron", "jobs.json"), "utf8")) as {
    jobs: Record<string, unknown>[];
  };
  const modelJobs = store.jobs.filter((job) => job["no_agent"] !== true).map((job) => job["id"]);
  if (modelJobs.length > 0) {
    fail(`${description} ships only no_agent jobs; ${modelJobs.join(", ")} would run the model.`);
  }
}

// Who may run terminal, file, and code_execution. They always run on the host as hermes, so only in
// a profile nobody but the owner can message: never with gateway: slack, on any surface, except the
// owner console. A Kanban worker and a profile without Slack ingress that runs on
// a schedule also qualify; the residual risk is stated once in
// infra/docs/deploy-profiles.md#code-execution.
function validateExecutionReach(
  profile: DefaultProfile | FleetProfile,
  platformToolsets: PlatformToolsets,
  config: Record<string, unknown>,
  ownerSlackId: string,
): void {
  const surfaces = profilePlatforms.filter((platform) =>
    platformToolsets[platform].some((toolset) => executionToolsets.has(toolset)),
  );
  if (
    surfaces.length > 0 &&
    profile.gateway === "slack" &&
    !isOwnerOnlySlackProfile(profile, config, ownerSlackId)
  ) {
    fail(
      `Slack gateway profile ${profile.name} must not select terminal, file, or code_execution on ` +
        `any surface (${surfaces.join(", ")}).`,
    );
  }
}

// Dodo's own stdio servers: only reviewed ones, each shared/mcp-servers/<name>/server.py and nothing
// else, standard library only, without symlinks or credential-shaped content.
function validateDodoMcpServers(): number {
  const entries = existsSync(sharedMcpServersRoot) ? readdirSync(sharedMcpServersRoot).sort() : [];
  const reviewed = policy.stdioServers
    .filter((server) => server.command === undefined)
    .map((server) => server.name);
  const unreviewed = entries.filter((name) => !reviewed.includes(name));
  if (unreviewed.length > 0) {
    fail(
      `shared/mcp-servers/ may contain only the Dodo servers the fleet policy lists ` +
        `(${reviewed.join(", ")}), not ${unreviewed.join(", ")}.`,
    );
  }
  for (const name of entries) {
    const directory = join(sharedMcpServersRoot, name);
    if (
      !lstatSync(directory).isDirectory() ||
      JSON.stringify(readdirSync(directory)) !== JSON.stringify(["server.py"]) ||
      !lstatSync(join(directory, "server.py")).isFile()
    ) {
      fail(`shared/mcp-servers/${name} must contain exactly server.py.`);
    }
    const problem = scriptImportProblem(
      join(directory, "server.py"),
      dodoMcpServerModules,
      dodoMcpServerProcessNames,
    );
    if (problem !== undefined) {
      fail(`shared/mcp-servers/${name}/server.py ${problem}.`);
    }
  }
  if (entries.length > 0) {
    validateNoSecretsOrRuntimeData(sharedMcpServersRoot);
  }
  return entries.length;
}

interface FleetWorker extends KanbanWorker {
  readonly name: string;
}

// A Kanban worker is a profile nothing reaches but a task the hand-off plugin creates. Returns the
// declared workers, sorted by name. A job worker declares `job`: one of its own no_agent cron
// jobs takes its tasks with a reviewed script, so the dispatcher never runs a model for it.
function validateKanbanWorkers(
  profiles: readonly (DefaultProfile | FleetProfile)[],
): FleetWorker[] {
  const workers: FleetWorker[] = [];
  for (const profile of profiles) {
    const value: unknown = profile.kanban_worker;
    if (value === false) {
      continue;
    }
    const description = `Profile ${profile.name} kanban_worker`;
    if (profile.desired_state === "present") {
      fail("The default profile cannot be a Kanban worker.");
    }
    assertPlainObject(value, `${description} (false or a mapping)`);
    const keys = ["handoff_tool", "max_retries", "max_runtime_seconds"];
    assertExactKeys(value, "job" in value ? [...keys, "job"] : keys, description);
    const job = value["job"];
    if (job !== undefined && (typeof job !== "string" || !profile.cron.includes(job))) {
      fail(`${description}.job must name one of the profile's own cron jobs.`);
    }
    const tool = value["handoff_tool"];
    if (
      typeof tool !== "string" ||
      !handoffToolPattern.test(tool) ||
      policy.handoff.tools.includes(tool)
    ) {
      fail(
        `${description}.handoff_tool must match handoff_<name> and not be ` +
          `${policy.handoff.tools.join(" or ")}.`,
      );
    }
    const runtime = value["max_runtime_seconds"];
    if (
      typeof runtime !== "number" ||
      !Number.isInteger(runtime) ||
      runtime < workerRuntimeSeconds[0] ||
      runtime > workerRuntimeSeconds[1]
    ) {
      fail(
        `${description}.max_runtime_seconds must be an integer from ${workerRuntimeSeconds[0]} to ` +
          `${workerRuntimeSeconds[1]}.`,
      );
    }
    const retries = value["max_retries"];
    if (
      typeof retries !== "number" ||
      !Number.isInteger(retries) ||
      retries < 0 ||
      retries > workerMaxRetries
    ) {
      fail(`${description}.max_retries must be an integer from 0 to ${workerMaxRetries}.`);
    }
    if (workers.some((worker) => worker.handoff_tool === tool)) {
      fail(`${description}.handoff_tool ${tool} is declared by another worker.`);
    }
    workers.push({
      handoff_tool: tool,
      max_retries: retries,
      max_runtime_seconds: runtime,
      name: profile.name,
      ...(typeof job === "string" ? { job } : {}),
    });
  }
  return workers.sort((left, right) => (left.name < right.name ? -1 : 1));
}

// The workers the dispatcher runs a model for: every Kanban worker but a job worker.
function modelWorkers(workers: readonly FleetWorker[]): FleetWorker[] {
  return workers.filter((worker) => worker.job === undefined);
}

function isModelWorker(profile: DefaultProfile | FleetProfile): boolean {
  return profile.kanban_worker !== false && profile.kanban_worker.job === undefined;
}

// `plugins`: name -> {toolset, tools}, or {hooks} for a Kanban worker's hook plugin; the hand-off
// plugin adds its hooks to its tools.
// Returns the profile's plugin toolsets.
function validatePluginDeclarations(
  profile: DefaultProfile | FleetProfile,
  mcpServerNames: ReadonlySet<string>,
): Set<string> {
  const plugins: unknown = profile.plugins;
  assertPlainObject(plugins, `plugins for ${profile.name}`);
  const toolsets = new Set<string>();
  for (const [name, value] of Object.entries(plugins)) {
    const description = `Profile ${profile.name} plugin ${name}`;
    if (!pluginNamePattern.test(name)) {
      fail(`Profile ${profile.name} has an invalid plugin name: ${name}.`);
    }
    assertPlainObject(value, description);
    if ("hooks" in value && !("toolset" in value)) {
      assertExactKeys(value, ["hooks"], description);
      assertUniqueStrings(value["hooks"], `${description} hooks`);
      if (value["hooks"].length === 0 || value["hooks"].some((hook) => !pluginHooks.has(hook))) {
        fail(`${description} hooks must be a non-empty subset of: ${[...pluginHooks].join(", ")}.`);
      }
      if (!isModelWorker(profile)) {
        fail(
          `${description}: only a Kanban worker the dispatcher runs ships a hook plugin, its guard.`,
        );
      }
      continue;
    }
    if ("hooks" in value) {
      assertExactKeys(value, ["hooks", "toolset", "tools"], description);
      if (
        name !== policy.handoff.plugin ||
        JSON.stringify(value["hooks"]) !== JSON.stringify(policy.handoff.hooks)
      ) {
        fail(
          `${description}: only ${policy.handoff.plugin} declares hooks next to its tools, exactly ` +
            `the policy's [${policy.handoff.hooks.join(", ")}].`,
        );
      }
    } else {
      assertExactKeys(value, ["toolset", "tools"], description);
    }
    const toolset = value["toolset"];
    if (
      typeof toolset !== "string" ||
      !pluginIdentifierPattern.test(toolset) ||
      reservedMcpServerNames.has(toolset) ||
      toolset.startsWith(reservedMcpServerPrefix) ||
      mcpServerNames.has(toolset) ||
      toolsets.has(toolset)
    ) {
      fail(
        `${description} toolset must be a new name, not a Hermes toolset, platform, sentinel, ` +
          "MCP server, or another plugin's toolset.",
      );
    }
    assertUniqueStrings(value["tools"], `${description} tools`, pluginIdentifierPattern);
    if (value["tools"].length === 0) {
      fail(`${description} must list its tools.`);
    }
    toolsets.add(toolset);
  }
  if (profile.desired_state === "present" && toolsets.size > 0) {
    fail("The default profile ships no plugins.");
  }
  return toolsets;
}

// The files under profiles/<name>/plugins/, the toolsets' surfaces, and the hand-off contract.
function validatePlugins(
  profile: DefaultProfile | FleetProfile,
  directory: string,
  platformToolsets: PlatformToolsets,
  workers: readonly FleetWorker[],
): void {
  const plugins = profile.plugins;
  const pluginsDirectory = join(directory, "plugins");
  const names = Object.keys(plugins).sort();
  if (names.length === 0) {
    if (existsSync(pluginsDirectory)) {
      fail(`Profile ${profile.name} declares no plugins and must not contain plugins/.`);
    }
    if (profile.name === policy.handoff.profile && workers.length > 0) {
      fail(
        `Kanban workers are declared, so ${policy.handoff.profile} must declare ` +
          `${policy.handoff.plugin}.`,
      );
    }
    return;
  }
  if (!lstatSync(pluginsDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Profile ${profile.name} declares plugins and needs a plugins/ directory.`);
  }
  const entries = readdirSync(pluginsDirectory).sort();
  if (JSON.stringify(entries) !== JSON.stringify(names)) {
    fail(
      `Profile ${profile.name} plugins/ must contain exactly its declared plugins: ${names.join(", ")}.`,
    );
  }
  for (const name of names) {
    const declaration = plugins[name] as PluginDeclaration;
    const description = `Profile ${profile.name} plugin ${name}`;
    const isHookPlugin = declaration.hooks !== undefined && declaration.toolset === undefined;
    const pluginDirectory = join(pluginsDirectory, name);
    if (!lstatSync(pluginDirectory).isDirectory()) {
      fail(`${description} must be a directory.`);
    }
    const expectedFiles =
      name === policy.handoff.plugin ? [...pluginFiles, handoffWorkersFile] : pluginFiles;
    const files = readdirSync(pluginDirectory).sort();
    if (
      JSON.stringify(files) !== JSON.stringify([...expectedFiles].sort()) ||
      files.some((file) => !lstatSync(join(pluginDirectory, file)).isFile())
    ) {
      fail(`${description} must contain exactly the files ${expectedFiles.join(", ")}.`);
    }
    const manifest = readYaml(join(pluginDirectory, "plugin.yaml"));
    assertPlainObject(manifest, `${description} plugin.yaml`);
    assertExactKeys(
      manifest,
      isHookPlugin
        ? hookPluginManifestKeys
        : declaration.hooks === undefined
          ? pluginManifestKeys
          : [...pluginManifestKeys, "provides_hooks"],
      `${description} plugin.yaml`,
    );
    // A declared kind keeps Hermes from guessing one from the source
    // (hermes_cli/plugins_manifest.py:469-488), and a flat plugin's key is its manifest name
    // (:504-505), which plugins.enabled lists.
    if (manifest["name"] !== name || manifest["kind"] !== "standalone") {
      fail(`${description} plugin.yaml must set name: ${name} and kind: standalone.`);
    }
    if (typeof manifest["version"] !== "string" || !semverPattern.test(manifest["version"])) {
      fail(`${description} plugin.yaml must have a semantic version.`);
    }
    if (typeof manifest["description"] !== "string" || manifest["description"].trim() === "") {
      fail(`${description} plugin.yaml needs a description.`);
    }
    if (declaration.hooks !== undefined) {
      // Hermes reads provides_hooks for the plugin listing (hermes_cli/plugins_manifest.py:516).
      assertUniqueStrings(manifest["provides_hooks"], `${description} provides_hooks`);
      if (
        JSON.stringify([...manifest["provides_hooks"]].sort()) !==
        JSON.stringify([...declaration.hooks].sort())
      ) {
        fail(`${description} plugin.yaml provides_hooks must equal its fleet hooks.`);
      }
    }
    if (isHookPlugin) {
      continue;
    }
    assertUniqueStrings(manifest["provides_tools"], `${description} provides_tools`);
    if (
      JSON.stringify([...manifest["provides_tools"]].sort()) !==
      JSON.stringify([...(declaration.tools ?? [])].sort())
    ) {
      fail(`${description} plugin.yaml provides_tools must equal its fleet tools.`);
    }
    const toolset = declaration.toolset ?? "";
    const surfaces = profilePlatforms.filter((platform) =>
      platformToolsets[platform].includes(toolset),
    );
    if (surfaces.length === 0) {
      fail(`${description} toolset ${declaration.toolset} is selected on no surface.`);
    }
    if (name === policy.handoff.plugin) {
      validateHandoffPlugin(profile, declaration, surfaces, pluginDirectory, workers);
    }
  }
}

// JSON with every object's keys sorted, so two values compare by content as the reconciler's
// same_value does.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1)))
      : item,
  );
}

function validateHandoffPlugin(
  profile: DefaultProfile | FleetProfile,
  declaration: PluginDeclaration,
  surfaces: readonly Platform[],
  pluginDirectory: string,
  workers: readonly FleetWorker[],
): void {
  const { plugin, profile: handoffProfile, tools } = policy.handoff;
  const description = `Profile ${profile.name} plugin ${plugin}`;
  if (profile.name !== handoffProfile || profile.gateway !== "slack") {
    fail(`${plugin} ships only in ${handoffProfile}, a gateway: slack profile.`);
  }
  if (surfaces.length !== 1 || surfaces[0] !== "slack") {
    fail(`${description} toolset is selected on the slack surface only.`);
  }
  const expectedTools = [...tools, ...workers.map((worker) => worker.handoff_tool).sort()];
  if (JSON.stringify(declaration.tools) !== JSON.stringify(expectedTools)) {
    fail(
      `${description} tools must be exactly ${expectedTools.join(", ")}: the policy's hand-off ` +
        "tools, then each Kanban worker's handoff_tool.",
    );
  }
  const expectedWorkers = Object.fromEntries(
    workers.map((worker) => [
      worker.handoff_tool,
      {
        assignee: worker.name,
        max_retries: worker.max_retries,
        max_runtime_seconds: worker.max_runtime_seconds,
      },
    ]),
  );
  const actual: unknown = JSON.parse(
    readFileSync(join(pluginDirectory, handoffWorkersFile), "utf8"),
  );
  assertPlainObject(actual, `${description} ${handoffWorkersFile}`);
  if (canonicalJson(actual) !== canonicalJson(expectedWorkers)) {
    fail(
      `${description} ${handoffWorkersFile} must map each worker's handoff_tool to its name, ` +
        "max_runtime_seconds, and max_retries from the fleet.",
    );
  }
  // A worker's report can carry the private data its credentials read; it reaches the surface
  // through handoff_result (principle 6).
  if (workers.length > 0) {
    const egress = profile.platform_toolsets.slack.filter((toolset) => egressToolsets.has(toolset));
    if (egress.length > 0) {
      fail(
        `${description}: the slack surface reads worker results next to ${egress.join(", ")}; ` +
          "drop the egress toolsets once a Kanban worker exists.",
      );
    }
  }
}

// What a Kanban worker may be: reachable only through a task, without web, a schedule, or memory
// across tasks, with its guard as its only plugin, and with explicit approvals for its `chat -q`
// runs. Its credentials and code are bounded by the runtime-credential and GitHub-read rules.
function validateKanbanWorkerProfile(
  profile: DefaultProfile | FleetProfile,
  platformToolsets: PlatformToolsets,
  config: Record<string, unknown>,
): void {
  const description = `Kanban worker ${profile.name}`;
  if (profile.gateway !== false || profile.cron.length > 0) {
    fail(`${description} must declare gateway: false and ship no cron jobs.`);
  }
  for (const platform of ["slack", "cron"] as const) {
    if (platformToolsets[platform].some((toolset) => toolset !== noMcpSentinel)) {
      fail(`${description} must select nothing but ${noMcpSentinel} on its ${platform} surface.`);
    }
  }
  const selected = new Set(Object.values(platformToolsets).flat());
  const refused = ["web", ...personalToolsets].filter((toolset) => selected.has(toolset));
  if (refused.length > 0) {
    fail(`${description} must not select ${refused.join(", ")} on any surface.`);
  }
  const unexpected = [...selected].filter(
    (toolset) =>
      !workerToolsets.has(toolset) &&
      !Object.hasOwn(profile.mcp_servers, toolset) &&
      toolset !== noMcpSentinel,
  );
  if (unexpected.length > 0) {
    fail(
      `${description} selects ${unexpected.sort().join(", ")}; a worker selects only ` +
        `${[...workerToolsets].sort().join(", ")}, and its own MCP servers.`,
    );
  }
  // Hermes gives a worker its Kanban tools whatever the config, and only lifecycle changes are
  // bound to its own task (tools/kanban_tools.py:83-102, :225-239, :1183-1204).
  if (
    canonicalJson(profile.plugins) !==
    canonicalJson({ [policy.workerGuard]: workerGuardDeclaration })
  ) {
    fail(
      `${description} must ship exactly the ${policy.workerGuard} plugin, ` +
        `declared as {hooks: [pre_tool_call]}, and no other plugin.`,
    );
  }
  if (JSON.stringify(config["approvals"]) !== JSON.stringify(workerApprovals)) {
    fail(`${description} must set approvals: {mode: manual, single_query_mode: deny}.`);
  }
  const agent = config["agent"];
  assertPlainObject(agent, `agent config for ${profile.name}`);
  if (!("run_budget_seconds" in agent)) {
    fail(`${description} must set agent.run_budget_seconds.`);
  }
}

// The default profile's kanban block, read by the dispatcher in the launch profile's gateway.
function validateKanbanConfig(value: unknown, workers: readonly FleetWorker[]): void {
  assertPlainObject(value, "kanban config in the default profile");
  assertExactKeys(value, kanbanConfigKeys, "kanban config in the default profile");
  // A job worker stays out: the dispatcher would run a model as that profile.
  const expected = modelWorkers(workers).map((worker) => worker.name);
  if (JSON.stringify(value["dispatch_profiles"]) !== JSON.stringify(expected)) {
    fail(
      "kanban.dispatch_profiles must list exactly the Kanban workers the dispatcher runs, not job " +
        `workers, sorted: [${expected.join(", ")}].`,
    );
  }
  if (value["auto_decompose"] !== false || value["review_dispatch"] !== false) {
    fail("kanban.auto_decompose and kanban.review_dispatch must be false.");
  }
  if (value["max_in_progress_per_profile"] !== 1) {
    fail("kanban.max_in_progress_per_profile must be 1: one task per worker at a time.");
  }
}

// Every Kanban worker ships the same guard, so one reviewed file decides what any worker's
// completion may carry (its DELIVERABLES table).
function validateWorkerGuards(workers: readonly FleetWorker[]): void {
  const [first, ...others] = modelWorkers(workers);
  if (first === undefined) {
    return;
  }
  const guard = (name: string) =>
    workerGuardFiles.map((file) =>
      readFileSync(join(profilesRoot, name, "plugins", policy.workerGuard, file), "utf8"),
    );
  const reference = guard(first.name);
  for (const worker of others) {
    if (JSON.stringify(guard(worker.name)) !== JSON.stringify(reference)) {
      fail(
        `Kanban worker ${worker.name} must ship the same ${policy.workerGuard} files as ` +
          `${first.name}: one guard for every worker.`,
      );
    }
  }
}

function validateProfile(
  profile: DefaultProfile | FleetProfile,
  sharedSkillNames: Set<string>,
  ownerSlackId: string,
  workers: readonly FleetWorker[],
): void {
  if (!skillNamePattern.test(profile.name)) {
    fail(`Invalid profile name: ${profile.name}`);
  }
  if (profile.desired_state === "present") {
    if (profile.name !== "default" || profile.gateway !== false || profile.cron.length !== 0) {
      fail("The default profile must remain present without gateway or cron activation.");
    }
  } else if (
    profile.alias !== true ||
    (profile.gateway !== false &&
      profile.gateway !== "slack" &&
      profile.gateway !== slackOutboundGateway)
  ) {
    fail(
      `Profile ${profile.name} must be installed with an alias and gateway false, slack, or ` +
        `${slackOutboundGateway}.`,
    );
  }
  const expectedSource = `profiles/${profile.name}`;
  if (profile.source !== expectedSource) {
    fail(`Profile ${profile.name} source must be ${expectedSource}.`);
  }
  if (!profilePlatforms.includes("cli")) {
    fail("Internal platform contract is invalid.");
  }
  validateRuntimeEnv(profile);
  assertUniqueStrings(profile.brokered_env, `${profile.name}.brokered_env`);
  validateCronDeclaration(profile);
  const hasJobs = profile.cron.length > 0;
  const isWorker = isModelWorker(profile);
  const mcpServers = validateMcpServers(
    profile.mcp_servers,
    profile.name,
    profile.runtime_env,
    profile.brokered_env,
    isWorker,
  );
  const mcpServerNames = new Set(Object.keys(mcpServers));
  const pluginToolsets = validatePluginDeclarations(profile, mcpServerNames);
  const platformToolsets = validatePlatformToolsets(
    profile.platform_toolsets,
    profile.name,
    mcpServerNames,
    pluginToolsets,
  );
  validateBrokeredEnv(profile);
  // An agent that can schedule jobs could create work no review has seen.
  if (Object.values(platformToolsets).some((toolsets) => toolsets.includes("cronjob"))) {
    fail(`Profile ${profile.name} must not select cronjob on any surface.`);
  }
  assertUniqueStrings(profile.dodo_skills, `${profile.name}.dodo_skills`, skillNamePattern);
  assertUniqueStrings(profile.raven_skills, `${profile.name}.raven_skills`, ravenSkillPathPattern);
  assertUniqueStrings(
    profile.hermes_skills,
    `${profile.name}.hermes_skills`,
    hermesSkillPathPattern,
  );
  for (const skill of profile.dodo_skills) {
    if (!sharedSkillNames.has(skill)) {
      fail(`Profile ${profile.name} selects unknown Dodo skill ${skill}.`);
    }
  }
  const selectedSkillNames = [
    ...profile.dodo_skills,
    ...profile.raven_skills.map((path) => basename(path)),
    ...profile.hermes_skills.map((path) => basename(path)),
  ];
  if (new Set(selectedSkillNames).size !== selectedSkillNames.length) {
    fail(`Profile ${profile.name} selects the same skill name from more than one source.`);
  }
  if (!(["auto", "profile", "real"] as const).includes(profile.terminal_home_mode)) {
    fail(`Profile ${profile.name} has an invalid terminal_home_mode.`);
  }

  const directory = resolve(repositoryRoot, profile.source);
  if (relative(profilesRoot, directory).startsWith("..")) {
    fail(`Profile ${profile.name} escapes the profiles directory.`);
  }
  const requiredFiles = [".gitignore", "SOUL.md", "config.yaml", "README.md"];
  if (profile.desired_state === "installed") {
    requiredFiles.push("distribution.yaml");
  }
  for (const required of requiredFiles) {
    if (!lstatSync(join(directory, required)).isFile()) {
      fail(`Profile ${profile.name} is missing ${required}.`);
    }
  }

  if (profile.desired_state === "installed") {
    const distribution = readYaml(join(directory, "distribution.yaml"));
    assertPlainObject(distribution, `Distribution ${profile.name}`);
    const { distribution_owned: distributionOwned, name, version } = distribution;
    if (name !== profile.name) {
      fail(`Distribution name does not match directory for ${profile.name}.`);
    }
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      fail(`Distribution ${profile.name} must have a semantic version.`);
    }
    const expectedDistributionOwned = ["SOUL.md", "config.yaml", "README.md"];
    // Hermes merges exactly cron/jobs.json by job id; every other cron/ path is runtime state
    // (hermes_cli/profile_distribution.py:58-71, :396-431).
    if (hasJobs) {
      expectedDistributionOwned.push("cron/jobs.json");
      if (existsSync(join(directory, "scripts"))) {
        expectedDistributionOwned.push("scripts");
      }
    }
    // An owned directory is merged per plugin, and a plugin directory with files is replaced whole
    // (hermes_cli/profile_distribution.py:483-497, :536-543).
    if (Object.keys(profile.plugins).length > 0) {
      expectedDistributionOwned.push("plugins");
    }
    if (
      !Array.isArray(distributionOwned) ||
      distributionOwned.length !== expectedDistributionOwned.length ||
      expectedDistributionOwned.some((path, index) => distributionOwned[index] !== path)
    ) {
      fail(
        `Distribution ${profile.name} must own exactly: ${expectedDistributionOwned.join(", ")}.`,
      );
    }
    if ("env_requires" in distribution) {
      fail(`Distribution ${profile.name} must not require credentials.`);
    }
  }

  const config = readYaml(join(directory, "config.yaml"));
  assertPlainObject(config, `Config ${profile.name}`);
  const isDefault = profile.desired_state === "present";
  const isSlackGateway = profile.gateway === "slack";
  const isSlackOutbound = profile.gateway === slackOutboundGateway;
  // Inbound policy means nothing to a profile that never opens Socket Mode, and a stale allowlist
  // there would only mislead. Its slack block only switches link previews off for what its jobs
  // deliver: Hermes promotes a root slack block's keys into the platform's extra
  // (gateway/config_loader.py:226-233, :266-290), and the standalone sender passes unfurl_links and
  // unfurl_media from there to chat.postMessage (plugins/platforms/slack/adapter.py:89-100, :6581).
  // Slack unfurls by default, so a profile with Slack delivery targets must switch both off.
  if (isSlackOutbound) {
    const slack = config["slack"];
    const valid =
      profile.delivery_targets.length > 0
        ? slack !== null &&
          typeof slack === "object" &&
          !Array.isArray(slack) &&
          Object.keys(slack).length === Object.keys(outboundSlackBlock).length &&
          Object.entries(outboundSlackBlock).every(
            ([key, value]) => (slack as Record<string, unknown>)[key] === value,
          )
        : !("slack" in config);
    if (!valid) {
      fail(
        profile.delivery_targets.length > 0
          ? `Profile ${profile.name} delivers to Slack and its slack block must be exactly ` +
              "{unfurl_links: false, unfurl_media: false}."
          : `Profile ${profile.name} declares gateway: ${slackOutboundGateway} without delivery ` +
              "targets and must not have a slack block; it receives no Slack events.",
      );
    }
  }
  const configKeys = [
    "agent",
    "mcp_servers",
    "platform_toolsets",
    "security",
    "skills",
    "terminal",
  ];
  if (isDefault) {
    configKeys.push("max_concurrent_sessions", "slack");
  } else if (isSlackGateway) {
    configKeys.push("approvals", "memory", "slack");
  } else if (hasJobs || isWorker) {
    configKeys.push("approvals");
  }
  if (isSlackOutbound && profile.delivery_targets.length > 0) {
    configKeys.push("slack");
  }
  // Schema 5 owns plugins.enabled everywhere: an absent key makes Hermes grandfather every installed
  // user plugin (hermes_cli/plugins_discovery.py:97-106, hermes_cli/config_migrations.py:310-329).
  // The default profile owns the dispatcher's kanban block, and the profile that receives hand-off
  // results owns its media policy.
  const declaresHandoff = Object.hasOwn(profile.plugins, policy.handoff.plugin);
  {
    configKeys.push("plugins");
    if (isDefault) {
      configKeys.push("kanban");
    }
    if (isSlackGateway && (declaresHandoff || "gateway" in config)) {
      configKeys.push("gateway");
    }
  }
  // Schema 5 pins the timezone of the default profile, whose value the gateway bridges into
  // HERMES_TIMEZONE for every profile when it runs unmultiplexed (gateway/run.py:2087-2089), and of
  // every profile that ships jobs. Another profile may set it, to the same zone only.
  if (isDefault || hasJobs || "timezone" in config) {
    configKeys.push("timezone");
  }
  // A profile that ships jobs may switch off the header and footer Hermes wraps around every cron
  // delivery (cron/scheduler_delivery.py:1944-1963), read from the job's own profile config, so its
  // targets get only the job's output. The block is exactly that switch.
  if (hasJobs && "cron" in config) {
    configKeys.push("cron");
    const cron = config["cron"];
    if (
      cron === null ||
      typeof cron !== "object" ||
      Array.isArray(cron) ||
      Object.keys(cron).length !== 1 ||
      (cron as Record<string, unknown>)["wrap_response"] !== false
    ) {
      fail(`Profile ${profile.name} cron block must be exactly {wrap_response: false}.`);
    }
  }
  const delegates = profilePlatforms.some((platform) =>
    platformToolsets[platform].includes("delegation"),
  );
  if (delegates) {
    configKeys.push("delegation");
  }
  assertExactKeys(config, configKeys, `Config ${profile.name}`);
  if (delegates) {
    validateDelegation(config["delegation"], profile.name);
  }
  if ("timezone" in config && config["timezone"] !== policy.timezone) {
    fail(`Profile ${profile.name} timezone must be ${policy.timezone}.`);
  }
  const configToolsets = validatePlatformToolsets(
    config["platform_toolsets"],
    profile.name,
    mcpServerNames,
    pluginToolsets,
  );
  if (JSON.stringify(configToolsets) !== JSON.stringify(platformToolsets)) {
    fail(`Profile ${profile.name} config toolsets do not match its fleet declaration.`);
  }
  if (isDefault) {
    validateHostGatewayPolicy(config);
  }
  let personalGateway = false;
  if (isSlackGateway) {
    personalGateway = validateSlackGatewayConfig(
      config,
      platformToolsets,
      profile.name,
      profile.plugins[policy.handoff.plugin]?.hooks?.includes(gatewayDispatchHook) === true,
      isOwnerOnlySlackProfile(profile, config, ownerSlackId),
    );
  } else if (platformToolsets.slack.some((toolset) => toolset !== noMcpSentinel)) {
    fail(`Profile ${profile.name} selects slack toolsets without declaring gateway: slack.`);
  }
  if (isSlackOutbound) {
    const reading = selectedEnvironmentReaders(platformToolsets);
    if (reading.length > 0) {
      fail(
        `Profile ${profile.name} declares gateway: ${slackOutboundGateway} and must not select ` +
          `${reading.join(", ")} on any surface; it holds the Slack bot token in .env.`,
      );
    }
  }
  if (
    isSlackGateway &&
    profile.dodo_skills.some((skill) => policy.repositoryWriteSkills.has(skill)) &&
    !isOwnerOnlySlackProfile(profile, config, ownerSlackId)
  ) {
    fail(`Slack gateway profile ${profile.name} must not select a repository write skill.`);
  }
  if (JSON.stringify(config["mcp_servers"]) !== JSON.stringify(mcpServers)) {
    fail(`Profile ${profile.name} config MCP servers do not match its fleet declaration.`);
  }
  {
    validateMcpSurfaces(profile, platformToolsets, config, ownerSlackId);
    validateReviewedMcpServers(profile, config, ownerSlackId);
    validateCredentials(profile, config);
    validatePersonalDataProfile(profile, platformToolsets);
    const pluginsConfig = config["plugins"];
    assertPlainObject(pluginsConfig, `plugins config for ${profile.name}`);
    assertExactKeys(pluginsConfig, ["enabled"], `plugins config for ${profile.name}`);
    const enabled = Object.keys(profile.plugins).sort();
    if (JSON.stringify(pluginsConfig["enabled"]) !== JSON.stringify(enabled)) {
      fail(
        `Profile ${profile.name} plugins.enabled must list exactly its plugins: [${enabled.join(", ")}].`,
      );
    }
    if (
      "gateway" in config &&
      JSON.stringify(config["gateway"]) !== JSON.stringify(strictMediaGateway)
    ) {
      fail(`Profile ${profile.name} must set gateway: {strict: true, trust_recent_files: false}.`);
    }
    if (isDefault) {
      validateKanbanConfig(config["kanban"], workers);
    }
    if (isWorker) {
      validateKanbanWorkerProfile(profile, platformToolsets, config);
    }
  }

  const agent = config["agent"];
  assertPlainObject(agent, `agent config for ${profile.name}`);
  // Schema 5 caps the turns of every profile, because each one runs the model somewhere. Without
  // agent.max_turns the CLI (and so every Kanban worker), the launch profile's gateway turns, and
  // cron run unlimited, and the dashboard allows 500 (hermes_cli/cli_init_mixin.py:194-205,
  // gateway/run.py:1644-1661, cron/scheduler.py:2373-2378, tui_gateway/server.py:2452). The time
  // budget stays optional off Slack: cron runs ignore it (cron/scheduler.py:2408-2440), and it is
  // only advisory. Schema 4 capped Slack gateways only.
  const capsTurns = true;
  const agentKeys = ["disabled_toolsets"];
  if (isSlackGateway || (capsTurns && "run_budget_seconds" in agent)) {
    agentKeys.push("max_turns", "run_budget_seconds");
  } else if (capsTurns) {
    agentKeys.push("max_turns");
  }
  assertExactKeys(agent, agentKeys, `agent config for ${profile.name}`);
  if (capsTurns) {
    // Anyone on a shared gateway's allowlists can start its runs.
    const turnLimit =
      isSlackGateway && !personalGateway ? sharedGatewayMaxTurnsLimit : maxTurnsLimit;
    assertBoundedInteger(agent["max_turns"], turnLimit, `agent.max_turns for ${profile.name}`);
    if ("run_budget_seconds" in agent) {
      assertBoundedInteger(
        agent["run_budget_seconds"],
        runBudgetSecondsLimit,
        `agent.run_budget_seconds for ${profile.name}`,
      );
    }
  }
  if (hasJobs) {
    // Unattended runs refuse every dangerous command; deny is also Hermes's default
    // (tools/approval_context.py:281-293), but the reviewed config says so explicitly.
    const approvals = config["approvals"];
    assertPlainObject(approvals, `approvals config for ${profile.name}`);
    assertExactKeys(approvals, ["cron_mode"], `approvals config for ${profile.name}`);
    if (approvals["cron_mode"] !== "deny") {
      fail(`Profile ${profile.name} ships jobs and must set approvals.cron_mode: deny.`);
    }
  }
  assertUniqueStrings(
    agent["disabled_toolsets"],
    `agent.disabled_toolsets for ${profile.name}`,
    toolsetNamePattern,
  );
  const disabledToolsets = expectedDisabledToolsets(platformToolsets, isWorker);
  if (JSON.stringify(agent["disabled_toolsets"]) !== JSON.stringify(disabledToolsets)) {
    fail(
      isWorker
        ? `Kanban worker ${profile.name} must disable every unselected built-in toolset but kanban.`
        : `Profile ${profile.name} must disable every unselected built-in toolset.`,
    );
  }

  assertPlainObject(config["skills"], `skills config for ${profile.name}`);
  assertExactKeys(config["skills"], ["external_dirs"], `skills config for ${profile.name}`);
  const expectedExternalDirs = [`${dodoSkillsRoot}/${profile.name}`];
  if (profile.raven_skills.length > 0) {
    expectedExternalDirs.push(`${ravenSkillsRoot}/${profile.name}`);
  }
  if (profile.hermes_skills.length > 0) {
    expectedExternalDirs.push(`${hermesSkillsRoot}/${profile.name}`);
  }
  if (JSON.stringify(config["skills"]["external_dirs"]) !== JSON.stringify(expectedExternalDirs)) {
    fail(`Profile ${profile.name} external skill directories do not match its selections.`);
  }

  assertPlainObject(config["security"], `security config for ${profile.name}`);
  assertExactKeys(config["security"], ["redact_secrets"], `security config for ${profile.name}`);
  if (config["security"]["redact_secrets"] !== true) {
    fail(`Profile ${profile.name} must enable security.redact_secrets.`);
  }
  const terminal = config["terminal"];
  assertPlainObject(terminal, `terminal config for ${profile.name}`);
  // Schema 5 states the local backend, so a TERMINAL_ENV in the profile's .env cannot change it:
  // an explicit config.yaml key wins over .env (tools/terminal_scope.py:89-158,
  // hermes_cli/env_loader.py:475-498). A schema 4 profile runs Hermes's default local backend
  // (hermes_cli/config_defaults.py:278).
  const terminalKeys = ["backend", "home_mode"];
  if ("env_passthrough" in terminal) {
    terminalKeys.push("env_passthrough");
  }
  assertExactKeys(terminal, terminalKeys, `terminal config for ${profile.name}`);
  if (terminal["backend"] !== "local") {
    fail(`Profile ${profile.name} must set terminal.backend: local.`);
  }
  if (terminal["home_mode"] !== profile.terminal_home_mode) {
    fail(`Profile ${profile.name} terminal.home_mode does not match its fleet declaration.`);
  }
  if ("env_passthrough" in terminal) {
    validateEnvPassthrough(profile, terminal["env_passthrough"], platformToolsets);
  }
  validateExecutionReach(profile, platformToolsets, config, ownerSlackId);

  validateNoSecretsOrRuntimeData(directory);
  validateCronJobs(profile, directory, platformToolsets, selectedSkillNames);
  validatePlugins(profile, directory, platformToolsets, workers);
  validateModelFreeProfile(profile, directory, platformToolsets, terminal);
}

function validateFleet(): void {
  // The fleet first: its policy decides what the skill and server scans below accept.
  const fleetValue = readYaml(fleetPath);
  assertPlainObject(fleetValue, "Fleet manifest");
  const {
    default_profile: defaultValue,
    owner_slack_id: ownerSlackId,
    policy: policyValue,
    profiles,
    schema_version: schemaVersion,
  } = fleetValue;
  if (schemaVersion !== fleetSchemaVersion || !Array.isArray(profiles) || profiles.length === 0) {
    fail(
      `Fleet manifest must use schema_version ${fleetSchemaVersion} and contain named profiles.`,
    );
  }
  assertExactKeys(
    fleetValue,
    ["default_profile", "owner_slack_id", "policy", "profiles", "schema_version"],
    "Fleet manifest",
  );
  if (typeof ownerSlackId !== "string" || !slackUserIdPattern.test(ownerSlackId)) {
    fail("owner_slack_id must be a Slack user ID.");
  }
  const owner = ownerSlackId;
  policy = parsePolicy(policyValue);

  const sharedSkillNames = new Set<string>();
  for (const entry of readdirSync(sharedSkillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      fail(`Unexpected entry in shared/skills/: ${entry.name}`);
    }
    const skillFile = join(sharedSkillsRoot, entry.name, "SKILL.md");
    if (!lstatSync(skillFile).isFile()) {
      fail(`Shared skill ${entry.name} is missing SKILL.md.`);
    }
    validateSkill(skillFile);
    sharedSkillNames.add(entry.name);
  }
  validateNoSecretsOrRuntimeData(sharedSkillsRoot);
  const dodoServers = validateDodoMcpServers();

  const defaultProfile = validateProfileShape(defaultValue, true) as DefaultProfile;
  const fleetProfiles = profiles.map((value) => validateProfileShape(value, false) as FleetProfile);
  const fleet: FleetManifest = { default_profile: defaultProfile, profiles: fleetProfiles };
  validatePolicyProfiles(
    new Set([defaultProfile, ...fleetProfiles].map((profile) => profile.name)),
  );

  const workers = validateKanbanWorkers([fleet.default_profile, ...fleet.profiles]);
  const names = new Set<string>();
  validateProfile(fleet.default_profile, sharedSkillNames, owner, workers);
  names.add(fleet.default_profile.name);
  const pluginToolsetOwners = new Map<string, string>();
  let pluginCount = 0;
  for (const profile of fleet.profiles) {
    if (names.has(profile.name)) {
      fail(`Duplicate fleet profile: ${profile.name}`);
    }
    names.add(profile.name);
    validateProfile(profile, sharedSkillNames, owner, workers);
    // The reconciler lists every fleet plugin toolset as known on every profile.
    pluginCount += Object.keys(profile.plugins).length;
    for (const declaration of Object.values(profile.plugins)) {
      if (declaration.toolset === undefined) {
        continue;
      }
      const other = pluginToolsetOwners.get(declaration.toolset);
      if (other !== undefined) {
        fail(
          `Plugin toolset ${declaration.toolset} is declared by both ${other} and ${profile.name}.`,
        );
      }
      pluginToolsetOwners.set(declaration.toolset, profile.name);
    }
  }

  validateWorkerGuards(workers);

  const profileDirectories = new Set<string>();
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (entry.name === "fleet.yaml" && entry.isFile()) {
      continue;
    }
    if (!entry.isDirectory()) {
      fail(`Unexpected entry in profiles/: ${entry.name}`);
    }
    profileDirectories.add(entry.name);
  }
  if (
    names.size !== profileDirectories.size ||
    [...names].some((name) => !profileDirectories.has(name))
  ) {
    fail("Every profile directory must be declared exactly once in profiles/fleet.yaml.");
  }

  const dodoSelections = [fleet.default_profile, ...fleet.profiles].reduce(
    (count, profile) => count + profile.dodo_skills.length,
    0,
  );
  const ravenSelections = [fleet.default_profile, ...fleet.profiles].reduce(
    (count, profile) => count + profile.raven_skills.length,
    0,
  );
  const hermesSelections = [fleet.default_profile, ...fleet.profiles].reduce(
    (count, profile) => count + profile.hermes_skills.length,
    0,
  );
  const runtimeCredentials = [fleet.default_profile, ...fleet.profiles].reduce(
    (count, profile) => count + profile.runtime_env.length,
    0,
  );
  const brokeredCredentials = fleet.profiles.reduce(
    (count, profile) => count + profile.brokered_env.length,
    0,
  );
  const cronJobs = fleet.profiles.reduce((count, profile) => count + profile.cron.length, 0);
  console.log(
    `Validated the default profile, ${fleet.profiles.length} named profiles, ` +
      `${dodoSelections} Dodo, ${ravenSelections} Raven, and ${hermesSelections} Hermes skill selections, ` +
      `${runtimeCredentials} runtime and ${brokeredCredentials} brokered credential declarations, ` +
      `${cronJobs} cron jobs, ` +
      `${pluginCount} plugins, ${dodoServers} Dodo MCP servers, and ${workers.length} Kanban workers.`,
  );
}

validateFleet();
