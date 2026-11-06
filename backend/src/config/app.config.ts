export type DependencyScanConfig = {
  enabled: boolean;
  intervalMs: number;
};

export type LogLevel = "error" | "warn" | "info" | "debug";

export const DEFAULT_NPM_RANGE_RESOLUTION_TTL_MS = 1440 * 60_000;

export function buildNpmRangeResolutionTtl(environment: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(environment.NPM_RANGE_RESOLUTION_TTL_MINUTES?.trim() || "1440");
  const ttlMs = minutes * 60_000;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || !Number.isSafeInteger(ttlMs)) {
    throw new Error("NPM_RANGE_RESOLUTION_TTL_MINUTES must be a positive safe integer in minutes.");
  }
  return ttlMs;
}

export function buildDependencyResolutionRetries(environment: NodeJS.ProcessEnv = process.env): number {
  const retries = Number(environment.DEPENDENCY_RESOLUTION_RETRIES?.trim() || "2");
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new Error("DEPENDENCY_RESOLUTION_RETRIES must be a nonnegative integer.");
  }
  return retries;
}

export function buildGitConcurrency(environment: NodeJS.ProcessEnv = process.env): number {
  const maximum = Number(environment.GIT_MAX_CONCURRENCY?.trim() || "4");
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("GIT_MAX_CONCURRENCY must be a positive integer.");
  }
  return maximum;
}

export function buildGitHubToken(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = environment.GITHUB_TOKEN?.trim();
  if (!token) {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex -- Reject control characters in credentials.
  if (/[\s\x00-\x1f\x7f]/.test(token)) {
    throw new Error("GITHUB_TOKEN must not contain embedded whitespace or control characters.");
  }
  return token;
}

export function buildLogLevel(environment: NodeJS.ProcessEnv = process.env): LogLevel {
  const level = environment.LOG_LEVEL?.trim().toLowerCase() || "info";
  switch (level) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      throw new Error("LOG_LEVEL must be error, warn, info or debug.");
  }
}

export function buildDependencyScanConfig(
  environment: NodeJS.ProcessEnv = process.env
): DependencyScanConfig {
  const enabled = environment.DEPENDENCY_SCAN_ENABLED?.trim().toLowerCase() || "true";
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("DEPENDENCY_SCAN_ENABLED must be true or false.");
  }

  const intervalMinutes = Number(environment.DEPENDENCY_SCAN_INTERVAL_MINUTES?.trim() || "15");
  const intervalMs = intervalMinutes * 60_000;
  if (!Number.isInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
    throw new Error(
      "DEPENDENCY_SCAN_INTERVAL_MINUTES must produce an interval between 1 and 2147483647 milliseconds."
    );
  }

  return { enabled: enabled === "true", intervalMs };
}