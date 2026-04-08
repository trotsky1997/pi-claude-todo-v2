import type { Theme } from "@mariozechner/pi-coding-agent";
import type { RecentCollabEvent, Task, TeammateSnapshot, WorkerSnapshot } from "./types.js";

const RECENT_COMPLETED_TTL_MS = 30_000;

function byIdAsc(a: Task, b: Task): number {
  const aNum = Number.parseInt(a.id, 10);
  const bNum = Number.parseInt(b.id, 10);
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
    return aNum - bNum;
  }
  return a.id.localeCompare(b.id);
}

function previewText(text: string, max = 48): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function getTeammateThemeColor(color: string | undefined): keyof Theme | undefined {
  switch (color?.toLowerCase()) {
    case "red":
      return "error";
    case "orange":
    case "yellow":
      return "warning";
    case "green":
      return "success";
    case "blue":
    case "cyan":
      return "accent";
    case "gray":
    case "grey":
      return "muted";
    default:
      return undefined;
  }
}

function findOwnedTask(tasks: Task[], teammateName: string): Task | undefined {
  const owned = tasks
    .filter((task) => task.status !== "completed" && task.owner === teammateName)
    .sort((a, b) => {
      if (a.status === "in_progress" && b.status !== "in_progress") return -1;
      if (a.status !== "in_progress" && b.status === "in_progress") return 1;
      return byIdAsc(a, b);
    });
  return owned[0];
}

function getTeammateActivity(
  teammate: TeammateSnapshot,
  worker: WorkerSnapshot | undefined,
  ownedTask: Task | undefined,
): string | undefined {
  if (teammate.status === "running") {
    if (worker?.currentTaskId) {
      const subject = worker.currentTaskSubject ? ` ${previewText(worker.currentTaskSubject, 28)}` : "";
      return `working on #${worker.currentTaskId}${subject}`;
    }
    if (ownedTask) {
      return `working on #${ownedTask.id} ${previewText(ownedTask.subject, 28)}`;
    }
    if (teammate.lastDescription) {
      return previewText(teammate.lastDescription);
    }
    return "working";
  }

  if (teammate.status === "failed") {
    return teammate.lastError ? previewText(teammate.lastError) : "failed";
  }
  if (teammate.status === "interrupted") {
    return teammate.lastError ? previewText(teammate.lastError) : "interrupted";
  }
  if (teammate.lastResultText) {
    return previewText(teammate.lastResultText);
  }
  if (worker?.message) {
    return previewText(worker.message);
  }
  return teammate.autoClaimTasks ? "available for work" : "idle";
}

function getTeammateStatusDisplay(teammate: TeammateSnapshot): { label: string; color: keyof Theme } {
  switch (teammate.status) {
    case "running":
      return { label: "running", color: "accent" };
    case "failed":
      return { label: "failed", color: "error" };
    case "interrupted":
      return { label: "interrupted", color: "warning" };
    case "completed":
    case "idle":
    default:
      return {
        label: teammate.autoClaimTasks ? "available" : "idle",
        color: "muted",
      };
  }
}

function getRecentEventColor(event: RecentCollabEvent): keyof Theme {
  switch (event.type) {
    case "assignment":
      return "accent";
    case "completion":
      return "success";
    case "stop":
      return "warning";
    case "teammate_update":
    default:
      return "muted";
  }
}

function getRecentEventIcon(event: RecentCollabEvent): string {
  switch (event.type) {
    case "assignment":
      return "->";
    case "completion":
      return "✓";
    case "stop":
      return "!";
    case "teammate_update":
    default:
      return "~";
  }
}

function formatTaskIdList(taskIds: string[]): string {
  return taskIds
    .filter((taskId, index, list) => list.indexOf(taskId) === index)
    .sort((a, b) => {
      const aNum = Number.parseInt(a, 10);
      const bNum = Number.parseInt(b, 10);
      if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
        return aNum - bNum;
      }
      return a.localeCompare(b);
    })
    .map((taskId) => `#${taskId}`)
    .join(", ");
}

