/**
 * The one CORS policy this relay answers with.
 *
 * It exists because there are two places that reply to a preflight — the pairing
 * module, which sees the request first, and the proxy behind it — and they drifted.
 * The pairing module allowed a narrower set of headers, so it shadowed the correct
 * answer for every /api/ route and the desktop app's requests, which carry
 * X-OpenCode-Target and X-OpenCode-Directory, were blocked by the browser before
 * they were ever sent. The relay looked healthy from a shell the whole time,
 * because curl does not enforce CORS and the phone talks to a page the relay
 * itself serves, which is same-origin and never preflights.
 *
 * Any header the client sends or reads belongs in one of these two lists.
 */

// Sent by the client. A header missing here makes the whole request fail with a
// bare "Failed to fetch", naming nothing.
export const ALLOWED_REQUEST_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-OpenCode-Directory",
  "X-OpenCode-Target",
];

// Read off the response. A header missing here is not an error anywhere: it just
// reads back as null, which turned pagination into a silent single page.
export const EXPOSED_RESPONSE_HEADERS = [
  "X-Next-Cursor",
  "X-OpenCode-Directory",
  "X-OpenCode-Target",
];

export const ALLOWED_METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"];

export const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

/** Headers for a preflight (OPTIONS) reply. */
export function preflightHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS.join(","),
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS.join(","),
    "Access-Control-Expose-Headers": EXPOSED_RESPONSE_HEADERS.join(","),
    "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
  };
}

/** Headers to put on an actual response, so its custom headers stay readable. */
export function responseHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": EXPOSED_RESPONSE_HEADERS.join(","),
  };
}
