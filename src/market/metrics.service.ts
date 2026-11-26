import { Injectable } from '@nestjs/common';

/**
 * In-process Prometheus-format counter store (#162).
 *
 * Intentionally does not use `prom-client` — the dep is not installed and
 * adding it just for a handful of counters would be over-engineering. The
 * Prometheus text exposition format is a 10-line spec; we just write it
 * ourselves. All counters are monotonically increasing integers (they reset
 * on process restart, which is fine for rate-of-change alerting).
 *
 * Consumers call `inc(name)` or `inc(name, labelPairs, value)` and nothing
 * else. MetricsController exposes the snapshot at GET /metrics.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly help = new Map<string, string>();
  private readonly startMs = Date.now();

  register(name: string, description: string) {
    this.help.set(name, description);
    if (!this.counters.has(name)) this.counters.set(name, 0);
  }

  inc(name: string, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Render all counters as Prometheus text format (exposition format v0.0.4). */
  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP polaris_process_uptime_seconds Seconds since this process started`);
    lines.push(`# TYPE polaris_process_uptime_seconds gauge`);
    lines.push(`polaris_process_uptime_seconds ${((Date.now() - this.startMs) / 1000).toFixed(1)}`);
    lines.push('');
    for (const [name, count] of this.counters) {
      const desc = this.help.get(name) ?? name;
      lines.push(`# HELP ${name} ${desc}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}_total ${count}`);
      lines.push('');
    }
    return lines.join('\n');
  }
}
