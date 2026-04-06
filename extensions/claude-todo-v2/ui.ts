import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Task, WorkerSnapshot } from "./types.js";

const RECENT_COMPLETED_TTL_MS = 30_000;

function byIdAsc(a: Task, b: Task): number {
  const aNum = Number.parseInt(a.id, 10);
  const bNum = Number.parseInt(b.id, 10);
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
    return aNum - bNum;
  }
  return a.id.localeCompare(b.id);
}

export function syncCompletionTimestamps(
  tasks: Task[],
  completionTimestamps: Map<string, number>,
): void {
  const currentCompletedIds = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  const now = Date.now();

  for (const id of currentCompletedIds) {
    if (!completionTimestamps.has(id)) {
      completionTimestamps.set(id, now);
    }
  }

  for (const id of [...completionTimestamps.keys()]) {
    if (!currentCompletedIds.has(id)) {
      completionTimestamps.delete(id);
    }
  }
}

export function sortTasksForDisplay(
  tasks: Task[],
  completionTimestamps: Map<string, number>,
): Task[] {
  const now = Date.now();
  const unresolvedTaskIds = new Set(
    tasks.filter((task) => task.status !== "completed").map((task) => task.id),
  );

  const recentCompleted: Task[] = [];
  const olderCompleted: Task[] = [];
  for (const task of tasks.filter((entry) => entry.status === "completed")) {
    const completedAt = completionTimestamps.get(task.id);
    if (completedAt && now - completedAt < RECENT_COMPLETED_TTL_MS) {
      recentCompleted.push(task);
    } else {
      olderCompleted.push(task);
    }
  }

  recentCompleted.sort(byIdAsc);
  olderCompleted.sort(byIdAsc);

  const inProgress = tasks
    .filter((task) => task.status === "in_progress")
    .sort(byIdAsc);

  const pending = tasks
    .filter((task) => task.status === "pending")
    .sort((a, b) => {
      const aBlocked = a.blockedBy.some((id) => unresolvedTaskIds.has(id));
      const bBlocked = b.blockedBy.some((id) => unresolvedTaskIds.has(id));
      if (aBlocked !== bBlocked) {
        return aBlocked ? 1 : -1;
      }
      return byIdAsc(a, b);
    });

  return [...recentCompleted, ...inProgress, ...pending, ...olderCompleted];
}

function formatTaskLine(
  theme: Theme,
  task: Task,
  openBlockers: string[],
): string {
  const icon =
    task.status === "completed"
      ? theme.fg("success", "✓")
      : task.status === "in_progress"
        ? theme.fg("accent", "■")
        : theme.fg("dim", "□");

  const owner = task.owner ? theme.fg("dim", ` (@${task.owner})`) : "";
  const blocked =
    openBlockers.length > 0
      ? theme.fg("warning", ` blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}`)
      : "";

  let subject = task.subject;
  if (task.status === "completed") {
    subject = theme.fg("muted", theme.strikethrough(subject));
  } else if (task.status === "in_progress") {
    subject = theme.bold(subject);
  }

  return `${icon} ${subject}${owner}${blocked}`;
}

export function buildTaskWidgetLines(
  theme: Theme,
  taskListId: string,
  tasks: Task[],
  workers: WorkerSnapshot[],
  completionTimestamps: Map<string, number>,
  options: {
    maxItems?: number;
  } = {},
): string[] {
  const maxItems = options.maxItems ?? 10;
  const orderedTasks = sortTasksForDisplay(tasks, completionTimestamps);
  const unresolvedTaskIds = new Set(
    tasks.filter((task) => task.status !== "completed").map((task) => task.id),
  );

  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const pendingCount = tasks.filter((task) => task.status === "pending").length;
  const inProgressCount = tasks.length - completedCount - pendingCount;

  const visibleTasks = orderedTasks.slice(0, maxItems);
  const hiddenTasks = orderedTasks.slice(maxItems);

  const lines = [
    `${theme.fg("accent", theme.bold("Claude Todo V2"))} ${theme.fg("dim", taskListId)}`,
    theme.fg(
      "muted",
      `${tasks.length} task(s): ${completedCount} done, ${inProgressCount} in progress, ${pendingCount} open`,
    ),
  ];

  if (tasks.length === 0) {
    lines.push(theme.fg("dim", "No tasks yet."));
  } else {
    for (const task of visibleTasks) {
      const openBlockers = task.blockedBy.filter((id) => unresolvedTaskIds.has(id));
      lines.push(formatTaskLine(theme, task, openBlockers));
    }
  }

  if (hiddenTasks.length > 0) {
    const hiddenPending = hiddenTasks.filter((task) => task.status === "pending").length;
    const hiddenInProgress = hiddenTasks.filter((task) => task.status === "in_progress").length;
    const hiddenCompleted = hiddenTasks.filter((task) => task.status === "completed").length;
    const parts = [];
    if (hiddenInProgress > 0) parts.push(`${hiddenInProgress} in progress`);
    if (hiddenPending > 0) parts.push(`${hiddenPending} pending`);
    if (hiddenCompleted > 0) parts.push(`${hiddenCompleted} completed`);
    lines.push(theme.fg("dim", `... +${parts.join(", ")}`));
  }

  if (workers.length > 0) {
    lines.push("");
    lines.push(theme.fg("accent", theme.bold("Workers")));
    for (const worker of workers) {
      const taskLabel = worker.currentTaskId ? ` #${worker.currentTaskId}` : "";
      const message = worker.message ? ` - ${worker.message}` : "";
      const color = worker.status === "error" ? "error" : worker.status === "running" ? "accent" : "muted";
      lines.push(theme.fg(color as keyof Theme, `${worker.name}: ${worker.status}${taskLabel}${message}`));
    }
  }

  return lines;
}

export function buildStatusText(
  theme: Theme,
  taskListId: string,
  tasks: Task[],
  workers: WorkerSnapshot[],
): string {
  const incomplete = tasks.filter((task) => task.status !== "completed").length;
  if (workers.length > 0) {
    return theme.fg("accent", `tasks:${taskListId} open:${incomplete} workers:${workers.length}`);
  }
  return theme.fg("accent", `tasks:${taskListId} open:${incomplete}`);
}
