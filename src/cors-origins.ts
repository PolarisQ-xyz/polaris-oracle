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
/** Returns true only for strings that look like a bare origin (scheme + host + optional port). */
function isValidOrigin(value: string): boolean {
  if (value === '*') return false;
  try {
    const url = new URL(value);
    // A valid origin has no pathname beyond '/', no search, no hash, and
    // must use http or https. Trailing slashes and embedded paths are
    // rejected: 'https://app.example.com/' !== 'https://app.example.com'
    // as far as browser Origin headers and the cors package are concerned.
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.pathname === '' || url.pathname === '/') &&
      url.search === '' &&
      url.hash === '' &&
      url.href === value
    );
  } catch {
    return false;
  }
}

export function resolveCorsOrigins(envValue: string | undefined): string[] {
  return (envValue ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .filter((o) => {
      if (!isValidOrigin(o)) {
        // Log but don't throw — a misconfigured entry silently never matches
        // (keeping the closed-by-default guarantee) but should be visible.
        console.warn(
          `[cors] ignoring malformed CORS_ORIGINS entry ${JSON.stringify(o)}: ` +
            `expected a bare origin like 'https://app.example.com' (no trailing slash, path, or wildcard)`,
        );
        return false;
      }
      return true;
    });
}
