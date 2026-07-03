import type { MediaPlayerInstance } from "@vidstack/react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { isTerminalTaskStatus } from "../../shared/protocol";
import { AssistantText, ToolPill } from "../../shared/transcriptUi";
import { CommentRail, type RailComment } from "./CommentRail";
import {
  commentEventTime,
  desiredCenterForTime,
  type EventAnchor,
} from "./commentLayout";
import { grabFrame } from "./comments";
import { useDashboardSecret } from "./config";
import { type PlayerComment, RecordingPlayer } from "./RecordingPlayer";
import { playerState } from "./recording";
import { spaLink } from "./router";
import { buildTimeline, type TimelineRow } from "./timeline";
import {
  AgentBadge,
  ArchiveButton,
  calendar,
  clock,
  duration,
  FollowUp,
  MastClock,
  RetryButton,
  StatusTag,
  StopButton,
  useActionNotes,
  useNowTicker,
} from "./ui";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function TaskDetailPage({ taskId }: { taskId: string }) {
  const secret = useDashboardSecret();
  const detail = useQuery(api.dashboard.taskDetail, { secret, taskId });

  return (
    <main>
      <header className="masthead">
        <h1>
          <a className="mast-home" href="/" onClick={spaLink("/")}>
            Ultraclaude<span className="mast-sep">·</span>Fleet
          </a>
        </h1>
        <MastClock />
      </header>

      <a className="detail-back" href="/" onClick={spaLink("/")}>
        ← fleet
      </a>

      {detail === undefined && <div className="dim">loading task…</div>}
      {detail === null && (
        <div className="boot-error">
          <p>
            Task <code>{taskId}</code> not found — it may have been pruned, or
            the dashboard secret was rejected.
          </p>
        </div>
      )}
      {detail != null && <TaskDetailBody detail={detail} />}
    </main>
  );
}

type TaskDetail = NonNullable<
  FunctionReturnType<typeof api.dashboard.taskDetail>
>;

