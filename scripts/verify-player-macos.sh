#!/usr/bin/env bash
# End-to-end check that the in-app player starts, plays and quits on macOS,
# with nobody clicking anything.
#
# Builds a debug "Prism Verify" app bundle under its own identifier, so the
# real Prism's settings, queue and torrents are never touched. Launches it RUNS
# times with PRISM_VERIFY_PLAYER=<clip>. The debug-only hook in
# src-tauri/src/player.rs opens the player, logs "player-verify: ok" once
# playback passes 1 s, and quits. A run fails if that line doesn't appear
# within the budget, or if the app then doesn't quit. A failed run is sampled
# (`sample`), so a deadlock shows its stacks. The whole check also fails if
# macOS records a new hang report for the verify app.
#
#   scripts/verify-player-macos.sh [runs=20] [clip=src-tauri/examples/fixtures/clip.mp4]
#
# Needs src-tauri/lib populated the way release builds are — run
# scripts/bundle-libmpv-macos.sh first (CI does the same before bundling).
set -euo pipefail

cd "$(dirname "$0")/.."
RUNS="${1:-20}"
CLIP_ARG="${2:-src-tauri/examples/fixtures/clip.mp4}"
CLIP="$(cd "$(dirname "$CLIP_ARG")" && pwd)/$(basename "$CLIP_ARG")"
BUDGET_SECS=45
QUIT_SECS=15
ID="com.prism.verify"

[[ "$(uname)" == "Darwin" ]] || { echo "macOS only" >&2; exit 64; }
[[ -f "$CLIP" ]] || { echo "clip not found: $CLIP" >&2; exit 64; }
[[ -f src-tauri/lib/libmpv.dylib ]] || {
  echo "src-tauri/lib/libmpv.dylib is missing — run scripts/bundle-libmpv-macos.sh first" >&2
  exit 64
}

# No updater artifacts: they need the release signing key, which only CI has.
npx tauri build --debug --bundles app \
  --config "{\"identifier\":\"$ID\",\"productName\":\"Prism Verify\",\"bundle\":{\"createUpdaterArtifacts\":false}}"

APP="src-tauri/target/debug/bundle/macos/Prism Verify.app"
EXE="$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$APP/Contents/Info.plist")"
BIN="$APP/Contents/MacOS/$EXE"
WORK="$(mktemp -d -t prism-verify-player)"

hang_reports() { ls /Library/Logs/DiagnosticReports 2>/dev/null | grep -ci "prism.verify\|Prism Verify" || true; }
hangs_before="$(hang_reports)"

failures=0
for i in $(seq 1 "$RUNS"); do
  log="$WORK/run-$i.log"
  PRISM_VERIFY_PLAYER="$CLIP" PRISM_VERIFY_EXIT=1 "$BIN" >"$log" 2>&1 &
  pid=$!

  result="timeout"
  for _ in $(seq 1 $((BUDGET_SECS * 10))); do
    if grep -q "player-verify: ok" "$log"; then result="ok"; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then result="exited"; break; fi
    sleep 0.1
  done

  if [[ "$result" == "ok" ]]; then
    for _ in $(seq 1 $((QUIT_SECS * 10))); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then result="no-quit"; fi
  fi

  if [[ "$result" == "ok" ]]; then
    echo "run $i: ok"
  else
    failures=$((failures + 1))
    echo "run $i: FAILED ($result) — log: $log"
    if kill -0 "$pid" 2>/dev/null; then
      /usr/bin/sample "$pid" 3 -file "$log.sample.txt" >/dev/null 2>&1 || true
      for frame in mp_dispatch_lock mp_rendezvous _dispatch_sync_f_slow MacCommon; do
        grep -q "$frame" "$log.sample.txt" 2>/dev/null && echo "  sample contains $frame"
      done
      echo "  sample: $log.sample.txt"
      kill -9 "$pid" 2>/dev/null || true
    fi
    grep -iE "player|mpv|error" "$log" | tail -5 | sed 's/^/  /' || true
  fi
  wait "$pid" 2>/dev/null || true
done

hangs_after="$(hang_reports)"
if [[ "$hangs_after" -gt "$hangs_before" ]]; then
  echo "macOS recorded a new hang report for Prism Verify (/Library/Logs/DiagnosticReports)"
  failures=$((failures + 1))
fi

echo "logs: $WORK"
echo "verify app data (safe to delete): ~/Library/Application Support/$ID"
if [[ "$failures" -gt 0 ]]; then
  echo "player verification FAILED ($failures problem(s) across $RUNS run(s))"
  exit 1
fi
echo "player verification passed: $RUNS/$RUNS runs played and quit cleanly"
