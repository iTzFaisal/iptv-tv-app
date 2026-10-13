// App bootstrap + router + views.
// Vanilla ES modules, no build step. Everything client-side.

import * as api from "./js/api.js";
import * as store from "./js/store.js";
import * as catalog from "./js/catalog.js";
import * as ui from "./js/ui.js";
import { compat, containerWarning } from "./js/compat.js";
import * as player from "./js/player.js";
import * as exporter from "./js/export.js";

const { $, $$, el, esc, debounce, toast, confirmDialog, fmtDate, fmtDateTime } = ui;

const TABS = ["live", "movies", "series", "favorites", "export", "settings"];
const TAB_KIND = { live: "live", movies: "vod", series: "series", favorites: null };
const KIND_TAB = { live: "live", vod: "movies", series: "series" };
const FAV_KIND = { live: "live", vod: "movie", series: "series" };

const state = {
  tab: "live",
  creds: null,
  gateway: null,
  catalogs: { live: null, vod: null, series: null }, // { fetchedAt, items, categories }
  itemMaps: { live: new Map(), vod: new Map(), series: new Map() },
  catMaps: { live: new Map(), vod: new Map(), series: new Map() },
  filters: {
    live: { q: "", cat: "all", favOnly: false },
    vod: { q: "", cat: "all", favOnly: false },
    series: { q: "", cat: "all", favOnly: false },
  },
  lastFiltered: { live: [], vod: [], series: [] },
  grids: {},
  favorites: [],
  favSet: new Set(),
  offline: {},
  seriesInfoCache: new Map(),
  seriesDetail: null,
  account: null,
  episodeCache: null,
  exportAbort: null,
};

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  state.creds = store.getCreds();
  state.gateway = store.getGateway();
  state.favorites = store.getFavorites();
  state.favSet = new Set(state.favorites.map((f) => `${f.kind}:${f.id}`));
  state.offline = (await store.idbGet("meta", "offline")) || {};
  state.episodeCache = await catalog.getEpisodesCache();
  const settings = store.getSettings();
  state.tab = TABS.includes(settings.lastTab) ? settings.lastTab : "live";

  player.initPlayer({
    onPlaybackOk: clearOfflineFlag,
    onChannelOffline: markOfflineFlag,
    onClosed: () => {},
  });

  state.grids = {
    live: ui.createGrid($("#live-grid"), { emptyText: "No channels match." }),
    vod: ui.createGrid($("#movies-grid"), { emptyText: "No movies match." }),
    series: ui.createGrid($("#series-grid"), { emptyText: "No series match." }),
    favorites: ui.createGrid($("#fav-list"), {
      emptyText: "No favorites yet — tap ★ on any channel, movie or series.",
    }),
  };

  wireTabs();
  wireBrowse();
  wireSeriesDetail();
  wireExport();
  wireSetup();
  renderMoviesNotice();
  renderCompatNote();

  if (needsSetup()) {
    showSetup();
  } else {
    $("#app-chrome").classList.remove("hidden");
    $("#view-setup").classList.add("hidden");
    showTab(state.tab);
  }
}

function needsSetup() {
  const c = state.creds;
  if (!c || !c.host || !c.username || !c.password) return true;
  if (state.gateway.mode === "worker" && !state.gateway.url) return true;
  return false;
}

/* --------------------------------- routing -------------------------------- */

function wireTabs() {
  $$("#tabs button").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });
  $("#brand-home").addEventListener("click", () => {
    if (!needsSetup()) showTab("live");
  });
}

async function showTab(tab) {
  if (!TABS.includes(tab)) tab = "live";
  state.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${tab}`));

  const settings = store.getSettings();
  store.setSettings({ ...settings, lastTab: tab });

  if (tab === "live" || tab === "movies" || tab === "series") await openBrowse(tab);
  if (tab === "favorites") renderFavorites();
  if (tab === "export") renderExportInfo();
  if (tab === "settings") renderSettings();
}

function showView(id) {
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${id}`));
}

/* --------------------------------- browsing -------------------------------- */

function setStatus(tab, message, { error = false, retry = null } = {}) {
  const statusEl = $(`#${tab}-status`);
  const retryEl = $(`#${tab}-retry`);
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", !!error);
  if (retryEl) {
    retryEl.classList.toggle("hidden", !retry);
    retryEl.onclick = retry || null;
  }
}

async function ensureCatalog(kind, { force = false, silent = false } = {}) {
  const existing = state.catalogs[kind];
  if (existing && !force) return existing;

  const tab = KIND_TAB[kind];
  if (!silent) setStatus(tab, "Loading catalog…");
  const record = await catalog.loadCatalog(state.creds, kind, {
    force,
    onProgress: (m) => !silent && setStatus(tab, m),
  });
  state.catalogs[kind] = record;
  state.catMaps[kind] = new Map(record.categories.map((c) => [String(c.id), c.name]));
  state.itemMaps[kind] = new Map(record.items.map((i) => [i.id, i]));
  return record;
}