function TaskDetailBody({ detail }: { detail: TaskDetail }) {
  const secret = useDashboardSecret();
  const createComment = useMutation(api.dashboard.createComment);
  const editComment = useMutation(api.dashboard.editComment);
  const deleteComment = useMutation(api.dashboard.deleteComment);
  const now = useNowTicker();
  const { notes, postNote } = useActionNotes();

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const playerRef = useRef<MediaPlayerInstance | null>(null);

  const task = detail.task;
  const terminal = isTerminalTaskStatus(task.status);
  const ran =
    task.startedAt !== undefined && task.finishedAt !== undefined
      ? duration(task.finishedAt - task.startedAt)
      : task.startedAt !== undefined
        ? duration(now - task.startedAt)
        : "—";

  const recState = playerState(detail.recording, {
    taskTerminal: terminal,
    finishedAt: task.finishedAt ?? null,
    now,
  });
  const recordingStartedAt = detail.recording?.startedAt ?? null;

  // The dashboard bundle deploys separately from the Convex backend
  // (scripts/deploy-dashboard.sh ships only static files), so during a
  // staggered rollout this page can briefly run against an older taskDetail
  // that predates the #70 fields. Default them so the page degrades to "no
  // comments / status-only timeline" instead of crashing on `undefined.map`.
  const comments = detail.comments ?? [];
  const events = detail.events ?? [];

  const rows = buildTimeline(events);

  const playerComments: PlayerComment[] = comments.map((c) => ({
    id: c.id,
    videoTimeSec: c.videoTimeSec,
    text: c.text,
  }));
  const railComments: RailComment[] = comments.map((c) => ({
    id: c.id,
    videoTimeSec: c.videoTimeSec,
    text: c.text,
    imageUrl: c.imageUrl,
    updatedAt: c.updatedAt,
  }));

  const onCreateComment = async (videoTimeSec: number, text: string) => {
    // Best-effort frame grab first; the comment is created regardless.
    const imageStorageId = await grabFrame(secret, task.taskId, videoTimeSec);
    const res = await createComment({
      secret,
      taskId: task.taskId,
      videoTimeSec,
      text,
      ...(imageStorageId === null
        ? {}
        : { imageStorageId: imageStorageId as Id<"_storage"> }),
    });
    if (res.ok) setFocusedId(res.commentId);
    else postNote(task.taskId, `✗ ${res.reason}`);
  };

  const onEdit = async (id: string, text: string) => {
    await editComment({ secret, commentId: id as Id<"comments">, text });
  };
  const onDelete = async (id: string) => {
    await deleteComment({ secret, commentId: id as Id<"comments"> });
    if (focusedId === id) setFocusedId(null);
  };
  const onSeek = (videoTimeSec: number) => {
    if (playerRef.current !== null)
      playerRef.current.currentTime = videoTimeSec;
  };

  return (
    <article className="task-detail">
      <div className="task-detail-head">
        <StatusTag status={task.status} />
        <AgentBadge task={task} />
        <h2 className="task-detail-title">{task.title}</h2>
        <span className="task-detail-meta">
          <code>{task.taskId}</code>
          <span className="dot">·</span>ran {ran}
          {task.devboxId !== undefined && (
            <>
              <span className="dot">·</span>
              {task.devboxId}
            </>
          )}
          {task.localMachineId !== undefined && (
            <>
              <span className="dot">·</span>
              {task.localMachineId}
            </>
          )}
          {task.finishedAt !== undefined && (
            <>
              <span className="dot">·</span>
              {calendar(task.finishedAt)}
            </>
          )}
        </span>
        <span className="task-detail-links">
          {task.slackPermalink !== undefined && (
            <a
              className="link"
              href={task.slackPermalink}
              target="_blank"
              rel="noreferrer"
            >
              thread ↗
            </a>
          )}
          {detail.monitoringUrl !== null && (
            <a
              className="link"
              href={detail.monitoringUrl}
              target="_blank"
              rel="noreferrer"
            >
              monitor ↗
            </a>
          )}
        </span>
        <span className="task-detail-actions">
          {!terminal &&
            (task.devboxId !== undefined ||
              task.localMachineId !== undefined) && (
              <FollowUp taskId={task.taskId} onNote={postNote} />
            )}
          {!terminal && <StopButton taskId={task.taskId} onNote={postNote} />}
          {terminal && <RetryButton taskId={task.taskId} onNote={postNote} />}
          {terminal && (
            <ArchiveButton
              taskId={task.taskId}
              archived={task.archived}
              onNote={postNote}
            />
          )}
        </span>
      </div>
      {notes[task.taskId] !== undefined && (
        <div className="row-note">{notes[task.taskId]}</div>
      )}

      <section className="rec-section">
        <h3 className="detail-section-label">screen recording</h3>
        {task.placement === "local" ? (
          <div className="rec-meta">
            Local tasks aren't screen-recorded (the user's own machine —
            privacy). Per-window screenshots appear in the timeline below.
          </div>
        ) : (
          <RecordingPlayer
            state={recState}
            src={detail.recording?.url ?? null}
            title={task.title}
            comments={playerComments}
            onCreateComment={onCreateComment}
            onFocusComment={setFocusedId}
            playerRef={playerRef}
          />
        )}
        {recState === "available" && detail.recording !== null && (
          <div className="rec-meta">
            {detail.recording.bytes !== null &&
              `${formatBytes(detail.recording.bytes)} · `}
            {detail.recording.uploadedAt !== null
              ? `recorded ${calendar(detail.recording.uploadedAt)}`
              : "recorded"}
          </div>
        )}
      </section>

      <section className="detail-prompt-section">
        <h3 className="detail-section-label">prompt</h3>
        <pre className="detail-prompt">{task.prompt}</pre>
      </section>

      <section className="detail-timeline-section">
        <h3 className="detail-section-label">timeline</h3>
        <TimelineGrid
          rows={rows}
          comments={railComments}
          recordingStartedAt={recordingStartedAt}
          focusedId={focusedId}
          onFocus={setFocusedId}
          onSeek={onSeek}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </section>
    </article>
  );
}

/** Measures the rendered event rows' vertical extents (in the events column's
 * coordinate space) so the rail can align comments to them and the red focus
 * bar can sit between events. Re-measures on layout/content/resize changes. */
function useAnchors(
  ref: RefObject<HTMLElement | null>,
  rowsKey: string,
): EventAnchor[] {
  const [anchors, setAnchors] = useState<EventAnchor[]>([]);
  // rowsKey isn't read inside the effect; it's a deliberate re-measure trigger
  // when the rendered row set changes (count / last timestamp).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowsKey deliberately re-runs the measure
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const nodes = el.querySelectorAll<HTMLElement>("[data-anchor-ts]");
      const next: EventAnchor[] = [];
      for (const node of nodes) {
        const ts = Number(node.dataset.anchorTs);
        next.push({
          ts,
          top: node.offsetTop,
          bottom: node.offsetTop + node.offsetHeight,
        });
      }
      setAnchors((prev) =>
        prev.length === next.length &&
        prev.every(
          (a, i) =>
            a.ts === next[i]?.ts &&
            a.top === next[i]?.top &&
            a.bottom === next[i]?.bottom,
        )
          ? prev
          : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const node of el.querySelectorAll<HTMLElement>("[data-anchor-ts]")) {
      ro.observe(node);
    }
    return () => ro.disconnect();
  }, [ref, rowsKey]);
  return anchors;
}

