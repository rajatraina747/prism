import { useCallback, useEffect, useRef, useState } from 'react';
import { observeProperties, type MpvObservableProperty } from 'tauri-plugin-libmpv-api';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  Play, Pause, RotateCcw, Volume2, VolumeX, Maximize2, Minimize2, AlertTriangle, FolderOpen,
  SkipBack, SkipForward, Captions, PictureInPicture2,
} from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { formatDuration } from '@/services/utils';
import { PLAYER_LOAD_EVENT, type PlayerSource } from '@/lib/player-window';
import { playerFailureHint } from '@/lib/player-failure';

// The in-app player. Runs in its own transparent "player" window: mpv embeds
// into the window's native view and renders *beneath* the webview, so this
// page is the chrome floating on top of the video. It must never mount the
// app providers (AppProvider would spawn a second download orchestrator) —
// App.tsx routes this window straight here.

// mpv is driven only through Prism's allowlisting `player_*` commands
// (src-tauri/src/player.rs): the plugin's raw command/property passthrough is
// not granted to this window, and mpv starts with config, scripts and the
// ytdl hook disabled. `observeProperties` is a plain event listener — the
// observed set itself is fixed in Rust and must match this list.
const setProp = (name: string, value: unknown) => invoke('player_set', { name, value });
const seek = (seconds: number, relative = false) => invoke('player_seek', { seconds, relative });

const OBSERVED = [
  ['pause', 'flag'],
  ['time-pos', 'double', 'none'],
  ['duration', 'double', 'none'],
  ['volume', 'double'],
  ['mute', 'flag'],
  ['speed', 'double'],
  ['track-list', 'node'],
  ['media-title', 'string', 'none'],
  ['video-params', 'node', 'none'],
  ['eof-reached', 'flag', 'none'],
  ['chapter-list', 'node', 'none'],
  ['chapter', 'int64', 'none'],
  ['sub-delay', 'double'],
  ['sub-visibility', 'flag'],
] as const satisfies MpvObservableProperty[];

interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  title?: string;
  lang?: string;
  selected?: boolean;
  ['demux-channel-count']?: number;
}

interface MpvChapter {
  title?: string;
  time: number;
}

