// Xtream Codes API client + stream URL builders.
//
// Catalog calls go straight to the panel over https (the panel sends
// `Access-Control-Allow-Origin: *`). Streams are plain http and always
// redirect https -> http, so playback goes through the configured gateway.

export const STREAM_HOST = "be2.it.com:80";

/* ------------------------------ panel/api URL ----------------------------- */

export function normalizeHost(host) {
  let h = String(host || "").trim().replace(/\/+$/, "");
  if (!h) return "";
  if (!/^https?:\/\//i.test(h)) h = "http://" + h;
  try {
    return new URL(h).origin;
  } catch {
    return "";
  }
}

export function apiBase(host) {
  const normalized = normalizeHost(host);
  if (!normalized) throw new Error("Panel host is empty");
  const url = new URL(normalized);
  // The panel API is reachable over https with CORS enabled (verified).
  return "https://" + url.hostname;
}

async function apiGet(creds, action, params = {}) {
  const url = new URL(apiBase(creds.host) + "/player_api.php");
  const sp = url.searchParams;
  sp.set("username", creds.username);
  sp.set("password", creds.password);
  if (action) sp.set("action", action);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) sp.set(key, String(value));
  }

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Panel API returned HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Panel returned a non-JSON response (wrong host or credentials?)");
  }
}

/* ------------------------------ account info ------------------------------ */

export async function testConnection(creds) {
  const data = await apiGet(creds);
  const info = data && data.user_info;
  if (!info || info.user_info === undefined && info.auth === undefined) {
    throw new Error("Unexpected API response — is this an Xtream panel host?");
  }
  if (String(info.auth) === "0") {
    throw new Error("Credentials rejected by the panel");
  }
  const server = data.server_info || {};
  return {
    status: info.status || "unknown",
    expDate: Number(info.exp_date) || null,
    maxConnections: Number(info.max_connections) || null,
    activeCons: Number(info.active_cons) || 0,
    isTrial: String(info.is_trial) === "1",
    allowedFormats: info.allowed_output_formats || [],
    serverUrl: server.url || "",
    serverPort: server.port || "",
    timezone: server.timezone || "",
  };
}

/* --------------------------------- catalog -------------------------------- */

export async function getLiveCategories(creds) {
  const arr = (await apiGet(creds, "get_live_categories")) || [];
  return arr.map((c) => ({ id: String(c.category_id), name: c.category_name || "" }));
}

export async function getLiveStreams(creds, categoryId) {
  const arr =
    (await apiGet(creds, "get_live_streams", categoryId ? { category_id: categoryId } : {})) || [];
  return arr.map((s) => ({
    type: "live",
    id: String(s.stream_id),
    name: s.name || "",
    num: s.num ?? null,
    icon: s.stream_icon || "",
    cat: String(s.category_id ?? ""),
    added: s.added || "",
    epgChannelId: s.epg_channel_id || null,
  }));
}

export async function getVodCategories(creds) {
  const arr = (await apiGet(creds, "get_vod_categories")) || [];
  return arr.map((c) => ({ id: String(c.category_id), name: c.category_name || "" }));
}

export async function getVodStreams(creds, categoryId) {
  const arr =
    (await apiGet(creds, "get_vod_streams", categoryId ? { category_id: categoryId } : {})) || [];
  return arr.map((s) => ({
    type: "movie",
    id: String(s.stream_id),
    name: s.name || s.title || "",
    icon: s.stream_icon || "",
    cat: String(s.category_id ?? ""),
    added: s.added || "",
    rating: Number(s.rating) || 0,
    ext: (s.container_extension || "mp4").toLowerCase(),
  }));
}

export async function getSeriesCategories(creds) {
  const arr = (await apiGet(creds, "get_series_categories")) || [];
  return arr.map((c) => ({ id: String(c.category_id), name: c.category_name || "" }));
}