function compactRecentEvents(events: RecentCollabEvent[]): RecentCollabEvent[] {
  const compacted: Array<RecentCollabEvent & { taskIds?: string[] }> = [];

  for (const event of events) {
    const previous = compacted[compacted.length - 1];

    if (
      previous &&
      event.type === "assignment" &&
      previous.type === "assignment" &&
      previous.teammateName === event.teammateName &&
      previous.assignedBy === event.assignedBy
    ) {
      previous.taskIds = [...(previous.taskIds ?? (previous.taskId ? [previous.taskId] : [])), ...(event.taskId ? [event.taskId] : [])];
      previous.text = `${formatTaskIdList(previous.taskIds)} assigned to @${event.teammateName} by ${event.assignedBy ?? "team-lead"}`;
      continue;
    }

    if (
      previous &&
      event.type === "completion" &&
      previous.type === "completion" &&
      previous.teammateName &&
      previous.teammateName === event.teammateName
    ) {
      previous.taskIds = [...(previous.taskIds ?? (previous.taskId ? [previous.taskId] : [])), ...(event.taskId ? [event.taskId] : [])];
      previous.text = `@${event.teammateName} completed ${formatTaskIdList(previous.taskIds)}`;
      continue;
    }

    if (
      previous &&
      event.type === "teammate_update" &&
      previous.type === "teammate_update" &&
      previous.teammateName === event.teammateName
    ) {
      continue;
    }

    compacted.push({
      ...event,
      ...(event.taskId ? { taskIds: [event.taskId] } : {}),
    });
  }

  return compacted;
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

function buildTaskLines(
  theme: Theme,
  task: Task,
  openBlockers: string[],
  options: {
    ownerColor?: keyof Theme;
    ownerActive?: boolean;
    activity?: string;
  } = {},
): string[] {
  const icon =
    task.status === "completed"
      ? theme.fg("success", "✓")
      : task.status === "in_progress"
        ? theme.fg("accent", "■")
        : theme.fg("dim", "□");

  const owner = task.owner
    ? options.ownerColor
      ? ` (${theme.fg(options.ownerColor, `@${task.owner}`)})`
      : theme.fg("dim", ` (@${task.owner})`)
    : "";
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

  const lines = [`${icon} ${subject}${owner}${blocked}`];
  if (
    options.activity &&
    options.ownerActive &&
    task.status === "in_progress" &&
    openBlockers.length === 0
  ) {
    lines.push(theme.fg("dim", `  ${options.activity}`));
  }
  return lines;
}

export function buildTaskWidgetLines(
  theme: Theme,
  taskListId: string,
  tasks: Task[],
  workers: WorkerSnapshot[],
  teammates: TeammateSnapshot[],
  recentEvents: RecentCollabEvent[],
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
  const workerByName = new Map(workers.map((worker) => [worker.name, worker]));
  const teammateByName = new Map(teammates.map((teammate) => [teammate.name, teammate]));

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
      const teammate = task.owner ? teammateByName.get(task.owner) : undefined;
      const ownerColor = getTeammateThemeColor(teammate?.color);
      const ownerActive = teammate?.status === "running";
      const activity = teammate
        ? getTeammateActivity(teammate, workerByName.get(teammate.name), task.owner === teammate.name ? task : undefined)
        : undefined;
      lines.push(
        ...buildTaskLines(theme, task, openBlockers, {
          ownerColor,
          ownerActive,
          activity,
        }),
      );
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

  if (teammates.length > 0) {
    lines.push("");
    lines.push(theme.fg("accent", theme.bold("Teammates")));
    for (const teammate of teammates) {
      const worker = workerByName.get(teammate.name);
      const ownedTask = findOwnedTask(tasks, teammate.name);
      const { label, color } = getTeammateStatusDisplay(teammate);
      const taskLabel = ownedTask ? ` #${ownedTask.id}` : worker?.currentTaskId ? ` #${worker.currentTaskId}` : "";
      const activity = getTeammateActivity(teammate, worker, ownedTask);
      const detail = activity ? ` - ${activity}` : "";
      lines.push(theme.fg(color, `${teammate.name}: ${label}${taskLabel}${detail}`));
    }
  } else if (workers.length > 0) {
    lines.push("");
    lines.push(theme.fg("accent", theme.bold("Workers")));
    for (const worker of workers) {
      const taskLabel = worker.currentTaskId ? ` #${worker.currentTaskId}` : "";
      const message = worker.message ? ` - ${worker.message}` : "";
      const color = worker.status === "error" ? "error" : worker.status === "running" ? "accent" : "muted";
      lines.push(theme.fg(color as keyof Theme, `${worker.name}: ${worker.status}${taskLabel}${message}`));
    }
  }

  if (recentEvents.length > 0) {
    const compactedRecentEvents = compactRecentEvents(recentEvents).slice(0, 3);
    lines.push("");
    lines.push(theme.fg("accent", theme.bold("Recent")));
    for (const event of compactedRecentEvents) {
      const icon = getRecentEventIcon(event);
      const color = getRecentEventColor(event);
      lines.push(theme.fg(color, `${icon} ${event.text}`));
    }
  }

  return lines;
}

export function buildStatusText(
  theme: Theme,
  taskListId: string,
  tasks: Task[],
  workers: WorkerSnapshot[],
  teammates: TeammateSnapshot[],
): string {
  const incomplete = tasks.filter((task) => task.status !== "completed").length;
  if (teammates.length > 0) {
    const running = teammates.filter((teammate) => teammate.status === "running").length;
    return theme.fg("accent", `tasks:${taskListId} open:${incomplete} mates:${running}/${teammates.length}`);
  }
  if (workers.length > 0) {
    return theme.fg("accent", `tasks:${taskListId} open:${incomplete} workers:${workers.length}`);
  }
  return theme.fg("accent", `tasks:${taskListId} open:${incomplete}`);
}
