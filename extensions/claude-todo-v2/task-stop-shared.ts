import { emitRecentCollabEvent } from "./recent-collab-bridge.js";
import { getManagedTaskRegistry, getSubagentRuntimeManager } from "./subagent-runtime-integration.js";
import { getTask, unassignOwnerTasks } from "./tasks.js";
import type { TaskStopDetails } from "./types.js";

async function stopManagedRuntimeTask(options: {
  cwd: string;
  taskListId: string;
  taskId: string;
  actingAgentName?: string;
}): Promise<TaskStopDetails | null> {
  const registry = getManagedTaskRegistry();
  const runtimeManager = getSubagentRuntimeManager();
  if (!registry || !runtimeManager) {
    return null;
  }

  const managedTask = registry.get(options.taskId);
  if (!managedTask) {
    return null;
  }

  if (managedTask.status !== "running") {
    return {
      success: false,
      taskId: options.taskId,
      taskListId: managedTask.teamName ?? options.taskListId,
      owner: managedTask.runtimeName,
      error: `Managed run ${managedTask.taskId} is not running.`,
    };
  }

  const runtimeStopRequested = await runtimeManager.abort(managedTask.runtimeName, {
    kind: managedTask.runtimeKind,
    ...(managedTask.teamName ? { teamName: managedTask.teamName } : {}),
  });

  if (managedTask.runtimeKind === "teammate" && managedTask.teamName) {
    await unassignOwnerTasks(options.cwd, managedTask.teamName, managedTask.runtimeName);
  }

  emitRecentCollabEvent({
    type: "stop",
    taskListId: managedTask.teamName ?? options.taskListId,
    timestamp: new Date().toISOString(),
    text: `${managedTask.taskId} stopped${options.actingAgentName ? ` by @${options.actingAgentName}` : ""}`,
    ...(options.actingAgentName ? { teammateName: options.actingAgentName } : {}),
    status: "pending",
  });

  return {
    success: true,
    taskId: managedTask.taskId,
    taskListId: managedTask.teamName ?? options.taskListId,
    owner: managedTask.runtimeName,
    runtimeStopRequested,
  };
}

export async function executeTaskStopOperation(options: {
  cwd: string;
  taskListId: string;
  taskId: string;
  actingAgentName?: string;
}): Promise<TaskStopDetails> {
  const task = await getTask(options.cwd, options.taskListId, options.taskId);
  if (!task) {
    return await stopManagedRuntimeTask(options) ?? {
      success: false,
      taskId: options.taskId,
      taskListId: options.taskListId,
      error: "Task not found",
    };
  }

  if (task.status !== "in_progress") {
    return {
      success: false,
      taskId: options.taskId,
      taskListId: options.taskListId,
      owner: task.owner,
      error: `Task #${task.id} is not running.`,
    };
  }

  if (!task.owner) {
    return {
      success: false,
      taskId: options.taskId,
      taskListId: options.taskListId,
      error: `Task #${task.id} has no owner to stop.`,
    };
  }

  let runtimeStopRequested = false;
  const runtimeManager = getSubagentRuntimeManager();
  if (runtimeManager) {
    if (options.actingAgentName && options.actingAgentName === task.owner) {
      runtimeStopRequested = true;
      setTimeout(() => {
        void runtimeManager.abort(task.owner!, { kind: "teammate", teamName: options.taskListId });
      }, 0);
    } else {
      runtimeStopRequested = await runtimeManager.abort(task.owner, {
        kind: "teammate",
        teamName: options.taskListId,
      });
    }
  }

  await unassignOwnerTasks(options.cwd, options.taskListId, task.owner);
  emitRecentCollabEvent({
    type: "stop",
    taskListId: options.taskListId,
    timestamp: new Date().toISOString(),
    text: `#${task.id} stopped${options.actingAgentName ? ` by @${options.actingAgentName}` : ""}`,
    taskId: task.id,
    ...(options.actingAgentName ? { teammateName: options.actingAgentName } : {}),
    status: "pending",
  });

  return {
    success: true,
    taskId: task.id,
    taskListId: options.taskListId,
    owner: task.owner,
    runtimeStopRequested,
  };
}

export function buildTaskStopResultText(details: TaskStopDetails): string {
  if (!details.success) {
    return details.error ?? "Task stop failed";
  }

  const isManagedRuntimeTask = details.taskId.includes(":");
  const owner = details.owner ? ` owned by @${details.owner}` : "";
  const runtime = details.runtimeStopRequested
    ? " The teammate runtime was asked to stop immediately."
    : " No live teammate runtime was found, so stale ownership was cleared and the task was requeued.";
  if (isManagedRuntimeTask) {
    const stopText = details.runtimeStopRequested
      ? " The managed runtime was asked to stop immediately."
      : " No live managed runtime was found.";
    return `Stopped managed run ${details.taskId}${owner}.${stopText}`;
  }
  return `Stopped task #${details.taskId}${owner}. It is now pending and unassigned.${runtime}`;
}
