// Player: hls.js for live, native playback for VOD, with a global
// single-connection guard (the provider allows only 1 concurrent stream).
//
// The DOM lives in index.html; this module wires it up and owns playback.

import * as api from "./api.js";
import * as store from "./store.js";
import { compat } from "./compat.js";
import { fmtDuration, toast } from "./ui.js";

let deps = {
  onPlaybackOk: () => {}, // live stream started -> clear offline flag
  onChannelOffline: () => {}, // live stream failed -> mark offline
  onClosed: () => {}, // player closed -> views may want to refresh
};

let els = null;
let active = null; // current session (see makeSession)
let initialized = false;
const vodRetryCounts = new Map(); // resumeKey -> auto-retries used (VOD hiccups)

/* ------------------------------- session mgmt ------------------------------ */

function makeSession({ kind, item, series = null, list = null, index = null, title, subtitle }) {
  return {
    kind,
    item,
    series,
    list,
    index,
    title,
    subtitle,
    video: els.video,
    hls: null,
    netRetries: 0,
    mediaRetries: 0,
    manifestParsed: false,
    started: false,
    failed: false,
    ended: false,
    watchdog: null,
    lastSaveAt: 0,
    resumePos: 0,
    resumeKey:
      kind === "movie" ? `movie:${item.id}` : kind === "episode" ? `ep:${item.id}` : `live:${item.id}`,
    sessionId: Math.random().toString(36).slice(2),
    restart: null,
  };
}

function cleanupStream(session) {
  if (session.hls) {
    try {
      session.hls.destroy();
    } catch {
      /* ignore */
    }
    session.hls = null;
  }
  clearTimeout(session.watchdog);
  const video = session.video;
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    /* ignore */
  }
}

/** Global guard: always call before starting a new stream. */
export function stopPlayback() {
  const session = active;
  if (!session) return;
  active = null; // detach first so event handlers stop caring
  flushHistory(session);
  cleanupStream(session);
}

export function closePlayer() {
  stopPlayback();
  if (els) {
    els.root.classList.add("hidden");
    document.body.classList.remove("player-open");
  }
  deps.onClosed();
}

/* ---------------------------------- start --------------------------------- */

export function playLive(item, context = {}) {
  const previous = active;
  stopPlayback();
  const session = makeSession({
    kind: "live",
    item,
    list: context.list || [item],
    index: context.index ?? 0,
    title: item.name,
    subtitle: `#${item.num ?? item.id}`,
  });
  session.restart = () => playLive(item, context);
  active = session;
  show(session);

  let url;
  try {
    url = api.gatewayStreamUrl(store.getGateway(), api.livePath(store.getCreds(), item.id, "m3u8"));
  } catch (err) {
    failConfig(session, err.message);
    return;
  }

  // Accounts with max_connections = 1 need a beat to release the previous
  // stream upstream before the next one can get an auth token. Without this,
  // rapid zapping fails transiently.
  const settleMs = previous ? 1200 : 0;
  const begin = () => {
    if (active !== session || session.failed) return;
    if (compat.canHlsJs) {
      const Hls = window.Hls;
      const hls = new Hls({ enableWorker: true, backBufferLength: 30, maxBufferLength: 30 });
      session.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (active === session) session.manifestParsed = true;
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => onHlsError(session, data));
      hls.loadSource(url);
      hls.attachMedia(session.video);
    } else if (compat.canNativeHls) {
      session.video.src = url;
    } else {
      showOverlay(session, "Live playback not supported", "This browser can't play HLS streams.", [
        { label: "Close", onClick: () => closePlayer() },
      ]);
      return;
    }
    attemptPlay(session);
    startWatchdog(session, 25000);
  };

  if (settleMs) setTimeout(begin, settleMs);
  else begin();
}

export function playMovie(item) {
  stopPlayback();
  const session = makeSession({
    kind: "movie",
    item,
    title: item.name,
    subtitle: [item.ext ? item.ext.toUpperCase() : "", item.rating ? `★ ${item.rating}` : ""]
      .filter(Boolean)
      .join(" · "),
  });
  session.restart = () => playMovie(item);
  active = session;
  startNative(session, api.moviePath(store.getCreds(), item.id, item.ext));
}

