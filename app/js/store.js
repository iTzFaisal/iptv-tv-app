// Storage helpers: localStorage for small state, IndexedDB for the big catalog.
// All keys are namespaced under "iptv." to avoid clashing with anything else.

const LS_PREFIX = "iptv.";

/* ------------------------------ localStorage ------------------------------ */

export function lsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota errors / private mode: state simply won't persist.
  }
}

export function lsDel(key) {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------- app state -------------------------------- */

/* creds   -> { host, username, password }
   gateway -> { mode: 'worker' | 'direct', url }
   settings-> { autoplay, lastTab }                                      */

export const getCreds = () => lsGet("creds");
export const setCreds = (creds) => lsSet("creds", creds);

export const getGateway = () => lsGet("gateway", { mode: "worker", url: "" });
export const setGateway = (gateway) => lsSet("gateway", gateway);

export const getSettings = () => lsGet("settings", { autoplay: true, lastTab: "live" });
export const setSettings = (settings) => lsSet("settings", settings);

/* -------------------------------- favorites ------------------------------- */
// [{ kind: 'live'|'movie'|'series', id, name, icon, addedAt }]

export function getFavorites() {
  const list = lsGet("favorites", []);
  return Array.isArray(list) ? list : [];
}

export function setFavorites(list) {
  lsSet("favorites", list);
}

export function favKey(kind, id) {
  return `${kind}:${id}`;
}

export function toggleFavorite(entry) {
  const list = getFavorites();
  const key = favKey(entry.kind, entry.id);
  const idx = list.findIndex((f) => favKey(f.kind, f.id) === key);
  let nowFavorite;
  if (idx >= 0) {
    list.splice(idx, 1);
    nowFavorite = false;
  } else {
    list.push({ ...entry, addedAt: Date.now() });
    nowFavorite = true;
  }
  setFavorites(list);
  return nowFavorite;
}

/* --------------------------------- history -------------------------------- */
// { 'live:<id>'|'movie:<id>'|'ep:<epId>': { pos, dur, updatedAt, title, kind, seriesId?, season?, episodeNum? } }

const HISTORY_MAX = 300;
const HISTORY_KEYS = "history";

export function getAllHistory() {
  const h = lsGet(HISTORY_KEYS, {});
  return h && typeof h === "object" ? h : {};
}

export function getHistory(key) {
  return getAllHistory()[key] || null;
}

export function saveHistory(key, entry) {
  const h = getAllHistory();
  h[key] = { ...(h[key] || {}), ...entry, updatedAt: Date.now() };
  const keys = Object.keys(h);
  if (keys.length > HISTORY_MAX) {
    keys
      .sort((a, b) => (h[a].updatedAt || 0) - (h[b].updatedAt || 0))
      .slice(0, keys.length - HISTORY_MAX)
      .forEach((k) => delete h[k]);
  }
  lsSet(HISTORY_KEYS, h);
}

export function removeHistory(key) {
  const h = getAllHistory();
  delete h[key];
  lsSet(HISTORY_KEYS, h);
}

export function clearHistory() {
  lsDel(HISTORY_KEYS);
}

/* ------------------------------- settings I/O ----------------------------- */
// Backup string so users can survive iOS storage eviction / switch devices.

export function exportSettingsString() {
  const payload = {
    v: 1,
    app: "iptv-web-player",
    exportedAt: Date.now(),
    creds: getCreds(),
    gateway: getGateway(),
    settings: getSettings(),
    favorites: getFavorites(),
    history: getAllHistory(),
  };
  return b64encode(JSON.stringify(payload));
}

export function importSettingsString(str) {
  const data = JSON.parse(b64decode(String(str).trim()));
  if (!data || typeof data !== "object") throw new Error("Unrecognised settings string");
  if (data.creds) setCreds(data.creds);
  if (data.gateway) setGateway(data.gateway);
  if (data.settings) setSettings(data.settings);
  if (Array.isArray(data.favorites)) setFavorites(data.favorites);
  if (data.history && typeof data.history === "object") lsSet(HISTORY_KEYS, data.history);
  return data;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* -------------------------------- IndexedDB -------------------------------- */
// db "iptv": store "catalog" -> live | vod | series  { fetchedAt, items, categories }
//            store "meta"    -> offline, series-episodes, ...

const DB_NAME = "iptv";
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("catalog")) db.createObjectStore("catalog");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbGet(storeName, key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function idbSet(storeName, key, value) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return false;
  }
}

export async function idbDel(storeName, key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return false;
  }
}

export async function idbClear(storeName) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return false;
  }
}
