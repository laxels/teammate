import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RECORDING_CONTENT_TYPE,
  type RecordingStatus,
} from "../../shared/protocol";
import type { GatewayConfig } from "./config";
import type { FetchLike } from "./events";

/**
 * Records the devbox screen for the duration of a task with macOS
 * `screencapture -v` (cursor + clicks), then uploads the .mov to Convex file
 * storage so it outlives the ephemeral VM.
 *
 * - start() spawns the recorder and marks the task "recording".
 * - finish() SIGINTs the recorder (which finalizes a valid .mov), uploads via
 *   the Convex generateUploadUrl flow, and marks the task "available" — or
 *   "failed" if anything along the way breaks.
 *
 * Both are best-effort: a recording is never allowed to crash a task. finish()
 * must complete inside the post-task VM-reclaim grace window
 * (EPHEMERAL_RETIRE_GRACE_MS); a recording too large to push in one upload POST
 * is simply lost (status "failed" → dashboard shows "unavailable").
 */
export type ScreenRecorder = {
  /** Begin recording the screen for this task. Fire-and-forget. */
  start(taskId: string): void;
  /** Stop recording this task and upload the file. Idempotent per task. */
  finish(taskId: string): Promise<void>;
  /** Best-effort: kill any in-flight capture without uploading (shutdown). */
  abort(): void;
};

/** The slice of a spawned child process the recorder needs — stubbed in tests. */
export type RecorderProcess = {
  kill(signal: NodeJS.Signals): void;
  readonly exited: Promise<number>;
};

export type SpawnRecorder = (outputPath: string) => RecorderProcess;

export type RecorderDeps = {
  config: Pick<
    GatewayConfig,
    "convexSiteUrl" | "devboxId" | "devboxSharedSecret"
  >;
  fetchFn?: FetchLike;
  /** Spawns the screen-capture child. Default: `screencapture -v -C -k -x`. */
  spawn?: SpawnRecorder;
  /** Reads the finished recording off disk. Default: Bun.file(path).bytes(). */
  readFile?: (path: string) => Promise<Uint8Array>;
  removeFile?: (path: string) => Promise<void>;
  /** Where .mov files are written. Default: ~/.ultraclaude/recordings. */
  recordingsDir?: string;
  /** Override the SIGINT-finalize wait (tests). Default FINALIZE_TIMEOUT_MS. */
  finalizeTimeoutMs?: number;
};

/** How long finish() waits for screencapture to exit after SIGINT before
 * treating the capture as wedged: past this it force-kills the process and
 * marks the recording failed (it does NOT upload — a capture that hasn't exited
 * has no finalized `moov` atom, so the file would be unplayable). Finalization
 * is near instant in practice; this only bounds a hung capture. */
export const FINALIZE_TIMEOUT_MS = 30_000;

/** `screencapture -v`: video recording; `-C` cursor; `-k` clicks; `-x` no UI
 * sounds. Runs until SIGINT, which writes a valid `moov` and exits cleanly. */
