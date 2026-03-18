import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const level: LogLevel = (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info';
const pretty = process.env['LOG_PRETTY'] === 'true';

const transport = pretty
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } })
  : undefined;

const baseLogger = pino(
  {
    level,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.epochTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  },
  transport,
);

export type Logger = pino.Logger;

/**
 * Returns a child logger bound to a module name.
 * All log lines from this child will include { module }.
 */
export function getLogger(module: string): Logger {
  return baseLogger.child({ module });
}

/** Root logger — prefer getLogger(module) in application code. */
export const logger = baseLogger;
