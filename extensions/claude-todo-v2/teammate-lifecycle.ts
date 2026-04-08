import { loadClaudeTodoConfig, runTaskHook } from "./hooks.js";
import { emitRecentCollabEvent } from "./recent-collab-bridge.js";
import { filterExternalTasks, listTasks } from "./tasks.js";

type ManagedTeammateStatus = "idle" | "running" | "completed" | "failed" | "interrupted";

type TeammateRuntimeEvent = {
  teamName?: unknown;
  name?: unknown;
  status?: unknown;
  lastResultText?: unknown;
  lastError?: unknown;
};

function isManagedTeammateStatus(value: unknown): value is ManagedTeammateStatus {
  return value === "idle"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "interrupted";
}

function getLifecycleKey(taskListId: string, teammateName: string): string {
  return `${taskListId}:${teammateName}`;
}

function buildHookFeedbackText(options: {
  teammateName: string;
  hookName: "TaskCompleted" | "TeammateIdle";
  taskId?: string;
  detail: string;
}): string {
  const taskPrefix = options.taskId ? `#${options.taskId} ` : "";
  return `@${options.teammateName} ${taskPrefix}${options.hookName}: ${options.detail}`;
}

export class TeammateLifecycleManager {
  private readonly previousStatuses = new Map<string, ManagedTeammateStatus>();

  constructor(private readonly cwd: string) {}

  async handleRuntimeEvent(event: TeammateRuntimeEvent): Promise<void> {
    const taskListId = typeof event.teamName === "string" ? event.teamName.trim() : "";
    const teammateName = typeof event.name === "string" ? event.name.trim() : "";
    if (!taskListId || !teammateName || !isManagedTeammateStatus(event.status)) {
      return;
    }

    const status = event.status;
    const key = getLifecycleKey(taskListId, teammateName);
    const previousStatus = this.previousStatuses.get(key);
    this.previousStatuses.set(key, status);

    if (previousStatus !== "running" || status === "running") {
      return;
    }

    await this.runStopTimeTaskCompletedHooks(taskListId, teammateName);

    if (status === "completed" || status === "idle") {
      await this.runTeammateIdleHook(taskListId, teammateName);
    }
  }

  private async runStopTimeTaskCompletedHooks(taskListId: string, teammateName: string): Promise<void> {
    const config = await loadClaudeTodoConfig(this.cwd);
    if (!config.hooks?.taskCompleted) {
      return;
    }

    const tasks = filterExternalTasks(await listTasks(this.cwd, taskListId))
      .filter((task) => task.status === "in_progress" && task.owner === teammateName);

    for (const task of tasks) {
      const hookResult = await runTaskHook(this.cwd, config.hooks.taskCompleted, {
        hook_event_name: "TaskCompleted",
        task_id: task.id,
        task_subject: task.subject,
        task_description: task.description,
        task_list_id: taskListId,
        teammate_name: teammateName,
        team_name: taskListId,
      });

      const detail = hookResult.blocked
        ? hookResult.message ?? "blocked"
        : hookResult.warning;
      if (!detail) continue;

      emitRecentCollabEvent({
        type: "teammate_update",
        taskListId,
        timestamp: new Date().toISOString(),
        text: buildHookFeedbackText({
          teammateName,
          hookName: "TaskCompleted",
          taskId: task.id,
          detail,
        }),
        teammateName,
        taskId: task.id,
        status: hookResult.blocked ? "blocked" : "warning",
      });
    }
  }

  private async runTeammateIdleHook(taskListId: string, teammateName: string): Promise<void> {
    const config = await loadClaudeTodoConfig(this.cwd);
    if (!config.hooks?.teammateIdle) {
      return;
    }

    const hookResult = await runTaskHook(this.cwd, config.hooks.teammateIdle, {
      hook_event_name: "TeammateIdle",
      teammate_name: teammateName,
      team_name: taskListId,
      task_list_id: taskListId,
    });

    const detail = hookResult.blocked
      ? hookResult.message ?? "blocked"
      : hookResult.warning;
    if (!detail) return;

    emitRecentCollabEvent({
      type: "teammate_update",
      taskListId,
      timestamp: new Date().toISOString(),
      text: buildHookFeedbackText({
        teammateName,
        hookName: "TeammateIdle",
        detail,
      }),
      teammateName,
      status: hookResult.blocked ? "blocked" : "warning",
    });
  }
}
