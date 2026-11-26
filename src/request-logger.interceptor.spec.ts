import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { RequestLoggerInterceptor } from './request-logger.interceptor';

function makeContext(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        url: '/test',
        ip: '127.0.0.1',
        headers,
        route: { path: '/test' },
      }),
      getResponse: () => ({ statusCode: 200 }),
    }),
  } as unknown as ExecutionContext;
}

function makeHandler(): CallHandler {
  return { handle: () => of({}) };
}

describe('RequestLoggerInterceptor', () => {
  let interceptor: RequestLoggerInterceptor;
  let logLines: string[];
  let originalWrite: typeof process.stdout.write;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    interceptor = new RequestLoggerInterceptor();
    logLines = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    // Capture structured log output.
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  it('logs method, route, status and durationMs', (done) => {
    const ctx = makeContext();
    interceptor.intercept(ctx, makeHandler()).subscribe({
      complete: () => {
        expect(logLines.length).toBeGreaterThan(0);
        const entry = JSON.parse(logLines[0]);
        expect(entry.method).toBe('GET');
        expect(entry.route).toBe('/test');
        expect(entry.status).toBe(200);
        expect(typeof entry.durationMs).toBe('number');
        done();
      },
    });
  });

  it('never logs x-admin-key in the headers field', (done) => {
    const ctx = makeContext({ 'x-admin-key': 'supersecret', 'content-type': 'application/json' });
    interceptor.intercept(ctx, makeHandler()).subscribe({
      complete: () => {
        const raw = logLines.join('\n');
        expect(raw).not.toContain('supersecret');
        const entry = JSON.parse(logLines[0]);
        expect(entry.headers['x-admin-key']).toBe('[redacted]');
        expect(entry.headers['content-type']).toBe('application/json');
        done();
      },
    });
  });

  it('never logs cookie values', (done) => {
    const ctx = makeContext({ cookie: 'polaris_session=abc123; Path=/' });
    interceptor.intercept(ctx, makeHandler()).subscribe({
      complete: () => {
        const raw = logLines.join('\n');
        expect(raw).not.toContain('abc123');
        const entry = JSON.parse(logLines[0]);
        expect(entry.headers['cookie']).toBe('[redacted]');
        done();
      },
    });
  });

  it('reads client IP from x-forwarded-for when present', (done) => {
    const ctx = makeContext({ 'x-forwarded-for': '203.0.113.42, 10.0.0.1' });
    interceptor.intercept(ctx, makeHandler()).subscribe({
      complete: () => {
        const entry = JSON.parse(logLines[0]);
        expect(entry.ip).toBe('203.0.113.42');
        done();
      },
    });
  });
});
