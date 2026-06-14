import type { MouseEvent } from "react";
import { useSyncExternalStore } from "react";

/**
 * Hand-rolled History-API routing for the two dashboard views (no router
 * dependency): the fleet board at "/" and a task-details page at
 * "/task/<taskId>". navigate() pushes state and notifies subscribers (pushState
 * fires no event of its own); useRoute() re-renders on back/forward + navigate.
 */

export type Route = { taskId: string | null };

const ROUTE_EVENT = "ultraclaude:navigate";

/** Pure path parser (unit-tested): "/task/<id>" -> that id, anything else -> the
 * board. The id is URL-decoded; a trailing slash is tolerated. */
export function parsePath(pathname: string): Route {
  const match = /^\/task\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1] === undefined || match[1] === "") {
    return { taskId: null };
  }
  try {
    return { taskId: decodeURIComponent(match[1]) };
  } catch {
    // A malformed escape sequence isn't a real task path.
    return { taskId: null };
  }
}

/** The stable details path for a task id. */
export function taskPath(taskId: string): string {
  return `/task/${encodeURIComponent(taskId)}`;
}

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(ROUTE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(ROUTE_EVENT, onChange);
  };
}

/** onClick for an `<a href={to}>` that should navigate within the SPA on a
 * plain left-click, while letting modified / middle clicks open a new tab
 * (so deep links remain real, shareable URLs). */
export function spaLink(to: string): (e: MouseEvent) => void {
  return (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    navigate(to);
  };
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => "/",
  );
  return parsePath(pathname);
}
