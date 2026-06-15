import type { MediaPlayerInstance } from "@vidstack/react";
import { useMutation, useQuery } from "convex/react";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
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
  ArmedButton,
  calendar,
  duration,
  FollowUp,
  MastClock,
  StatusTag,
  TERMINAL,
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
  ReturnType<typeof useQuery<typeof api.dashboard.taskDetail>>
>;

function TaskDetailBody({ detail }: { detail: TaskDetail }) {
  const secret = useDashboardSecret();
  const retry = useMutation(api.dashboard.retryTask);
  const stop = useMutation(api.dashboard.stopTask);
  const createComment = useMutation(api.dashboard.createComment);
  const editComment = useMutation(api.dashboard.editComment);
  const deleteComment = useMutation(api.dashboard.deleteComment);
  const now = useNowTicker();
  const [note, setNote] = useState<string | null>(null);
  const postNote = (_taskId: string, text: string) => setNote(text);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const playerRef = useRef<MediaPlayerInstance | null>(null);

  const task = detail.task;
  const terminal = TERMINAL.has(task.status);
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

  // Prompt anchors the timeline at the recording's start (so it lines up with
  // video 0), falling back to when the task first ran, then creation.
  const promptTs = recordingStartedAt ?? task.startedAt ?? task.createdAt;
  const rows = buildTimeline(events, task.prompt, promptTs);

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
          {!terminal && task.devboxId !== undefined && (
            <FollowUp taskId={task.taskId} onNote={postNote} />
          )}
          {!terminal && (
            <ArmedButton
              label="stop"
              armedLabel="confirm stop"
              danger
              onFire={() => {
                void stop({ secret, taskId: task.taskId }).then((r) =>
                  postNote(task.taskId, r.ok ? `✓ ${r.note}` : `✗ ${r.reason}`),
                );
              }}
            />
          )}
          {terminal && (
            <ArmedButton
              label="retry"
              armedLabel="confirm retry"
              onFire={() => {
                void retry({ secret, taskId: task.taskId }).then((r) =>
                  postNote(
                    task.taskId,
                    r.ok ? `✓ ${r.note} → ${r.taskId}` : `✗ ${r.reason}`,
                  ),
                );
              }}
            />
          )}
        </span>
      </div>
      {note !== null && <div className="row-note">{note}</div>}

      <section className="rec-section">
        <h3 className="detail-section-label">screen recording</h3>
        <RecordingPlayer
          state={recState}
          src={detail.recording?.url ?? null}
          title={task.title}
          comments={playerComments}
          onCreateComment={onCreateComment}
          onFocusComment={setFocusedId}
          playerRef={playerRef}
        />
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

      <section className="detail-timeline-section">
        <h3 className="detail-section-label">events &amp; comments</h3>
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

const STATUS_GLYPH: Record<string, string> = {
  started: "rocket",
  needs_input: "needs",
  completed: "ok",
  failed: "fail",
  stopped: "stop",
};

function TimelineEventRow({ row }: { row: TimelineRow }) {
  const [expanded, setExpanded] = useState(false);

  if (row.kind === "prompt") {
    return (
      <div className="tl-row tl-row-prompt" data-anchor-ts={row.ts}>
        <span className="tl-label tl-label-prompt">Prompt</span>
        <pre className="tl-prompt-text">{row.text}</pre>
      </div>
    );
  }

  if (row.kind === "status") {
    return (
      <div
        className={`tl-row tl-row-status status-ev-${row.status}`}
        data-anchor-ts={row.ts}
      >
        <span
          className={`tl-status-dot tl-status-${STATUS_GLYPH[row.status] ?? "ok"}`}
        />
        <span className="tl-status-label">{row.status.replace("_", " ")}</span>
        <span className="tl-status-summary">{row.summary}</span>
      </div>
    );
  }

  if (row.kind === "assistant") {
    const hasMore = row.detail !== null && row.detail !== row.summary;
    return (
      <div className="tl-row tl-row-assistant" data-anchor-ts={row.ts}>
        <span className="tl-label tl-label-assistant">assistant</span>
        <div className="tl-assistant-body">
          <div className="tl-assistant-text">
            {expanded && row.detail !== null ? row.detail : row.summary}
          </div>
          {hasMore && (
            <button
              type="button"
              className="tl-expand"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "show less" : "show more"}
            </button>
          )}
        </div>
      </div>
    );
  }

  // tool_call / tool_result — collapsed by default, expand to detail (+ image).
  const isResult = row.kind === "tool_result";
  const image = isResult ? row.imageUrl : null;
  const expandable = row.detail !== null || image !== null;
  return (
    <div
      className={`tl-row tl-row-tool ${isResult ? "tl-row-tool-result" : "tl-row-tool-call"}`}
      data-anchor-ts={row.ts}
    >
      <button
        type="button"
        className="tl-tool-head"
        onClick={() => expandable && setExpanded((v) => !v)}
        aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable}
      >
        <span
          className={`tl-tool-caret${expanded ? " tl-tool-caret-open" : ""}`}
        >
          {expandable ? "▸" : "·"}
        </span>
        <span className="tl-tool-kind">{isResult ? "result" : "call"}</span>
        {row.tool !== null && <code className="tl-tool-name">{row.tool}</code>}
        <span className="tl-tool-summary">{row.summary}</span>
      </button>
      {expanded && expandable && (
        <div className="tl-tool-detail">
          {row.detail !== null && (
            <pre className="tl-tool-pre">{row.detail}</pre>
          )}
          {image !== null && (
            <img
              className="tl-tool-shot"
              src={image}
              alt="tool result screenshot"
            />
          )}
        </div>
      )}
    </div>
  );
}
