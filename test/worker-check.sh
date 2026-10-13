#!/usr/bin/env bash
# Probes an IPTV stream gateway worker (local wrangler dev by default).
#
# Usage:
#   test/worker-check.sh                                     # local http://127.0.0.1:8787
#   BASE=https://your-worker.workers.dev test/worker-check.sh
#   CHANNEL=12345 EPISODE=67890 test/worker-check.sh
#
# Credentials are read from iptv.txt in the repo root when present, or from
# the XT_USER / XT_PASS environment variables. They are never printed.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${BASE:-http://127.0.0.1:8787}"
CHANNEL="${CHANNEL:-526337}"
EPISODE="${EPISODE:-900353}"

XT_USER="${XT_USER:-}"
XT_PASS="${XT_PASS:-}"
if [ -f "$ROOT/iptv.txt" ]; then
  [ -z "$XT_USER" ] && XT_USER="$(sed -n 's/^Username:[[:space:]]*//p' "$ROOT/iptv.txt" | head -1)"
  [ -z "$XT_PASS" ] && XT_PASS="$(sed -n 's/^Password:[[:space:]]*//p' "$ROOT/iptv.txt" | head -1)"
fi

if [ -z "$XT_USER" ] || [ -z "$XT_PASS" ]; then
  echo "No credentials: create iptv.txt or set XT_USER / XT_PASS." >&2
  exit 2
fi

PASS=0
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok()   { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
note() { echo "        $1"; }

echo "Gateway: $BASE"
echo

# --- 1. CORS preflight -------------------------------------------------------
echo "[1] OPTIONS preflight"
PREFLIGHT_HEADERS="$TMP/preflight.txt"
curl -s -m 15 -D "$PREFLIGHT_HEADERS" -o /dev/null -X OPTIONS "$BASE/s/anything" || true
if grep -qi '^access-control-allow-origin: *\*' "$PREFLIGHT_HEADERS"; then
  ok "CORS allow-origin header on preflight"
else
  bad "missing Access-Control-Allow-Origin on preflight"
fi
if grep -qi '^access-control-allow-methods:.*GET' "$PREFLIGHT_HEADERS"; then
  ok "GET allowed in preflight"
else
  bad "Access-Control-Allow-Methods missing GET"
fi

# --- 2. Live manifest --------------------------------------------------------
echo "[2] Live manifest /s/live/…/$CHANNEL.m3u8"
MANIFEST="$TMP/manifest.m3u8"
MANIFEST_HEADERS="$TMP/manifest.headers"
CODE="$(curl -s -m 25 -D "$MANIFEST_HEADERS" -o "$MANIFEST" -w '%{http_code}' "$BASE/s/live/$XT_USER/$XT_PASS/$CHANNEL.m3u8" || echo 000)"
if [ "$CODE" = "200" ] && head -c 64 "$MANIFEST" | grep -q '#EXTM3U'; then
  ok "manifest returned (#EXTM3U, $(wc -c < "$MANIFEST" | tr -d ' ') bytes)"
else
  bad "manifest not returned (http $CODE)"
  note "Channel $CHANNEL may be offline — pick a fresh channel and re-run with CHANNEL=…"
fi
if grep -qi '^access-control-allow-origin: *\*' "$MANIFEST_HEADERS" && [ "$CODE" = "200" ]; then
  ok "CORS header on manifest"
fi

# --- 3. HLS segment via /hls/ ------------------------------------------------
echo "[3] HLS segment /hls/…"
SEGMENT_PATH="$(grep -v '^#' "$MANIFEST" 2>/dev/null | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r')"
if [ -n "${SEGMENT_PATH:-}" ]; then
  SEGMENT_HEADERS="$TMP/segment.headers"
  SEGMENT_CODE="$(curl -s -m 25 -D "$SEGMENT_HEADERS" -o "$TMP/segment.bin" -w '%{http_code}' "$BASE$SEGMENT_PATH" || echo 000)"
  SEGMENT_TYPE="$(grep -i '^content-type:' "$SEGMENT_HEADERS" | head -1 | tr -d '\r' | cut -d' ' -f2-)"
  SEGMENT_SIZE="$(wc -c < "$TMP/segment.bin" | tr -d ' ')"
  if [ "$SEGMENT_CODE" = "200" ] && [ "$SEGMENT_SIZE" -gt 1000 ]; then
    ok "segment served ($SEGMENT_TYPE, $SEGMENT_SIZE bytes)"
  else
    bad "segment fetch failed (http $SEGMENT_CODE, $SEGMENT_SIZE bytes)"
  fi
else
  note "skipped (no manifest to extract a segment URL from)"
fi

# --- 4. Series episode + Range ----------------------------------------------
echo "[4] Series episode /s/series/…/$EPISODE.mkv (Range)"
RANGE_HEADERS="$TMP/range.headers"
RANGE_CODE="$(curl -s -m 30 -D "$RANGE_HEADERS" -o "$TMP/range.bin" -w '%{http_code}' -H 'Range: bytes=0-1048575' "$BASE/s/series/$XT_USER/$XT_PASS/$EPISODE.mkv" || echo 000)"
RANGE_SIZE="$(wc -c < "$TMP/range.bin" | tr -d ' ')"
if [ "$RANGE_CODE" = "206" ] || [ "$RANGE_CODE" = "200" ]; then
  if [ "$RANGE_SIZE" -gt 1000 ]; then
    ok "episode served over Range (http $RANGE_CODE, $RANGE_SIZE bytes)"
  else
    bad "episode returned http $RANGE_CODE but only $RANGE_SIZE bytes"
  fi
else
  bad "episode fetch failed (http $RANGE_CODE)"
  note "Episode $EPISODE may be gone — pick a fresh episode and re-run with EPISODE=…"
fi
if grep -qi '^content-range:' "$RANGE_HEADERS"; then
  ok "content-range exposed (seeking works)"
fi

# --- 5. Unknown route -> 404 -------------------------------------------------
echo "[5] Unknown route is rejected"
UNKNOWN_CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$BASE/definitely/not/a/route" || echo 000)"
if [ "$UNKNOWN_CODE" = "404" ]; then
  ok "unknown route -> 404"
else
  bad "unknown route returned $UNKNOWN_CODE (expected 404)"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