export async function getSeriesList(creds, categoryId) {
  const arr =
    (await apiGet(creds, "get_series", categoryId ? { category_id: categoryId } : {})) || [];
  return arr.map((s) => ({
    type: "series",
    id: String(s.series_id),
    name: s.name || s.title || "",
    icon: s.cover || "",
    cat: String(s.category_id ?? ""),
    added: s.last_modified || "",
    rating: Number(s.rating) || 0,
    plot: s.plot || "",
    cast: s.cast || "",
    director: s.director || "",
    genre: s.genre || "",
    releaseDate: s.releaseDate || s.release_date || "",
  }));
}

/* ------------------------------- series info ------------------------------ */
// Raw shape: { seasons: [...], info: {...}, episodes: { "1": [episode, ...] } }
// Normalised: seasons sorted numerically, episodes grouped by season number.

export async function getSeriesInfo(creds, seriesId) {
  const raw = await apiGet(creds, "get_series_info", { series_id: seriesId });
  return normalizeSeriesInfo(raw);
}

export function normalizeSeriesInfo(raw) {
  const data = raw || {};
  const bySeason = {};

  for (const [seasonKey, list] of Object.entries(data.episodes || {})) {
    const seasonNum = Number(seasonKey);
    if (Number.isNaN(seasonNum)) continue;
    bySeason[seasonNum] = (list || [])
      .map((e) => {
        const info = e.info || {};
        return {
          id: String(e.id),
          num: Number(e.episode_num) || 0,
          title: e.title || "",
          ext: (e.container_extension || "mkv").toLowerCase(),
          season: seasonNum,
          dur: info.duration || "",
          durSecs: Number(info.duration_secs) || 0,
          plot: info.plot || "",
          icon: info.movie_image || info.cover_big || "",
          added: e.added || "",
        };
      })
      .sort((a, b) => a.num - b.num);
  }

  const seasonNums = Object.keys(bySeason)
    .map(Number)
    .sort((a, b) => a - b);

  const seasons = seasonNums.map((num) => {
    const meta = (data.seasons || []).find((s) => Number(s.season_number) === num) || {};
    return {
      num,
      name: meta.name || `Season ${num}`,
      count: bySeason[num].length,
      cover: meta.cover || "",
    };
  });

  return { seasons, episodes: bySeason, info: data.info || {} };
}

/* ------------------------------- stream URLs ------------------------------ */
// Paths ride on the worker's /s/ route (or the raw panel host in direct mode).
// Credentials are part of these paths by design — never log them.

export function livePath(creds, id, ext = "m3u8") {
  return `live/${creds.username}/${creds.password}/${id}.${ext}`;
}

export function moviePath(creds, id, ext = "mp4") {
  return `movie/${creds.username}/${creds.password}/${id}.${ext || "mp4"}`;
}

export function episodePath(creds, epId, ext = "mkv") {
  return `series/${creds.username}/${creds.password}/${epId}.${ext || "mkv"}`;
}

export function rawStreamUrl(path) {
  return `http://${STREAM_HOST}/${path}`;
}

export function gatewayStreamUrl(gateway, path) {
  const g = gateway || {};
  if (g.mode === "direct") return rawStreamUrl(path);
  const base = String(g.url || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Gateway URL is not configured (Settings -> Stream gateway)");
  return `${base}/s/${path}`;
}

/* --------------------------- export (Xtream style) ------------------------ */
// The panel's own playlist style: http://<stream host>/<user>/<pass>/<id>.<ext>

export function xtreamLiveUrl(creds, id, ext = "ts") {
  return `http://${STREAM_HOST}/${creds.username}/${creds.password}/${id}.${ext}`;
}

export function xtreamMovieUrl(creds, id, ext = "mp4") {
  return `http://${STREAM_HOST}/movie/${creds.username}/${creds.password}/${id}.${ext || "mp4"}`;
}

export function xtreamEpisodeUrl(creds, epId, ext = "mkv") {
  return `http://${STREAM_HOST}/series/${creds.username}/${creds.password}/${epId}.${ext || "mkv"}`;
}