interface VideoParams {
  w?: number;
  h?: number;
  gamma?: string;
  ['sig-peak']?: number;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const IS_MAC = navigator.userAgent.includes('Mac');
const IS_WINDOWS = navigator.userAgent.includes('Windows');

function trackLabel(t: MpvTrack): string {
  const parts = [t.title, t.lang?.toUpperCase()].filter(Boolean);
  const label = parts.join(' · ') || `Track ${t.id}`;
  const ch = t['demux-channel-count'];
  return ch && ch > 2 ? `${label} (${ch}ch)` : label;
}

export default function Player() {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [timePos, setTimePos] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [videoParams, setVideoParams] = useState<VideoParams | null>(null);
  const [title, setTitle] = useState('Prism Player');
  const [eof, setEof] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  // Set when this file was left partway through, so the jump is visible and
  // undoable rather than the video mysteriously starting in the middle.
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const [chapters, setChapters] = useState<MpvChapter[]>([]);
  const [chapter, setChapter] = useState<number | null>(null);
  const [subDelay, setSubDelay] = useState(0);
  const [subVisible, setSubVisible] = useState(true);
  const [siblingSubs, setSiblingSubs] = useState<string[]>([]);
  const [mini, setMini] = useState(false);

  // While the user drags the seek bar, ignore time-pos updates so the thumb
  // doesn't fight the stream.
  const seekingRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFile = useCallback(async (src: PlayerSource) => {
    setEof(false);
    if (src.title) {
      setTitle(src.title);
      getCurrentWindow().setTitle(src.title).catch(() => {});
    }
    // Rust validates either way (a path against the allowed roots and media
    // types; a stream against the torrent's own file list) and unpauses. A
    // failure — bad path, file not in the torrent, engine timing out — is
    // shown, not swallowed.
    try {
      if (src.stream) {
        await invoke('player_load_stream', { torrentId: src.stream.torrentId, fileIdx: src.stream.fileIdx });
      } else if (src.pick) {
        // The picker runs in Rust so the pick itself is the permission: the
        // player loads only files Prism downloaded when it's handed a path.
        const name = await invoke<string | null>('player_open_file');
        if (name === null) return;
        setTitle(name);
        getCurrentWindow().setTitle(name).catch(() => {});
      } else if (src.path) {
        await invoke('player_load', { path: src.path });
      } else {
        return;
      }
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      throw e;
    }
    // Pick up where this one was left, if it was left partway through. Rust
    // knows which item is open; this only asks for the number.
    try {
      const at = await invoke<number | null>('player_resume_position');
      if (at && at > 0) {
        await invoke('player_seek', { seconds: at, relative: false });
        setResumedFrom(at);
      } else {
        setResumedFrom(null);
      }
    } catch { /* a missing position is not worth reporting */ }
    // Subtitles sitting next to this file, offered without a file picker.
    invoke<string[]>('player_sibling_subtitles')
      .then(setSiblingSubs)
      .catch(() => setSiblingSubs([]));
    // Re-run the macOS adoption pass in case mpv (re)created its video window
    // for this load — idempotent, no-op elsewhere. See src-tauri/src/player.rs.
    invoke('fixup_player_video').catch(() => {});
  }, []);

  // One-time setup: transparent page, mpv init, property observers, load
  // events from the main window, and the file passed in the URL.
  useEffect(() => {
    document.documentElement.classList.add('player-window');
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      // Listen BEFORE init: mpv emits the initial value of every observed
      // property during init, and events fired before the JS listener attaches
      // are lost — the classic symptom is a playing video whose button still
      // says Play (stale `paused`), making the toggle a permanent no-op.
      unlisteners.push(await observeProperties(OBSERVED, ({ name, data }) => {
        switch (name) {
          case 'pause': setPaused(data); break;
          case 'time-pos': if (!seekingRef.current) setTimePos(data ?? 0); break;
          case 'duration': setDuration(data ?? 0); break;
          case 'volume': setVolume(data); break;
          case 'mute': setMuted(data); break;
          case 'speed': setSpeed(data); break;
          case 'track-list': setTracks((data as MpvTrack[] | null) ?? []); break;
          case 'media-title': if (data) setTitle(data); break;
          case 'video-params': setVideoParams(data as VideoParams | null); break;
          case 'eof-reached': setEof(data ?? false); break;
          case 'chapter-list': setChapters((data as MpvChapter[] | null) ?? []); break;
          case 'chapter': setChapter(data); break;
          case 'sub-delay': setSubDelay(data ?? 0); break;
          case 'sub-visibility': setSubVisible(data ?? true); break;
        }
      }));

      unlisteners.push(await listen<PlayerSource>(PLAYER_LOAD_EVENT, (e) => {
        loadFile(e.payload).catch(() => {});
      }));

      if (cancelled) return;

      // mpv options (vo, hwdec, HDR hint, lockdown) and the observed property
      // set live in Rust — see player_mpv_config in src-tauri/src/player.rs.
      // mpv's own log lands at <app data>/mpv.log.
      try {
        await invoke('player_init');
      } catch (e) {
        if (!cancelled) setInitError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (cancelled) return;

      // macOS: adopt mpv's standalone video window under this window and pin
      // its frame. See src-tauri/src/player.rs. No-op on other platforms.
      invoke<string[]>('fixup_player_video')
        .then((views) => console.log('[player] app windows:', views))
        .catch((e) => console.warn('[player] video-window adoption failed:', e));

      setReady(true);

      const params = new URLSearchParams(window.location.search);
      const title = params.get('title') ?? undefined;
      const torrentId = params.get('torrentId');
      const fileIdx = params.get('fileIdx');
      const src = params.get('src');
      if (torrentId && fileIdx !== null) {
        await loadFile({ stream: { torrentId, fileIdx: Number(fileIdx) }, title }).catch(() => {});
      } else if (src) {
        await loadFile({ path: src, title }).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
      document.documentElement.classList.remove('player-window');
      // The plugin also destroys on window close; this covers HMR/unmount.
      invoke('player_destroy').catch(() => {});
    };
  }, [loadFile]);

  // Remember the position periodically and when the window goes away. Rust
  // decides what is worth keeping (and forgets anything watched to the end),
  // so this just reports where the player is.
  const progressRef = useRef({ timePos: 0, duration: 0 });
  progressRef.current = { timePos, duration };
  useEffect(() => {
    const save = () => {
      const { timePos: position, duration: total } = progressRef.current;
      if (position > 0) invoke('player_save_position', { position, duration: total }).catch(() => {});
    };
    const t = setInterval(save, 5000);
    window.addEventListener('beforeunload', save);
    return () => {
      clearInterval(t);
      window.removeEventListener('beforeunload', save);
      save();
    };
  }, []);

  // Non-mac: native fullscreen can change outside our button — track the real
  // state on resizes. On macOS we use *simple* fullscreen (below) whose state
  // is ours alone, and isFullscreen() would wrongly reset it to false.
  useEffect(() => {
    if (IS_MAC) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win.onResized(() => {
      win.isFullscreen().then(setFullscreen).catch(() => {});
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => unlisten?.();
  }, []);

  // Keep the adopted video window pinned across any size change the native
  // Resized hook misses (simple-fullscreen transitions, display scale
  // changes). The webview resizes with the window, so its own resize event is
  // the most reliable signal there is.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => invoke('fixup_player_video').catch(() => {}), 100);
    };
    window.addEventListener('resize', onResize);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const togglePause = useCallback(() => {
    if (eof) {
      // Replay from the start — with keep-open, unpausing at EOF is a no-op.
      seek(0).then(() => setProp('pause', 'no')).catch(() => {});
      return;
    }
    setProp('pause', paused ? 'no' : 'yes').catch(() => {});
  }, [paused, eof]);

  const seekTo = useCallback((secs: number) => {
    seek(secs).catch(() => {});
  }, []);

  const toggleFullscreen = useCallback(() => {
    const win = getCurrentWindow();
    if (IS_MAC) {
      // Native fullscreen moves the window into its own Space, which strands
      // the adopted mpv video window (see src-tauri/src/player.rs) — the
      // video and controls separate. Simple fullscreen fills the screen in
      // the current Space, so the parent/child pairing survives.
      const next = !fullscreen;
      win.setSimpleFullscreen(next).then(() => {
        setFullscreen(next);
        // Re-pin the adopted video window — the native Resized hook doesn't
        // fire reliably across simple-fullscreen transitions.
        invoke('fixup_player_video').catch(() => {});
      }).catch(() => {});
      return;
    }
    win.isFullscreen()
      .then((fs) => win.setFullscreen(!fs).then(() => setFullscreen(!fs)))
      .catch(() => {});
  }, [fullscreen]);

  const pickAndPlay = useCallback(() => {
    loadFile({ pick: true }).catch(() => {});
  }, [loadFile]);

  const goChapter = useCallback((delta: number) => {
    if (chapters.length === 0) return;
    const next = Math.min(chapters.length - 1, Math.max(0, (chapter ?? 0) + delta));
    setProp('chapter', next).catch(() => {});
  }, [chapters.length, chapter]);

  const addSubtitle = useCallback(() => {
    openFileDialog({
      multiple: false,
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'ass', 'ssa', 'sub', 'lrc'] }],
    }).then((picked) => {
      if (typeof picked === 'string') {
        invoke('player_add_subtitle', { path: picked })
          .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
      }
    }).catch(() => {});
  }, []);