async function openBrowse(tab) {
  const kind = TAB_KIND[tab];
  try {
    const record = await ensureCatalog(kind);
    if (record.fromCache) {
      setStatus(tab, `Catalog from cache (${fmtDateTime(record.fetchedAt)})`);
      setTimeout(() => setStatus(tab, ""), 3000);
    } else {
      setStatus(tab, "");
    }
  } catch (err) {
    setStatus(tab, `Catalog failed: ${err.message}`, {
      error: true,
      retry: () => {
        state.catalogs[kind] = null;
        openBrowse(tab);
      },
    });
    return;
  }
  if (state.tab === tab) renderBrowse(tab);
}

function categoryCounts(kind) {
  const record = state.catalogs[kind];
  const byId = new Map();
  let all = 0;
  for (const item of record.items) {
    all++;
    byId.set(item.cat, (byId.get(item.cat) || 0) + 1);
  }
  return { all, byId };
}

function filterItems(kind) {
  const record = state.catalogs[kind];
  if (!record) return [];
  const filter = state.filters[kind];
  const favKind = FAV_KIND[kind];
  let items = record.items;

  if (filter.cat !== "all") items = items.filter((i) => i.cat === filter.cat);
  if (filter.favOnly) items = items.filter((i) => state.favSet.has(`${favKind}:${i.id}`));
  if (filter.q) {
    const q = filter.q.toLowerCase();
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        (kind === "live" && String(i.num ?? "").includes(q)) ||
        (kind === "series" && (i.plot || "").toLowerCase().includes(q))
    );
  }
  return items;
}

function renderBrowse(tab) {
  const kind = TAB_KIND[tab];
  const record = state.catalogs[kind];
  if (!record) return;

  ui.renderChips($(`#${tab}-cats`), record.categories, state.filters[kind].cat, (cat) => {
    state.filters[kind].cat = cat;
    renderBrowse(tab);
  }, { allLabel: "All", counts: categoryCounts(kind) });

  const items = filterItems(kind);
  state.lastFiltered[kind] = items;

  const renderer = tab === "live" ? liveCardHTML : tab === "movies" ? movieCardHTML : seriesCardHTML;
  state.grids[kind].render(items, renderer);

  const label = { live: "channels", movies: "movies", series: "series" }[tab];
  $(`#${tab}-count`).textContent = `${items.length.toLocaleString()} ${label}`;
}

/* --------------------------------- cards ---------------------------------- */

function favButtonHTML(kind, id) {
  const fav = state.favSet.has(`${kind}:${id}`);
  return `<button class="fav-btn${fav ? " is-fav" : ""}" data-fav="1" title="Toggle favorite">★</button>`;
}

function thumbHTML(icon, fallback, extraHTML = "") {
  return `<div class="thumb"><span class="thumb-fallback">${fallback}</span>${
    icon ? `<img loading="lazy" src="${esc(icon)}" alt="" onerror="this.remove()">` : ""
  }${extraHTML}</div>`;
}

function liveCardHTML(channel) {
  const offline = state.offline[channel.id];
  return `<article class="card card-live${offline ? " is-offline" : ""}" data-id="${esc(channel.id)}">
    ${thumbHTML(channel.icon, "📺", offline ? ui.offlineBadgeHTML(offline) : "")}
    <div class="card-body">
      <div class="card-name" title="${esc(channel.name)}">${esc(channel.name)}</div>
      <div class="card-sub">#${esc(channel.num ?? channel.id)}</div>
    </div>
    ${favButtonHTML("live", channel.id)}
  </article>`;
}

function movieCardHTML(movie) {
  const bad = compat.canMkv ? "" : movie.ext === "mkv" ? `<span class="badge badge-warn" title="MKV not supported by this browser">⛔ MKV</span>` : "";
  const avail = compat.canMkv || movie.ext !== "mkv" ? "" : " unavailable-mkv";
  return `<article class="card card-movie${avail}" data-id="${esc(movie.id)}">
    ${thumbHTML(movie.icon, "🎬")}
    <div class="card-body">
      <div class="card-name" title="${esc(movie.name)}">${esc(movie.name)}</div>
      <div class="card-sub">
        <span class="badge badge-kind">${esc(movie.ext.toUpperCase())}</span>
        ${movie.rating ? `<span class="card-rating">★ ${movie.rating}</span>` : ""}
        ${bad}
      </div>
    </div>
    ${favButtonHTML("movie", movie.id)}
  </article>`;
}

function seriesCardHTML(series) {
  return `<article class="card card-series" data-id="${esc(series.id)}">
    ${thumbHTML(series.icon, "🎞️")}
    <div class="card-body">
      <div class="card-name" title="${esc(series.name)}">${esc(series.name)}</div>
      <div class="card-sub">${series.rating ? `<span class="card-rating">★ ${series.rating}</span>` : ""}</div>
    </div>
    ${favButtonHTML("series", series.id)}
  </article>`;
}

/* -------------------------------- interactions ----------------------------- */

