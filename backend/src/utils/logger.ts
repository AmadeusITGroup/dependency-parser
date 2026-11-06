import "dotenv/config";

import { buildLogLevel, LogLevel } from "../config/app.config";

type LogContext = Readonly<Record<string, unknown>>;
type LogMethod = {
  (message: string): void;
  (context: LogContext, message: string): void;
};

export type Logger = Record<LogLevel, LogMethod>;

const priorities: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export function createLogger(
  environment: NodeJS.ProcessEnv = process.env,
  output: Pick<Console, LogLevel> = console
): Logger {
  const minimumLevel = buildLogLevel(environment);
  const logAt = (level: LogLevel): LogMethod => (
    contextOrMessage: LogContext | string,
    message?: string
  ) => {
    if (priorities[level] > priorities[minimumLevel]) {
      return;
    }

    const text = typeof contextOrMessage === "string" ? contextOrMessage : message;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${text}`;
    if (typeof contextOrMessage === "string") {
      output[level](line);
    } else {
      output[level](line, contextOrMessage);
    }
  };

  return {
    error: logAt("error"),
    warn: logAt("warn"),
    info: logAt("info"),
    debug: logAt("debug"),
  };
}

export const logger = createLogger();