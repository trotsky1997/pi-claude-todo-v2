import { readdir, unlink } from "node:fs/promises";
import {
  getHighWaterMarkPath,
  getTaskListDir,
  getTaskPath,
  readHighWaterMark,
  readJsonFile,
  withListLock,
  withTaskLock,
  withTaskLocks,
  writeHighWaterMark,
  writeJsonFile,
} from "./storage.js";
import type { ClaimTaskOptions, ClaimTaskResult, Task, TaskStatus } from "./types.js";

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeTask(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Task>;
  if (typeof input.id !== "string") return null;
  if (typeof input.subject !== "string") return null;
  if (typeof input.description !== "string") return null;
  if (!isTaskStatus(input.status)) return null;

  const normalized: Task = {
    id: input.id,
    subject: input.subject,
    description: input.description,
    status: input.status,
    blocks: asStringArray(input.blocks),
    blockedBy: asStringArray(input.blockedBy),
  };

  if (typeof input.activeForm === "string" && input.activeForm.trim()) {
    normalized.activeForm = input.activeForm;
  }
  if (typeof input.owner === "string" && input.owner.trim()) {
    normalized.owner = input.owner;
  }
  if (input.metadata && typeof input.metadata === "object") {
    normalized.metadata = input.metadata as Record<string, unknown>;
  }

  return normalized;
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aId = Number.parseInt(a.id, 10);
    const bId = Number.parseInt(b.id, 10);
    if (!Number.isNaN(aId) && !Number.isNaN(bId)) {
      return aId - bId;
    }
    return a.id.localeCompare(b.id);
  });
}

async function findHighestTaskIdFromFiles(cwd: string, taskListId: string): Promise<number> {
  let files: string[] = [];
  try {
    files = await readdir(getTaskListDir(cwd, taskListId));
  } catch {
    return 0;
  }

  let highest = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const taskId = Number.parseInt(file.replace(/\.json$/, ""), 10);
    if (!Number.isNaN(taskId) && taskId > highest) {
      highest = taskId;
    }
  }
  return highest;
}

async function findHighestTaskId(cwd: string, taskListId: string): Promise<number> {
  const [fromFiles, fromMark] = await Promise.all([
    findHighestTaskIdFromFiles(cwd, taskListId),
    readHighWaterMark(cwd, taskListId),
  ]);
  return Math.max(fromFiles, fromMark);
}

async function writeTaskDirect(cwd: string, taskListId: string, task: Task): Promise<void> {
  await writeJsonFile(getTaskPath(cwd, taskListId, task.id), task);
}

async function updateTaskDirect(
  cwd: string,
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, "id">>,
): Promise<Task | null> {
  const existing = await getTask(cwd, taskListId, taskId);
  if (!existing) return null;
  const updated: Task = {
    ...existing,
    ...updates,
    id: taskId,
    blocks: updates.blocks ? [...updates.blocks] : existing.blocks,
    blockedBy: updates.blockedBy ? [...updates.blockedBy] : existing.blockedBy,
  };
  if (updated.owner !== undefined && !updated.owner) {
    delete updated.owner;
  }
  if (updated.activeForm !== undefined && !updated.activeForm) {
    delete updated.activeForm;
  }
  if (updated.metadata && Object.keys(updated.metadata).length === 0) {
    delete updated.metadata;
  }
  await writeTaskDirect(cwd, taskListId, updated);
  return updated;
}

export async function getTask(cwd: string, taskListId: string, taskId: string): Promise<Task | null> {
  const task = await readJsonFile<Task>(getTaskPath(cwd, taskListId, taskId));
  return normalizeTask(task);
}

export async function listTasks(cwd: string, taskListId: string): Promise<Task[]> {
  let files: string[] = [];
  try {
    files = await readdir(getTaskListDir(cwd, taskListId));
  } catch {
    return [];
  }

  const taskIds = files.filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, ""));
  const tasks = await Promise.all(taskIds.map((taskId) => getTask(cwd, taskListId, taskId)));
  return sortTasks(tasks.filter((task): task is Task => task !== null));
}

export async function createTask(
  cwd: string,
  taskListId: string,
  taskData: Omit<Task, "id">,
): Promise<string> {
  return withListLock(cwd, taskListId, async () => {
    const nextId = String((await findHighestTaskId(cwd, taskListId)) + 1);
    await writeTaskDirect(cwd, taskListId, { id: nextId, ...taskData });
    return nextId;
  });
}

export async function updateTask(
  cwd: string,
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, "id">>,
): Promise<Task | null> {
  const taskBeforeLock = await getTask(cwd, taskListId, taskId);
  if (!taskBeforeLock) return null;
  return withTaskLock(cwd, taskListId, taskId, async () => updateTaskDirect(cwd, taskListId, taskId, updates));
}

