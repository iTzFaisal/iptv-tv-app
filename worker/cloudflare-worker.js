/**
 * IPTV stream gateway — Cloudflare Worker (single file, deploy by pasting into the dashboard).
 *
 * Why this exists
 *   The provider's stream hosts only speak plain http, and playback requests
 *   redirect https -> http (mixed content). Browsers refuse that. This worker
 *   sits in between: the browser talks https to the worker, the worker talks
 *   http to the panel, follows the /auth + /vauth redirects server-side and
 *   retries the provider's transient 5xx / empty-html failures.
 *
 * Routes
 *   GET /s/<rest>    -> http://<host>/<rest>       streams (live/movie/series), follows redirects
 *   GET /hls/<rest>  -> http://<host>/hls/<rest>   HLS segments referenced by manifests
 *   OPTIONS *        -> CORS preflight
 *   anything else    -> 404
 *
 * Design rules (do not break these)
 *   - Upstream hosts are hard-coded below. This is NOT an open proxy.
 *   - Credentials live inside the URL path, so this worker never logs the
 *     path or query string. Keep it that way.
 *   - Browser-visible errors should be clean: dead streams become 404,
 *     transient upstream errors become the upstream status after retries.
 *
 * Local dev:  npx wrangler dev worker/cloudflare-worker.js --port 8787
 * Deploy:     paste this file into dash.cloudflare.com > Workers & Pages > Create
 *             (or: npx wrangler deploy worker/cloudflare-worker.js)
 */

const PRIMARY_HOST = "be2.it.com";
const FALLBACK_HOST = "b-4k.pics";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges",
};

// Headers worth passing back to the browser (media bytes are streamed, not copied).
const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return preflight();
    if (method !== "GET" && method !== "HEAD") return notFound();

    const match = url.pathname.match(/^\/(s|hls)\/(.+)$/);
    if (!match) return notFound();

    const route = match[1];
    const inner = match[2];
    if (inner.includes("..")) return notFound();
    // /s/<rest>   -> http://host/<rest>
    // /hls/<rest> -> http://host/hls/<rest>   (segment paths in manifests)
    const rest = (route === "hls" ? "hls/" : "") + inner + url.search;

    // Attempt sequence: /s/* retries once on the primary host, then flips to
    // the fallback host. /hls/* retries once, directly on the fallback host.
    const hosts =
      route === "hls"
        ? [PRIMARY_HOST, FALLBACK_HOST]
        : [PRIMARY_HOST, PRIMARY_HOST, FALLBACK_HOST];

    let lastResponse = null;
    let lastError = null;

    for (let i = 0; i < hosts.length; i++) {
      const isLast = i === hosts.length - 1;
      let response;
      try {
        response = await fetchUpstream(hosts[i], rest, request);
      } catch (err) {
        lastError = err;
        if (isLast) break;
        continue;
      }

      if (request.method === "HEAD") {
        // No body to inspect; 5xx is still worth a retry.
        if (response.status >= 500 && !isLast) {
          lastResponse = response;
          continue;
        }
        return passThrough(response);
      }

      // Upstream 5xx: transient, retry.
      if (response.status >= 500) {
        lastResponse = response;
        if (isLast) break;
        continue;
      }

      // 404: might be a flaky 302 -> 404 chain; retry exactly once.
      if (response.status === 404 && i === 0) {
        lastResponse = response;
        continue;
      }

      // Dead-stream signature: 200 with an html body (often empty) or zero
      // bytes. Report as 404 so the app can mark the channel offline.
      if (await looksDead(response)) {
        return textResponse("stream is not available upstream", 404);
      }

      return passThrough(response);
    }

    if (lastResponse && lastResponse.status < 500) return passThrough(lastResponse);
    if (lastResponse) return passThrough(lastResponse);
    return textResponse(
      lastError ? "upstream unreachable" : "upstream error",
      502
    );
  },
};

/* ------------------------------------------------------------------ */

function fetchUpstream(host, pathAndQuery, request) {
  const headers = new Headers();
  headers.set("user-agent", USER_AGENT);
  headers.set("accept", "*/*");
  // Forward Range/If-Range so video seeking works (VOD, series episodes).
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const ifRange = request.headers.get("if-range");
  if (ifRange) headers.set("if-range", ifRange);

  return fetch(`http://${host}/${pathAndQuery}`, {
    method: request.method.toUpperCase() === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "follow",
  });
}

async function looksDead(response) {
  if (response.status !== 200) return false;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (type.includes("text/html")) return true; // dead channel page / error page
  const length = response.headers.get("content-length");
  if (length === "0") return true; // empty 200
  return false;
}

function passThrough(response) {
  const headers = new Headers(CORS_HEADERS);
  for (const name of PASSTHROUGH_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Range, If-Range, Content-Type",
      "access-control-max-age": "86400",
    },
  });
}

function notFound() {
  return textResponse("not found", 404);
}

function textResponse(body, status) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
