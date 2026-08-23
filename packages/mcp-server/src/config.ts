import {
  MochiClient,
  formatIssues,
  settingsFromEnv,
  sinksFromEnv,
  type GradeSink,
  type ReviewSettings,
} from "@mochi-voice/core";

export interface ServerConfig {
  mochiToken: string;
  settings: ReviewSettings;
  sinks: GradeSink[];
  /** Bearer token callers must present. Empty disables auth (LAN-only!). */
  authToken: string;
  port: number;
  host: string;
  /** Allowed Origin header values; MCP requires origin validation. */
  allowedOrigins: string[];
  sessionTtlMs: number;
  /** Misconfigured environment variables, for the caller to warn about. */
  warnings: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mochiToken = env.MOCHI_API_TOKEN ?? "";
  if (!mochiToken) {
    throw new Error(
      "MOCHI_API_TOKEN is required. Get it from Mochi > Settings > API (Mochi Pro only).",
    );
  }

  // Shared with the voice broker, so a documented knob cannot work on one
  // path and silently do nothing on the other.
  const { settings, issues: settingIssues } = settingsFromEnv(env);
  const client = new MochiClient({
    token: mochiToken,
    ...(env.MOCHI_API_BASE_URL ? { baseUrl: env.MOCHI_API_BASE_URL } : {}),
  });
  const { sinks, issues: sinkIssues } = sinksFromEnv(env, client);

  const port = Number(env.PORT);
  const ttl = Number(env.REVIEW_SESSION_TTL_MS);

  return {
    mochiToken,
    settings,
    sinks,
    authToken: env.MCP_AUTH_TOKEN ?? "",
    port: Number.isFinite(port) && port > 0 ? port : 8765,
    host: env.HOST ?? "0.0.0.0",
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sessionTtlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : 60 * 60 * 1000,
    warnings: formatIssues([...settingIssues, ...sinkIssues]),
  };
}