  const toggleMini = useCallback(() => {
    const next = !mini;
    invoke('player_set_mini', { on: next }).then(() => setMini(next)).catch(() => {});
  }, [mini]);

  // Controls stay while paused; fade after idle mouse while playing.
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);
  const showControls = !ready || initError !== null || loadError !== null || paused || eof || controlsVisible;

  // Keyboard parity with normal players.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      switch (e.key) {
        case ' ': e.preventDefault(); togglePause(); break;
        case 'ArrowLeft': seek(-5, true).catch(() => {}); break;
        case 'ArrowRight': seek(5, true).catch(() => {}); break;
        case 'ArrowUp': setProp('volume', Math.min(100, Math.round(volume) + 5)).catch(() => {}); break;
        case 'ArrowDown': setProp('volume', Math.max(0, Math.round(volume) - 5)).catch(() => {}); break;
        case 'm': setProp('mute', muted ? 'no' : 'yes').catch(() => {}); break;
        case 'f': toggleFullscreen(); break;
        // Simple fullscreen has no OS-level Escape handling — provide it.
        case 'Escape': if (fullscreen) toggleFullscreen(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePause, toggleFullscreen, volume, muted, fullscreen]);

  const audioTracks = tracks.filter((t) => t.type === 'audio');
  const subTracks = tracks.filter((t) => t.type === 'sub');
  const isHdr = videoParams?.gamma === 'pq' || videoParams?.gamma === 'hlg'
    || (videoParams?.['sig-peak'] ?? 1) > 1;
  const audioCh = audioTracks.find((t) => t.selected)?.['demux-channel-count'];
  const channelBadge = audioCh === 6 ? '5.1' : audioCh === 8 ? '7.1'
    : audioCh && audioCh > 2 ? `${audioCh}ch` : null;

  if (initError) {
    return (
      <div className="fixed inset-0 bg-black text-white flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <AlertTriangle className="w-8 h-8 mx-auto text-amber-400" />
          <h1 className="text-sm font-semibold">The player engine failed to start</h1>
          <p className="text-xs text-white/70 break-words">{initError}</p>
          {/* A reinstall only helps when the library is missing; see
              lib/player-failure.ts. */}
          <p className="text-xs text-white/50">
            {playerFailureHint(initError, IS_MAC ? 'mac' : IS_WINDOWS ? 'windows' : 'linux')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`fixed inset-0 select-none ${showControls ? '' : 'cursor-none'} ${ready ? '' : 'bg-black'}`}
      // Not decorative: macOS treats fully transparent window pixels as
      // click-through, so with a 0-alpha surface every click/hover over the
      // video would fall through to the video window behind and steal
      // keyboard focus (dead spacebar, controls that never reappear). 1%
      // black is imperceptible but makes the whole surface hit-testable.
      style={ready ? { background: 'rgba(0, 0, 0, 0.01)' } : undefined}
      onMouseMove={pokeControls}
    >
      {/* Click video = play/pause, double-click = fullscreen */}
      <div className="absolute inset-0" onClick={togglePause} onDoubleClick={toggleFullscreen} />

      {/* Top bar: title + format badges */}
      <div
        className={`absolute top-0 inset-x-0 px-4 pt-3 pb-8 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300 pointer-events-none ${showControls ? 'opacity-100' : 'opacity-0'}`}
      >
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-medium text-white truncate drop-shadow">{title}</h1>
          {loadError && (
            <span role="alert" className="shrink-0 max-w-[60%] truncate text-[11px] px-1.5 py-0.5 rounded bg-red-500/80 text-white" title={loadError}>
              {loadError}
            </span>
          )}
          {resumedFrom !== null && (
            <button
              onClick={() => { seek(0).catch(() => {}); setResumedFrom(null); }}
              className="shrink-0 pointer-events-auto text-[11px] px-1.5 py-0.5 rounded bg-white/15 text-white/90 hover:bg-white/25 transition-colors"
              title={`Resumed from ${formatDuration(resumedFrom)}`}
            >
              Resumed from {formatDuration(resumedFrom)} · Start over
            </button>
          )}
          {isHdr && (
            <span className="shrink-0 text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-amber-400/90 text-black">
              HDR
            </span>
          )}
          {videoParams?.w && videoParams?.h && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-white/15 text-white/90 tabular-nums">
              {videoParams.w}×{videoParams.h}
            </span>
          )}
          {channelBadge && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-white/15 text-white/90 tabular-nums">
              {channelBadge}
            </span>
          )}
        </div>
      </div>

      {/* Bottom controls */}
      <div
        className={`absolute bottom-0 inset-x-0 px-4 pb-3 pt-10 bg-gradient-to-t from-black/80 to-transparent transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <div className="relative mb-2.5">
          <Slider
            value={[seekingRef.current ? timePos : Math.min(timePos, duration || timePos)]}
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.1}
            onValueChange={([v]) => { seekingRef.current = true; setTimePos(v); }}
            onValueCommit={([v]) => { seekingRef.current = false; seekTo(v); }}
            aria-label="Seek"
          />
          {/* Chapter marks. Decoration only — the slider underneath stays the
              thing you drag. */}
          {chapters.length > 1 && duration > 0 && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2">
              {chapters.map((c, i) => (
                <span
                  key={`${c.time}-${i}`}
                  className="absolute w-px h-2 -translate-y-1/2 bg-white/70"
                  style={{ left: `${Math.min(100, Math.max(0, (c.time / duration) * 100))}%` }}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 text-white">
          <button
            onClick={togglePause}
            className="p-1.5 rounded-md hover:bg-white/15 transition-colors"
            title={eof ? 'Replay' : paused ? 'Play' : 'Pause'}
            aria-label={eof ? 'Replay' : paused ? 'Play' : 'Pause'}
          >
            {eof ? <RotateCcw className="w-5 h-5" /> : paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
          </button>

          {chapters.length > 1 && (
            <>
              <button
                onClick={() => goChapter(-1)}
                className="p-1.5 rounded-md hover:bg-white/15 transition-colors"
                title="Previous chapter"
                aria-label="Previous chapter"
              >
                <SkipBack className="w-4 h-4" />
              </button>
              <button
                onClick={() => goChapter(1)}
                className="p-1.5 rounded-md hover:bg-white/15 transition-colors"
                title="Next chapter"
                aria-label="Next chapter"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </>
          )}

          <span className="text-[11px] tabular-nums text-white/90 shrink-0">
            {formatDuration(timePos)} / {formatDuration(duration)}
          </span>

          {chapters.length > 1 && chapter !== null && chapters[chapter]?.title && (
            <span className="text-[11px] text-white/70 truncate max-w-40 shrink-0" title={chapters[chapter].title}>
              {chapters[chapter].title}
            </span>
          )}

          <div className="flex items-center gap-1.5 ml-1">
            <button
              onClick={() => setProp('mute', muted ? 'no' : 'yes').catch(() => {})}
              className="p-1.5 rounded-md hover:bg-white/15 transition-colors"
              title={muted ? 'Unmute' : 'Mute'}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <Slider
              value={[muted ? 0 : volume]}
              min={0}
              max={100}
              step={1}
              onValueChange={([v]) => setProp('volume', v).catch(() => {})}
              className="w-20"
              aria-label="Volume"
            />
          </div>

          <div className="flex-1" />

          {audioTracks.length > 0 && (
            <label className="flex items-center gap-1 text-[11px] text-white/80">
              Audio
              <select
                value={audioTracks.find((t) => t.selected)?.id ?? ''}
                onChange={(e) => setProp('aid', e.target.value).catch(() => {})}
                className="bg-black/60 border border-white/20 rounded px-1 py-0.5 text-[11px] text-white max-w-36"
              >
                {audioTracks.map((t) => (
                  <option key={t.id} value={t.id}>{trackLabel(t)}</option>
                ))}
              </select>
            </label>
          )}

          <label className="flex items-center gap-1 text-[11px] text-white/80">
            Subs
            {subTracks.length > 0 && (
              <select
                value={subVisible ? (subTracks.find((t) => t.selected)?.id ?? 'no') : 'no'}
                onChange={(e) => {
                  // "Off" hides subtitles rather than only deselecting, so an
                  // external file added later doesn't come back on its own.
                  setProp('sub-visibility', e.target.value !== 'no').catch(() => {});
                  if (e.target.value !== 'no') setProp('sid', e.target.value).catch(() => {});
                }}
                className="bg-black/60 border border-white/20 rounded px-1 py-0.5 text-[11px] text-white max-w-36"
              >
                <option value="no">Off</option>
                {subTracks.map((t) => (
                  <option key={t.id} value={t.id}>{trackLabel(t)}</option>
                ))}
              </select>
            )}
            {/* Sidecar subtitles found next to the file, then any file. */}
            {siblingSubs.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  invoke('player_add_subtitle', { path: e.target.value })
                    .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
                  e.target.value = '';
                }}
                className="bg-black/60 border border-white/20 rounded px-1 py-0.5 text-[11px] text-white max-w-28"
                aria-label="Subtitles found next to this file"
              >
                <option value="">Nearby…</option>
                {siblingSubs.map((p) => (
                  <option key={p} value={p}>{p.split('/').pop()}</option>
                ))}
              </select>
            )}
            <button
              onClick={addSubtitle}
              className="p-1 rounded-md hover:bg-white/15 transition-colors"
              title="Add a subtitle file…"
              aria-label="Add a subtitle file…"
            >
              <Captions className="w-4 h-4" />
            </button>
            {subVisible && subTracks.some((t) => t.selected) && (
              <span className="flex items-center gap-0.5">
                <button
                  onClick={() => setProp('sub-delay', Math.max(-60, Number((subDelay - 0.5).toFixed(1)))).catch(() => {})}
                  className="px-1 rounded hover:bg-white/15 transition-colors"
                  title="Subtitles earlier"
                  aria-label="Subtitles earlier"
                >
                  −
                </button>
                <span className="tabular-nums text-white/70 w-10 text-center" title="Subtitle delay">
                  {subDelay.toFixed(1)}s
                </span>
                <button
                  onClick={() => setProp('sub-delay', Math.min(60, Number((subDelay + 0.5).toFixed(1)))).catch(() => {})}
                  className="px-1 rounded hover:bg-white/15 transition-colors"
                  title="Subtitles later"
                  aria-label="Subtitles later"
                >
                  +
                </button>
              </span>
            )}
          </label>

          <label className="flex items-center gap-1 text-[11px] text-white/80">
            <select
              value={speed}
              onChange={(e) => setProp('speed', Number(e.target.value)).catch(() => {})}
              className="bg-black/60 border border-white/20 rounded px-1 py-0.5 text-[11px] text-white"
              aria-label="Playback speed"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>{s}×</option>
              ))}
            </select>
          </label>

          <button
            onClick={pickAndPlay}
            className="p-1.5 rounded-md hover:bg-white/15 transition-colors"
            title="Open file…"
            aria-label="Open file…"
          >
            <FolderOpen className="w-4 h-4" />
          </button>

          <button
            onClick={toggleMini}
            className={`p-1.5 rounded-md hover:bg-white/15 transition-colors ${mini ? 'bg-white/20' : ''}`}
            title={mini ? 'Leave mini player' : 'Mini player'}
            aria-label={mini ? 'Leave mini player' : 'Mini player'}
            aria-pressed={mini}
          >
            <PictureInPicture2 className="w-4 h-4" />
          </button>

          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-md hover:bg-white/15 transition-colors"
            title={fullscreen ? 'Exit full screen' : 'Full screen'}
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          >
            {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