function wireBrowse() {
  for (const tab of ["live", "movies", "series"]) {
    const kind = TAB_KIND[tab];
    $(`#${tab}-grid`).addEventListener("click", (event) => {
      const card = event.target.closest(".card");
      if (!card) return;
      const item = state.itemMaps[kind].get(card.dataset.id);
      if (!item) return;
      if (event.target.closest(".fav-btn")) {
        toggleFavorite(kind, item, card);
        return;
      }
      openItem(kind, item);
    });

    $(`#${tab}-search`).addEventListener(
      "input",
      debounce((event) => {
        state.filters[kind].q = event.target.value.trim();
        renderBrowse(tab);
      }, 200)
    );

    $(`#${tab}-fav`).addEventListener("click", (event) => {
      state.filters[kind].favOnly = !state.filters[kind].favOnly;
      event.currentTarget.classList.toggle("active", state.filters[kind].favOnly);
      renderBrowse(tab);
    });

    $(`#${tab}-refresh`).addEventListener("click", async (event) => {
      const button = event.currentTarget;
      ui.setBusy(button, true, "…");
      try {
        await ensureCatalog(kind, { force: true });
        if (state.tab === tab) renderBrowse(tab);
        toast("Catalog refreshed", { type: "ok" });
        renderExportInfo();
      } catch (err) {
        toast(`Refresh failed: ${err.message}`, { type: "error" });
      }
      ui.setBusy(button, false);
    });
  }
}

function toggleFavorite(kind, item, card) {
  const nowFav = store.toggleFavorite({
    kind: FAV_KIND[kind],
    id: item.id,
    name: item.name,
    icon: item.icon,
  });
  state.favorites = store.getFavorites();
  state.favSet = new Set(state.favorites.map((f) => `${f.kind}:${f.id}`));
  if (card) card.querySelector(".fav-btn")?.classList.toggle("is-fav", nowFav);
  toast(nowFav ? "Added to favorites" : "Removed from favorites", { type: nowFav ? "ok" : "info", ms: 1800 });
  if (state.filters[kind].favOnly) renderBrowse(KIND_TAB[kind]);
  if (state.tab === "favorites") renderFavorites();
}

function openItem(kind, item) {
  if (kind === "live") {
    const list = state.lastFiltered.live.length ? state.lastFiltered.live : [item];
    const index = Math.max(0, list.findIndex((i) => i.id === item.id));
    player.playLive(item, { list, index });
    return;
  }
  if (kind === "vod") {
    const warning = containerWarning(item.ext);
    if (warning) {
      toast(warning, { type: "error", ms: 7000 });
      return;
    }
    player.playMovie(item);
    return;
  }
  openSeriesDetail(item);
}

/* ------------------------------ series detail ------------------------------ */

function wireSeriesDetail() {
  $("#series-back").addEventListener("click", () => showTab("series"));
}

async function openSeriesDetail(item) {
  state.seriesDetail = { item, info: null, error: null };
  showView("series-detail");
  renderSeriesDetail();
  try {
    const info = await getSeriesInfoCached(item.id);
    if (state.seriesDetail && state.seriesDetail.item.id === item.id) {
      state.seriesDetail.info = info;
      renderSeriesDetail();
    }
  } catch (err) {
    if (state.seriesDetail && state.seriesDetail.item.id === item.id) {
      state.seriesDetail.error = err.message;
      renderSeriesDetail();
    }
  }
}

async function getSeriesInfoCached(id) {
  if (state.seriesInfoCache.has(id)) return state.seriesInfoCache.get(id);
  const info = await api.getSeriesInfo(state.creds, id);
  state.seriesInfoCache.set(id, info);
  return info;
}

