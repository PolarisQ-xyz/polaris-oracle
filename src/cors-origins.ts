/**
 * Parses `CORS_ORIGINS` into an explicit allowlist for `enableCors({ origin,
 * credentials: true })`. Deliberately returns `[]` — never `true`/`*` — when
 * unset: this API sets a session cookie (`polaris_session`), so
 * `credentials: true` is on, and `cors` reflects the request's `Origin`
 * verbatim whenever `origin` is `true`. Reflecting any origin with
 * credentials on lets any website ride a signed-in user's session cookie
 * (read responses, trigger sponsored trades). An empty allowlist fails
 * closed instead, the way `AdminGuard` fails closed on a missing
 * `ADMIN_API_KEY`.
 */
export function resolveCorsOrigins(envValue: string | undefined): string[] {
  return (envValue ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      // Strip a trailing slash so "https://app.example.com/" matches the
      // browser Origin "https://app.example.com".
      const normalized = o.endsWith('/') ? o.slice(0, -1) : o;
      // Warn about entries that can never match a browser Origin header.
      if (normalized === '*') {
        console.warn(
          'cors-origins: "*" in CORS_ORIGINS does not enable wildcard mode — ' +
            'it is treated as a literal origin and will never match. ' +
            'Remove it or set CORS_ORIGINS to a comma-separated list of exact origins.',
        );
      } else if (normalized.includes('/')) {
        console.warn(
          `cors-origins: "${normalized}" contains a path and will never match a browser Origin header. ` +
            'Origins must be scheme+host+optional-port only (e.g. "https://app.example.com").',
        );
      }
      return normalized;
    });
}
