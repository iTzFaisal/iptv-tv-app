# IPTV Web Player — Implementation Plan

> Browser-based IPTV player (live TV, movies, series) for an Xtream Codes account.
> Static frontend on **GitHub Pages** + one **Cloudflare Worker** as stream gateway.
> Users enter their own Xtream credentials at first run. Free forever.
>
> **Status:** ready for implementation (verified against the live provider on 2026-10-14).
> **Credentials:** live in `iptv.txt` (repo root, **gitignored — never commit**). This plan uses `<USER>` / `<PASS>` / `<PANEL_HOST>` placeholders.

---

## 1. Goal & scope

**v1 (this plan):**

- Enter Xtream credentials once → stored in browser `localStorage` → full catalog browsing + playback in browser.
- Live TV (8,647 channels, 98 categories), Series (8,991 series, 55 categories), Movies (17,082, 76 categories) — browse/search/favorite/resume.
- Playback without any IPTV player app: live via HLS, movies/series via direct file streaming.
- Export all links for other uses (M3U / CSV / JSON downloads).
- Deployable by: pushing repo → GitHub Pages; pasting one worker file → Cloudflare. Share = send the Pages URL.

**Out of scope v1 (documented in §11):** EPG, self-hosted remux backend, multiuser accounts, Chromecast.

**Known provider-side issue (as of 2026-10-14):** all movies 404 upstream (24 samples, both hosts, all URL patterns). Series + live work. The app must list movies gracefully and show "unavailable upstream" on play failure. Re-test after provider fixes.

---

## 2. Locked decisions

| Topic             | Decision                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack             | Vanilla HTML/CSS/ES-modules, **no build step**. `hls.js` vendored into repo.                                                                                                                                    |
| Hosting           | GitHub Pages (public repo = free). Video never flows through Pages.                                                                                                                                             |
| Stream gateway    | One Cloudflare Worker (free tier): https + CORS + server-side redirect following + retries.                                                                                                                     |
| Credentials       | `localStorage`, entered via setup screen, only ever sent to the panel and the user's own worker.                                                                                                                |
| Catalog cache     | IndexedDB (`iptv` db), TTL 24 h, manual refresh. (Catalog JSON is ~10s of MB — **too big for localStorage**.)                                                                                                   |
| Small state       | `localStorage`: creds, gateway URL, favorites, resume positions, settings.                                                                                                                                      |
| Gateway pluggable | Gateway setting supports: `worker` (workers.dev URL) or `direct` (use panel host as-is; works only when app is served over plain http, e.g. local dev) or a future self-hosted gateway. No rework needed later. |
| Theme             | Dark, mobile-first responsive.                                                                                                                                                                                  |

---

## 3. Verified provider facts (probed live — do not re-derive)

**Account:** active, expires 2027-10-05, **max_connections = 1** (single stream at a time!), allowed output formats `m3u8, ts, rtmp`. Panel is XUI 1.5.13.

**API (works over https, CORS `Access-Control-Allow-Origin: *`):**

```
https://<PANEL_HOST>/player_api.php?username=<USER>&password=<PASS>                  → user_info/server_info
  &action=get_live_categories | get_live_streams        → 98 cats / 8,647 channels
  &action=get_vod_categories  | get_vod_streams         → 76 cats / 17,082 movies
  &action=get_series_categories | get_series            → 55 cats / 8,991 series
  &action=get_series_info&series_id=<id>                → seasons/episodes (episode ids)
  (&action=get_short_epg — exists, untested, EPG future)
```

`get.php?username=…&type=m3u_plus&output=m3u8` also works over https (~79 MB playlist; not needed — app builds exports client-side).

**Stream hosts:** `b-4k.pics` (API) and `be2.it.com` (server_info url). Both serve streams. Stream requests always redirect **https → http://** → this is why a Worker is mandatory (mixed-content).

**Live streams:**