function renderSeriesDetail() {
  const detail = state.seriesDetail;
  if (!detail) return;
  const { item, info, error } = detail;

  $("#series-title").textContent = item.name;
  const cover = $("#series-cover");
  cover.innerHTML = item.icon ? `<img src="${esc(item.icon)}" alt="" onerror="this.remove()">` : "🎞️";

  const meta = [];
  if (item.rating) meta.push(`★ ${item.rating}`);
  if (item.genre) meta.push(item.genre);
  if (item.releaseDate) meta.push(item.releaseDate);
  $("#series-meta").textContent = meta.join(" · ");
  $("#series-plot").textContent = item.plot || "";

  const favBtn = $("#series-fav");
  favBtn.classList.toggle("is-fav", state.favSet.has(`series:${item.id}`));
  favBtn.onclick = () => toggleFavorite("series", item, null);

  const seasonsEl = $("#series-seasons");
  const episodesEl = $("#series-episodes");
  const statusEl = $("#series-episodes-status");

  if (error) {
    statusEl.textContent = `Couldn't load episodes: ${error}`;
    seasonsEl.replaceChildren();
    episodesEl.replaceChildren();
    return;
  }
  if (!info) {
    statusEl.textContent = "Loading episodes…";
    seasonsEl.replaceChildren();
    episodesEl.replaceChildren();
    return;
  }

  statusEl.textContent = `${item.name} — ${info.seasons.reduce((n, s) => n + s.count, 0)} episodes`;

  const currentSeason = detail.season ?? (info.seasons[0] ? info.seasons[0].num : null);
  detail.season = currentSeason;

  seasonsEl.replaceChildren(
    ...info.seasons.map((season) => {
      const chip = el("button", { class: `chip${season.num === currentSeason ? " active" : ""}` },
        season.name,
        el("span", { class: "chip-count" }, String(season.count))
      );
      chip.addEventListener("click", () => {
        detail.season = season.num;
        renderSeriesDetail();
      });
      return chip;
    })
  );

  const episodes = info.episodes[currentSeason] || [];
  episodesEl.replaceChildren(
    ...episodes.map((episode) => {
      const warning = containerWarning(episode.ext);
      const row = el("div", { class: `episode-row${warning ? " unavailable" : ""}` });
      const main = el("div", { class: "episode-main" });
      main.append(
        el("div", { class: "episode-title" }, `E${episode.num}${episode.title ? " · " + episode.title : ""}`),
        el("div", { class: "episode-sub" },
          [episode.dur, episode.ext.toUpperCase(), warning ? "⛔ " + warning : ""].filter(Boolean).join(" · ")
        )
      );
      const playBtn = el("button", { class: "btn btn-small btn-primary" }, "▶ Play");
      playBtn.addEventListener("click", () => {
        if (warning) {
          toast(warning, { type: "error", ms: 7000 });
          return;
        }
        const flat = flatEpisodes(info);
        player.playEpisode({
          series: item,
          episode,
          list: flat,
          index: flat.findIndex((e) => e.id === episode.id),
        });
      });
      row.append(main, playBtn);
      return row;
    })
  );
}

function flatEpisodes(info) {
  const out = [];
  for (const season of Object.keys(info.episodes).map(Number).sort((a, b) => a - b)) {
    out.push(...info.episodes[season]);
  }
  return out;
}

/* -------------------------------- favorites -------------------------------- */

function renderFavorites() {
  state.favorites = store.getFavorites();
  state.favSet = new Set(state.favorites.map((f) => `${f.kind}:${f.id}`));

  const filter = state.favFilter || "all";
  const list = filter === "all" ? state.favorites : state.favorites.filter((f) => f.kind === filter);
  ui.renderChips(
    $("#fav-filter"),
    [
      { id: "live", name: "Live" },
      { id: "movie", name: "Movies" },
      { id: "series", name: "Series" },
    ],
    filter,
    (value) => {
      state.favFilter = value;
      renderFavorites();
    },
    { allLabel: "All" }
  );

  $("#fav-count").textContent = `${list.length} favorites`;
  state.grids.favorites.render(list, (fav) => `
    <article class="card card-fav" data-kind="${esc(fav.kind)}" data-id="${esc(fav.id)}">
      ${thumbHTML(fav.icon, fav.kind === "live" ? "📺" : fav.kind === "movie" ? "🎬" : "🎞️")}
      <div class="card-body">
        <div class="card-name" title="${esc(fav.name)}">${esc(fav.name)}</div>
        <div class="card-sub">${ui.kindBadgeHTML(fav.kind)}</div>
      </div>
      ${favButtonHTML(fav.kind, fav.id)}
    </article>`);

  $("#fav-list").onclick = async (event) => {
    const card = event.target.closest(".card");
    if (!card) return;
    const kind = card.dataset.kind;
    const id = card.dataset.id;
    if (event.target.closest(".fav-btn")) {
      const entry = state.favorites.find((f) => f.kind === kind && f.id === id);
      if (entry) {
        store.toggleFavorite(entry);
        renderFavorites();
      }
      return;
    }
    await openFavorite(kind, id, card);
  };
}

async function openFavorite(favKind, id, card) {
  const kind = { live: "live", movie: "vod", series: "series" }[favKind];
  try {
    await ensureCatalog(kind, { silent: true });
  } catch (err) {
    toast(`Catalog unavailable: ${err.message}`, { type: "error" });
    return;
  }
  const item = state.itemMaps[kind].get(id);
  if (!item) {
    toast("Not found in the catalog anymore — removing from favorites", { type: "error" });
    store.setFavorites(store.getFavorites().filter((f) => !(f.kind === favKind && f.id === id)));
    renderFavorites();
    return;
  }
  if (kind === "series") {
    openSeriesDetail(item);
    return;
  }
  if (kind === "vod") {
    const warning = containerWarning(item.ext);
    if (warning) {
      toast(warning, { type: "error", ms: 7000 });
      return;
    }
    player.playMovie(item);
    return;
  }
  player.playLive(item, {
    list: state.catalogs.live.items,
    index: Math.max(0, state.catalogs.live.items.findIndex((i) => i.id === item.id)),
  });
}

/* --------------------------------- notices --------------------------------- */