function TimelineGrid({
  rows,
  comments,
  recordingStartedAt,
  focusedId,
  onFocus,
  onSeek,
  onEdit,
  onDelete,
}: {
  rows: TimelineRow[];
  comments: RailComment[];
  recordingStartedAt: number | null;
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  onSeek: (videoTimeSec: number) => void;
  onEdit: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const eventsRef = useRef<HTMLDivElement | null>(null);
  const rowsKey = `${rows.length}:${rows.at(-1)?.ts ?? 0}`;
  const anchors = useAnchors(eventsRef, rowsKey);

  // The red bar sits at the focused comment's timestamp, between events.
  const focused = comments.find((c) => c.id === focusedId) ?? null;
  const focusedTime =
    focused === null
      ? null
      : commentEventTime(recordingStartedAt, focused.videoTimeSec);
  const redBarTop =
    focusedTime === null ? null : desiredCenterForTime(focusedTime, anchors);

  // Scroll a freshly-focused comment into view (also right after posting one).
  useEffect(() => {
    if (focusedId === null) return;
    const el = document.querySelector<HTMLElement>(
      `[data-comment-id="${CSS.escape(focusedId)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedId]);

  return (
    <div className="timeline-grid">
      <div className="timeline-events" ref={eventsRef}>
        {rows.map((row, i) => (
          <TimelineEventRow
            // The timeline is append-only and (ts, kind) can repeat within a
            // burst, so the index disambiguates an otherwise-stable key.
            // biome-ignore lint/suspicious/noArrayIndexKey: stable append-only timeline; index only disambiguates same-ts rows
            key={`${row.ts}-${row.kind}-${i}`}
            row={row}
          />
        ))}
        {redBarTop !== null && (
          <div
            className="timeline-redbar"
            style={{ top: redBarTop }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="timeline-rail-col">
        <CommentRail
          comments={comments}
          anchors={anchors}
          recordingStartedAt={recordingStartedAt}
          focusedId={focusedId}
          onFocus={onFocus}
          onSeek={onSeek}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  needs_input: "needs input",
  failed: "failed",
  stopped: "stopped",
};

/** One timeline entry: a left timestamp column (top-aligned, horizontally
 * aligned across rows) and the event content. */
function TimelineEventRow({ row }: { row: TimelineRow }) {
  return (
    <div className={`tl-row tl-row-${row.kind}`} data-anchor-ts={row.ts}>
      <span className="tl-time">{clock(row.ts)}</span>
      <div className="tl-content">
        <TimelineRowContent row={row} />
      </div>
    </div>
  );
}

function TimelineRowContent({ row }: { row: TimelineRow }) {
  if (row.kind === "assistant") {
    return (
      <>
        {row.local && <span className="tl-localtag">local</span>}
        <AssistantText text={row.text} />
      </>
    );
  }
  if (row.kind === "tool") {
    return (
      <>
        {row.local && <span className="tl-localtag">local</span>}
        <ToolPill
          name={row.tool}
          params={row.params ?? ""}
          result={row.result}
          imageUrl={row.imageUrl}
        />
      </>
    );
  }
  // #138: peer-channel traffic between a split task's cloud and local agents.
  if (row.kind === "peer") {
    return (
      <details className="tl-peer">
        <summary className="tl-peer-summary">
          {row.direction === "request" ? "→ local request" : "← local reply"}
        </summary>
        <pre className="tl-peer-body">{row.text}</pre>
      </details>
    );
  }
  // status — a distinct, color-coded pill centered in the content column, with
  // connector lines reaching the column's left/right edges (not the timestamp
  // or comment areas).
  return (
    <div className={`tl-statusrow tl-status-${row.status}`}>
      <div className="tl-statusbar">
        <span className="tl-statusline" aria-hidden="true" />
        <span className="tl-statuspill">
          {STATUS_LABEL[row.status] ?? row.status.replace("_", " ")}
        </span>
        <span className="tl-statusline" aria-hidden="true" />
      </div>
      {row.summary !== "" && (
        <div className="tl-statussummary">{row.summary}</div>
      )}
    </div>
  );
}
