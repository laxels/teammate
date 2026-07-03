import {
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  commentEventTime,
  desiredCenterForTime,
  type EventAnchor,
  layoutComments,
  type RailItem,
} from "./commentLayout";
import { formatTimecode } from "./ui";

/** The slice of a comment the rail renders (#70). */
export type RailComment = {
  id: string;
  videoTimeSec: number;
  text: string;
  imageUrl: string | null;
  updatedAt: number;
};

export type CommentRailProps = {
  comments: RailComment[];
  /** Measured event-row positions in the shared timeline coordinate space. */
  anchors: EventAnchor[];
  /** Recorder wall-clock start, to map a comment's seconds onto event time. */
  recordingStartedAt: number | null;
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  /** Seek the player to a comment's timestamp (rail -> player). */
  onSeek: (videoTimeSec: number) => void;
  onEdit: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

/** Fallback height before a block is measured (keeps the first paint sane). */
const ASSUMED_HEIGHT = 96;

export function CommentRail({
  comments,
  anchors,
  recordingStartedAt,
  focusedId,
  onFocus,
  onSeek,
  onEdit,
  onDelete,
}: CommentRailProps) {
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef<Map<string, HTMLElement>>(new Map());

  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.commentId;
          if (id === undefined) continue;
          const h = (entry.target as HTMLElement).offsetHeight;
          if (next.get(id) !== h) {
            next.set(id, h);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
    observer.current = ro;
    for (const el of observed.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, []);

  /** Callback ref per block: observe it (and seed its measured height). */
  const register = (id: string) => (el: HTMLElement | null) => {
    const prev = observed.current.get(id);
    if (prev !== undefined && prev !== el) {
      observer.current?.unobserve(prev);
      observed.current.delete(id);
    }
    if (el !== null) {
      observed.current.set(id, el);
      observer.current?.observe(el);
      const h = el.offsetHeight;
      setHeights((m) => (m.get(id) === h ? m : new Map(m).set(id, h)));
    }
  };

  const items: RailItem[] = comments.map((c) => {
    const eventTime = commentEventTime(recordingStartedAt, c.videoTimeSec);
    // With a known recording start, align to the event timeline; otherwise fall
    // back to a simple time-ordered stack (pre-#70 recordings have no start).
    const desiredCenter =
      eventTime === null
        ? c.videoTimeSec
        : desiredCenterForTime(eventTime, anchors);
    return {
      id: c.id,
      desiredCenter,
      height: heights.get(c.id) ?? ASSUMED_HEIGHT,
    };
  });
  const tops = layoutComments(items, focusedId);

  const height = Math.max(
    0,
    ...anchors.map((a) => a.bottom),
    ...comments.map(
      (c) => (tops.get(c.id) ?? 0) + (heights.get(c.id) ?? ASSUMED_HEIGHT),
    ),
  );

  if (comments.length === 0) {
    return (
      <div className="comment-rail comment-rail-empty">
        <p className="dim">
          No comments yet. Pause the recording and hit the comment button to pin
          feedback to a timestamp.
        </p>
      </div>
    );
  }

  return (
    <div className="comment-rail" style={{ height }}>
      {comments.map((c) => (
        <CommentBlock
          key={c.id}
          comment={c}
          focused={c.id === focusedId}
          top={tops.get(c.id) ?? 0}
          registerEl={register(c.id)}
          onFocus={onFocus}
          onSeek={onSeek}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function CommentBlock({
  comment,
  focused,
  top,
  registerEl,
  onFocus,
  onSeek,
  onEdit,
  onDelete,
}: {
  comment: RailComment;
  focused: boolean;
  top: number;
  registerEl: (el: HTMLElement | null) => void;
  onFocus: (id: string | null) => void;
  onSeek: (videoTimeSec: number) => void;
  onEdit: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const toggleFocus = () => {
    if (!editing) onFocus(focused ? null : comment.id);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: the card wraps interactive children (timestamp + action buttons, edit textarea), so it can't be a <button>; role+tabIndex+keydown keep it accessible
    <div
      ref={registerEl}
      data-comment-id={comment.id}
      className={`comment-block${focused ? " comment-block-focused" : ""}`}
      style={{ transform: `translateY(${top}px)` }}
      role="button"
      tabIndex={0}
      aria-pressed={focused}
      onClick={toggleFocus}
      onKeyDown={(e) => {
        // Only the card's own Enter/Space toggles focus — ignore keys bubbling
        // up from the timestamp button, action buttons, or the edit textarea
        // (otherwise Space would never reach the textarea).
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleFocus();
        }
      }}
    >
      {comment.imageUrl !== null && (
        <button
          type="button"
          className="comment-thumb-btn"
          title="View full image"
          onClick={(e) => {
            e.stopPropagation();
            setDialogOpen(true);
          }}
        >
          <img
            className="comment-thumb"
            src={comment.imageUrl}
            alt={`frame at ${formatTimecode(comment.videoTimeSec)}`}
          />
        </button>
      )}
      <div className="comment-body">
        <CommentMeta
          comment={comment}
          editing={editing}
          className="comment-meta"
          onSeek={(e) => {
            e.stopPropagation();
            onSeek(comment.videoTimeSec);
          }}
          onEditClick={(e) => {
            e.stopPropagation();
            onFocus(comment.id);
            setEditing(true);
          }}
          onDelete={(e) => {
            e.stopPropagation();
            void onDelete(comment.id);
          }}
        />
        {editing ? (
          <CommentEditor
            initial={comment.text}
            onCancel={() => setEditing(false)}
            onSave={async (text) => {
              await onEdit(comment.id, text);
              setEditing(false);
            }}
          />
        ) : (
          <div
            className={`comment-text${focused ? " comment-text-full" : " comment-text-preview"}`}
          >
            {comment.text}
          </div>
        )}
      </div>
      {dialogOpen && comment.imageUrl !== null && (
        <CommentDialog
          comment={comment}
          onClose={() => setDialogOpen(false)}
          onSeek={onSeek}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

/** The timestamp-seek button + edit/delete action pair shared by the rail card
 * and the full-view dialog. Handlers receive the raw click event so each caller
 * keeps its own propagation/close behavior inline. */
function CommentMeta({
  comment,
  editing,
  className,
  onSeek,
  onEditClick,
  onDelete,
}: {
  comment: RailComment;
  editing: boolean;
  className: string;
  onSeek: (e: MouseEvent<HTMLButtonElement>) => void;
  onEditClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onDelete: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className={className}>
      <button
        type="button"
        className="comment-ts"
        title="Jump the recording here"
        onClick={onSeek}
      >
        {formatTimecode(comment.videoTimeSec)}
      </button>
      {!editing && (
        <span className="comment-actions">
          <button
            type="button"
            className="comment-act"
            title="Edit"
            onClick={onEditClick}
          >
            edit
          </button>
          <button
            type="button"
            className="comment-act comment-act-danger"
            title="Delete"
            onClick={onDelete}
          >
            delete
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * Full-quality view of a comment's frame (#118): the thumbnail is tiny, so
 * clicking it opens this overlay with the image at full size beside the comment
 * text, timestamp, and edit/delete controls. Rendered through a portal because
 * the parent `.comment-block` is `transform`ed — a `position: fixed` child of a
 * transformed ancestor anchors to that ancestor, not the viewport.
 */
function CommentDialog({
  comment,
  onClose,
  onSeek,
  onEdit,
  onDelete,
}: {
  comment: RailComment;
  onClose: () => void;
  onSeek: (videoTimeSec: number) => void;
  onEdit: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);

  // Escape closes — the standard dialog affordance alongside click-outside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const timecode = formatTimecode(comment.videoTimeSec);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a click-to-dismiss surface, not a control; keyboard users dismiss via the Escape listener above
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above — Escape handles keyboard dismissal
    <div
      className="comment-dialog-backdrop"
      onClick={(e) => {
        // The dialog is portal'd but still a React child of the comment card,
        // so without this, every click in here would bubble (through the React
        // tree, not the DOM) to the card's onClick and toggle rail focus.
        e.stopPropagation();
        // Only a click on the backdrop itself dismisses; clicks that bubble up
        // from the dialog card are ignored.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="comment-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`comment at ${timecode}`}
      >
        <div className="comment-dialog-figure">
          <img
            className="comment-dialog-img"
            src={comment.imageUrl ?? ""}
            alt={`frame at ${timecode}`}
          />
        </div>
        <div className="comment-dialog-body">
          <CommentMeta
            comment={comment}
            editing={editing}
            className="comment-dialog-meta"
            onSeek={() => {
              onSeek(comment.videoTimeSec);
              onClose();
            }}
            onEditClick={() => setEditing(true)}
            onDelete={() => {
              onClose();
              void onDelete(comment.id);
            }}
          />
          {editing ? (
            <CommentEditor
              initial={comment.text}
              onCancel={() => setEditing(false)}
              onSave={async (text) => {
                await onEdit(comment.id, text);
                setEditing(false);
              }}
            />
          ) : (
            <div className="comment-dialog-text">{comment.text}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CommentEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // An empty edit deletes the comment (server-enforced) — issue decision.
      await onSave(text.trim());
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="comment-editor">
      <textarea
        // biome-ignore lint/a11y/noAutofocus: edit mode exists to be typed in
        autoFocus
        className="comment-editor-text"
        value={text}
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (!saving) onCancel();
          }
        }}
      />
      <div className="comment-editor-actions">
        <button
          type="button"
          className="act"
          onClick={onCancel}
          disabled={saving}
        >
          cancel
        </button>
        <button
          type="button"
          className="act act-primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "saving…" : "save"}
        </button>
      </div>
    </div>
  );
}
