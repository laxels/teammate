import {
  Controls,
  FullscreenButton,
  MediaPlayer,
  MediaProvider,
  MuteButton,
  PlayButton,
  SeekButton,
  Time,
  TimeSlider,
  useMediaRemote,
  useMediaState,
} from "@vidstack/react";
import "@vidstack/react/player/styles/base.css";
import { type ReactNode, useState } from "react";
import type { PlayerState } from "./recording";

/** Discrete playback rates for the speed control (issue #66). The </> keyboard
 * shortcuts step Vidstack's own rate ladder; this menu snaps to these. */
const PLAYBACK_RATES = [0.25, 0.5, 1, 2, 4, 8, 16] as const;

/**
 * The task-details recording section. Renders the themed Vidstack player when a
 * recording is available, or a distinct placeholder for each other state
 * (recording in progress / uploading / unavailable).
 */
export function RecordingPlayer({
  state,
  src,
  title,
}: {
  state: PlayerState;
  src: string | null;
  title: string;
}) {
  if (state === "available" && src !== null) {
    return <ThemedPlayer src={src} title={title} />;
  }
  // playerState only returns "available" when a URL exists, so this fallback is
  // belt-and-suspenders for an available-but-urlless edge.
  return (
    <RecordingPlaceholder
      state={state === "available" ? "unavailable" : state}
    />
  );
}

function ThemedPlayer({ src, title }: { src: string; title: string }) {
  return (
    <MediaPlayer
      className="rec-player"
      title={title}
      // Force the video provider; the Convex storage URL has no extension to
      // sniff. The browser plays the H.264/.mov bytes regardless of this hint.
      src={{ src, type: "video/mp4" }}
      playsInline
      aspectRatio="16/9"
      // The operator navigated here specifically to watch the recording, so
      // attach the source immediately (metadata preload) rather than waiting
      // for the player to scroll into view — duration + scrubbing are ready.
      load="eager"
      // Global shortcuts (no focus needed); Vidstack suppresses them while a
      // text input / textarea / contenteditable is focused — issue decision #5.
      keyTarget="document"
    >
      <MediaProvider />
      <PlayerControls />
    </MediaPlayer>
  );
}

function PlayerControls() {
  return (
    <Controls.Root className="rec-controls">
      {/* Click/gesture area above the bar keeps the video tappable. */}
      <div className="rec-controls-fill" />
      <Controls.Group className="rec-seek-row">
        <TimeSlider.Root className="rec-slider">
          <TimeSlider.Track className="rec-slider-track">
            <TimeSlider.TrackFill className="rec-slider-fill" />
          </TimeSlider.Track>
          <TimeSlider.Thumb className="rec-slider-thumb" />
        </TimeSlider.Root>
      </Controls.Group>
      <Controls.Group className="rec-button-row">
        <PlayButton className="rec-btn">
          <PlayPauseGlyph />
        </PlayButton>
        <SeekButton className="rec-btn" seconds={-10}>
          <SeekGlyph dir="back" />
        </SeekButton>
        <SeekButton className="rec-btn" seconds={10}>
          <SeekGlyph dir="fwd" />
        </SeekButton>
        <span className="rec-time">
          <Time className="rec-time-cur" type="current" />
          <span className="rec-time-sep">/</span>
          <Time className="rec-time-dur" type="duration" />
        </span>
        <span className="rec-spacer" />
        <SpeedControl />
        <MuteButton className="rec-btn">
          <VolumeGlyph />
        </MuteButton>
        <FullscreenButton className="rec-btn">
          <FullscreenGlyph />
        </FullscreenButton>
      </Controls.Group>
    </Controls.Root>
  );
}

function PlayPauseGlyph() {
  const paused = useMediaState("paused");
  return paused ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function SeekGlyph({ dir }: { dir: "back" | "fwd" }) {
  // A circular replay arrow with the seek amount; mirrored for forward.
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={dir === "fwd" ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="13"
        y="16"
        fontSize="8"
        fontWeight="700"
        fill="currentColor"
        textAnchor="middle"
        style={
          dir === "fwd"
            ? { transform: "scaleX(-1)", transformOrigin: "13px 14px" }
            : undefined
        }
      >
        10
      </text>
    </svg>
  );
}

function VolumeGlyph() {
  const muted = useMediaState("muted");
  const volume = useMediaState("volume");
  const silent = muted || volume === 0;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor" />
      {silent ? (
        <path
          d="M16 9l5 5m0-5l-5 5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M16 8.5a4 4 0 0 1 0 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function FullscreenGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SpeedControl() {
  const rate = useMediaState("playbackRate");
  const remote = useMediaRemote();
  const [open, setOpen] = useState(false);
  return (
    <div className="rec-speed">
      <button
        type="button"
        className="rec-btn rec-speed-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {rate}×
      </button>
      {open && (
        <div className="rec-speed-menu" role="menu">
          {PLAYBACK_RATES.map((r) => (
            <button
              type="button"
              key={r}
              role="menuitemradio"
              aria-checked={r === rate}
              className={`rec-speed-item ${r === rate ? "rec-speed-on" : ""}`}
              onClick={() => {
                remote.changePlaybackRate(r);
                setOpen(false);
              }}
            >
              {r}×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordingPlaceholder({
  state,
}: {
  state: Exclude<PlayerState, "available">;
}) {
  const copy: Record<
    typeof state,
    { glyph: ReactNode; title: string; sub: string }
  > = {
    recording: {
      glyph: <span className="rec-dot" aria-hidden="true" />,
      title: "Recording in progress",
      sub: "The devbox screen is being captured while the task runs.",
    },
    uploading: {
      glyph: <span className="rec-uploading-spin" aria-hidden="true" />,
      title: "Processing recording",
      sub: "The screen recording finished and is uploading — this can take a moment.",
    },
    unavailable: {
      glyph: <span className="rec-none-glyph" aria-hidden="true" />,
      title: "No screen recording",
      sub: "This task has no recording (it predates the feature, or the recording was interrupted before it could be saved).",
    },
  };
  const { glyph, title, sub } = copy[state];
  return (
    <div className={`rec-placeholder rec-placeholder-${state}`}>
      {glyph}
      <div className="rec-placeholder-title">{title}</div>
      <div className="rec-placeholder-sub">{sub}</div>
    </div>
  );
}