export async function deleteTask(cwd: string, taskListId: string, taskId: string): Promise<boolean> {
  return withListLock(cwd, taskListId, async () => {
    const allTasks = await listTasks(cwd, taskListId);
    return withTaskLocks(
      cwd,
      taskListId,
      allTasks.map((task) => task.id),
      async () => {
        const existing = await getTask(cwd, taskListId, taskId);
        if (!existing) return false;

        const numericId = Number.parseInt(taskId, 10);
        if (!Number.isNaN(numericId)) {
          const currentMark = await readHighWaterMark(cwd, taskListId);
          if (numericId > currentMark) {
            await writeHighWaterMark(cwd, taskListId, numericId);
          }
        }

        try {
          await unlink(getTaskPath(cwd, taskListId, taskId));
        } catch {
          return false;
        }

        const remainingTasks = await listTasks(cwd, taskListId);
        for (const task of remainingTasks) {
          const blocks = task.blocks.filter((id) => id !== taskId);
          const blockedBy = task.blockedBy.filter((id) => id !== taskId);
          if (blocks.length !== task.blocks.length || blockedBy.length !== task.blockedBy.length) {
            await updateTaskDirect(cwd, taskListId, task.id, { blocks, blockedBy });
          }
        }

        return true;
      }
    );
  });
}

export async function resetTaskList(cwd: string, taskListId: string): Promise<void> {
  await withListLock(cwd, taskListId, async () => {
    const currentTasks = await listTasks(cwd, taskListId);
    await withTaskLocks(
      cwd,
      taskListId,
      currentTasks.map((task) => task.id),
      async () => {
        const currentHighest = await findHighestTaskIdFromFiles(cwd, taskListId);
        if (currentHighest > 0) {
          const existingMark = await readHighWaterMark(cwd, taskListId);
          if (currentHighest > existingMark) {
            await writeHighWaterMark(cwd, taskListId, currentHighest);
          }
        }

        let files: string[] = [];
        try {
          files = await readdir(getTaskListDir(cwd, taskListId));
        } catch {
          files = [];
        }

        for (const file of files) {
          if (!file.endsWith(".json") || file.startsWith(".")) continue;
          try {
            await unlink(getTaskPath(cwd, taskListId, file.replace(/\.json$/, "")));
          } catch {
            // Ignore delete races.
          }
        }
      },
    );
  });
}

