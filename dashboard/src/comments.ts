// Client helper for the host frame-grab endpoint (#70). Same origin as the page
// (Tailscale Serve forwards / to the dashboard-server), so no CORS.

/**
 * Ask the fleet host to grab the recording frame at `videoTimeSec`, store it,
 * and return its storageId — to be attached to the comment as its thumbnail.
 * Returns null on any failure: the comment is still created, just text-only.
 */
export async function grabFrame(
  secret: string,
  taskId: string,
  videoTimeSec: number,
): Promise<string | null> {
  try {
    const res = await fetch("/api/frame", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, taskId, videoTimeSec }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { storageId?: unknown };
    return typeof body.storageId === "string" ? body.storageId : null;
  } catch {
    return null;
  }
}
