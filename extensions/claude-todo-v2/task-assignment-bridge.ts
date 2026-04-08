import type { TaskAssignmentNotification } from "./types.js";

type TaskAssignmentNotifier = (notification: TaskAssignmentNotification) => void;

type Bridge = {
  notifier: TaskAssignmentNotifier | null;
};

const GLOBAL_KEY = "__pi_claude_todo_v2_task_assignment_bridge__";
const bridge = ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as Bridge | undefined) ?? {
  notifier: null,
};

(globalThis as Record<string, unknown>)[GLOBAL_KEY] = bridge;

export function setTaskAssignmentNotifier(notifier: TaskAssignmentNotifier | null): void {
  bridge.notifier = notifier;
}

export function emitTaskAssignmentNotification(notification: TaskAssignmentNotification): void {
  bridge.notifier?.(notification);
}
