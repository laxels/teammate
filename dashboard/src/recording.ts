/**
 * Maps a task's stored recording (from api.dashboard.taskDetail) to one of the
 * four player-section states the task-details page renders. Pure + unit-tested;
 * the component supplies the live clock + task status.
 */

/** The recording slice of api.dashboard.taskDetail's return (kept structural so
 * this stays a pure module; the call site is type-checked against the query). */
export type RecordingInfo = {
  status: "recording" | "uploading" | "available" | "failed";
  url: string | null;
  bytes: number | null;
  uploadedAt: number | null;
} | null;

export type PlayerState =
  | "recording"
  | "uploading"
  | "available"
  | "unavailable";

/** Past this much after a task finished, a recording still stuck "uploading"
 * (or "recording") is presumed lost — the VM is long reclaimed (the 5-min
 * EPHEMERAL_RETIRE_GRACE_MS window, plus buffer). */
export const UPLOAD_GRACE_MS = 6 * 60_000;

export function playerState(
  recording: RecordingInfo | undefined,
  opts: { taskTerminal: boolean; finishedAt: number | null; now: number },
): PlayerState {
  // No recording => the task predates the feature (null), or the dashboard
  // bundle is briefly newer than the deployment's taskDetail (undefined).
  if (recording == null) {
    return "unavailable";
  }
  switch (recording.status) {
    case "available":
      // "available" without a URL means the stored blob was pruned/lost.
      return recording.url !== null ? "available" : "unavailable";
    case "failed":
      return "unavailable";
    case "recording":
      // A terminal task still marked "recording" means the VM died before the
      // recorder could finalize — show unavailable, not a phantom live capture.
      return opts.taskTerminal ? "unavailable" : "recording";
    case "uploading":
      // A push that never completed (VM killed mid-upload) eventually reads as
      // lost rather than forever "processing".
      return opts.finishedAt !== null &&
        opts.now - opts.finishedAt > UPLOAD_GRACE_MS
        ? "unavailable"
        : "uploading";
  }
}