function renderCompatNote() {
  const hls = $("#compat-hls");
  const mkv = $("#compat-mkv");
  const engine = $("#compat-engine");
  if (!hls || !mkv || !engine) return;
  hls.textContent = compat.canHlsJs ? "hls.js" : compat.canNativeHls ? "native" : "unsupported";
  mkv.textContent = compat.canMkv ? "supported" : "not supported (use Chrome/Android)";
  engine.textContent = compat.engine;
}

function renderMoviesNotice() {
  const notices = store.lsGet("notices", {});
  if (notices.moviesDismissed) return;
  const notice = $("#movies-notice");
  if (!notice) return;
  notice.classList.remove("hidden");
  $("#movies-notice-close").addEventListener("click", () => {
    notice.classList.add("hidden");
    store.lsSet("notices", { ...store.lsGet("notices", {}), moviesDismissed: true });
  });
}

/* --------------------------------- exports --------------------------------- */

function wireExport() {
  $("#export-all").addEventListener("click", (e) => runExport(e.currentTarget, exportAll));
  $("#export-live-hls").addEventListener("click", (e) => runExport(e.currentTarget, exportLiveHls));
  $("#export-csv").addEventListener("click", (e) => runExport(e.currentTarget, exportCsv));
  $("#export-json").addEventListener("click", (e) => runExport(e.currentTarget, exportJson));
  $("#export-series").addEventListener("click", (e) => runExport(e.currentTarget, exportSeries));
  $("#export-cancel").addEventListener("click", () => {
    if (state.exportAbort) state.exportAbort.abort();
  });
  $("#export-refresh-info").addEventListener("click", renderExportInfo);
}

function setExportStatus(message, { cancel = false } = {}) {
  $("#export-status").textContent = message || "";
  $("#export-cancel").classList.toggle("hidden", !cancel);
}

async function runExport(button, fn) {
  ui.setBusy(button, true, "Working…");
  try {
    await fn();
  } catch (err) {
    toast(`Export failed: ${err.message}`, { type: "error" });
  }
  ui.setBusy(button, false);
  renderExportInfo();
}

async function ensureAllCatalogs() {
  for (const kind of ["live", "vod", "series"]) {
    if (!state.catalogs[kind]) {
      setExportStatus(`Loading ${catalog.KIND_LABEL[kind]}…`);
      await ensureCatalog(kind, { silent: true });
    }
  }
}

function exportContext({ withEpisodes = false } = {}) {
  return {
    creds: state.creds,
    live: state.catalogs.live ? state.catalogs.live.items : [],
    vod: state.catalogs.vod ? state.catalogs.vod.items : [],
    series: state.catalogs.series ? state.catalogs.series.items : [],
    episodes: withEpisodes && state.episodeCache && state.episodeCache.episodes ? state.episodeCache.episodes : [],
    catMaps: state.catMaps,
  };
}

async function exportAll() {
  await ensureAllCatalogs();
  const episodes = state.episodeCache && state.episodeCache.episodes ? state.episodeCache.episodes : [];
  const m3u = exporter.buildPlaylistAll(exportContext({ withEpisodes: true }));
  exporter.download("playlist-all.m3u", m3u, "audio/x-mpegurl;charset=utf-8");
  if (episodes.length) {
    toast(`playlist-all.m3u exported (${(state.catalogs.live.items.length).toLocaleString()} live + ${(state.catalogs.vod.items.length).toLocaleString()} movies + ${episodes.length.toLocaleString()} episodes)`, { type: "ok", ms: 6000 });
  } else {
    toast("playlist-all.m3u exported (live + movies). Run “Fetch series episodes” once to include series too.", { type: "info", ms: 8000 });
  }
}

async function exportLiveHls() {
  await ensureCatalog("live");
  const m3u = exporter.buildLiveHls(exportContext());
  exporter.download("live-hls.m3u", m3u, "audio/x-mpegurl;charset=utf-8");
  toast("live-hls.m3u exported", { type: "ok" });
}

async function exportCsv() {
  await ensureAllCatalogs();
  const csv = exporter.buildCatalogCsv(exportContext({ withEpisodes: true }));
  exporter.download("catalog.csv", csv, "text/csv;charset=utf-8");
  toast("catalog.csv exported", { type: "ok" });
}

async function exportJson() {
  await ensureAllCatalogs();
  const json = exporter.buildCatalogJson(exportContext({ withEpisodes: true }));
  exporter.download("catalog.json", json, "application/json;charset=utf-8");
  toast("catalog.json exported", { type: "ok" });
}

