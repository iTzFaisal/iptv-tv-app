// Export generators: M3U playlists, CSV, JSON — all built client-side from
// the cached catalog. Downloads preserve UTF-8 (Arabic names) and use CRLF.

import { xtreamLiveUrl, xtreamMovieUrl, xtreamEpisodeUrl } from "./api.js";

/* --------------------------------- helpers -------------------------------- */

function attr(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .trim();
}

function m3uItem({ id, name, icon, group, url }) {
  const parts = [`tvg-id="${attr(id)}"`, `tvg-name="${attr(name)}"`];
  if (icon) parts.push(`tvg-logo="${attr(icon)}"`);
  if (group) parts.push(`group-title="${attr(group)}"`);
  return `#EXTINF:-1 ${parts.join(" ")},${String(name ?? "").replace(/[\r\n]+/g, " ")}\r\n${url}`;
}

function header() {
  return "#EXTM3U\r\n";
}

function csvCell(value) {
  const str = String(value ?? "");
  return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

const CRLF = "\r\n";

/* -------------------------------- playlists ------------------------------- */

/** Live + movies + (optionally) cached series episodes, Xtream-style URLs. */
export function buildPlaylistAll({ creds, live = [], vod = [], episodes = [], catMaps = {} }) {
  const parts = [header()];

  for (const channel of live) {
    parts.push(
      m3uItem({
        id: channel.epgChannelId || channel.id,
        name: channel.name,
        icon: channel.icon,
        group: catMaps.live?.get(channel.cat) || "",
        url: xtreamLiveUrl(creds, channel.id, "ts"),
      }) + CRLF
    );
  }

  for (const movie of vod) {
    parts.push(
      m3uItem({
        id: movie.id,
        name: movie.name,
        icon: movie.icon,
        group: catMaps.vod?.get(movie.cat) || "",
        url: xtreamMovieUrl(creds, movie.id, movie.ext),
      }) + CRLF
    );
  }

  for (const episode of episodes) {
    parts.push(
      m3uItem({
        id: episode.seriesId,
        name: `${episode.seriesName} S${episode.season}E${episode.num}${episode.title ? " - " + episode.title : ""}`,
        icon: "",
        group: catMaps.series?.get(episode.cat) || episode.seriesName,
        url: xtreamEpisodeUrl(creds, episode.epId, episode.ext),
      }) + CRLF
    );
  }

  return parts.join("");
}

/** Live channels as .m3u8 links for modern players. */
export function buildLiveHls({ creds, live = [], catMaps = {} }) {
  const parts = [header()];
  for (const channel of live) {
    parts.push(
      m3uItem({
        id: channel.epgChannelId || channel.id,
        name: channel.name,
        icon: channel.icon,
        group: catMaps.live?.get(channel.cat) || "",
        url: xtreamLiveUrl(creds, channel.id, "m3u8"),
      }) + CRLF
    );
  }
  return parts.join("");
}

/** Just the series episodes. */
export function buildSeriesPlaylist({ creds, episodes = [], catMaps = {} }) {
  const parts = [header()];
  for (const episode of episodes) {
    parts.push(
      m3uItem({
        id: episode.seriesId,
        name: `${episode.seriesName} S${episode.season}E${episode.num}${episode.title ? " - " + episode.title : ""}`,
        icon: "",
        group: catMaps.series?.get(episode.cat) || episode.seriesName,
        url: xtreamEpisodeUrl(creds, episode.epId, episode.ext),
      }) + CRLF
    );
  }
  return parts.join("");
}

/* --------------------------------- catalog -------------------------------- */

const CSV_COLUMNS = ["id", "type", "name", "category", "added", "rating", "poster", "container", "season", "episode", "series_id"];

export function buildCatalogCsv({ live = [], vod = [], series = [], episodes = [], catMaps = {} }) {
  const rows = [CSV_COLUMNS.join(",")];

  const row = (values) => rows.push(CSV_COLUMNS.map((c) => csvCell(values[c])).join(","));

  for (const channel of live) {
    row({ id: channel.id, type: "live", name: channel.name, category: catMaps.live?.get(channel.cat), added: channel.added, rating: "", poster: channel.icon, container: "ts" });
  }
  for (const movie of vod) {
    row({ id: movie.id, type: "movie", name: movie.name, category: catMaps.vod?.get(movie.cat), added: movie.added, rating: movie.rating, poster: movie.icon, container: movie.ext });
  }
  for (const item of series) {
    row({ id: item.id, type: "series", name: item.name, category: catMaps.series?.get(item.cat), added: item.added, rating: item.rating, poster: item.icon, container: "" });
  }
  for (const episode of episodes) {
    row({ id: episode.epId, type: "episode", name: `${episode.seriesName} S${episode.season}E${episode.num}${episode.title ? " - " + episode.title : ""}`, category: catMaps.series?.get(episode.cat), added: "", rating: "", poster: "", container: episode.ext, season: episode.season, episode: episode.num, series_id: episode.seriesId });
  }

  return "\uFEFF" + rows.join(CRLF) + CRLF; // BOM so Excel renders Arabic correctly
}

export function buildCatalogJson({ live = [], vod = [], series = [], episodes = [], catMaps = {}, exportedAt = Date.now() }) {
  const items = [];

  for (const channel of live) {
    items.push({ id: channel.id, type: "live", name: channel.name, category: catMaps.live?.get(channel.cat) || "", added: channel.added, rating: null, poster: channel.icon, container: "ts", num: channel.num });
  }
  for (const movie of vod) {
    items.push({ id: movie.id, type: "movie", name: movie.name, category: catMaps.vod?.get(movie.cat) || "", added: movie.added, rating: movie.rating, poster: movie.icon, container: movie.ext });
  }
  for (const item of series) {
    items.push({ id: item.id, type: "series", name: item.name, category: catMaps.series?.get(item.cat) || "", added: item.added, rating: item.rating, poster: item.icon, container: "", plot: item.plot || "" });
  }
  for (const episode of episodes) {
    items.push({ id: episode.epId, type: "episode", name: `${episode.seriesName} S${episode.season}E${episode.num}${episode.title ? " - " + episode.title : ""}`, category: catMaps.series?.get(episode.cat) || "", added: "", rating: null, poster: "", container: episode.ext, seriesId: episode.seriesId, season: episode.season, episode: episode.num });
  }

  return JSON.stringify({ app: "iptv-web-player", exportedAt, counts: { live: live.length, movies: vod.length, series: series.length, episodes: episodes.length }, items }, null, 0);
}

/* --------------------------------- download -------------------------------- */

export function download(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
