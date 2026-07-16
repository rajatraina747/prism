import { useCallback, useEffect, useRef, useState } from 'react';
import {
  init,
  destroy,
  command,
  setProperty,
  observeProperties,
  type MpvObservableProperty,
} from 'tauri-plugin-libmpv-api';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  Play, Pause, RotateCcw, Volume2, VolumeX, Maximize2, Minimize2, AlertTriangle, FolderOpen,
} from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { formatDuration } from '@/services/utils';
import { PLAYER_LOAD_EVENT, type PlayerSource } from '@/lib/player-window';

// The in-app player. Runs in its own transparent "player" window: mpv embeds
// into the window's native view and renders *beneath* the webview, so this
// page is the chrome floating on top of the video. It must never mount the
// app providers (AppProvider would spawn a second download orchestrator) —
// App.tsx routes this window straight here.

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
] as const satisfies MpvObservableProperty[];

interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  title?: string;
  lang?: string;
  selected?: boolean;
  ['demux-channel-count']?: number;
}

interface VideoParams {
  w?: number;
  h?: number;
  gamma?: string;
  ['sig-peak']?: number;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const IS_MAC = navigator.userAgent.includes('Mac');

function trackLabel(t: MpvTrack): string {
  const parts = [t.title, t.lang?.toUpperCase()].filter(Boolean);
  const label = parts.join(' · ') || `Track ${t.id}`;
  const ch = t['demux-channel-count'];
  return ch && ch > 2 ? `${label} (${ch}ch)` : label;
}

export default function Player() {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
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
    await command('loadfile', [src.path]);
    await setProperty('pause', 'no');
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
        }
      }));

      unlisteners.push(await listen<PlayerSource>(PLAYER_LOAD_EVENT, (e) => {
        loadFile(e.payload).catch(() => {});
      }));

      if (cancelled) return;

      try {
        await init({
          initialOptions: {
            vo: 'gpu-next',
            hwdec: 'auto-safe',
            // Survive EOF so the user can replay instead of the window dying.
            'keep-open': 'yes',
            'force-window': 'yes',
            // mpv resizes its (adopted — see src-tauri/src/player.rs) window
            // to each video's native size on load, breaking the frame pinning.
            'auto-window-resize': 'no',
            // HDR: hint the source's colorspace to the display. On macOS this
            // drives EDR, so HDR content renders as true HDR on capable
            // panels; SDR displays fall back to gpu-next tone mapping.
            'target-colorspace-hint': 'yes',
            // The webview owns all input and chrome.
            'input-default-bindings': 'no',
            osc: 'no',
          },
          observedProperties: OBSERVED,
        });
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
      const src = params.get('src');
      if (src) {
        await loadFile({ path: src, title: params.get('title') ?? undefined });
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
      document.documentElement.classList.remove('player-window');
      // The plugin also destroys on window close; this covers HMR/unmount.
      destroy().catch(() => {});
    };
  }, [loadFile]);

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
      command('seek', [0, 'absolute']).then(() => setProperty('pause', 'no')).catch(() => {});
      return;
    }
    setProperty('pause', paused ? 'no' : 'yes').catch(() => {});
  }, [paused, eof]);

  const seekTo = useCallback((secs: number) => {
    command('seek', [secs, 'absolute']).catch(() => {});
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
    openFileDialog({
      multiple: false,
      filters: [{
        name: 'Media',
        extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'mp3', 'm4a', 'opus', 'flac', 'wav', 'ogg'],
      }],
    }).then((picked) => {
      if (typeof picked === 'string') {
        const name = picked.split('/').pop() ?? picked;
        loadFile({ path: picked, title: name }).catch(() => {});
      }
    }).catch(() => {});
  }, [loadFile]);

  // Controls stay while paused; fade after idle mouse while playing.
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);
  const showControls = !ready || initError !== null || paused || eof || controlsVisible;

  // Keyboard parity with normal players.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      switch (e.key) {
        case ' ': e.preventDefault(); togglePause(); break;
        case 'ArrowLeft': command('seek', [-5, 'relative']).catch(() => {}); break;
        case 'ArrowRight': command('seek', [5, 'relative']).catch(() => {}); break;
        case 'ArrowUp': setProperty('volume', Math.min(100, Math.round(volume) + 5)).catch(() => {}); break;
        case 'ArrowDown': setProperty('volume', Math.max(0, Math.round(volume) - 5)).catch(() => {}); break;
        case 'm': setProperty('mute', muted ? 'no' : 'yes').catch(() => {}); break;
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
          <p className="text-xs text-white/50">
            Prism's player needs libmpv. On macOS install it with{' '}
            <code className="bg-white/10 px-1 rounded">brew install mpv</code>, then reopen the player.
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
        <Slider
          value={[seekingRef.current ? timePos : Math.min(timePos, duration || timePos)]}
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          onValueChange={([v]) => { seekingRef.current = true; setTimePos(v); }}
          onValueCommit={([v]) => { seekingRef.current = false; seekTo(v); }}
          className="mb-2.5"
          aria-label="Seek"
        />
        <div className="flex items-center gap-3 text-white">
          <button
            onClick={togglePause}
            className="p-1.5 rounded-md hover:bg-white/15 transition-colors"
            title={eof ? 'Replay' : paused ? 'Play' : 'Pause'}
            aria-label={eof ? 'Replay' : paused ? 'Play' : 'Pause'}
          >
            {eof ? <RotateCcw className="w-5 h-5" /> : paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
          </button>

          <span className="text-[11px] tabular-nums text-white/90 shrink-0">
            {formatDuration(timePos)} / {formatDuration(duration)}
          </span>

          <div className="flex items-center gap-1.5 ml-1">
            <button
              onClick={() => setProperty('mute', muted ? 'no' : 'yes').catch(() => {})}
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
              onValueChange={([v]) => setProperty('volume', v).catch(() => {})}
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
                onChange={(e) => setProperty('aid', e.target.value).catch(() => {})}
                className="bg-black/60 border border-white/20 rounded px-1 py-0.5 text-[11px] text-white max-w-36"
              >
                {audioTracks.map((t) => (
                  <option key={t.id} value={t.id}>{trackLabel(t)}</option>
                ))}
              </select>
            </label>
          )}

          {subTracks.length > 0 && (
            <label className="flex items-center gap-1 text-[11px] text-white/80">
              Subs
              <select
                value={subTracks.find((t) => t.selected)?.id ?? 'no'}
                onChange={(e) => setProperty('sid', e.target.value).catch(() => {})}
                className="bg-black/60 border border-white/20 rounded px-1 py-0.5 text-[11px] text-white max-w-36"
              >
                <option value="no">Off</option>
                {subTracks.map((t) => (
                  <option key={t.id} value={t.id}>{trackLabel(t)}</option>
                ))}
              </select>
            </label>
          )}

          <label className="flex items-center gap-1 text-[11px] text-white/80">
            <select
              value={speed}
              onChange={(e) => setProperty('speed', Number(e.target.value)).catch(() => {})}
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
