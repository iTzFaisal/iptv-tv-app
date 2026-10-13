# IPTV Web Player

A browser-based IPTV player for an **Xtream Codes** account: live TV, movies and
series — browse, search, favorite, resume and play, without installing an IPTV app.
Static frontend on **GitHub Pages** + one tiny **Cloudflare Worker** as stream
gateway. Free forever.

- **Live TV** (8,000+ channels with categories, search, favorites, offline badges)
- **Movies** (poster grid, categories, search)
- **Series** (seasons/episodes from the panel, next-episode autoplay)
- **Resume** movies/episodes where you left off (saved in your browser)
- **Export** M3U / CSV / JSON catalogs built client-side (Arabic-safe UTF-8)
- **Dark, mobile-first** UI. Works in Chrome/Edge, Safari and Firefox
  (MKV playback needs a Chromium browser — see [Compatibility](#compatibility)).

Your credentials never leave your browser except to talk to your provider's panel
and your own Worker. There is no server of ours, no analytics, no accounts.

---

## How it works

```
GitHub Pages (static UI)          Cloudflare Worker (stream gateway)        Provider panel
┌──────────────────────┐          ┌───────────────────────────────┐        ┌────────────────┐
│ catalog + UI (JS)    │── https ─│ /s/*   → live/movie/series    │─ http ─▶│ be2.it.com /   │
│ player (hls.js)      │── https ─│ /hls/* → HLS segments         │        │ b-4k.pics      │
│ localStorage + IDB   │          │ follows 302s, retries, CORS   │        └────────────────┘
└──────────────────────┘          └───────────────────────────────┘
```

Provider streams are plain **http** and redirect `https → http`, which browsers
block as mixed content on an https page. The Worker solves that and also cleans
up the provider's flaky moments (dead channels, transient 502s).

## Deploy (once, ~5 minutes)

### 1. Cloudflare Worker (stream gateway)

Free tier, no card required.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Worker**.
2. Give it a name (e.g. `iptv-gateway`) → **Deploy**.
3. **Edit code** and replace the contents with this repo's
   [`worker/cloudflare-worker.js`](worker/cloudflare-worker.js) → **Deploy**.
4. Copy the URL shown, e.g. `https://iptv-gateway.<your-subdomain>.workers.dev`.

Prefer the CLI? `npx wrangler login && npx wrangler deploy` — the repo ships a
`wrangler.toml` (worker name `iptv-gateway`) so this just works. Rename it there
if you like.

> Free tier limits are fine for personal use: 100,000 requests/day, while a
> viewer costs roughly 500 requests/hour.

### 2. GitHub Pages (the app)

1. Push this repo to GitHub (public is fine — there are no secrets in it).
2. **Settings** → **Pages** → Source: *Deploy from a branch* → `main` / `(root)`.
3. Your app is at `https://<your-user>.github.io/<repo-name>/`.

### 3. First run

Open the Pages URL and fill in:

| Field | Example |
|---|---|
| Panel host | `http://b-4k.pics:80` |
| Username / Password | your Xtream credentials |
| Gateway | paste the Worker URL from step 1 |

Hit **Test connection** (you should see status/expiry/active connections), then
**Save**. The catalog downloads once and is cached in your browser for 24 h.

> **Never commit credentials.** `iptv.txt` in the repo root is gitignored; keep it
> that way.

---

## Local development

The catalog API is CORS-enabled, but streams are http-only — so when testing
locally either use the Worker (recommended) or serve the app over plain http.

```bash
# 1. stream gateway (dev)
npx wrangler dev worker/cloudflare-worker.js --port 8787

# 2. static app over http
python3 -m http.server 8000
# open http://localhost:8000/
```

In **Settings → Stream gateway** pick:

- **Worker URL** → `http://127.0.0.1:8787` (works over https pages too), or
- **Direct panel host** → only when the page itself is served over http
  (`http://localhost`) — the browser blocks mixed content otherwise.

Worker smoke tests:

```bash
test/worker-check.sh                                     # local wrangler dev
BASE=https://iptv-gateway.you.workers.dev test/worker-check.sh
```

Playback harness (hls.js live + MKV episode in one page, results in
`window.__RESULTS`):

```bash
python3 -m http.server 8080
# http://localhost:8080/test/playback-check.html?user=…&pass=…&channel=526337&episode=900353
```

---

## Compatibility

| Browser | Live TV (HLS) | MP4 movies | MKV movies/series |
|---|---|---|---|
| Chrome / Edge (desktop, Android) | ✅ hls.js | ✅ | ✅ |
| Firefox (desktop, Android) | ✅ hls.js | ✅ | ⛔ |
| Safari (macOS, iOS — all browsers) | ✅ native HLS | ✅ | ⛔ |

- On engines that can't decode MKV, the app shows a ⛔ badge with an explanation
  instead of failing silently. Use Chrome or an Android device for series.
- **Single connection:** most Xtream accounts allow only one stream at a time.
  The player always stops the previous stream before starting another; still,
  don't play two tabs at once.
- **Movies upstream issue:** as of 2026-10-14 the provider's movie servers return
  404 for all movie links (provider-side — series and live are fine). The app
  lists movies gracefully and shows a friendly "not available right now" notice
  on play failure.

## Exports

From **Export**:

- `playlist-all.m3u` — live channels (Xtream format) + movies + cached series episodes
- `live-hls.m3u` — live channels as `.m3u8`
- `playlist-series.m3u` — all episodes (first run fetches episode ids from the
  panel, a few minutes; cached afterwards, resumable)
- `catalog.csv` / `catalog.json` — full catalog with metadata

All built in your browser, UTF-8 with CRLF, so Arabic names survive in VLC and
Excel. The URLs embed your username/password — treat the files as secrets.

## Privacy & security

- Credentials live in your browser's `localStorage`; they're sent only to the
  panel API and your own Worker.
- The Worker only proxies the provider's hosts — it is not an open proxy — and
  never logs paths (credentials ride in the path).
- Settings can be backed up as a base64 string (Settings → Backup) for when a
  device clears website storage.
- Nothing is committed to this repo except code: `iptv.txt` is gitignored.

## Repo layout

```
index.html               app shell
app/app.js               bootstrap, router, views
app/app.css              dark mobile-first theme
app/js/api.js            Xtream API client + URL builders
app/js/catalog.js        catalog cache (IndexedDB, 24 h TTL) + episode crawler
app/js/store.js          localStorage + IndexedDB helpers, backup strings
app/js/compat.js         browser capability detection (HLS/MKV)
app/js/player.js         hls.js/native player, single-connection guard, resume
app/js/ui.js             DOM helpers, toasts, chunked grid renderer
app/js/export.js         M3U/CSV/JSON generators
app/vendor/hls.min.js    vendored hls.js (no CDN dependency)
worker/cloudflare-worker.js   the stream gateway (deploy this)
test/playback-check.html      manual/Playwright playback harness
test/worker-check.sh          curl probes for the gateway
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Stream gateway not configured" on play | Settings → paste your Worker URL (or use direct mode on `http://localhost`). |
| Live channel shows "offline" | The channel is dead provider-side (≈40% of random channels are). The badge clears when it plays again; retry any time. |
| Series won't play in Safari/Firefox | MKV isn't supported there — that's what the ⛔ badge means. Use Chrome/Android. |
| Movies don't play | Provider-side outage (see above); retry in **Settings → Catalog cache → Refresh**. |
| Channel logos missing | The provider's logo server has a broken TLS certificate — the app falls back to a placeholder icon. Playback is unaffected. |
| Everything fails after working | Re-run **Test connection** in Settings; if the account expired, renew with your provider. |
| iPhone: settings lost after a while | iOS evicts storage for unused sites; use **Settings → Backup → Generate string** and keep it safe. |
