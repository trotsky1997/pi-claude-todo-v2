import type { RecentCollabEvent } from "./types.js";

type RecentCollabNotifier = (event: RecentCollabEvent) => void;

type Bridge = {
  notifier: RecentCollabNotifier | null;
};

const GLOBAL_KEY = "__pi_claude_todo_v2_recent_collab_bridge__";
const bridge = ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as Bridge | undefined) ?? {
  notifier: null,
};

(globalThis as Record<string, unknown>)[GLOBAL_KEY] = bridge;

export function setRecentCollabNotifier(notifier: RecentCollabNotifier | null): void {
  bridge.notifier = notifier;
}

export function emitRecentCollabEvent(event: RecentCollabEvent): void {
  bridge.notifier?.(event);
}
