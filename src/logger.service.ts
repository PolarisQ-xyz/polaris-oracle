import { ConsoleLogger, Injectable, LogLevel } from '@nestjs/common';

export interface StructuredLog {
  level: string;
  context?: string;
  message: string;
  ts: string;
  [key: string]: unknown;
}

/**
 * In production (`NODE_ENV=production`) emits one JSON object per line so
 * Fly's log drain (and any structured-log aggregator) can filter by field
 * (`contractId`, `feedId`, `event`, `txHash`). In dev falls back to Nest's
 * default ColourLogger so the terminal stays readable.
 *
 * Usage — pass structured fields as the last positional argument:
 *   this.logger.log('settle ok', { event: 'settle_ok', contractId, txHash });
 *
 * The fields spread into the JSON object alongside `level`, `context`,
 * `message`, and `ts`.
 */
@Injectable()
export class AppLoggerService extends ConsoleLogger {
  private readonly isJson: boolean;

  constructor() {
    super();
    this.isJson = process.env.NODE_ENV === 'production';
  }

  override log(message: unknown, ...rest: unknown[]): void {
    this.emit('log', message, rest);
  }

  override error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }

  override warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }

  override debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  override verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('verbose', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
    if (!this.isJson) {
      (super[level] as (...a: unknown[]) => void)(message, ...rest);
      return;
    }

    const fields: Record<string, unknown> = {};
    let context: string | undefined;

    for (const r of rest) {
      if (typeof r === 'string') {
        context = r;
      } else if (r && typeof r === 'object' && !Array.isArray(r)) {
        Object.assign(fields, r);
      }
    }

    const entry: StructuredLog = {
      level,
      ts: new Date().toISOString(),
      context: context ?? this.context,
      message: String(message),
      ...fields,
    };

    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}
