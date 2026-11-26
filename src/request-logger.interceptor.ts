import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';

/**
 * Logs one structured line per HTTP request: method, route pattern, status,
 * duration and client IP (read from `X-Forwarded-For` after trust-proxy is on,
 * otherwise `req.ip`). Request bodies are never logged. The `x-admin-key`
 * header and `Cookie` header are always redacted.
 *
 * Written as a NestJS interceptor rather than middleware so it has access to
 * the route pattern (`req.route.path`) the way controllers see it, not just
 * the raw URL — avoiding accidental high-cardinality log keys from dynamic
 * segments (e.g. `/markets/CXYZ` → `/markets/:id`).
 */
@Injectable()
export class RequestLoggerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    const method = req.method;
    const url = req.url;
    const ip = this.clientIp(req);

    // Redact sensitive headers before logging.
    const headers = this.safeHeaders(req);

    return next.handle().pipe(
      tap({
        next: () => {
          const durationMs = Date.now() - start;
          const route = (req.route as { path?: string } | undefined)?.path ?? url;
          const status = res.statusCode;
          if (process.env.NODE_ENV === 'production') {
            process.stdout.write(
              JSON.stringify({ level: 'log', ts: new Date().toISOString(), method, route, status, durationMs, ip, headers }) + '\n',
            );
          } else {
            // Human-readable in dev.
            // eslint-disable-next-line no-console
            console.log(`[http] ${method} ${route} ${status} ${durationMs}ms ip=${ip}`);
          }
        },
        error: (err: unknown) => {
          const durationMs = Date.now() - start;
          const route = (req.route as { path?: string } | undefined)?.path ?? url;
          const status = res.statusCode || 500;
          if (process.env.NODE_ENV === 'production') {
            process.stdout.write(
              JSON.stringify({ level: 'error', ts: new Date().toISOString(), method, route, status, durationMs, ip, headers, error: String(err) }) + '\n',
            );
          } else {
            // eslint-disable-next-line no-console
            console.error(`[http] ${method} ${route} ${status} ${durationMs}ms ip=${ip} error=${String(err)}`);
          }
        },
      }),
    );
  }

  private clientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.ip ?? 'unknown';
  }

  /** Returns a copy of the headers object with sensitive values redacted. */
  private safeHeaders(req: Request): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower === 'x-admin-key' || lower === 'cookie' || lower === 'authorization') {
        out[key] = '[redacted]';
      } else if (typeof value === 'string') {
        out[key] = value;
      }
    }
    return out;
  }
}
