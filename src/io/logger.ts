/**
 * Run logging. Every command gets a run ID; every line carries a timestamp and
 * that ID. Logs land in the data layer (tenants/{tenant}/logs/) because the
 * watchdog reads them back as job heartbeats.
 *
 * Buffered and flushed at the end of the run: the Drive backend has no append,
 * so one write per run beats one round trip per line.
 */

import { TenantPaths, type Storage } from './storage.js';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface Logger {
  readonly runId: string;
  readonly logPath: string;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Print to the user's terminal only — never written to the log file. */
  flush(): Promise<void>;
}

export function makeRunId(now: Date): string {
  // Sortable and collision-resistant enough for one operator on one machine.
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const suffix = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(3, '0');
  return `${stamp}-${suffix}`;
}

export function logFileName(job: string, now: Date): string {
  return `${job}-${isoDate(now)}.log`;
}

export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface LoggerOptions {
  /** Also print INFO lines to stdout. Jobs do; interactive skills usually don't. */
  echo?: boolean;
  now?: Date;
}

export function createLogger(
  storage: Storage,
  tenant: string,
  job: string,
  options: LoggerOptions = {},
): Logger {
  const now = options.now ?? new Date();
  const runId = makeRunId(now);
  const logPath = TenantPaths.log(tenant, logFileName(job, now));
  const lines: string[] = [];

  const write = (level: LogLevel, message: string) => {
    const line = `${new Date().toISOString()} [${runId}] ${level} ${message}`;
    lines.push(line);
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else if (options.echo) console.log(line);
  };

  return {
    runId,
    logPath,
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    async flush() {
      if (lines.length === 0) return;
      try {
        await storage.ensureDir(TenantPaths.logs(tenant));
        await storage.appendFile(logPath, lines.join('\n') + '\n');
        lines.length = 0;
      } catch (error) {
        // Never let logging failure mask the real error from the command.
        console.error(`Warning: could not write log to ${logPath}: ${(error as Error).message}`);
      }
    },
  };
}

/** Heartbeat marker the watchdog greps for. */
export const HEARTBEAT = 'HEARTBEAT';

export function heartbeatLine(job: string): string {
  return `${HEARTBEAT} job=${job} completed`;
}
