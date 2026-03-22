import pino from 'pino';
import { stdout } from 'node:process';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const level: LogLevel = (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info';

// Enable pretty printing when running interactively (TTY) unless explicitly disabled.
// Force JSON with LOG_PRETTY=false, force pretty with LOG_PRETTY=true.
const prettyEnv = process.env['LOG_PRETTY'];
const isTTY = stdout.isTTY ?? false;
const usePretty = prettyEnv === 'false' ? false : prettyEnv === 'true' ? true : isTTY;

const transport = usePretty
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',   // just the time, no date clutter
        ignore: 'pid,hostname,module',   // strip noise (module shown via messageFormat)
        messageFormat: '{module} › {msg}',
        errorLikeObjectKeys: ['err', 'error'],
        levelFirst: true,
        // Custom level labels with symbols for quick scanning
        customLevels: 'trace:10,debug:20,info:30,warn:40,error:50,fatal:60',
        customColors: 'trace:gray,debug:cyan,info:green,warn:yellow,error:red,fatal:magentaBright',
        useOnlyCustomProps: false,
      },
    })
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
