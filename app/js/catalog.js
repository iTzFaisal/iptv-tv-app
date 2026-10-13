// Catalog loading + IndexedDB cache (24 h TTL) + series-episode crawler.

import * as api from "./api.js";
import * as store from "./store.js";

export const TTL_MS = 24 * 60 * 60 * 1000;

export const KIND_LABEL = { live: "channels", vod: "movies", series: "series" };

/* --------------------------------- loading -------------------------------- */

async function fetchKind(creds, kind) {
  if (kind === "live") {
    const [categories, items] = await Promise.all([
      api.getLiveCategories(creds).catch(() => []),
      api.getLiveStreams(creds),
    ]);
    return { items, categories };
  }
  if (kind === "vod") {
    const [categories, items] = await Promise.all([
      api.getVodCategories(creds).catch(() => []),
      api.getVodStreams(creds),
    ]);
    return { items, categories };
  }
  const [categories, items] = await Promise.all([
    api.getSeriesCategories(creds).catch(() => []),
    api.getSeriesList(creds),
  ]);
  return { items, categories };
}

/**
 * Returns { fetchedAt, items, categories, fromCache }.
 * Fresh cache (< TTL) is used unless force = true.
 */
export async function loadCatalog(creds, kind, { force = false, onProgress } = {}) {
  if (!force) {
    const cached = await store.idbGet("catalog", kind);
    if (cached && cached.items && Date.now() - cached.fetchedAt < TTL_MS) {
      return { ...cached, fromCache: true };
    }
  }

  onProgress && onProgress(`Downloading ${KIND_LABEL[kind] || kind} from the panel…`);
  const { items, categories } = await fetchKind(creds, kind);
  const record = { fetchedAt: Date.now(), items, categories };
  await store.idbSet("catalog", kind, record);
  return { ...record, fromCache: false };
}

export async function catalogMeta() {
  const out = {};
  for (const kind of ["live", "vod", "series"]) {
    const rec = await store.idbGet("catalog", kind);
    out[kind] = rec ? { fetchedAt: rec.fetchedAt, count: (rec.items || []).length } : null;
  }
  return out;
}

export async function clearCatalog() {
  await store.idbClear("catalog");
}

/* --------------------------- series episode crawler ------------------------ */
// get_series_info gives us episode ids; fetching all of them takes a few
// minutes (~9000 API calls), so results are cached in IndexedDB and the crawl
// is resumable: series already fetched are skipped next time.

export async function getEpisodesCache() {
  return store.idbGet("meta", "series-episodes");
}

export async function crawlSeriesEpisodes(creds, seriesList, { concurrency = 6, onProgress, signal } = {}) {
  const previous = (await getEpisodesCache()) || { episodes: [], completedIds: [] };
  const completed = new Set(previous.completedIds || []);
  const episodes = [...(previous.episodes || [])];

  const pending = seriesList.filter((s) => !completed.has(s.id));
  const total = seriesList.length;
  let done = completed.size;
  let failed = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      if (signal && signal.aborted) return;
      const series = pending[cursor++];
      try {
        const info = await api.getSeriesInfo(creds, series.id);
        for (const seasonNum of Object.keys(info.episodes).map(Number).sort((a, b) => a - b)) {
          for (const ep of info.episodes[seasonNum]) {
            episodes.push({
              seriesId: series.id,
              seriesName: series.name,
              cat: series.cat,
              season: ep.season,
              num: ep.num,
              epId: ep.id,
              title: ep.title,
              ext: ep.ext,
            });
          }
        }
        completed.add(series.id);
      } catch {
        failed++;
      }
      done++;
      if (done % 5 === 0 || done === total) {
        onProgress && onProgress({ done, total, failed, aborted: !!(signal && signal.aborted) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, worker));

  episodes.sort(
    (a, b) =>
      a.seriesName.localeCompare(b.seriesName) || a.season - b.season || a.num - b.num
  );

  const record = {
    fetchedAt: Date.now(),
    episodes,
    completedIds: [...completed],
    totalSeries: total,
    failed,
    complete: completed.size >= total,
  };
  await store.idbSet("meta", "series-episodes", record);
  return record;
}