async function exportSeries() {
  await ensureCatalog("series", { silent: true });
  const seriesItems = state.catalogs.series.items;
  const cache = await catalog.getEpisodesCache();
  const alreadyDone = cache ? cache.completedIds.length : 0;

  const go = await confirmDialog(
    alreadyDone
      ? `Fetch episode lists for ${seriesItems.length.toLocaleString()} series? ${alreadyDone.toLocaleString()} are already cached — only the rest will be fetched (a few minutes, ~${(seriesItems.length - alreadyDone).toLocaleString()} API calls).`
      : `Fetch episode lists for ${seriesItems.length.toLocaleString()} series? This makes ~${seriesItems.length.toLocaleString()} API calls and can take a few minutes. Results are cached locally.`,
    { okLabel: "Fetch & export", cancelLabel: "Cancel" }
  );
  if (!go) return;

  state.exportAbort = new AbortController();
  try {
    const record = await catalog.crawlSeriesEpisodes(state.creds, seriesItems, {
      signal: state.exportAbort.signal,
      onProgress: ({ done, total, failed, aborted }) =>
        setExportStatus(`Fetching episode lists… ${done.toLocaleString()} / ${total.toLocaleString()}` + (failed ? ` (${failed} failed)` : "") + (aborted ? " — stopping…" : ""), { cancel: !aborted }),
    });
    state.episodeCache = record;
    const m3u = exporter.buildSeriesPlaylist({
      creds: state.creds,
      episodes: record.episodes,
      catMaps: state.catMaps,
    });
    exporter.download("playlist-series.m3u", m3u, "audio/x-mpegurl;charset=utf-8");
    toast(
      record.complete
        ? `playlist-series.m3u exported (${record.episodes.length.toLocaleString()} episodes). playlist-all.m3u now includes them too.`
        : `Partial export: ${record.episodes.length.toLocaleString()} episodes. Run again to fetch the rest (it resumes).`,
      { type: "ok", ms: 8000 }
    );
  } finally {
    state.exportAbort = null;
    setExportStatus("");
  }
}

function renderExportInfo() {
  const info = $("#export-info");
  const parts = [];
  const labels = { live: "live channels", vod: "movies", series: "series" };
  for (const kind of ["live", "vod", "series"]) {
    const record = state.catalogs[kind];
    parts.push(
      record
        ? `<li>${(record.items.length).toLocaleString()} ${labels[kind]} — cached ${esc(fmtDateTime(record.fetchedAt))}</li>`
        : `<li>${labels[kind]} — not loaded yet</li>`
    );
  }
  const eps = state.episodeCache;
  parts.push(
    eps
      ? `<li>${(eps.episodes || []).length.toLocaleString()} series episodes cached (${eps.complete ? "complete" : (eps.completedIds || []).length.toLocaleString() + " / " + (eps.totalSeries || 0).toLocaleString() + " series fetched"})</li>`
      : "<li>series episodes — not fetched yet</li>"
  );
  info.innerHTML = `<ul>${parts.join("")}</ul>`;
}

/* -------------------------------- settings --------------------------------- */

const CREDS_FORM_HTML = (prefix) => `
  <div class="field">
    <label for="${prefix}-host">Panel host</label>
    <input id="${prefix}-host" type="text" placeholder="http://panel.example.com:80" autocomplete="off" spellcheck="false">
  </div>
  <div class="field-row">
    <div class="field">
      <label for="${prefix}-user">Username</label>
      <input id="${prefix}-user" type="text" autocomplete="username" spellcheck="false">
    </div>
    <div class="field">
      <label for="${prefix}-pass">Password</label>
      <input id="${prefix}-pass" type="password" autocomplete="current-password">
    </div>
  </div>
  <fieldset class="gateway-box">
    <legend>Stream gateway</legend>
    <label class="radio"><input type="radio" name="${prefix}-gw" value="worker"> Cloudflare Worker URL <span class="muted">(recommended)</span></label>
    <input id="${prefix}-gw-url" type="url" placeholder="https://your-worker.your-subdomain.workers.dev" spellcheck="false" autocomplete="off">
    <label class="radio"><input type="radio" name="${prefix}-gw" value="direct"> Direct panel host <span class="muted">(only works when this app is served over plain http, e.g. local dev)</span></label>
  </fieldset>
  <div class="form-actions">
    <button id="${prefix}-test" class="btn" type="button">Test connection</button>
    <button id="${prefix}-save" class="btn btn-primary" type="button">Save</button>
  </div>
  <div id="${prefix}-status" class="form-status"></div>`;

function wireSetup() {
  $("#setup-form").innerHTML = CREDS_FORM_HTML("setup");
  wireCredsForm("setup", { afterSave: startAfterSetup });
}

function renderSettings() {
  const slot = $("#settings-form");
  if (!slot.dataset.built) {
    slot.innerHTML = CREDS_FORM_HTML("settings");
    slot.dataset.built = "1";
    wireCredsForm("settings", { afterSave: () => renderSettings() });
    wireSettingsExtras();
  }
  renderAccountCard();
  renderCacheInfo();
}

function wireCredsForm(prefix, { afterSave } = {}) {
  const creds = store.getCreds() || {};
  const gateway = store.getGateway();
  $(`#${prefix}-host`).value = creds.host || "";
  $(`#${prefix}-user`).value = creds.username || "";
  $(`#${prefix}-pass`).value = creds.password || "";
  $(`#${prefix}-gw-url`).value = gateway.url || "";
  $$(`input[name="${prefix}-gw"]`).forEach((radio) => {
    radio.checked = radio.value === (gateway.mode || "worker");
  });

  $(`#${prefix}-test`).addEventListener("click", () => testConnection(prefix));
  $(`#${prefix}-save`).addEventListener("click", () => saveSettings(prefix, afterSave));
}

