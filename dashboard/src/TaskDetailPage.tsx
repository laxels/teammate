import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { useDashboardSecret } from "./config";
import { RecordingPlayer } from "./RecordingPlayer";
import { playerState } from "./recording";
import { spaLink } from "./router";
import { extractTranscriptLines } from "./transcriptView";
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
  const now = useNowTicker();
  const [note, setNote] = useState<string | null>(null);
  const postNote = (_taskId: string, text: string) => setNote(text);

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

      <div className="task-detail-grid">
        <section className="detail-prompt">
          <h3 className="detail-section-label">prompt</h3>
          <pre>{task.prompt}</pre>
        </section>
        <section className="detail-events">
          <h3 className="detail-section-label">events</h3>
          {detail.events.length === 0 && (
            <div className="dim">none recorded</div>
          )}
          {detail.events.map((event) => (
            <div className="event" key={`${event.ts}-${event.type}`}>
              <span className="event-ts">{calendar(event.ts)}</span>
              <span className={`status status-ev-${event.type}`}>
                {event.type.replace("_", " ")}
              </span>
              <span className="event-summary">{event.summary}</span>
            </div>
          ))}
        </section>
      </div>

      {detail.hasTranscript && (
        <section className="detail-transcript">
          <h3 className="detail-section-label">session transcript</h3>
          <TranscriptPanel taskId={task.taskId} />
        </section>
      )}
    </article>
  );
}

function TranscriptPanel({ taskId }: { taskId: string }) {
  const secret = useDashboardSecret();
  const [open, setOpen] = useState(false);
  // The payload can approach 1 MB — fetch only on explicit request.
  const transcript = useQuery(
    api.dashboard.transcript,
    open ? { secret, taskId } : "skip",
  );
  if (!open) {
    return (
      <button type="button" className="act" onClick={() => setOpen(true)}>
        show transcript
      </button>
    );
  }
  if (transcript === undefined) {
    return <div className="dim">loading transcript…</div>;
  }
  if (transcript === null) {
    return <div className="dim">no transcript stored</div>;
  }
  return (
    <div className="transcript">
      {extractTranscriptLines(transcript.json).map((line, i) => (
        <div
          className={`transcript-line transcript-${line.role}`}
          // biome-ignore lint/suspicious/noArrayIndexKey: static render of an immutable list
          key={i}
        >
          <span className="transcript-role">{line.role}</span>
          <span className="transcript-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