- `http://be2.it.com:80/live/<USER>/<PASS>/<id>.m3u8` → sometimes direct 200; usually `302 → /auth/<token>` → HLS manifest.
- Manifest: `#EXTM3U` + `#EXTINF:~10.12s` entries; segment URLs are **absolute paths** `/hls/i-<token>` → in a browser they resolve against the worker origin (see §5) and segments are open (no auth) `video/mp2t`.
- `…/<id>.ts` gives raw MPEG-TS (`video/mp2t`) — for exports only, browsers can't play raw TS.
- Old-style `http://be2.it.com:80/<USER>/<PASS>/<id>.ts|.m3u8` also valid (the panel's own M3U emits this).
- Codecs: **H.264 + AAC** (verified with ffprobe). Some channel variants are HEVC — fine, they'll be marked in the catalog by name only.

**Series:** `http://be2.it.com:80/series/<USER>/<PASS>/<episode_id>.mkv` → direct 200 or `302 → /vauth/<token>` → `video/x-matroska`, H.264 720p + AAC. Episode metadata (duration etc.) from `get_series_info`.

**Movies:** `http://be2.it.com:80/movie/<USER>/<PASS>/<id>.<ext>` → **all 404 today** (upstream broken). Container mix: mp4 12,550 / mkv 4,263 / avi 263 / mpg 3 / flv 2 / ts 1.

**Flakiness (must be handled):**

- Dead channels: empty `200` text/html or `404` — normal, ~40% of a random sample. Treat manifest failure as "offline".
- Transient `502` on segments; occasional flaky 302→404 chains → retry once or twice.

**Browser playback verified (Chrome 155 headless, 2026-10-14):**

- Live m3u8 through the redirect chain via hls.js: **played** (1024×576, zero errors).
- Series `.mkv` over http: **played** (1280×720, 50:41 duration, container parsed).

---

## 4. Architecture

```
GitHub Pages (https, static)            Cloudflare Worker (https, free)            Panel (http only)
┌───────────────────────────┐           ┌──────────────────────────────┐           ┌──────────────────┐
│  App UI (vanilla JS)      │           │  /hls/*   → panel /hls/*     │           │ b-4k.pics (API)  │
│  ├─ catalog via API ──────┼── https ──┼──(direct, CORS ok)───────────┼── http ──▶│ be2.it.com       │
│  ├─ player: hls.js/native ┼── https ──┼── /s/* → panel live/movie/   │           │  (streams,       │
│  ├─ localStorage state    │           │          series (+302 follow,│           │   /auth /vauth)  │
│  └─ export M3U/CSV/JSON   │           │          retries, Range)     │           └──────────────────┘
└───────────────────────────┘           └──────────────────────────────┘
```

- **Catalog:** fetched **directly** from the panel over https (verified working + CORS). No worker involved.
- **Playback:** always through the worker (solves mixed content; worker follows `/auth` + `/vauth` redirects server-side, normalizes flakiness).
- **Exports:** generated client-side from catalog data (no 79 MB download needed).

---

## 5. Worker specification (`worker/cloudflare-worker.js`)

**Upstream allow-list (hardcoded):** `be2.it.com` (primary), `b-4k.pics` (fallback). Anything else → 404. Not an open proxy.

**Routes:**
| Route | Upstream | Notes |
|---|---|---|
| `GET /hls/<rest>` | `http://be2.it.com/hls/<rest>` (fallback `b-4k.pics`) | HLS segments; pass through bytes + content-type; retry once on 5xx _before first byte_. |
| `GET /s/<rest>` | `http://be2.it.com/<rest>` | For `live/…m3u8`, `movie/…`, `series/…`; follow redirects (`redirect: "follow"`); retry up to 2× on 5xx / empty-body-200 / html-error when upstream content should be media; flip to fallback host on last retry. |
| `OPTIONS *` | – | CORS preflight. |
| anything else | – | 404. |

**Headers:**

- Always: `Access-Control-Allow-Origin: *`; `Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges`.
- Forward from client: `Range` (seeking for VOD/series).
- Strip: `Cookie`, client `Origin`, hop-by-hop.
- Use a fixed desktop-browser `User-Agent` (panel is UA-insensitive; stable is better).
- `Cache-Control: no-store` on responses.

**Rules:**

- **Never log path/query** — credentials are embedded in paths.
- Retry recipe: `200 + text/html + 0 bytes` = dead stream → return it as `404` to the app (so the UI can mark offline); `5xx` → retry; browser-visible responses should be clean.
- Workers free limits are fine (100k req/day; a viewer costs ~500 req/h). Note in README.

**Local dev:** `npx wrangler dev worker/cloudflare-worker.js` → `http://127.0.0.1:8787`; app gateway = that URL. (Wrangler is a dev-time `npx` tool only; not required to build the app.)

---

## 6. Frontend specification

**Screens**

1. **Setup** (first run + Settings): host, username, password, gateway mode (worker URL or direct), **Test connection** (shows status, expiry, active connections). Export/import settings string (backup for iOS storage eviction).
2. **Live**: category chips + channel grid (lazy chunk rendering), search, favorites toggle, offline badge.
3. **Movies**: grid + category + search; poster from `stream_icon`; playable badge logic (§compat).
4. **Series**: grid → detail (seasons/episodes via `get_series_info`) → play episode.
5. **Player**: inline page (not modal on mobile): play/pause, seek (VOD), fullscreen, PiP, next episode (series), channel zapping next/prev (live).
6. **Favorites**: unified list of live/movies/series.
7. **Export**: buttons → downloads:
   - `playlist-all.m3u` (Xtream-style URLs: `http://be2.it.com:80/<USER>/<PASS>/<id>` for live; `/movie/…`, `/series/…` for VOD)
   - `live-hls.m3u` (live links as `.m3u8` for modern players)
   - `catalog.csv`, `catalog.json` (id, type, name, category, added, rating, poster, container)
   - UTF-8 / Arabic names preserved (`#EXTM3U`, CRLF).

**Storage schema**

- `localStorage['iptv.creds']` → `{host, username, password}`
- `localStorage['iptv.gateway']` → `{mode:'worker'|'direct', url}`
- `localStorage['iptv.favorites']` → `[{kind, id, name, icon}]`
- `localStorage['iptv.history']` → `{key: {pos, dur, updatedAt, title, kind, seriesId?, season?, episodeNum?}}` (key = `live:<id>` / `movie:<id>` / `ep:<episodeId>`)
- `localStorage['iptv.settings']` → `{autoplay, lastTab}`
- IndexedDB `iptv` → store `catalog` → keys `live|vod|series|categories` with `{fetchedAt, data}`; TTL 24 h + Refresh button.

**Player rules**

- Live: `Hls.isSupported()` → hls.js (`{enableWorker:true, backBufferLength:30}` + built-in error recovery); else if `canPlayType('application/vnd.apple.mpegurl')` (iOS/Safari) → native `video.src`.
- VOD mp4 → native playback. MKV → native on Chromium; see compat below.
- **Single connection (critical, provider allows 1):** one global `stopPlayback()` called before every new stream; verify with API `active_cons` ≤ 1 while zapping.
- Resume: save position every 10 s for movies/episodes; offer "Resume from 12:34?".
- Live failure → after retries, mark channel "offline" locally (IndexedDB soft flag + badge with date), let user retry anyway. Movies play failure → "Available later — provider issue" info (not an error-looking screen).

**Compatibility detection (`js/compat.js`)**
| Browser engine | Live HLS | mp4 | MKV |
|---|---|---|---|
| Chromium (Chrome/Edge desktop & Android) | ✅ hls.js | ✅ | ✅ (verified) |
| Gecko (Firefox) | ✅ hls.js | ✅ | ⛔ |
| WebKit macOS (Safari) | ✅ native HLS | ✅ | ⛔ |
| WebKit iOS (all browsers) | ✅ native HLS | ✅ | ⛔ |

- Detect via UA + `Hls.isSupported()`/`canPlayType`; show ⛔ badge on all series episodes (they're `.mkv`) and mkv movies in Gecko/WebKit, with a one-line explanation ("MKV not supported by this browser — use Chrome or Android").

**Performance:** catalog render chunked (100 items + IntersectionObserver auto-load), search debounced 200 ms, images lazy (`loading="lazy"`).

---

## 7. Repo structure

```
PLAN.md                      ← this file (safe to commit; no secrets)
README.md                    ← public setup/deploy guide (worker deploy, pages enable, first run)
.gitignore                   ← .DS_Store + iptv.txt (update existing)
index.html
app/
  app.css
  app.js                     ← bootstrap/router
  js/api.js                  ← Xtream client (account, catalog, series_info, epg-later)
  js/store.js                ← localStorage + IndexedDB helpers
  js/catalog.js              ← load/cache/refresh catalog
  js/ui.js                   ← DOM helpers, list rendering, badges
  js/compat.js               ← capability detection
  js/player.js               ← hls.js/native, single-connection guard, resume
  js/export.js               ← M3U/CSV/JSON generators + download
  vendor/hls.min.js          ← vendored hls.js v1.x (no CDN dependency)
worker/
  cloudflare-worker.js
test/
  playback-check.html        ← manual/Playwright harness (see Appendix B)
  worker-check.sh            ← curl probes for deployed worker
```

---

## 8. Implementation phases

**P0 — Scaffold (small)**

- [ ] Update `.gitignore` (add `iptv.txt`), create README skeleton, index.html shell, vendored hls.js, base dark CSS.

**P1 — Worker**

- [ ] Implement `worker/cloudflare-worker.js` per §5.
- [ ] `npx wrangler dev` smoke test with `curl` against `/s/live/…m3u8` (expect manifest), `/hls/…` (expect `video/mp2t`), `/s/series/…mkv` range request (expect 200/206).
- [ ] `test/worker-check.sh` passing locally.

**P2 — Data layer + Setup**

- [ ] `api.js` (account/catalog/series_info), `store.js`, `catalog.js` (IndexedDB + TTL).
- [ ] Setup screen + Test connection (status/expiry/active_cons) + gateway mode selection.

**P3 — Browse UI**

- [ ] Live/Movies/Series grids, categories, search, favorites. Counts must match §3.

**P4 — Player**

- [ ] hls.js/native live playback; native VOD/series; badges; single-connection guard; resume; offline marking; next-episode; zapping.

**P5 — Export**

- [ ] M3U (all), M3U (live HLS), CSV, JSON downloads; Arabic-safe.

**P6 — Polish + ship**

- [ ] Mobile pass, settings import/export string, README deploy guide, acceptance tests (§9), deploy Worker + Pages, phone test.

---

## 9. Acceptance criteria (definition of done)

1. From the **deployed** Pages URL: live channel plays on Chrome desktop through the worker (manifest + segments, no mixed-content errors).
2. Series `.mkv` episode plays in Chrome via worker; seeking works (Range → 206). Badge shown on Safari/Firefox instead of failing silently.
3. iPhone Safari: live TV plays (native HLS); mp4 movies play; series shows the MKV advisory.
4. Android Chrome: live + an MKV episode play.
5. Catalog counts = 8,647 / 17,082 / 8,991; search + categories work; cache refresh works.
6. `active_cons` never exceeds 1 while switching channels/streams (check via API).
7. Exports: `playlist-all.m3u` opens in VLC with correct Arabic names; `live-hls.m3u` spot-checks in a second player.
8. Dead channel → offline badge after failed retries; movie → friendly "unavailable upstream" notice.
9. Worker: rejects non-panel paths (404), adds CORS everywhere, no credentials in logs.
10. Test harness (`test/playback-check.html`) passes on desktop Chrome.

---

## 10. Deployment guide (goes into README.md)

1. **Worker:** dash.cloudflare.com → Workers & Pages → Create → paste `worker/cloudflare-worker.js` → Deploy → copy `https://<name>.<subdomain>.workers.dev`. (Alt: `npx wrangler deploy`.)
2. **Pages:** push repo (public) → Settings → Pages → Deploy from branch → `main` / root. URL: `https://<user>.github.io/iptv-tv-app/`.
3. **First run:** open the Pages URL → enter Panel host (`http://b-4k.pics:80`), username, password, worker URL → Test → Save.
4. Remember: `iptv.txt` must stay untracked (`.gitignore` enforced). Public repo contains no secrets.

---

## 11. Future / optional (not v1)

- **Self-hosted ffmpeg gateway** (Docker, `ffmpeg -c copy` → fMP4/HLS) for MKV on iOS/Safari/Firefox. Same gateway interface (app just points at another gateway URL). Free compute options if ever wanted: Oracle Cloud Always Free (10 TB/mo egress), or local Mac.
- **EPG** via `get_short_epg` / `get_simple_data_table` (panel supports it).
- **Chromecast / AirPlay** (Remote Playback API), background channel prober, parental filters.
- Movies: auto-recheck playability (they 404 today; poll occasionally and badge them once healed).

---

## Appendix A — Provider quirks cheat-sheet (placeholders, no secrets)

```
API      https://<PANEL_HOST>/player_api.php?username=<USER>&password=<PASS>[&action=…]
Live     http://be2.it.com:80/live/<USER>/<PASS>/<id>.m3u8   (302 → /auth/<tok> → #EXTM3U, segments "/hls/i-…")
         http://be2.it.com:80/live/<USER>/<PASS>/<id>.ts     (video/mp2t; exports only)
         http://be2.it.com:80/<USER>/<PASS>/<id>.ts|.m3u8    (panel's own playlist format)
Movie    http://be2.it.com:80/movie/<USER>/<PASS>/<id>.<ext>  (ext from catalog; all 404 today)
Series   http://be2.it.com:80/series/<USER>/<PASS>/<episode_id>.mkv
Worker   https://<worker>/s/live/<USER>/<PASS>/<id>.m3u8
         https://<worker>/hls/<segment>        ← manifest segment paths resolve here
         https://<worker>/s/series/<USER>/<PASS>/<episode_id>.mkv
```

Error signatures: dead channel → empty `200 text/html` or `404`; transient `502`; flaky `302→404`. Retry logic per §5.

## Appendix B — Playback test harness (proven recipe)

`test/playback-check.html`: loads hls.js, then:

1. attach hls.js to a known-good channel (`/live/<USER>/<PASS>/526337.m3u8`, expect `playing`, videoWidth/Height, no errors)
2. then set `video.src` to a known series episode (`/series/<USER>/<PASS>/900353.mkv`, expect `loadedmetadata` 1280×720 + `playing`)
   Results recorded on `window.__RESULTS`; readable via Playwright.

Playwright routine (verified 2026-10-14, Chrome 155 headless):

```
launch headless Chrome with --remote-debugging-port; playwright-cli attach --cdp
serve a page over http://localhost (python3 -m http.server) so http streams aren't blocked
run the harness; read window.__RESULTS
```

Known-good samples: channel `526337`, episode `900353` (series 22687). Use a fresh channel if either goes offline.