function readCredsForm(prefix) {
  const mode = ($$(`input[name="${prefix}-gw"]`).find((r) => r.checked) || {}).value || "worker";
  return {
    creds: {
      host: $(`#${prefix}-host`).value.trim(),
      username: $(`#${prefix}-user`).value.trim(),
      password: $(`#${prefix}-pass`).value,
    },
    gateway: { mode, url: $(`#${prefix}-gw-url`).value.trim() },
  };
}

function setFormStatus(prefix, html, cls = "") {
  const el = $(`#${prefix}-status`);
  el.className = `form-status ${cls}`;
  el.innerHTML = html;
}

async function testConnection(prefix) {
  const { creds } = readCredsForm(prefix);
  if (!creds.host || !creds.username || !creds.password) {
    setFormStatus(prefix, "Fill in host, username and password first.", "error");
    return;
  }
  const button = $(`#${prefix}-test`);
  ui.setBusy(button, true, "Testing…");
  setFormStatus(prefix, "Contacting the panel…");
  try {
    const info = await api.testConnection(creds);
    state.account = info;
    const lines = [
      `<strong>Status:</strong> ${esc(info.status)}${info.isTrial ? " (trial)" : ""}`,
      info.expDate ? `<strong>Expires:</strong> ${esc(new Date(info.expDate * 1000).toLocaleDateString())}` : "",
      info.maxConnections != null ? `<strong>Connections:</strong> ${info.activeCons} / ${info.maxConnections} active` : "",
      info.serverUrl ? `<strong>Stream server:</strong> ${esc(info.serverUrl)}:${esc(info.serverPort)}` : "",
      info.allowedFormats.length ? `<strong>Formats:</strong> ${esc(info.allowedFormats.join(", "))}` : "",
    ].filter(Boolean);
    setFormStatus(prefix, lines.join("<br>"), "ok");
  } catch (err) {
    setFormStatus(prefix, `Connection failed: ${esc(err.message)}`, "error");
  }
  ui.setBusy(button, false);
}

function saveSettings(prefix, afterSave) {
  const { creds, gateway } = readCredsForm(prefix);
  if (!creds.host || !creds.username || !creds.password) {
    setFormStatus(prefix, "Host, username and password are required.", "error");
    return;
  }
  if (gateway.mode === "worker" && !gateway.url) {
    setFormStatus(prefix, "Enter your Cloudflare Worker URL, or switch to direct mode (local dev only).", "error");
    return;
  }
  if (gateway.mode === "direct" && location.protocol === "https:") {
    setFormStatus(prefix, "Direct mode can't work on an https page (mixed content). Use a Worker URL or <code>npx wrangler dev</code> + a local http page.", "error");
    return;
  }
  store.setCreds(creds);
  store.setGateway(gateway);
  state.creds = creds;
  state.gateway = gateway;
  state.catalogs = { live: null, vod: null, series: null };
  state.itemMaps = { live: new Map(), vod: new Map(), series: new Map() };
  state.seriesInfoCache.clear();
  setFormStatus(prefix, "Saved.", "ok");
  toast("Settings saved", { type: "ok" });
  if (afterSave) afterSave();
}

function startAfterSetup() {
  $("#app-chrome").classList.remove("hidden");
  $("#view-setup").classList.add("hidden");
  showTab("live");
}

function showSetup() {
  $("#app-chrome").classList.add("hidden");
  showView("setup");
}

function renderAccountCard() {
  const card = $("#account-card");
  if (!state.account) {
    card.innerHTML = `<p class="muted">Run “Test connection” to see account status.</p>`;
    return;
  }
  const info = state.account;
  card.innerHTML = `
    <p><strong>Status:</strong> ${esc(info.status)}${info.isTrial ? " (trial)" : ""}${
    info.expDate ? ` — expires ${esc(new Date(info.expDate * 1000).toLocaleDateString())}` : ""
  }</p>
    <p><strong>Connections:</strong> ${info.activeCons} / ${info.maxConnections ?? "?"} active ${
    info.maxConnections === 1 ? '<span class="muted">(single stream at a time — the player always stops the previous stream first)</span>' : ""
  }</p>
    <p><strong>Stream server:</strong> ${esc(info.serverUrl || "?")}:${esc(info.serverPort || "")}</p>`;
}

