import {
  Controls,
  FullscreenButton,
  MediaPlayer,
  type MediaPlayerInstance,
  MediaProvider,
  MuteButton,
  PlayButton,
  SeekButton,
  Time,
  TimeSlider,
  useMediaRemote,
  useMediaState,
  VolumeSlider,
} from "@vidstack/react";
import "@vidstack/react/player/styles/base.css";
import { type ReactNode, type RefObject, useState } from "react";
import { previewAlign } from "./commentLayout";
import type { PlayerState } from "./recording";

/** Discrete playback rates for the speed control (issue #66). The </> keyboard
 * shortcuts step Vidstack's own rate ladder; this menu snaps to these. */
const PLAYBACK_RATES = [0.25, 0.5, 1, 2, 4, 8, 16] as const;

/** The slice of a comment the player needs (seek-bar markers + capture) (#70). */
export type PlayerComment = { id: string; videoTimeSec: number; text: string };

export type RecordingPlayerProps = {
  state: PlayerState;
  src: string | null;
  title: string;
  comments: PlayerComment[];
  /** Grab the frame + persist a comment at the given video second. Resolves
   * once the comment exists so the capture box can close. */
  onCreateComment: (videoTimeSec: number, text: string) => Promise<void>;
  /** Focus a comment in the rail (e.g. after clicking its seek-bar marker). */
  onFocusComment: (id: string) => void;
  /** The live player instance, so the rail can seek the video on comment click. */
  playerRef: RefObject<MediaPlayerInstance | null>;
};

