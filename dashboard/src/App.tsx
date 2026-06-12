import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useDashboardSecret } from "./config";
import { extractTranscriptLines } from "./transcriptView";

type ActiveTask = FunctionReturnType<typeof api.dashboard.activeTasks>[number];
type HistoryTask = FunctionReturnType<
  typeof api.dashboard.listTasks
>["page"][number];
type Fleet = FunctionReturnType<typeof api.dashboard.fleet>;
type TaskStatus = ActiveTask["status"];

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

const STATUS_FILTERS = [
  "all",
  "running",
  "queued",
  "needs_input",
  "completed",
  "failed",
  "stopped",
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STALE_HEARTBEAT_MS = 120_000;

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

function calendar(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString("en-CA")} ${clock(ts)}`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** Per-second tick, used only in leaf components so the page tree doesn't
 * re-render every second. */
function useNowTicker(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Action feedback keyed by taskId, owned by the page — a live-board row
 * unmounts the moment its task goes terminal, which is exactly when stop
 * feedback arrives. Notes auto-expire after 8s.
 */
function useActionNotes(): {
  notes: Record<string, string>;
  postNote: (taskId: string, note: string) => void;
} {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of Object.values(pending)) clearTimeout(t);
    };
  }, []);
  const postNote = useCallback((taskId: string, note: string) => {
    setNotes((prev) => ({ ...prev, [taskId]: note }));
    clearTimeout(timers.current[taskId]);
    timers.current[taskId] = setTimeout(() => {
      setNotes((prev) => {
        const { [taskId]: _gone, ...rest } = prev;
        return rest;
      });
    }, 8000);
  }, []);
  return { notes, postNote };
}

function MastClock() {
  const now = useNowTicker();
  return <span className="mast-clock">{clock(now)}</span>;
}

function StatusTag({ status }: { status: TaskStatus }) {
  return (
    <span className={`status status-${status}`}>
      {status.replace("_", " ")}
    </span>
  );
}

// ---- fleet annunciator strip ----

function FleetStrip({ fleet }: { fleet: NonNullable<Fleet> }) {
  const now = useNowTicker();
  const bootstrap = fleet.recentHostEvents
    .filter((e) => e.type.startsWith("provision"))
    .at(-1);
  return (
    <section className="fleet" aria-label="fleet status">
      {fleet.hosts.map((host) => (
        <div className="cell" key={host.hostId}>
          <span className="cell-label">{host.hostId}</span>
          <span className="cell-value">
            <span className="slots">
              {Array.from({ length: host.maxVms }, (_, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional
                  key={i}
                  className={i < host.vmsInUse ? "slot slot-busy" : "slot"}
                />
              ))}
            </span>
            {host.status}
            {now - host.lastSeenAt > STALE_HEARTBEAT_MS ? " · STALE" : ""}
          </span>
        </div>
      ))}
      <div className="cell">
        <span className="cell-label">devboxes</span>
        <span className="cell-value">
          {fleet.devboxes.length === 0
            ? "—"
            : fleet.devboxes
                .map((d) => `${d.devboxId.replace("devbox-", "")}:${d.status}`)
                .join("  ")}
        </span>
      </div>
      <div className="cell">
        <span className="cell-label">queue</span>
        <span className="cell-value">
          {fleet.queuedEphemeralTasks.length === 0
            ? "empty"
            : `${fleet.queuedEphemeralTasks.length} waiting`}
        </span>
      </div>
      {bootstrap !== undefined && (
        <div className="cell cell-wide">
          <span className="cell-label">fleet log</span>
          <span className="cell-value cell-dim" title={bootstrap.summary}>
            [{bootstrap.hostId}] {bootstrap.summary.slice(0, 80)}
          </span>
        </div>
      )}
    </section>
  );
}

// ---- per-row controls ----

function ArmedButton({
  label,
  armedLabel,
  onFire,
  danger,
}: {
  label: string;
  armedLabel: string;
  onFire: () => void;
  danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`act ${danger ? "act-danger" : ""} ${armed ? "act-armed" : ""}`}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onFire();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? armedLabel : label}
    </button>
  );
}

function FollowUp({
  taskId,
  onNote,
}: {
  taskId: string;
  onNote: (taskId: string, note: string) => void;
}) {
  const secret = useDashboardSecret();
  const steer = useMutation(api.dashboard.steerTask);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) {
    return (
      <button type="button" className="act" onClick={() => setOpen(true)}>
        follow-up
      </button>
    );
  }
  return (
    <form
      className="followup"
      onSubmit={(e) => {
        e.preventDefault();
        const message = text.trim();
        if (message === "") return;
        // Keep the draft until the mutation confirms: a failure (or the task
        // finishing first) must not eat the user's text.
        void steer({ secret, taskId, text: message }).then((result) => {
          onNote(taskId, result.ok ? `✓ ${result.note}` : `✗ ${result.reason}`);
          if (result.ok) {
            setText("");
            setOpen(false);
          }
        });
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: opened by explicit user action
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="steer the live session…"
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="submit" className="act">
        send
      </button>
    </form>
  );
}

// ---- task rows ----

function ActiveRow({
  task,
  note,
  onNote,
}: {
  task: ActiveTask;
  note: string | undefined;
  onNote: (taskId: string, note: string) => void;
}) {
  const secret = useDashboardSecret();
  const now = useNowTicker();
  const stop = useMutation(api.dashboard.stopTask);
  const provisioning = task.devboxStatus === "provisioning";
  return (
    <div className="row row-active">
      <div className="row-main">
        <StatusTag status={task.status} />
        <span className="row-title" title={task.taskId}>
          {task.title}
        </span>
        <span className="row-meta">
          {/* Label the phase: a bare counter silently changes meaning (and
              jumps backward) at queued -> running. */}
          {task.status === "queued" ? (
            <span className="dim">
              queued{" "}
              <span className="elapsed">{duration(now - task.createdAt)}</span>
            </span>
          ) : (
            <span className="dim">
              ran{" "}
              <span className="elapsed">
                {duration(now - (task.startedAt ?? task.createdAt))}
              </span>
            </span>
          )}
          {task.devboxId !== undefined && (
            <span className="dim"> · {task.devboxId}</span>
          )}
        </span>
        <span className="row-links">
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
          {provisioning && <span className="dim">provisioning…</span>}
          {!provisioning && task.monitoringUrl !== null && (
            <a
              className="link"
              href={task.monitoringUrl}
              target="_blank"
              rel="noreferrer"
            >
              monitor ↗
            </a>
          )}
        </span>
        <span className="row-actions">
          {task.status !== "queued" && task.devboxId !== undefined && (
            <FollowUp taskId={task.taskId} onNote={onNote} />
          )}
          <ArmedButton
            label="stop"
            armedLabel="confirm stop"
            danger
            onFire={() => {
              void stop({ secret, taskId: task.taskId }).then((result) => {
                onNote(
                  task.taskId,
                  result.ok ? `✓ ${result.note}` : `✗ ${result.reason}`,
                );
              });
            }}
          />
        </span>
      </div>
      {note !== undefined && <div className="row-note">{note}</div>}
    </div>
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

function HistoryDetail({ taskId }: { taskId: string }) {
  const secret = useDashboardSecret();
  const detail = useQuery(api.dashboard.taskDetail, { secret, taskId });
  if (detail == null) {
    return <div className="detail dim">loading…</div>;
  }
  return (
    <div className="detail">
      <div className="detail-prompt">
        <span className="cell-label">prompt</span>
        <pre>{detail.task.prompt}</pre>
      </div>
      <div className="detail-events">
        <span className="cell-label">events</span>
        {detail.events.length === 0 && <div className="dim">none recorded</div>}
        {detail.events.map((event) => (
          <div className="event" key={`${event.ts}-${event.type}`}>
            <span className="event-ts">{calendar(event.ts)}</span>
            <span className={`status status-ev-${event.type}`}>
              {event.type.replace("_", " ")}
            </span>
            <span className="event-summary">{event.summary}</span>
          </div>
        ))}
        {detail.hasTranscript && (
          <div className="detail-transcript">
            <span className="cell-label">session transcript</span>
            <TranscriptPanel taskId={taskId} />
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({
  task,
  note,
  onNote,
}: {
  task: HistoryTask;
  note: string | undefined;
  onNote: (taskId: string, note: string) => void;
}) {
  const secret = useDashboardSecret();
  const retry = useMutation(api.dashboard.retryTask);
  const [expanded, setExpanded] = useState(false);
  const finished = task.finishedAt ?? task.updatedAt;
  const ran =
    task.startedAt !== undefined && task.finishedAt !== undefined
      ? duration(task.finishedAt - task.startedAt)
      : "—";
  return (
    <div className="row">
      {/* Interactive children must not nest inside the expand toggle (invalid
          DOM; clicking retry would also toggle). Only the title area is the
          button. */}
      <div className="row-main">
        <button
          type="button"
          className="row-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <StatusTag status={task.status} />
          <span className="row-title" title={task.taskId}>
            {task.title}
          </span>
          <span className="row-meta dim">
            {calendar(finished)} · ran {ran}
          </span>
        </button>
        <span className="row-links">
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
        </span>
        <span className="row-actions">
          {TERMINAL.has(task.status) && (
            <ArmedButton
              label="retry"
              armedLabel="confirm retry"
              onFire={() => {
                void retry({ secret, taskId: task.taskId }).then((result) => {
                  onNote(
                    task.taskId,
                    result.ok
                      ? `✓ ${result.note} → ${result.taskId}`
                      : `✗ ${result.reason}`,
                  );
                });
              }}
            />
          )}
        </span>
      </div>
      {note !== undefined && <div className="row-note">{note}</div>}
      {expanded && <HistoryDetail taskId={task.taskId} />}
    </div>
  );
}

// ---- page ----

export function App() {
  const secret = useDashboardSecret();
  const fleet = useQuery(api.dashboard.fleet, { secret });
  const active = useQuery(api.dashboard.activeTasks, { secret });
  const [filter, setFilter] = useState<StatusFilter>("all");
  const history = usePaginatedQuery(
    api.dashboard.listTasks,
    { secret, ...(filter === "all" ? {} : { status: filter }) },
    { initialNumItems: 25 },
  );
  const { notes, postNote } = useActionNotes();

  const unauthorized = fleet === null;
  // Feedback for rows that left the live board (stop confirmations land
  // exactly as the row unmounts).
  const activeIds = new Set((active ?? []).map((t) => t.taskId));
  const orphanNotes = Object.entries(notes).filter(
    ([taskId]) => !activeIds.has(taskId),
  );

  return (
    <main>
      <header className="masthead">
        <h1>
          Ultraclaude<span className="mast-sep">·</span>Fleet
        </h1>
        <MastClock />
      </header>

      {unauthorized ? (
        <div className="boot-error">
          <p>
            UNAUTHORIZED — the dashboard secret was rejected (or
            DASHBOARD_SECRET is unset on the deployment). Check config.json.
          </p>
        </div>
      ) : (
        <>
          {fleet != null && <FleetStrip fleet={fleet} />}

          <section aria-label="active tasks">
            <h2>
              live board
              {active !== undefined && active.length > 0 && (
                <span className="count">{active.length}</span>
              )}
            </h2>
            {active === undefined && <div className="dim">connecting…</div>}
            {active !== undefined && active.length === 0 && (
              <div className="empty">no tasks in flight</div>
            )}
            {active?.map((task) => (
              <ActiveRow
                key={task.taskId}
                task={task}
                note={notes[task.taskId]}
                onNote={postNote}
              />
            ))}
            {orphanNotes.map(([taskId, note]) => (
              <div className="row-note" key={taskId}>
                {taskId}: {note}
              </div>
            ))}
          </section>

          <section aria-label="task history">
            <h2>
              log
              <span className="filters">
                {STATUS_FILTERS.map((f) => (
                  <button
                    type="button"
                    key={f}
                    className={`chip ${filter === f ? "chip-on" : ""}`}
                    onClick={() => setFilter(f)}
                  >
                    {f.replace("_", " ")}
                  </button>
                ))}
              </span>
            </h2>
            {history.status === "LoadingFirstPage" && (
              <div className="dim">loading…</div>
            )}
            {history.status !== "LoadingFirstPage" &&
              history.results.length === 0 && (
                <div className="empty">no tasks recorded</div>
              )}
            {history.results.map((task) => (
              <HistoryRow
                key={task.taskId}
                task={task}
                note={notes[task.taskId]}
                onNote={postNote}
              />
            ))}
            {history.status === "CanLoadMore" && (
              <button
                type="button"
                className="act load-more"
                onClick={() => history.loadMore(25)}
              >
                load more
              </button>
            )}
            {history.status === "LoadingMore" && (
              <div className="dim">loading…</div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
