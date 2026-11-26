import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { AppLoggerService } from './logger.service';
import { resolveCorsOrigins } from './cors-origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new AppLoggerService() });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const origins = resolveCorsOrigins(process.env.CORS_ORIGINS);
  if (origins.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      '[cors] CORS_ORIGINS not set — rejecting all cross-origin requests. ' +
        'Do not fall back to reflecting the request Origin here: this API now ' +
        'sets a session cookie (polaris_session) and `credentials: true` is ' +
        'required for the browser to send it, so `origin: true` + `credentials: ' +
        'true` would let any website on the internet ride a signed-in user\'s ' +
        'session (read it and trigger sponsored trades, e.g. transfer) — CORS ' +
        'is the only thing standing between a stranger\'s browser and that ' +
        'cookie. Fail closed instead, the way AdminGuard fails closed on a ' +
        'missing ADMIN_API_KEY.',
    );
  }
  app.enableCors({
    // `credentials: true` is what lets the browser actually send the
    // `polaris_session` cookie cross-origin (frontend :3000 -> backend
    // :3001) — without it, fetch's `credentials: 'include'` on the
    // frontend has nothing to work with. Because credentials are on, origin
    // must be an explicit allowlist, never `true`/`*` — `cors` reflects the
    // request's Origin verbatim when `origin: true`, which combined with
    // `credentials: true` lets any site ride the session cookie. An unset
    // CORS_ORIGINS fails closed (empty allowlist) rather than open.
    origin: origins,
    credentials: true,
  });

  // Defense-in-depth security headers for a JSON API (issue #26).
  // No helmet dependency needed; these are the defaults helmet would set.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });

  const port = Number(process.env.PORT ?? 3000);
  // Fly.io's proxy reaches machines over private IPv6 — an IPv4-only bind
  // ('0.0.0.0' or omitted) is unreachable despite the process reporting
  // "started". Bind the wildcard IPv6 address instead.
  await app.listen(port, '::');
  // eslint-disable-next-line no-console
  console.log(`polaris-oracle listening on [::]:${port}`);
}

// Node ≥15 turns unhandled promise rejections into uncaught exceptions that
// crash the process — but the message is a generic "unhandledRejection" dump.
// Catch them here so we can log a structured message before the process exits,
// making it clear what crashed (boot failure, misconfig, etc.) rather than
// forcing the operator to parse a Node stack dump. (#168)
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[polaris-oracle] unhandled promise rejection — process will exit:', reason);
  process.exitCode = 1;
});

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[polaris-oracle] bootstrap() failed — process will exit:', err);
  process.exit(1);
});