export function playEpisode({ series, episode, list = null, index = null }) {
  stopPlayback();
  const session = makeSession({
    kind: "episode",
    item: episode,
    series,
    list,
    index,
    title: series ? series.name : episode.title,
    subtitle: `S${episode.season}E${episode.num}${episode.title ? " · " + episode.title : ""}`,
  });
  session.restart = () => playEpisode({ series, episode, list, index });
  active = session;
  startNative(session, api.episodePath(store.getCreds(), episode.id, episode.ext));
}

function startNative(session, path) {
  show(session);
  let url;
  try {
    url = api.gatewayStreamUrl(store.getGateway(), path);
  } catch (err) {
    failConfig(session, err.message);
    return;
  }
  session.video.src = url;
  maybeOfferResume(session);
  attemptPlay(session);
  startWatchdog(session, 30000);
}

function failConfig(session, message) {
  cleanupStream(session);
  showOverlay(session, "Stream gateway not configured", message + " (Settings → Stream gateway)", [
    { label: "Close", onClick: () => closePlayer() },
  ]);
}

function attemptPlay(session) {
  session.video.play().catch((err) => {
    if (!err || err.name === "AbortError") return;
    if (active !== session || session.failed) return;
    showOverlay(session, session.title, "Autoplay was blocked — tap play to start.", [
      {
        label: "▶ Play",
        primary: true,
        onClick: () => {
          hideOverlay();
          session.video.play().catch(() => {});
        },
      },
    ]);
  });
}

function startWatchdog(session, ms) {
  clearTimeout(session.watchdog);
  session.watchdog = setTimeout(() => {
    if (active === session && !session.started && !session.failed) {
      fail(session, session.kind === "live" ? "offline" : "timeout");
    }
  }, ms);
}

/* ------------------------------- error paths ------------------------------- */

function onHlsError(session, data) {
  if (active !== session || session.failed || !data.fatal) return;
  const Hls = window.Hls;
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    if (session.netRetries < 3) {
      session.netRetries++;
      const delay = 700 * session.netRetries;
      setTimeout(() => {
        if (active === session && session.hls && !session.failed) {
          try {
            session.hls.startLoad();
          } catch {
            fail(session, "offline");
          }
        }
      }, delay);
      return;
    }
    fail(session, "offline");
    return;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    if (session.mediaRetries < 1) {
      session.mediaRetries++;
      try {
        session.hls.recoverMediaError();
      } catch {
        fail(session, "media");
      }
      return;
    }
    fail(session, "media");
    return;
  }
  fail(session, "fatal");
}

function fail(session, reason) {
  if (active !== session || session.failed) return;
  session.failed = true;
  cleanupStream(session);

  const actions = [];
  let title = "Playback failed";
  let text = "The stream could not be loaded.";

  if (session.kind === "live") {
    title = "Channel appears to be offline";
    text = "The provider didn't return a stream for this channel. It has been marked offline in the list — you can still retry any time.";
    deps.onChannelOffline(session.item.id);
  } else if (session.kind === "movie") {
    title = "Not available right now";
    text = "The provider's movie servers are currently returning errors (upstream 404). This is a provider-side issue — please try again later.";
  } else {
    title = "Couldn't play this episode";
    text = reason === "media" ? "The video data could not be decoded." : "The stream could not be loaded.";
  }

  actions.push({
    label: "Retry",
    primary: true,
    onClick: () => {
      hideOverlay();
      session.failed = false;
      session.netRetries = 0;
      session.mediaRetries = 0;
      vodRetryCounts.delete(session.resumeKey);
      if (session.restart) session.restart();
    },
  });
  if (session.kind === "live" && session.list && session.list.length > 1) {
    actions.push({ label: "Next channel", onClick: () => step(1) });
  }
  showOverlay(session, title, text, actions);
}

/* ------------------------------ video events ------------------------------ */

