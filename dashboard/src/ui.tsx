import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useDashboardSecret } from "./config";

// Shared types + presentational helpers used by both the fleet board (App) and
// the task-details page (TaskDetailPage).

export type ActiveTask = FunctionReturnType<
  typeof api.dashboard.activeTasks
>[number];
export type HistoryTask = FunctionReturnType<
  typeof api.dashboard.listTasks
>["page"][number];
export type Fleet = FunctionReturnType<typeof api.dashboard.fleet>;
export type TaskStatus = ActiveTask["status"];

export const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export function calendar(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString("en-CA")} ${clock(ts)}`;
}

export function duration(ms: number): string {
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
export function useNowTicker(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function MastClock() {
  const now = useNowTicker();
  return <span className="mast-clock">{clock(now)}</span>;
}

export function StatusTag({ status }: { status: TaskStatus }) {
  return (
    <span className={`status status-${status}`}>
      {status.replace("_", " ")}
    </span>
  );
}

export function ArmedButton({
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

/**
 * Toggle a task's archived flag (#122). Reversible and low-stakes, so it skips
 * the ArmedButton confirm step. The label flips to reflect the current state;
 * the result note lands via the page's action-note channel like stop/retry.
 */
export function ArchiveButton({
  taskId,
  archived,
  onNote,
}: {
  taskId: string;
  archived: boolean;
  onNote: (taskId: string, note: string) => void;
}) {
  const secret = useDashboardSecret();
  const setArchived = useMutation(api.dashboard.setTaskArchived);
  return (
    <button
      type="button"
      className="act"
      onClick={() => {
        void setArchived({ secret, taskId, archived: !archived }).then((r) =>
          onNote(taskId, r.ok ? `✓ ${r.note}` : `✗ ${r.reason}`),
        );
      }}
    >
      {archived ? "unarchive" : "archive"}
    </button>
  );
}

export function FollowUp({
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

/**
 * Action feedback keyed by taskId, owned by the page — a live-board row
 * unmounts the moment its task goes terminal, which is exactly when stop
 * feedback arrives. Notes auto-expire after 8s.
 */
export function useActionNotes(): {
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
