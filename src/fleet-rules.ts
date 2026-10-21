// The fleet contract: every safety property the template relies on, checked against the files in
// this repository. scripts/host_rules.py re-checks the core of it on the host before a deployment;
// a rule added here that guards a boundary gets the same rule there.
//
// Toolset names, config keys, and the Slack, Kanban, and MCP behaviour assumed here are those of
// Hermes Agent v0.21.5 (tag v2026.9.24), as the reference implementation (Dodo) verified them.
// Re-check them against the Hermes release you deploy before you move to it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

export const schemaVersion = 1;
export const platforms = ["cli", "api_server", "slack", "cron"] as const;
export type Platform = (typeof platforms)[number];

// Every leaf toolset Hermes knows. A profile's agent.disabled_toolsets lists each one no surface
// selects, so a toolset is never switched on by omission.
export const knownToolsets = new Set([
  "bot_room",
  "browser",
  "clarify",
  "code_execution",
  "computer_use",
  "connections",
  "context_engine",
  "cronjob",
  "delegation",
  "desktop_ui",
  "discord",
  "discord_admin",
  "feishu_doc",
  "feishu_drive",
  "file",
  "homeassistant",
  "image_gen",
  "kanban",
  "memory",
  "project",
  "search",
  "session_search",
  "setup",
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
// Toolsets a Slack surface may select. Anything that executes code, touches files, schedules work,
// or reaches other platforms stays off Slack, except on the owner-only console.
export const slackSafeToolsets = new Set([
  "clarify",
  "memory",
  "session_search",
  "skills",
  "todo",
  "vision",
  "web",
]);
const ownerSlackToolsets = new Set(["file", "terminal"]);
// Toolsets that expose one user's history to another user of the same profile.
const personalToolsets = new Set(["memory", "session_search"]);
// Ways out: a surface that reads private data through an MCP server never also selects these.
// On a profile people can message, a shell counts too.
const egressToolsets = new Set(["browser", "vision", "web"]);
const messageableEgressToolsets = new Set([...egressToolsets, "code_execution", "terminal"]);
const executionToolsets = new Set(["code_execution", "file", "terminal"]);
const workerToolsets = new Set(["code_execution", "file", "skills", "terminal", "todo"]);
const noMcp = "no_mcp";

export const roles = ["launch", "owner", "team", "scheduled", "worker"] as const;
type Role = (typeof roles)[number];
const roleGateway: Record<Role, string | false> = {
  launch: false,
  owner: "slack",
  team: "slack",
  scheduled: "slack_outbound",
  worker: false,
};

const fleetProfileKeys = [
  "cron",
  "delivery_targets",
  "gateway",
  "kanban_worker",
  "mcp_servers",
  "name",
  "platform_toolsets",
  "plugins",
  "role",
  "runtime_env",
  "skills",
  "source",
];
// config.yaml fields the reconciler owns and rewrites on every deployment.
const requiredConfigKeys = [
  "agent",
  "mcp_servers",
  "platform_toolsets",
  "plugins",
  "security",
  "skills",
  "terminal",
];
const optionalConfigKeys = [
  "approvals",
  "gateway",
  "kanban",
  "max_concurrent_sessions",
  "memory",
  "slack",
  "timezone",
];
const mcpServerKeys = new Set([
  "args",
  "command",
  "elicitation",
  "env",
  "headers",
  "lifecycle",
  "prompts",
  "sampling",
  "strict_redirect_headers",
  "timeout",
  "tools",
  "trust",
  "url",
]);

const maxTurnsLimit = 50;
const sharedSlackMaxTurnsLimit = 25;
const runBudgetSecondsLimit = 900;
const workerRuntimeSeconds = [60, 3600] as const;
const workerMaxRetries = 2;
const dmOnlyChannelSentinel = "C0000000000";

const agentNamePattern = /^[a-z][a-z0-9]{1,20}$/;
const profileNamePattern = /^[a-z][a-z0-9-]{1,40}$/;
const slackUserIdPattern = /^[UW][A-Z0-9]{8,}$/;
const slackChannelIdPattern = /^[CG][A-Z0-9]{8,}$/;
const deliveryTargetPattern = /^slack:[CD][A-Z0-9]{8,}$/;
const runtimeEnvNamePattern = /^[A-Z][A-Z0-9_]{2,63}$/;
const reservedEnvPrefixes = [
  "API_SERVER_",
  "AUXILIARY_",
  "GATEWAY_",
  "HERMES_",
  "SLACK_",
  "TERMINAL_",
];
const mcpNamePattern = /^[a-z][a-z0-9_-]*$/;
const mcpToolNamePattern = /^[A-Za-z0-9_.:/-]+$/;
const headerValuePattern = /^(?:Bearer |Sentry-Bearer )?\$\{([A-Z][A-Z0-9_]*)\}$/;
const deleteToolPattern = /(?:^|[_-])(?:delete|destroy|purge|drop)(?:[_-]|$)/i;
const writeToolPattern =
  /^(?:save|create|update|delete|post|send|write|put|set|add|remove|upload|merge|publish|run|execute|edit|patch|assign|close|archive)(?:[_-]|$)/i;
const cronIdPattern = /^[a-z][a-z0-9-]{2,62}$/;
const cronScriptPattern = /^[a-z0-9][a-z0-9-]*\.(?:py|sh)$/;
const semverPattern = /^\d+\.\d+\.\d+$/;
const skillNamePattern = /^[a-z][a-z0-9-]*$/;
// A skill that writes to the agent's own repository: never on a profile teammates can message.
const repositoryWriteSkill = "change-workflow";
const secretPatterns = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bghs_[A-Za-z0-9._-]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\blin_api_[A-Za-z0-9]{20,}\b/,
  /\bphx_[A-Za-z0-9]{20,}\b/,
  /\bsntry[su]_[A-Za-z0-9_=-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const forbiddenFileNames = new Set([".env", "auth.json", "state.db", "hermes_state.db"]);

type Json = Record<string, unknown>;

export interface Repo {
  root: string;
  fleet: Json;
  configs: Record<string, Json>;
  distributions: Record<string, Json>;
  cronJobs: Record<string, Json[]>;
  handoffWorkers: Json;
  pluginManifests: Record<string, Record<string, Json>>;
  skillNames: Record<string, string | undefined>;
  files: string[];
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYaml(path: string): Json {
  const value = parse(readFileSync(path, "utf8"));
  return isObject(value) ? value : {};
}

function walk(root: string, directory = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(root, path));
    else found.push(relative(root, path));
  }
  return found;
}

function profilesOf(fleet: Json): Json[] {
  const named = Array.isArray(fleet.profiles) ? fleet.profiles.filter(isObject) : [];
  return isObject(fleet.default_profile) ? [fleet.default_profile, ...named] : named;
}

export function loadRepo(root: string): Repo {
  const fleet = readYaml(join(root, "profiles", "fleet.yaml"));
  const repo: Repo = {
    root,
    fleet,
    configs: {},
    distributions: {},
    cronJobs: {},
    handoffWorkers: {},
    pluginManifests: {},
    skillNames: {},
    files: walk(root),
  };
  for (const profile of profilesOf(fleet)) {
    const name = String(profile.name);
    const directory = join(root, "profiles", name);
    if (existsSync(join(directory, "config.yaml"))) {
      repo.configs[name] = readYaml(join(directory, "config.yaml"));
    }
    if (existsSync(join(directory, "distribution.yaml"))) {
      repo.distributions[name] = readYaml(join(directory, "distribution.yaml"));
    }
    const jobs = join(directory, "cron", "jobs.json");
    if (existsSync(jobs)) {
      const parsed = JSON.parse(readFileSync(jobs, "utf8"));
      repo.cronJobs[name] = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    }
    const pluginsRoot = join(directory, "plugins");
    if (existsSync(pluginsRoot)) {
      repo.pluginManifests[name] = {};
      for (const plugin of readdirSync(pluginsRoot)) {
        const manifest = join(pluginsRoot, plugin, "plugin.yaml");
        if (existsSync(manifest)) {
          (repo.pluginManifests[name] as Record<string, Json>)[plugin] = readYaml(manifest);
        }
        const workers = join(pluginsRoot, plugin, "workers.json");
        if (existsSync(workers)) repo.handoffWorkers = JSON.parse(readFileSync(workers, "utf8"));
      }
    }
  }
  const skillsRoot = join(root, "shared", "skills");
  if (existsSync(skillsRoot)) {
    for (const skill of readdirSync(skillsRoot)) {
      const file = join(skillsRoot, skill, "SKILL.md");
      const match = existsSync(file)
        ? /^---\n[\s\S]*?^name: ([^\n]+)$/m.exec(readFileSync(file, "utf8"))
        : null;
      repo.skillNames[skill] = match?.[1]?.trim();
    }
  }
  return repo;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

// Returns every problem found. An empty list means the fleet satisfies the contract.
export function validate(repo: Repo): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);
  const { fleet } = repo;

  if (fleet.schema_version !== schemaVersion)
    fail(`fleet: schema_version must be ${schemaVersion}.`);
  const agent = String(fleet.agent_name ?? "");
  if (!agentNamePattern.test(agent)) fail("fleet: agent_name must be a short lowercase name.");
  const owner = String(fleet.owner_slack_id ?? "");
  if (!slackUserIdPattern.test(owner)) fail("fleet: owner_slack_id must be a Slack user ID.");
  const handoffPlugin = `${agent}-handoff`;
  const handoffToolset = `${agent}_handoff`;
  const guardPlugin = `${agent}-worker-guard`;
  const deployRoot = `/var/lib/hermes/.${agent}-deployment`;

  const profiles = profilesOf(fleet);
  if (!isObject(fleet.default_profile) || fleet.default_profile.name !== "default") {
    fail("fleet: default_profile must be the profile named default.");
  }
  const names = profiles.map((profile) => String(profile.name));
  if (new Set(names).size !== names.length) fail("fleet: profile names must be unique.");
  const byRole = (role: Role) => profiles.filter((profile) => profile.role === role);
  if (byRole("owner").length !== 1) fail("fleet: exactly one profile has role owner.");
  if (byRole("team").length > 1) fail("fleet: at most one profile has role team.");
  const workers = byRole("worker").map((profile) => String(profile.name));

  const writes = Array.isArray(fleet.reviewed_writes) ? fleet.reviewed_writes.filter(isObject) : [];
  const reviewedWrite = (profile: string, server: string, tool: string) =>
    writes.some(
      (entry) =>
        entry.profile === profile &&
        entry.server === server &&
        (strings(entry.tools) ?? []).includes(tool),
    );
  for (const entry of writes) {
    const target = profiles.find((profile) => profile.name === entry.profile);
    if (!target || !isObject(target.mcp_servers) || !(String(entry.server) in target.mcp_servers)) {
      fail(`reviewed_writes: ${entry.profile}/${entry.server} is not a declared MCP server.`);
    }
    for (const tool of strings(entry.tools) ?? []) {
      if (deleteToolPattern.test(tool)) fail(`reviewed_writes: ${tool} is a delete tool.`);
    }
  }

  for (const profile of profiles) {
    const name = String(profile.name);
    const at = `profile ${name}`;
    const role = profile.role as Role;
    const isDefault = name === "default";
    const keys = sorted(Object.keys(profile));
    if (!sameJson(keys, fleetProfileKeys)) {
      fail(`${at}: fleet keys must be exactly ${fleetProfileKeys.join(", ")}.`);
      continue;
    }
    if (!profileNamePattern.test(name) || (!isDefault && !name.startsWith(`${agent}-`))) {
      fail(`${at}: named profiles are called ${agent}-<job>.`);
    }
    if (profile.source !== `profiles/${name}`) fail(`${at}: source must be profiles/${name}.`);
    if (!roles.includes(role) || (role === "launch") !== isDefault) {
      fail(`${at}: role must be one of ${roles.join(", ")}, and launch only for default.`);
      continue;
    }
    if (profile.gateway !== roleGateway[role]) {
      fail(`${at}: a ${role} profile has gateway ${roleGateway[role]}.`);
    }
    for (const file of [
      "SOUL.md",
      "config.yaml",
      "README.md",
      ...(isDefault ? [] : ["distribution.yaml"]),
    ]) {
      if (!existsSync(join(repo.root, "profiles", name, file))) fail(`${at}: missing ${file}.`);
    }
    if (!isDefault) {
      const distribution = repo.distributions[name] ?? {};
      if (distribution.name !== name) fail(`${at}: distribution.yaml name must be ${name}.`);
      if (!semverPattern.test(String(distribution.version))) {
        fail(`${at}: distribution.yaml version must be semver.`);
      }
    }

    // Surfaces and toolsets.
    const surfaces = isObject(profile.platform_toolsets) ? profile.platform_toolsets : {};
    const servers = isObject(profile.mcp_servers) ? profile.mcp_servers : {};
    const plugins = isObject(profile.plugins) ? profile.plugins : {};
    const pluginToolsets = new Set(
      Object.values(plugins)
        .filter(isObject)
        .map((plugin) => plugin.toolset)
        .filter((toolset): toolset is string => typeof toolset === "string"),
    );
    if (!sameJson(sorted(Object.keys(surfaces)), sorted(platforms))) {
      fail(`${at}: platform_toolsets must name exactly ${platforms.join(", ")}.`);
    }
    const selected = new Set<string>();
    const namedServers = new Set<string>();
    for (const platform of platforms) {
      const toolsets = strings(surfaces[platform]) ?? [];
      const where = `${at} ${platform}`;
      if (new Set(toolsets).size !== toolsets.length) fail(`${where}: toolsets repeat.`);
      const mcp = toolsets.filter((toolset) => toolset in servers);
      if (toolsets.includes(noMcp) === mcp.length > 0) {
        fail(`${where}: list its MCP servers, or no_mcp when it has none.`);
      }
      for (const toolset of toolsets) {
        if (toolset === noMcp || toolset in servers) continue;
        if (!knownToolsets.has(toolset) && !pluginToolsets.has(toolset)) {
          fail(`${where}: unknown toolset ${toolset}.`);
        }
        selected.add(toolset);
      }
      for (const server of mcp) namedServers.add(server);
      if (toolsets.includes("kanban")) fail(`${where}: no profile selects the raw kanban toolset.`);
      const messageable = profile.gateway === "slack";
      const egress = messageable ? messageableEgressToolsets : egressToolsets;
      if (role !== "owner" && mcp.length > 0) {
        const out = toolsets.filter((toolset) => egress.has(toolset));
        if (out.length > 0) {
          fail(
            `${where}: ${out.join(", ")} next to MCP servers would open a way out for private data.`,
          );
        }
      }
      if (platform === "slack" && profile.gateway === "slack") {
        for (const toolset of toolsets) {
          const allowed =
            toolset === noMcp ||
            toolset in servers ||
            pluginToolsets.has(toolset) ||
            slackSafeToolsets.has(toolset) ||
            (role === "owner" && ownerSlackToolsets.has(toolset));
          if (!allowed) fail(`${where}: ${toolset} is not allowed on a Slack surface.`);
          if (role !== "owner" && personalToolsets.has(toolset)) {
            fail(`${where}: ${toolset} would share one person's history with another.`);
          }
        }
      }
      if (profile.gateway === "slack" && role !== "owner") {
        const code = toolsets.filter((toolset) => executionToolsets.has(toolset));
        if (code.length > 0)
          fail(`${where}: ${code.join(", ")} only where nobody but the owner can message.`);
      }
      if (profile.gateway === "slack_outbound") {
        const code = toolsets.filter(
          (toolset) => toolset === "terminal" || toolset === "code_execution",
        );
        if (code.length > 0)
          fail(`${where}: an outbound profile runs no shell next to its bot token.`);
      }
      if (role === "worker") {
        if (platform === "cli") {
          for (const toolset of toolsets) {
            if (toolset !== noMcp && !(toolset in servers) && !workerToolsets.has(toolset)) {
              fail(
                `${where}: a worker selects only ${sorted(workerToolsets).join(", ")} and its MCP servers.`,
              );
            }
          }
        } else if (!sameJson(toolsets, [noMcp])) {
          fail(`${where}: a worker runs on the cli surface only; this one must be [no_mcp].`);
        }
      }
      if (role === "scheduled" && platform === "slack" && !sameJson(toolsets, [noMcp])) {
        fail(`${where}: an outbound profile has no Slack surface; it must be [no_mcp].`);
      }
    }
    for (const server of Object.keys(servers)) {
      if (!namedServers.has(server)) fail(`${at}: MCP server ${server} is named on no surface.`);
    }

    // MCP servers.
    const runtimeEnv = strings(profile.runtime_env) ?? [];
    const referencedEnv = new Set<string>();
    for (const [server, definition] of Object.entries(servers)) {
      const where = `${at} mcp ${server}`;
      if (!mcpNamePattern.test(server) || knownToolsets.has(server) || server === noMcp) {
        fail(`${where}: invalid or reserved server name.`);
      }
      if (!isObject(definition)) {
        fail(`${where}: must be a mapping.`);
        continue;
      }
      for (const key of Object.keys(definition)) {
        if (!mcpServerKeys.has(key)) fail(`${where}: unsupported key ${key}.`);
      }
      if (typeof definition.url === "string") {
        if (!definition.url.startsWith("https://")) fail(`${where}: url must be https.`);
        if (definition.strict_redirect_headers !== true) {
          fail(
            `${where}: strict_redirect_headers must be true, so a redirect never carries the key.`,
          );
        }
        if ("command" in definition) fail(`${where}: a server has a url or a command, not both.`);
      } else if (typeof definition.command !== "string" || !definition.command.startsWith("/")) {
        fail(`${where}: needs an https url or an absolute command path.`);
      }
      const tools = isObject(definition.tools) ? definition.tools : {};
      const include = strings(tools.include) ?? [];
      if (include.length === 0) fail(`${where}: tools.include must list the exact tools it loads.`);
      if (tools.resources !== false || tools.prompts !== false) {
        fail(`${where}: tools.resources and tools.prompts must be false.`);
      }
      if (!isObject(definition.sampling) || definition.sampling.enabled !== false) {
        fail(`${where}: sampling.enabled must be false.`);
      }
      if (!isObject(definition.elicitation) || definition.elicitation.enabled !== false) {
        fail(`${where}: elicitation.enabled must be false.`);
      }
      for (const tool of include) {
        if (!mcpToolNamePattern.test(tool) || tool.includes("*"))
          fail(`${where}: invalid tool ${tool}.`);
        if (deleteToolPattern.test(tool))
          fail(`${where}: ${tool} is a delete tool; no profile loads one.`);
        else if (writeToolPattern.test(tool) && !reviewedWrite(name, server, tool)) {
          fail(`${where}: ${tool} writes; list it in reviewed_writes for ${name}/${server}.`);
        }
      }
      const headers = isObject(definition.headers) ? definition.headers : {};
      const env = isObject(definition.env) ? definition.env : {};
      for (const [header, value] of Object.entries({ ...headers, ...env })) {
        const match = typeof value === "string" ? headerValuePattern.exec(value) : null;
        if (!match) {
          fail(`${where}: ${header} must be a \${NAME} reference, never a literal value.`);
          continue;
        }
        referencedEnv.add(match[1] as string);
        if (!runtimeEnv.includes(match[1] as string)) {
          fail(`${where}: ${header} uses ${match[1]}, which runtime_env does not declare.`);
        }
      }
    }

    // Credentials.
    if (new Set(runtimeEnv).size !== runtimeEnv.length) fail(`${at}: runtime_env repeats a name.`);
    if (isDefault && runtimeEnv.length > 0)
      fail(`${at}: the default profile holds no capability credentials.`);
    const config = repo.configs[name] ?? {};
    const terminal = isObject(config.terminal) ? config.terminal : {};
    const passthrough = strings(terminal.env_passthrough) ?? [];
    for (const variable of passthrough) {
      referencedEnv.add(variable);
      if (!runtimeEnv.includes(variable))
        fail(`${at}: env_passthrough ${variable} is not in runtime_env.`);
    }
    for (const variable of runtimeEnv) {
      if (!runtimeEnvNamePattern.test(variable))
        fail(`${at}: invalid runtime_env name ${variable}.`);
      if (reservedEnvPrefixes.some((prefix) => variable.startsWith(prefix))) {
        fail(`${at}: ${variable} uses a prefix Hermes reserves; Slack tokens come from gateway.`);
      }
      if (!referencedEnv.has(variable)) fail(`${at}: runtime_env ${variable} is used by nothing.`);
    }

    // config.yaml mirrors the fleet entry.
    const configKeys = Object.keys(config);
    for (const key of requiredConfigKeys) {
      if (!(key in config)) fail(`${at}: config.yaml must set ${key}.`);
    }
    for (const key of configKeys) {
      if (!requiredConfigKeys.includes(key) && !optionalConfigKeys.includes(key)) {
        fail(`${at}: config.yaml key ${key} is not owned by the reconciler.`);
      }
    }
    if (!sameJson(config.platform_toolsets, profile.platform_toolsets)) {
      fail(`${at}: config.yaml platform_toolsets must equal the fleet entry.`);
    }
    if (!sameJson(config.mcp_servers ?? {}, profile.mcp_servers)) {
      fail(`${at}: config.yaml mcp_servers must equal the fleet entry.`);
    }
    const enabled = isObject(config.plugins) ? (strings(config.plugins.enabled) ?? []) : [];
    if (!sameJson(sorted(enabled), sorted(Object.keys(plugins)))) {
      fail(`${at}: config.yaml plugins.enabled must list exactly the fleet's plugins.`);
    }
    const skillsConfig = isObject(config.skills) ? config.skills : {};
    if (!sameJson(skillsConfig.external_dirs, [`${deployRoot}/skills/${name}`])) {
      fail(`${at}: skills.external_dirs must be [${deployRoot}/skills/${name}].`);
    }
    if (!isObject(config.security) || config.security.redact_secrets !== true) {
      fail(`${at}: security.redact_secrets must be true.`);
    }
    if (terminal.backend !== "local") fail(`${at}: terminal.backend must be stated as local.`);
    for (const variable of passthrough) {
      if (variable.startsWith("SLACK_"))
        fail(`${at}: Hermes never passes ${variable} to a script.`);
    }

    // Run limits and disabled toolsets.
    const agentConfig = isObject(config.agent) ? config.agent : {};
    const maxTurns = agentConfig.max_turns;
    const turnLimit = role === "team" ? sharedSlackMaxTurnsLimit : maxTurnsLimit;
    if (
      !Number.isInteger(maxTurns) ||
      (maxTurns as number) < 1 ||
      (maxTurns as number) > turnLimit
    ) {
      fail(`${at}: agent.max_turns must be 1 to ${turnLimit}.`);
    }
    const budget = agentConfig.run_budget_seconds;
    if (
      (budget !== undefined || profile.gateway === "slack") &&
      (!Number.isInteger(budget) ||
        (budget as number) < 1 ||
        (budget as number) > runBudgetSecondsLimit)
    ) {
      fail(
        `${at}: agent.run_budget_seconds must be 1 to ${runBudgetSecondsLimit} (required on Slack).`,
      );
    }
    const disabled = new Set(strings(agentConfig.disabled_toolsets) ?? []);
    for (const toolset of knownToolsets) {
      const expected = !selected.has(toolset) && !(role === "worker" && toolset === "kanban");
      if (expected && !disabled.has(toolset))
        fail(`${at}: agent.disabled_toolsets must list ${toolset}.`);
      if (!expected && disabled.has(toolset))
        fail(`${at}: agent.disabled_toolsets must not list ${toolset}.`);
    }

    // Slack policy.
    const slack = isObject(config.slack) ? config.slack : undefined;
    const memory = isObject(config.memory) ? config.memory : {};
    if (role === "owner") {
      if (!slack || !sameJson(slack.allow_from, [owner])) {
        fail(
          `${at}: slack.allow_from must be exactly [owner_slack_id]; this profile keeps memory and a shell.`,
        );
      }
      if (slack && (strings(slack.group_allow_from) ?? []).length > 0) {
        fail(`${at}: the owner console takes no channel users.`);
      }
      if (slack && !sameJson(slack.allowed_channels, [dmOnlyChannelSentinel])) {
        fail(
          `${at}: slack.allowed_channels must be [${dmOnlyChannelSentinel}], so only DMs reach it.`,
        );
      }
    }
    if (role === "team") {
      const users = strings(slack?.allow_from) ?? [];
      if (!slack || users.length === 0 || !users.every((user) => slackUserIdPattern.test(user))) {
        fail(`${at}: slack.allow_from must list the team's Slack user IDs.`);
      }
      if (slack && !sameJson(slack.group_allow_from, slack.allow_from)) {
        fail(`${at}: slack.group_allow_from must equal slack.allow_from.`);
      }
      const channels = strings(slack?.allowed_channels) ?? [];
      if (
        channels.length === 0 ||
        !channels.every((channel) => slackChannelIdPattern.test(channel))
      ) {
        fail(`${at}: slack.allowed_channels must list the channel IDs it answers in.`);
      }
      if (slack?.require_mention !== true) fail(`${at}: slack.require_mention must be true.`);
      if (slack?.allow_bots !== "none") fail(`${at}: slack.allow_bots must be none.`);
      if (memory.memory_enabled !== false || memory.user_profile_enabled !== false) {
        fail(`${at}: a profile several people talk to keeps no memory.`);
      }
      if (
        !isObject(config.gateway) ||
        config.gateway.strict !== true ||
        config.gateway.trust_recent_files !== false
      ) {
        fail(`${at}: gateway must be strict and must not trust recent files.`);
      }
    }
    if (profile.gateway === "slack" || profile.gateway === "slack_outbound") {
      if (slack?.unfurl_links !== false || slack.unfurl_media !== false) {
        fail(`${at}: Slack link unfurling must be off.`);
      }
    }
    if (
      role === "scheduled" &&
      slack &&
      !sameJson(sorted(Object.keys(slack)), ["unfurl_links", "unfurl_media"])
    ) {
      fail(`${at}: an outbound profile holds no Slack policy but unfurling off.`);
    }
    if (role !== "owner" && role !== "team" && memory.memory_enabled === true) {
      fail(`${at}: memory is on only where one person can reach the profile.`);
    }
    if (role === "scheduled") {
      const approvals = isObject(config.approvals) ? config.approvals : {};
      if (approvals.cron_mode !== "deny") fail(`${at}: approvals.cron_mode must be deny.`);
    }

    // Kanban workers and hand-offs.
    const kanbanWorker = profile.kanban_worker;
    if (role === "worker") {
      if (!isObject(kanbanWorker)) {
        fail(`${at}: a worker declares kanban_worker.`);
      } else {
        const tool = String(kanbanWorker.handoff_tool);
        const runtime = kanbanWorker.max_runtime_seconds as number;
        const retries = kanbanWorker.max_retries as number;
        if (!/^handoff_[a-z][a-z0-9_]*$/.test(tool))
          fail(`${at}: handoff_tool must be handoff_<name>.`);
        if (
          !Number.isInteger(runtime) ||
          runtime < workerRuntimeSeconds[0] ||
          runtime > workerRuntimeSeconds[1]
        ) {
          fail(`${at}: max_runtime_seconds must be ${workerRuntimeSeconds.join(" to ")}.`);
        }
        if (!Number.isInteger(retries) || retries < 0 || retries > workerMaxRetries) {
          fail(`${at}: max_retries must be 0 to ${workerMaxRetries}.`);
        }
        const entry = repo.handoffWorkers[tool];
        if (
          !sameJson(entry, { assignee: name, max_runtime_seconds: runtime, max_retries: retries })
        ) {
          fail(`${at}: workers.json ${tool} must match its kanban_worker entry.`);
        }
      }
      if (!sameJson(plugins[guardPlugin], { hooks: ["pre_tool_call"] })) {
        fail(`${at}: every worker ships ${guardPlugin} with hooks [pre_tool_call].`);
      }
      const approvals = isObject(config.approvals) ? config.approvals : {};
      if (approvals.mode !== "manual" || approvals.single_query_mode !== "deny") {
        fail(`${at}: a worker's approvals are mode manual and single_query_mode deny.`);
      }
    } else if (kanbanWorker !== false) {
      fail(`${at}: only a worker sets kanban_worker.`);
    }
    for (const [plugin, declaration] of Object.entries(plugins)) {
      const manifest = repo.pluginManifests[name]?.[plugin];
      const where = `${at} plugin ${plugin}`;
      if (!manifest) {
        fail(`${where}: missing plugins/${plugin}/plugin.yaml.`);
        continue;
      }
      if (!existsSync(join(repo.root, "profiles", name, "plugins", plugin, "__init__.py"))) {
        fail(`${where}: missing __init__.py.`);
      }
      if (manifest.name !== plugin) fail(`${where}: plugin.yaml name must be ${plugin}.`);
      if (!isObject(declaration)) continue;
      if (plugin === handoffPlugin) {
        if (role !== "team") fail(`${where}: only the team profile hands off to workers.`);
        if (declaration.toolset !== handoffToolset)
          fail(`${where}: toolset must be ${handoffToolset}.`);
        const tools = strings(declaration.tools) ?? [];
        if (!sameJson(sorted(tools), sorted(strings(manifest.provides_tools) ?? []))) {
          fail(`${where}: tools must equal plugin.yaml provides_tools.`);
        }
        const handoffs = tools.filter((tool) => tool !== "handoff_result");
        if (!tools.includes("handoff_result")) fail(`${where}: ships handoff_result.`);
        if (!sameJson(sorted(handoffs), sorted(Object.keys(repo.handoffWorkers)))) {
          fail(`${where}: every hand-off tool has a workers.json entry, and nothing else does.`);
        }
        for (const tool of handoffs) {
          const assignee = isObject(repo.handoffWorkers[tool])
            ? repo.handoffWorkers[tool].assignee
            : undefined;
          const worker = profiles.find((candidate) => candidate.name === assignee);
          if (
            worker?.role !== "worker" ||
            !isObject(worker.kanban_worker) ||
            worker.kanban_worker.handoff_tool !== tool
          ) {
            fail(`${where}: ${tool} must hand off to the worker that declares it.`);
          }
        }
      } else if (plugin === guardPlugin) {
        if (role !== "worker") fail(`${where}: only workers ship the guard.`);
        if (!sameJson(strings(manifest.provides_hooks), ["pre_tool_call"])) {
          fail(`${where}: plugin.yaml provides_hooks must be [pre_tool_call].`);
        }
      } else {
        fail(`${where}: unreviewed plugin; add its rules to src/fleet-rules.ts first.`);
      }
    }

    // Schedules and delivery.
    const cron = strings(profile.cron) ?? [];
    const targets = strings(profile.delivery_targets) ?? [];
    if (role !== "scheduled" && (cron.length > 0 || targets.length > 0)) {
      fail(`${at}: only a scheduled profile, which nobody can message, ships cron jobs.`);
    }
    for (const target of targets) {
      if (!deliveryTargetPattern.test(target)) fail(`${at}: invalid delivery target ${target}.`);
    }
    const jobs = repo.cronJobs[name] ?? [];
    const jobIds = jobs.map((job) => String(job.id));
    if (!sameJson(sorted(jobIds), sorted(cron)))
      fail(`${at}: cron/jobs.json ids must equal the fleet's cron list.`);
    for (const job of jobs) {
      const where = `${at} cron ${job.id}`;
      if (!cronIdPattern.test(String(job.id))) fail(`${where}: invalid id.`);
      if (
        String(job.schedule ?? "")
          .trim()
          .split(/\s+/).length !== 5
      )
        fail(`${where}: schedule must be a 5-field cron.`);
      for (const field of ["deliver", "failure_deliver"]) {
        const value = String(job[field]);
        if (value !== "local" && !targets.includes(value)) {
          fail(`${where}: ${field} ${value} is not local or a declared delivery target.`);
        }
      }
      if (job.no_agent === true) {
        const script = String(job.script ?? "");
        if (
          !cronScriptPattern.test(script) ||
          !existsSync(join(repo.root, "profiles", name, "scripts", script))
        ) {
          fail(`${where}: a no_agent job runs a script in the profile's scripts/.`);
        }
      } else if (typeof job.prompt !== "string" || !job.prompt.trim()) {
        fail(`${where}: a model job needs a prompt.`);
      }
    }

    // Skills.
    for (const skill of strings(profile.skills) ?? []) {
      if (!skillNamePattern.test(skill) || repo.skillNames[skill] !== skill) {
        fail(`${at}: skill ${skill} must exist in shared/skills with a matching name.`);
      }
      if (skill === repositoryWriteSkill && role !== "owner" && role !== "worker") {
        fail(`${at}: ${repositoryWriteSkill} only where no teammate can message.`);
      }
    }
  }

  // The dispatcher runs exactly the workers.
  const defaultConfig = repo.configs.default ?? {};
  const kanban = isObject(defaultConfig.kanban) ? defaultConfig.kanban : {};
  if (!sameJson(sorted(strings(kanban.dispatch_profiles) ?? []), sorted(workers))) {
    fail("profile default: kanban.dispatch_profiles must list exactly the worker profiles.");
  }
  if (kanban.auto_decompose !== false || kanban.review_dispatch !== false) {
    fail("profile default: kanban.auto_decompose and review_dispatch must be false.");
  }
  const admins = isObject(defaultConfig.slack) ? defaultConfig.slack : {};
  if (
    !sameJson(admins.allow_admin_from, [owner]) ||
    !sameJson(admins.group_allow_admin_from, [owner])
  ) {
    fail("profile default: only the owner runs slash commands.");
  }

  // Nothing secret or runtime-owned is committed.
  for (const file of repo.files) {
    const base = file.split("/").pop() ?? "";
    if (forbiddenFileNames.has(base))
      fail(`${file}: runtime state or secrets never belong in Git.`);
    if (/\.(?:png|jpg|jpeg|gif|pdf|woff2?|ttf|lockb)$/.test(base)) continue;
    const text = readFileSync(join(repo.root, file), "utf8");
    if (secretPatterns.some((pattern) => pattern.test(text)))
      fail(`${file}: looks like it contains a secret.`);
  }
  return problems;
}