function wireSettingsExtras() {
  // Cache
  $("#cache-clear").addEventListener("click", async () => {
    const yes = await confirmDialog("Clear the cached catalog? It will be re-downloaded on next use.", { okLabel: "Clear" });
    if (!yes) return;
    await catalog.clearCatalog();
    state.catalogs = { live: null, vod: null, series: null };
    toast("Catalog cache cleared", { type: "ok" });
    renderCacheInfo();
    renderExportInfo();
  });
  $("#cache-refresh-all").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    ui.setBusy(button, true, "Refreshing…");
    try {
      for (const kind of ["live", "vod", "series"]) {
        setExportStatus(`Refreshing ${catalog.KIND_LABEL[kind]}…`);
        await ensureCatalog(kind, { force: true, silent: true });
      }
      toast("All catalogs refreshed", { type: "ok" });
      if (state.tab === "live" || state.tab === "movies" || state.tab === "series") renderBrowse(state.tab);
    } catch (err) {
      toast(`Refresh failed: ${err.message}`, { type: "error" });
    }
    ui.setBusy(button, false);
    renderCacheInfo();
  });

  // Backup
  $("#backup-export").addEventListener("click", () => {
    $("#backup-text").value = store.exportSettingsString();
    toast("Settings string generated — copy it somewhere safe", { type: "ok" });
  });
  $("#backup-copy").addEventListener("click", async () => {
    const text = $("#backup-text");
    if (!text.value) text.value = store.exportSettingsString();
    try {
      await navigator.clipboard.writeText(text.value);
      toast("Copied", { type: "ok" });
    } catch {
      text.select();
      document.execCommand("copy");
      toast("Copied", { type: "ok" });
    }
  });
  $("#backup-import").addEventListener("click", async () => {
    const value = $("#backup-text").value.trim();
    if (!value) {
      toast("Paste a settings string first", { type: "error" });
      return;
    }
    try {
      store.importSettingsString(value);
      toast("Imported — reloading…", { type: "ok" });
      setTimeout(() => location.reload(), 600);
    } catch {
      toast("That doesn't look like a valid settings string", { type: "error" });
    }
  });

  // Danger zone
  $("#clear-favorites").addEventListener("click", async () => {
    if (!(await confirmDialog("Remove all favorites?", { okLabel: "Remove", danger: true }))) return;
    store.setFavorites([]);
    state.favSet = new Set();
    toast("Favorites cleared", { type: "ok" });
  });
  $("#clear-history").addEventListener("click", async () => {
    if (!(await confirmDialog("Clear watch history and resume positions?", { okLabel: "Clear", danger: true }))) return;
    store.clearHistory();
    toast("History cleared", { type: "ok" });
  });
  $("#reset-app").addEventListener("click", async () => {
    if (!(await confirmDialog("Reset the app? This clears credentials, favorites, history and the cached catalog.", { okLabel: "Reset everything", danger: true }))) return;
    ["creds", "gateway", "favorites", "history", "settings", "notices"].forEach(store.lsDel);
    await catalog.clearCatalog();
    await store.idbDel("meta", "series-episodes");
    await store.idbDel("meta", "offline");
    location.reload();
  });
}

function renderCacheInfo() {
  const box = $("#cache-info");
  const rows = [];
  for (const [kind, label] of [["live", "Live channels"], ["vod", "Movies"], ["series", "Series"]]) {
    const record = state.catalogs[kind];
    rows.push(`
      <div class="cache-row">
        <div><strong>${label}</strong><br>
          <span class="muted">${record ? `${record.items.length.toLocaleString()} items — ${esc(fmtDateTime(record.fetchedAt))}` : "not cached yet"}</span>
        </div>
        <button class="btn btn-small" data-refresh-kind="${kind}">Refresh</button>
      </div>`);
  }
  box.innerHTML = rows.join("");
  $$("button[data-refresh-kind]", box).forEach((button) => {
    button.addEventListener("click", async () => {
      const kind = button.dataset.refreshKind;
      ui.setBusy(button, true, "…");
      try {
        await ensureCatalog(kind, { force: true, silent: true });
        toast(`${kind} catalog refreshed`, { type: "ok" });
        renderCacheInfo();
        renderExportInfo();
      } catch (err) {
        toast(`Refresh failed: ${err.message}`, { type: "error" });
      }
      ui.setBusy(button, false);
    });
  });
}

/* ---------------------------- offline flag helpers -------------------------- */

async function markOfflineFlag(id) {
  if (state.offline[id]) return;
  state.offline[id] = Date.now();
  await store.idbSet("meta", "offline", state.offline);
  updateOfflineBadge(id);
}

async function clearOfflineFlag(id) {
  if (!state.offline[id]) return;
  delete state.offline[id];
  await store.idbSet("meta", "offline", state.offline);
  updateOfflineBadge(id);
}

function updateOfflineBadge(id) {
  const grid = document.querySelector(`#live-grid`);
  const card = grid && grid.querySelector(`.card[data-id="${cssEscape(id)}"]`);
  if (!card) return;
  const thumb = card.querySelector(".thumb");
  const existing = thumb.querySelector(".badge-offline");
  if (state.offline[id]) {
    const badge = existing || document.createElement("span");
    badge.className = "badge badge-offline";
    badge.textContent = `offline ${fmtDate(state.offline[id])}`;
    if (!existing) thumb.append(badge);
    card.classList.add("is-offline");
  } else if (existing) {
    existing.remove();
    card.classList.remove("is-offline");
  }
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/* ----------------------------------- go ------------------------------------ */

document.addEventListener("DOMContentLoaded", boot);
