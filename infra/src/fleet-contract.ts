// Hermes facts the validator and the Pulumi program share. Nothing here is specific to Derek: the
// fleet's own policy lives in profiles/fleet.yaml. Keep this module free of side effects: importing
// validate-fleet.ts would run the whole validation.

// The fleet schema the validator accepts. A schema change ships with the validator that reads it,
// so the host never needs to accept an older one: to go back, revert and apply Pulumi again.
export const fleetSchemaVersion = 6;

export const runtimeEnvNamePattern = /^[A-Z][A-Z0-9_]{2,63}$/;
// Hermes's own credential suffixes plus _PASSWORD (hermes_cli/env_loader.py:24).
export const credentialSuffixPattern = /_(?:TOKEN|KEY|SECRET|PASSWORD)$/;
// Slack tokens are declared by `gateway`; the rest are Hermes runtime, policy, or internal secrets.
export const reservedRuntimeEnvPrefixes = [
  "API_SERVER_",
  "AUXILIARY_",
  "GATEWAY_",
  "HERMES_",
  "SLACK_",
  "TERMINAL_",
] as const;
// Hermes reads these as model credentials: the GitHub Copilot keys (hermes_cli/auth.py:185-186)
// and the Claude Code subscription OAuth token (hermes_cli/auth.py:210-216).
export const reservedRuntimeEnvNames = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);
// Hermes messaging platforms, from the `messaging` category of OPTIONAL_ENV_VARS
// (hermes_cli/config_defaults.py). A credential under one of these prefixes would open another
// gateway platform. The host reconciler also refuses the exact names the installed Hermes reports.
export const messagingRuntimeEnvPrefixes = [
  "A2A_",
  "BLUEBUBBLES_",
  "BUZZ_",
  "DINGTALK_",
  "DISCORD_",
  "EMAIL_",
  "FEISHU_",
  "GOOGLE_CHAT_",
  "HASS_",
  "IRC_",
  "LINE_",
  "MATRIX_",
  "MATTERMOST_",
  "NTFY_",
  "PHOTON_",
  "QQ_",
  "QQBOT_",
  "SIMPLEX_",
  "SMS_",
  "TEAMS_",
  "TELEGRAM_",
  "TWILIO_",
  "WEBHOOK_",
  "WECOM_",
  "WHATSAPP_",
] as const;
// Gateway kinds whose Slack tokens live in the profile's .env. An outbound-only profile holds the
// bot token and never the app token, so Hermes cannot open Socket Mode for it
// (plugins/platforms/slack/adapter.py:1771-1783).
export const gatewayRuntimeEnv: Readonly<Record<string, readonly string[]>> = {
  slack: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
  slack_outbound: ["SLACK_BOT_TOKEN"],
};
// Returns why `name` cannot be declared in a profile's runtime_env, or undefined when it can.
// `brokered` names the credentials the host's broker mints (the fleet policy's brokered_credentials).
export function runtimeEnvNameProblem(
  name: string,
  brokered: ReadonlySet<string>,
): string | undefined {
  if (!runtimeEnvNamePattern.test(name)) {
    return `${name} is not an upper-case environment variable name`;
  }
  if (brokered.has(name)) {
    return `${name} is minted by the host's broker; declare it in brokered_env instead`;
  }
  if (!credentialSuffixPattern.test(name)) {
    return `runtime_env declares credentials only; ${name} is not credential-shaped`;
  }
  const prefix = reservedRuntimeEnvPrefixes.find((reserved) => name.startsWith(reserved));
  if (prefix === "SLACK_") {
    return `${name} is a Slack key; Slack tokens follow the profile's gateway declaration`;
  }
  if (prefix !== undefined) {
    return `${name} uses the reserved prefix ${prefix}`;
  }
  if (reservedRuntimeEnvNames.has(name)) {
    return `${name} is a Hermes model-provider key`;
  }
  const platform = messagingRuntimeEnvPrefixes.find((reserved) => name.startsWith(reserved));
  if (platform !== undefined) {
    return `${name} uses the Hermes messaging-platform prefix ${platform}`;
  }
  return undefined;
}