function wireVideoEvents(video) {
  video.addEventListener("playing", () => {
    const session = active;
    if (!session || session.failed) return;
    session.started = true;
    vodRetryCounts.delete(session.resumeKey);
    clearTimeout(session.watchdog);
    hideOverlay();
    if (session.kind === "live") deps.onPlaybackOk(session.item.id);
  });

  video.addEventListener("timeupdate", () => {
    const session = active;
    if (!session || session.kind === "live" || session.failed) return;
    const now = Date.now();
    if (now - session.lastSaveAt >= 10000) {
      session.lastSaveAt = now;
      flushHistory(session);
    }
    const resume = els.resume;
    if (resume && !resume.classList.contains("hidden") && video.currentTime > 30) {
      resume.classList.add("hidden");
    }
  });

  video.addEventListener("pause", () => {
    const session = active;
    if (session && session.kind !== "live") flushHistory(session);
  });

  video.addEventListener("error", () => {
    const session = active;
    if (!session || session.failed) return;
    const code = video.error && video.error.code;
    if (code === 1) return; // MEDIA_ERR_ABORTED: we changed the source ourselves
    // Transient upstream hiccups are common right after another stream stopped
    // (single-connection accounts). Reload the source a couple of times first.
    if (session.kind !== "live" && session.restart) {
      const count = vodRetryCounts.get(session.resumeKey) || 0;
      if (count < 2) {
        vodRetryCounts.set(session.resumeKey, count + 1);
        setTimeout(() => {
          if (active === session && !session.failed) session.restart();
        }, 1000 * (count + 1));
        return;
      }
    }
    fail(session, session.kind === "movie" ? "unavailable" : "media");
  });

  video.addEventListener("ended", () => {
    const session = active;
    if (!session || session.failed) return;
    session.ended = true;
    if (session.kind !== "live") store.removeHistory(session.resumeKey);
    if (
      session.kind === "episode" &&
      session.list &&
      session.index != null &&
      session.index < session.list.length - 1 &&
      store.getSettings().autoplay
    ) {
      playEpisode({
        series: session.series,
        episode: session.list[session.index + 1],
        list: session.list,
        index: session.index + 1,
      });
      return;
    }
    const actions = [{ label: "Replay", primary: true, onClick: () => session.restart && session.restart() }];
    if (session.kind === "episode" && session.list && session.index < session.list.length - 1) {
      actions.push({
        label: "Next episode",
        onClick: () =>
          playEpisode({
            series: session.series,
            episode: session.list[session.index + 1],
            list: session.list,
            index: session.index + 1,
          }),
      });
    }
    showOverlay(session, "Finished", "", actions);
  });
}

function flushHistory(session) {
  if (session.kind === "live") return;
  const video = session.video;
  if (!video || !video.duration || !isFinite(video.duration) || video.duration <= 0) return;
  if (session.ended) return;
  store.saveHistory(session.resumeKey, {
    pos: video.currentTime,
    dur: video.duration,
    title: session.title,
    kind: session.kind,
    seriesId: session.series ? session.series.id : undefined,
    season: session.item.season,
    episodeNum: session.item.num,
    epTitle: session.item.title,
  });
}

function maybeOfferResume(session) {
  const history = store.getHistory(session.resumeKey);
  if (!history || !history.pos || history.pos < 30) return;
  if (history.dur && history.pos > history.dur - 30) return; // effectively finished

  session.resumePos = history.pos;
  const { resume } = els;
  els.resumeText.textContent = `Resume ${session.kind === "episode" ? "episode" : "movie"} from ${fmtDuration(history.pos)}?`;
  resume.classList.remove("hidden");
  clearTimeout(session.resumeTimer);
  session.resumeTimer = setTimeout(() => resume.classList.add("hidden"), 25000);
}

/* --------------------------------- zapping -------------------------------- */

function step(delta) {
  const session = active;
  if (!session || !session.list || session.index == null) return;
  const list = session.list;
  const count = list.length;
  if (count < 2) return;
  let next = session.index + delta;
  if (session.kind === "live") next = (next + count) % count; // catch-up wrap
  else if (next < 0 || next >= count) return;

  if (session.kind === "live") {
    playLive(list[next], { list, index: next });
  } else if (session.kind === "episode") {
    playEpisode({ series: session.series, episode: list[next], list, index: next });
  }
}

/* ----------------------------------- UI ----------------------------------- */

