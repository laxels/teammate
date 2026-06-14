import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { useDashboardSecret } from "./config";
import { spaLink, taskPath, useRoute } from "./router";
import { TaskDetailPage } from "./TaskDetailPage";
import {
  type ActiveTask,
  ArmedButton,
  calendar,
  duration,
  type Fleet,
  FollowUp,
  type HistoryTask,
  MastClock,
  StatusTag,
  TERMINAL,
  useActionNotes,
  useNowTicker,
} from "./ui";

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
  const finished = task.finishedAt ?? task.updatedAt;
  const ran =
    task.startedAt !== undefined && task.finishedAt !== undefined
      ? duration(task.finishedAt - task.startedAt)
      : "—";
  const href = taskPath(task.taskId);
  return (
    <div className="row">
      {/* The title area links to the task-details page (stable URL, deep-
          linkable). Interactive children stay OUTSIDE the link so a retry
          click doesn't also navigate. */}
      <div className="row-main">
        <a className="row-toggle" href={href} onClick={spaLink(href)}>
          <StatusTag status={task.status} />
          <span className="row-title" title={task.taskId}>
            {task.title}
          </span>
          <span className="row-meta dim">
            {calendar(finished)} · ran {ran}
          </span>
        </a>
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
    </div>
  );
}

// ---- fleet board ----

function FleetBoard() {
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

// ---- page (route switch) ----

export function App() {
  const route = useRoute();
  return route.taskId !== null ? (
    <TaskDetailPage taskId={route.taskId} />
  ) : (
    <FleetBoard />
  );
}