function defaultSpawn(outputPath: string): RecorderProcess {
  return Bun.spawn(
    ["screencapture", "-v", "-C", "-k", "-x", outputPath],
    // stdin MUST stay open. `screencapture -v` watches stdin ("type any
    // character to stop recording") and stops the instant it hits EOF — the
    // default stdin "ignore" is /dev/null → immediate EOF → it captures ~3
    // frames (~0.05s) then stops while we think it's still recording. A "pipe"
    // we never write to keeps stdin open so it records until SIGINT. (Verified
    // live on a devbox: /dev/null stdin → 0.05s; held-open stdin → full length.)
    // stdout/err piped so a capture failure leaves evidence in the gateway log.
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
}

type ActiveRecording = {
  taskId: string;
  path: string;
  /** Resolves to the spawned capture process, or null if spawning failed.
   * finish()/abort() await this so a same-tick claim can't slip past a still-
   * spawning recording and orphan the process (start() is async: mkdir + spawn
   * happen after it returns). */
  proc: Promise<RecorderProcess | null>;
  /** Set by whichever of finish()/abort()/spawn-failure claims the recording
   * first; the others (and a late "recording" status post) become no-ops. */
  claimed: boolean;
};

export function createScreenRecorder(deps: RecorderDeps): ScreenRecorder {
  const fetchFn = deps.fetchFn ?? fetch;
  const spawn = deps.spawn ?? defaultSpawn;
  const readFile =
    deps.readFile ?? (async (path) => await Bun.file(path).bytes());
  const removeFile =
    deps.removeFile ??
    (async (path) => {
      await unlink(path).catch(() => undefined);
    });
  const recordingsDir =
    deps.recordingsDir ?? join(homedir(), ".ultraclaude", "recordings");
  const finalizeTimeoutMs = deps.finalizeTimeoutMs ?? FINALIZE_TIMEOUT_MS;

  let active: ActiveRecording | null = null;

  const recordingEndpoint = new URL(
    "/devbox/recording",
    deps.config.convexSiteUrl,
  ).toString();
  const uploadUrlEndpoint = new URL(
    "/devbox/recording/upload-url",
    deps.config.convexSiteUrl,
  ).toString();
  const authHeader = { "x-devbox-secret": deps.config.devboxSharedSecret };

  const postStatus = async (
    taskId: string,
    status: RecordingStatus,
    extra: { storageId?: string; bytes?: number } = {},
  ): Promise<void> => {
    try {
      const response = await fetchFn(recordingEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader },
        body: JSON.stringify({
          devboxId: deps.config.devboxId,
          taskId,
          status,
          ...extra,
        }),
      });
      if (!response.ok) {
        console.error(
          `[gateway] recorder: status POST ${status} failed (${response.status})`,
        );
      }
    } catch (error) {
      console.error("[gateway] recorder: status POST error:", error);
    }
  };

  // Filenames are namespaced by taskId; the id is gateway-internal (never user
  // text), but sanitize defensively so it can't escape the recordings dir.
  const recordingPath = (taskId: string): string =>
    join(recordingsDir, `${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}.mov`);

  const start = (taskId: string): void => {
    if (active !== null) {
      // SessionManager runs one task at a time, so this should never happen;
      // if it does, abandon the stale capture rather than leak the process.
      console.error(
        `[gateway] recorder: start(${taskId}) while ${active.taskId} active; aborting the old capture`,
      );
      abort();
    }
    const path = recordingPath(taskId);
    let resolveProc!: (proc: RecorderProcess | null) => void;
    const procPromise = new Promise<RecorderProcess | null>((resolve) => {
      resolveProc = resolve;
    });
    // Register synchronously, BEFORE the async mkdir/spawn: a same-tick
    // finish() (instant terminal / immediate stop) then claims this recording
    // and awaits the spawn, instead of seeing `active === null` and dropping
    // it — which used to spawn screencapture after the task was already done.
    const recording: ActiveRecording = {
      taskId,
      path,
      proc: procPromise,
      claimed: false,
    };
    active = recording;
    void (async () => {
      try {
        await mkdir(recordingsDir, { recursive: true });
        const proc = spawn(path);
        resolveProc(proc);
        // If finish()/abort() already claimed it, they own the transitions —
        // don't post a late "recording".
        if (!recording.claimed) await postStatus(taskId, "recording");
      } catch (error) {
        console.error("[gateway] recorder: failed to start capture:", error);
        resolveProc(null);
        if (!recording.claimed) {
          recording.claimed = true;
          if (active === recording) active = null;
          await postStatus(taskId, "failed");
        }
      }
    })();
  };

  const finish = async (taskId: string): Promise<void> => {
    const recording = active;
    if (
      recording === null ||
      recording.taskId !== taskId ||
      recording.claimed
    ) {
      // Never started, already claimed, or for another task — idempotent no-op.
      return;
    }
    recording.claimed = true;
    active = null;
    try {
      // Wait for the (async) spawn to actually produce a process before acting.
      const proc = await recording.proc;
      if (proc === null) {
        // Spawn failed; start()'s catch already reported "failed" unless it
        // lost the claim race to us — post defensively (setStatus is idempotent).
        await postStatus(taskId, "failed");
        return;
      }
      // SIGINT makes screencapture finalize a valid .mov, then exit. If it does
      // NOT exit within the window, the file has no finalized `moov` atom — so
      // force-kill it (no orphaned capture) and fail, rather than upload an
      // unplayable file and leave the process running.
      proc.kill("SIGINT");
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), finalizeTimeoutMs),
        ),
      ]);
      if (!exited) {
        console.error(
          "[gateway] recorder: screencapture did not finalize within timeout; force-killing",
        );
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
        await postStatus(taskId, "failed");
        return;
      }

      await postStatus(taskId, "uploading");

      let bytes: Uint8Array;
      try {
        bytes = await readFile(recording.path);
      } catch (error) {
        console.error("[gateway] recorder: recording file unreadable:", error);
        await postStatus(taskId, "failed");
        return;
      }
      if (bytes.byteLength === 0) {
        console.error("[gateway] recorder: recording file is empty");
        await postStatus(taskId, "failed");
        return;
      }

      const storageId = await uploadBytes(bytes);
      if (storageId === null) {
        await postStatus(taskId, "failed");
        return;
      }
      await postStatus(taskId, "available", {
        storageId,
        bytes: bytes.byteLength,
      });
    } catch (error) {
      console.error("[gateway] recorder: finish failed:", error);
      await postStatus(taskId, "failed").catch(() => undefined);
    } finally {
      await removeFile(recording.path);
    }
  };

  /** generateUploadUrl flow: fetch a one-shot upload URL, POST the bytes to it,
   * return the resulting storageId (null on any failure). */
  const uploadBytes = async (bytes: Uint8Array): Promise<string | null> => {
    let url: string;
    try {
      const response = await fetchFn(uploadUrlEndpoint, {
        method: "POST",
        headers: authHeader,
      });
      if (!response.ok) {
        console.error(
          `[gateway] recorder: upload-url POST failed (${response.status})`,
        );
        return null;
      }
      ({ url } = (await response.json()) as { url: string });
    } catch (error) {
      console.error("[gateway] recorder: upload-url error:", error);
      return null;
    }
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": RECORDING_CONTENT_TYPE },
        // A fresh ArrayBuffer slice keeps BodyInit happy regardless of the
        // Uint8Array's underlying buffer offset.
        body: bytes.slice().buffer as ArrayBuffer,
      });
      if (!response.ok) {
        console.error(
          `[gateway] recorder: upload POST failed (${response.status})`,
        );
        return null;
      }
      const { storageId } = (await response.json()) as { storageId: string };
      return typeof storageId === "string" && storageId !== ""
        ? storageId
        : null;
    } catch (error) {
      console.error("[gateway] recorder: upload error:", error);
      return null;
    }
  };

  const abort = (): void => {
    const recording = active;
    if (recording === null || recording.claimed) return;
    recording.claimed = true;
    active = null;
    // The capture may still be spawning; kill it once (and if) it appears.
    void recording.proc.then((proc) => proc?.kill("SIGINT"));
  };

  return { start, finish, abort };
}
