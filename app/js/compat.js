// Browser capability detection.
//
//  Engine    | live HLS     | mp4 | MKV
//  ----------|--------------|-----|----
//  Chromium  | hls.js       | yes | yes   (Chrome/Edge desktop + Android)
//  Gecko     | hls.js       | yes | no    (Firefox)
//  WebKit    | native HLS   | yes | no    (Safari macOS, all iOS browsers)

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

const isIOS =
  /iPhone|iPad|iPod/.test(ua) ||
  (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);

function detectEngine() {
  if (isIOS) return "webkit";
  if (/FxiOS\//.test(ua) || /Firefox\//.test(ua)) return "gecko";
  if (/Edg(A|iOS)?\//.test(ua) || /OPR\//.test(ua)) return "chromium";
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return "chromium";
  if (/Safari\//.test(ua)) return "webkit";
  return "unknown";
}

function probe(type) {
  try {
    const video = document.createElement("video");
    return video.canPlayType(type) !== "";
  } catch {
    return false;
  }
}

const engine = detectEngine();

export const compat = {
  engine,
  isIOS,
  canHlsJs: !!(typeof window !== "undefined" && window.Hls && window.Hls.isSupported()),
  canNativeHls: probe("application/vnd.apple.mpegurl"),
  canMp4: probe("video/mp4"),
  // MKV playback is only reliable on Chromium video stacks (verified).
  canMkv: engine === "chromium",
  canPip: typeof document !== "undefined" && !!document.pictureInPictureEnabled,
  canFullscreen: typeof document !== "undefined" && !!document.documentElement.requestFullscreen,
};

export const engineName = {
  chromium: "Chrome/Edge",
  gecko: "Firefox",
  webkit: isIOS ? "iOS Safari" : "Safari",
  unknown: "this browser",
}[engine];

export const MKV_WARNING =
  `MKV video isn't supported by ${engineName} — use Chrome or Android for series playback.`;

export function canPlayContainer(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === "mkv") return compat.canMkv;
  if (e === "mp4" || e === "m4v" || e === "ts" || e === "mov") return true;
  if (e === "avi" || e === "mpg" || e === "mpeg" || e === "flv" || e === "wmv") return false;
  return true;
}

export function containerWarning(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === "mkv") return compat.canMkv ? "" : MKV_WARNING;
  if (!canPlayContainer(e)) {
    return `The .${e} container isn't supported by ${engineName} — use Chrome or Android.`;
  }
  return "";
}