/** m:ss timecode for a number of seconds. */
export function formatTimecode(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * The task-details recording section. Renders the themed Vidstack player (with
 * Loom-style timestamped commenting, #70) when a recording is available, or a
 * distinct placeholder for each other state.
 */
export function RecordingPlayer(props: RecordingPlayerProps) {
  if (props.state === "available" && props.src !== null) {
    return <ThemedPlayer {...props} src={props.src} />;
  }
  // playerState only returns "available" when a URL exists, so this fallback is
  // belt-and-suspenders for an available-but-urlless edge.
  return (
    <RecordingPlaceholder
      state={props.state === "available" ? "unavailable" : props.state}
    />
  );
}

function ThemedPlayer({
  src,
  title,
  comments,
  onCreateComment,
  onFocusComment,
  playerRef,
}: RecordingPlayerProps & { src: string }) {
  // The video second a comment is being written at, or null when not capturing.
  const [captureAt, setCaptureAt] = useState<number | null>(null);

  return (
    <MediaPlayer
      className="rec-player"
      ref={playerRef}
      title={title}
      // Force the video provider; the Convex storage URL has no extension to
      // sniff. The browser plays the H.264/.mov bytes regardless of this hint.
      src={{ src, type: "video/mp4" }}
      playsInline
      aspectRatio="16/9"
      load="eager"
      // Global shortcuts (no focus needed); Vidstack suppresses them while a
      // text input / textarea / contenteditable is focused — issue decision #5,
      // which is also exactly what makes the comment textarea safe to type in.
      keyTarget="document"
    >
      <MediaProvider />
      <PlayerControls
        comments={comments}
        captureAt={captureAt}
        onArm={(t) => setCaptureAt(t)}
        onCancelCapture={() => setCaptureAt(null)}
        onSubmitCapture={async (text) => {
          if (captureAt !== null) await onCreateComment(captureAt, text);
          setCaptureAt(null);
        }}
        onFocusComment={onFocusComment}
      />
    </MediaPlayer>
  );
}

function PlayerControls({
  comments,
  captureAt,
  onArm,
  onCancelCapture,
  onSubmitCapture,
  onFocusComment,
}: {
  comments: PlayerComment[];
  /** The video second being commented at, or null when not capturing. */
  captureAt: number | null;
  onArm: (videoTimeSec: number) => void;
  onCancelCapture: () => void;
  onSubmitCapture: (text: string) => Promise<void>;
  onFocusComment: (id: string) => void;
}) {
  return (
    <Controls.Root className="rec-controls">
      {/* Click/gesture area above the bar keeps the video tappable. */}
      <div className="rec-controls-fill" />
      <Controls.Group className="rec-seek-row">
        <CommentMarkers comments={comments} onFocusComment={onFocusComment} />
        <TimeSlider.Root className="rec-slider">
          <TimeSlider.Track className="rec-slider-track">
            <TimeSlider.TrackFill className="rec-slider-fill" />
          </TimeSlider.Track>
          <TimeSlider.Thumb className="rec-slider-thumb" />
        </TimeSlider.Root>
      </Controls.Group>
      {captureAt !== null ? (
        // Loom-style: the composer replaces the button row below the seek bar,
        // so writing a comment never obscures the video (#113).
        <CommentComposer
          videoTimeSec={captureAt}
          onCancel={onCancelCapture}
          onSubmit={onSubmitCapture}
        />
      ) : (
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
          <CommentButton onArm={onArm} />
          <SpeedControl />
          <VolumeControl />
          <FullscreenButton className="rec-btn">
            <FullscreenGlyph />
          </FullscreenButton>
        </Controls.Group>
      )}
    </Controls.Root>
  );
}

/** The "add a comment here" button: pauses, then arms the capture box at the
 * current timestamp. */
function CommentButton({ onArm }: { onArm: (videoTimeSec: number) => void }) {
  const time = useMediaState("currentTime");
  const remote = useMediaRemote();
  return (
    <button
      type="button"
      className="rec-btn rec-comment-btn"
      title="Comment at this timestamp"
      onClick={() => {
        remote.pause();
        onArm(time);
      }}
    >
      <CommentGlyph />
    </button>
  );
}

/** Speech-bubble markers over the seek bar, one per comment. Hover shows a
 * preview that shifts to stay inside the player; click seeks + focuses. */
function CommentMarkers({
  comments,
  onFocusComment,
}: {
  comments: PlayerComment[];
  onFocusComment: (id: string) => void;
}) {
  const duration = useMediaState("duration");
  const remote = useMediaRemote();
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return (
    <div className="rec-markers" aria-hidden={false}>
      {comments.map((c) => {
        const leftPct = Math.min(
          100,
          Math.max(0, (c.videoTimeSec / duration) * 100),
        );
        const align = previewAlign(leftPct);
        return (
          <button
            type="button"
            key={c.id}
            className="rec-marker"
            style={{ left: `${leftPct}%` }}
            title={`Comment at ${formatTimecode(c.videoTimeSec)}`}
            onClick={() => {
              remote.seek(c.videoTimeSec);
              onFocusComment(c.id);
            }}
          >
            <SpeechBubbleGlyph />
            <span className={`rec-marker-preview rec-marker-preview-${align}`}>
              {c.text}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Loom-style inline composer that replaces the control button row while a
 * comment is being written, so the video stays fully visible (#113). */
function CommentComposer({
  videoTimeSec,
  onSubmit,
  onCancel,
}: {
  videoTimeSec: number;
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    const trimmed = text.trim();
    if (trimmed === "") {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await onSubmit(trimmed);
    } catch {
      // The mutation/frame-grab swallow their own errors; re-enable on the rare
      // throw so the operator can retry rather than being stuck on "saving…".
      setSaving(false);
    }
  };

  return (
    <Controls.Group className="rec-compose">
      <span className="rec-compose-ts">{formatTimecode(videoTimeSec)}</span>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the box exists to be typed in
        autoFocus
        className="rec-compose-text"
        value={text}
        disabled={saving}
        rows={1}
        placeholder="Add a comment…  (Enter to save · Shift+Enter for a newline · Esc to cancel)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (!saving) onCancel();
          }
        }}
      />
      <button
        type="button"
        className="rec-compose-btn"
        onClick={onCancel}
        disabled={saving}
      >
        cancel
      </button>
      <button
        type="button"
        className="rec-compose-btn rec-compose-btn-primary"
        onClick={() => void submit()}
        disabled={saving}
      >
        {saving ? "saving…" : "comment"}
      </button>
    </Controls.Group>
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

function CommentGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 5h16v11H9l-4 4v-4H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SpeechBubbleGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="rec-marker-glyph">
      <path
        d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-4 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="currentColor"
      />
    </svg>
  );
}

function SeekGlyph({ dir }: { dir: "back" | "fwd" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g
        style={
          dir === "fwd"
            ? { transform: "scaleX(-1)", transformOrigin: "center" }
            : undefined
        }
      >
        <path
          d="M16.5 7.4A7 7 0 1 1 7.5 7.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path d="M7.9 3.4 6.4 8 11.2 7.7Z" fill="currentColor" />
      </g>
      <text
        x="12"
        y="16"
        fontSize="9"
        fontWeight="700"
        fill="currentColor"
        textAnchor="middle"
      >
        10
      </text>
    </svg>
  );
}

/** Mute toggle plus a real volume slider (issue #72). */
function VolumeControl() {
  return (
    <div className="rec-volume">
      <MuteButton className="rec-btn">
        <VolumeGlyph />
      </MuteButton>
      <VolumeSlider.Root className="rec-volume-slider">
        <VolumeSlider.Track className="rec-slider-track">
          <VolumeSlider.TrackFill className="rec-slider-fill" />
        </VolumeSlider.Track>
        <VolumeSlider.Thumb className="rec-slider-thumb" />
      </VolumeSlider.Root>
    </div>
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