export async function blockTask(
  cwd: string,
  taskListId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<boolean> {
  return withListLock(cwd, taskListId, async () => {
    return withTaskLocks(cwd, taskListId, [fromTaskId, toTaskId], async () => {
      const fromTask = await getTask(cwd, taskListId, fromTaskId);
      const toTask = await getTask(cwd, taskListId, toTaskId);
      if (!fromTask || !toTask) return false;

      if (!fromTask.blocks.includes(toTaskId)) {
        fromTask.blocks = [...fromTask.blocks, toTaskId];
        await writeTaskDirect(cwd, taskListId, fromTask);
      }

      if (!toTask.blockedBy.includes(fromTaskId)) {
        toTask.blockedBy = [...toTask.blockedBy, fromTaskId];
        await writeTaskDirect(cwd, taskListId, toTask);
      }

      return true;
    });
  });
}

export async function claimTask(
  cwd: string,
  taskListId: string,
  taskId: string,
  claimant: string,
  options: ClaimTaskOptions = {},
): Promise<ClaimTaskResult> {
  const claimWithoutBusyCheck = async (): Promise<ClaimTaskResult> => {
    const taskBeforeLock = await getTask(cwd, taskListId, taskId);
    if (!taskBeforeLock) {
      return { success: false, reason: "task_not_found" };
    }

    return withTaskLock(cwd, taskListId, taskId, async () => {
      const task = await getTask(cwd, taskListId, taskId);
      if (!task) return { success: false, reason: "task_not_found" };

      if (task.owner && task.owner !== claimant) {
        return { success: false, reason: "already_claimed", task };
      }

      if (task.status === "completed") {
        return { success: false, reason: "already_resolved", task };
      }

      const allTasks = await listTasks(cwd, taskListId);
      const unresolvedIds = new Set(allTasks.filter((entry) => entry.status !== "completed").map((entry) => entry.id));
      const blockedByTasks = task.blockedBy.filter((id) => unresolvedIds.has(id));
      if (blockedByTasks.length > 0) {
        return { success: false, reason: "blocked", task, blockedByTasks };
      }

      const updated = await updateTaskDirect(cwd, taskListId, taskId, { owner: claimant });
      return { success: true, task: updated ?? task };
    });
  };

  if (!options.checkAgentBusy) {
    return claimWithoutBusyCheck();
  }

  return withListLock(cwd, taskListId, async () => {
    return withTaskLock(cwd, taskListId, taskId, async () => {
      const tasks = await listTasks(cwd, taskListId);
      const task = tasks.find((entry) => entry.id === taskId);
      if (!task) return { success: false, reason: "task_not_found" };

      if (task.owner && task.owner !== claimant) {
        return { success: false, reason: "already_claimed", task };
      }

      if (task.status === "completed") {
        return { success: false, reason: "already_resolved", task };
      }

      const unresolvedIds = new Set(tasks.filter((entry) => entry.status !== "completed").map((entry) => entry.id));
      const blockedByTasks = task.blockedBy.filter((id) => unresolvedIds.has(id));
      if (blockedByTasks.length > 0) {
        return { success: false, reason: "blocked", task, blockedByTasks };
      }

      const busyWithTasks = tasks
        .filter(
          (entry) => entry.status !== "completed" && entry.owner === claimant && entry.id !== taskId,
        )
        .map((entry) => entry.id);
      if (busyWithTasks.length > 0) {
        return { success: false, reason: "agent_busy", task, busyWithTasks };
      }

      const updated = await updateTaskDirect(cwd, taskListId, taskId, { owner: claimant });
      return { success: true, task: updated ?? task };
    });
  });
}

export function findAvailableTask(tasks: Task[]): Task | undefined {
  const unresolvedIds = new Set(tasks.filter((task) => task.status !== "completed").map((task) => task.id));
  return sortTasks(tasks).find((task) => {
    if (task.status !== "pending") return false;
    if (task.owner) return false;
    return task.blockedBy.every((id) => !unresolvedIds.has(id));
  });
}

export async function unassignWorkerTasks(
  cwd: string,
  taskListId: string,
  workerName: string,
): Promise<Array<{ id: string; subject: string }>> {
  return withListLock(cwd, taskListId, async () => {
    const tasks = await listTasks(cwd, taskListId);
    const assigned = tasks.filter(
      (task) => task.status !== "completed" && task.owner === workerName,
    );

    return withTaskLocks(
      cwd,
      taskListId,
      assigned.map((task) => task.id),
      async () => {
        for (const task of assigned) {
          await updateTaskDirect(cwd, taskListId, task.id, {
            owner: undefined,
            status: "pending",
          });
        }

        return assigned.map((task) => ({ id: task.id, subject: task.subject }));
      },
    );
  });
}

export function filterExternalTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !task.metadata?._internal);
}

export function buildTaskSummary(task: Task, resolvedIds: Set<string>) {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    owner: task.owner,
    blockedBy: task.blockedBy.filter((id) => !resolvedIds.has(id)),
  };
}

export async function countCompletedTasks(cwd: string, taskListId: string): Promise<number> {
  const tasks = await listTasks(cwd, taskListId);
  return tasks.filter((task) => task.status === "completed").length;
}

export async function taskExists(cwd: string, taskListId: string, taskId: string): Promise<boolean> {
  return (await getTask(cwd, taskListId, taskId)) !== null;
}

export async function getAllDoneState(cwd: string, taskListId: string): Promise<{
  allDone: boolean;
  tasks: Task[];
}> {
  const tasks = await listTasks(cwd, taskListId);
  return {
    allDone: tasks.length > 0 && tasks.every((task) => task.status === "completed"),
    tasks,
  };
}

export async function markTaskInProgress(
  cwd: string,
  taskListId: string,
  taskId: string,
  owner?: string,
): Promise<Task | null> {
  return updateTask(cwd, taskListId, taskId, {
    status: "in_progress",
    ...(owner ? { owner } : {}),
  });
}

export async function setTaskOwner(
  cwd: string,
  taskListId: string,
  taskId: string,
  owner?: string,
): Promise<Task | null> {
  return updateTask(cwd, taskListId, taskId, { owner });
}

export async function bumpHighWaterMarkForTask(
  cwd: string,
  taskListId: string,
  taskId: string,
): Promise<void> {
  const numericId = Number.parseInt(taskId, 10);
  if (Number.isNaN(numericId)) return;
  const current = await readHighWaterMark(cwd, taskListId);
  if (numericId > current) {
    await writeHighWaterMark(cwd, taskListId, numericId);
  }
}

export function getHighWaterMarkFilePath(cwd: string, taskListId: string): string {
  return getHighWaterMarkPath(cwd, taskListId);
}