export function initPlayer(dependencies = {}) {
  deps = { ...deps, ...dependencies };
  els = {
    root: document.getElementById("player"),
    video: document.getElementById("player-video"),
    title: document.getElementById("player-title"),
    subtitle: document.getElementById("player-subtitle"),
    liveDot: document.getElementById("player-live-dot"),
    close: document.getElementById("player-close"),
    prev: document.getElementById("player-prev"),
    next: document.getElementById("player-next"),
    pip: document.getElementById("player-pip"),
    fs: document.getElementById("player-fs"),
    overlay: document.getElementById("player-overlay"),
    overlayTitle: document.getElementById("player-overlay-title"),
    overlayText: document.getElementById("player-overlay-text"),
    overlayActions: document.getElementById("player-overlay-actions"),
    resume: document.getElementById("player-resume"),
    resumeText: document.getElementById("player-resume-text"),
    resumeGo: document.getElementById("player-resume-go"),
    resumeRestart: document.getElementById("player-resume-restart"),
  };

  if (!els.root || initialized) return;
  initialized = true;

  els.close.addEventListener("click", () => closePlayer());
  els.prev.addEventListener("click", () => step(-1));
  els.next.addEventListener("click", () => step(1));
  els.fs.addEventListener("click", toggleFullscreen);
  els.pip.addEventListener("click", togglePip);

  els.resumeGo.addEventListener("click", () => {
    const session = active;
    els.resume.classList.add("hidden");
    if (session && session.resumePos) session.video.currentTime = session.resumePos;
  });
  els.resumeRestart.addEventListener("click", () => {
    const session = active;
    els.resume.classList.add("hidden");
    if (session) {
      store.removeHistory(session.resumeKey);
      session.video.currentTime = 0;
    }
  });

  wireVideoEvents(els.video);

  document.addEventListener("keydown", (event) => {
    if (!active || els.root.classList.contains("hidden")) return;
    const tag = (event.target && event.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const video = els.video;
    switch (event.key) {
      case " ":
      case "k":
        event.preventDefault();
        video.paused ? video.play().catch(() => {}) : video.pause();
        break;
      case "ArrowRight":
        if (active.kind !== "live") video.currentTime = Math.min(video.currentTime + 10, video.duration || 0);
        break;
      case "ArrowLeft":
        if (active.kind !== "live") video.currentTime = Math.max(video.currentTime - 10, 0);
        break;
      case "ArrowUp":
        if (active.kind === "live") step(1);
        break;
      case "ArrowDown":
        if (active.kind === "live") step(-1);
        break;
      case "f":
        toggleFullscreen();
        break;
      default:
        break;
    }
  });
}

function show(session) {
  els.root.classList.remove("hidden");
  document.body.classList.add("player-open");
  els.title.textContent = session.title || "";
  els.subtitle.textContent = session.subtitle || "";
  els.liveDot.classList.toggle("hidden", session.kind !== "live");
  hideOverlay();
  els.resume.classList.add("hidden");

  const hasList = !!(session.list && session.list.length > 1);
  els.prev.classList.toggle("hidden", !hasList);
  els.next.classList.toggle("hidden", !hasList);
  els.pip.classList.toggle("hidden", !compat.canPip || session.kind === "live");
  updateStepButtons(session);
}

function updateStepButtons(session) {
  const atStart = !session.list || session.index == null || session.index <= 0;
  const atEnd = !session.list || session.index == null || session.index >= session.list.length - 1;
  if (session.kind === "live") {
    els.prev.disabled = false;
    els.next.disabled = false;
  } else {
    els.prev.disabled = atStart;
    els.next.disabled = atEnd;
  }
}

function showOverlay(session, title, text, actions = []) {
  els.overlayTitle.textContent = title;
  els.overlayText.textContent = text || "";
  els.overlayActions.replaceChildren();
  for (const action of actions) {
    const button = document.createElement("button");
    button.className = `btn ${action.primary ? "btn-primary" : ""}`;
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    els.overlayActions.append(button);
  }
  els.overlay.classList.remove("hidden");
}

function hideOverlay() {
  els.overlay.classList.add("hidden");
}

function toggleFullscreen() {
  const root = els.root;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  if (root.requestFullscreen) {
    root.requestFullscreen().catch(() => {});
  } else if (els.video.webkitEnterFullscreen) {
    els.video.webkitEnterFullscreen(); // iOS Safari
  }
}

function togglePip() {
  const video = els.video;
  if (!compat.canPip) return;
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  } else {
    video.requestPictureInPicture().catch(() => toast("Picture-in-Picture is not available right now", { type: "error" }));
  }
}
