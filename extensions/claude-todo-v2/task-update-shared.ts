import type { Model } from "@mariozechner/pi-ai";
import type { ModelRegistry, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "pi-claude-runtime-core/agent-discovery";
import { loadTeamRecord } from "pi-claude-runtime-core/team-state";
import type { NamedAgentRecord } from "pi-claude-runtime-core/managed-runtime-schemas";
import { loadClaudeTodoConfig, runTaskHook } from "./hooks.js";
import { formatTaskForPrompt, getVerificationNudge, shouldAddVerificationNudge } from "./prompts.js";
import { emitRecentCollabEvent } from "./recent-collab-bridge.js";
import { getSubagentRuntimeManager } from "./subagent-runtime-integration.js";
import { emitTaskAssignmentNotification } from "./task-assignment-bridge.js";
import {
  blockTask,
  deleteTask,
  filterExternalTasks,
  getAllDoneState,
  getTask,
  updateTask,
} from "./tasks.js";
import type { Task, TaskUpdateDetails, TaskUpdateParams } from "./types.js";

type ClaudeTodoRuntimeContext = {
  modelRegistry: ModelRegistry;
  currentModel: Model<any> | undefined;
};

function pushUpdatedField(updatedFields: string[], field: string): void {
  if (!updatedFields.includes(field)) {
    updatedFields.push(field);
  }
}

function mergeTaskMetadata(task: Task, metadata: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...(task.metadata ?? {}) };
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function toManagedTeammateRecord(teamName: string, member: {
  name: string;
  agentType: string;
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  color?: string;
  status?: NamedAgentRecord["status"];
  lastResultText?: string;
  lastError?: string;
  autoClaimTasks?: boolean;
}): NamedAgentRecord | undefined {
  if (!member.sessionFile) return undefined;
  return {
    name: member.name,
    agentType: member.agentType,
    cwd: member.cwd,
    sessionFile: member.sessionFile,
    kind: "teammate",
    teamName,
    ...(typeof member.autoClaimTasks === "boolean" ? { autoClaimTasks: member.autoClaimTasks } : {}),
    ...(member.model ? { model: member.model } : {}),
    ...(member.sessionId ? { sessionId: member.sessionId } : {}),
    ...(member.color ? { color: member.color } : {}),
    status: member.status ?? "idle",
    ...(member.lastResultText ? { lastResultText: member.lastResultText } : {}),
    ...(member.lastError ? { lastError: member.lastError } : {}),
    background: false,
  };
}

function buildAssignmentPrompt(taskListId: string, task: Task, assignedBy: string): string {
  const openBlockers = task.blockedBy.map((id) => `#${id}`);
  const parts = [
    `Task #${task.id} in shared task list ${taskListId} is assigned to you by ${assignedBy}.`,
    formatTaskForPrompt(task),
    "Use TaskGet if you need the latest full details. If you begin now, ensure the task is in_progress. When you finish, mark it completed immediately.",
  ];

  if (openBlockers.length > 0) {
    parts.splice(
      2,
      0,
      `Current blockers: ${openBlockers.join(", ")}. If the task is still blocked, coordinate through the task list instead of silently waiting.`,
    );
  }

  return parts.join("\n\n");
}

async function maybeWakeAssignedTeammate(options: {
  cwd: string;
  taskListId: string;
  task: Task;
  previousOwner?: string;
  actingAgentName?: string;
  runtimeContext?: ClaudeTodoRuntimeContext;
  buildCustomTools?: (actingAgentName: string) => ToolDefinition[];
}): Promise<void> {
  const { cwd, taskListId, task, previousOwner, actingAgentName, runtimeContext, buildCustomTools } = options;
  if (!runtimeContext || !task.owner || task.owner === previousOwner || task.owner === actingAgentName) {
    return;
  }
  if (task.status === "completed") {
    return;
  }

  const runtimeManager = getSubagentRuntimeManager();
  if (!runtimeManager) {
    return;
  }

  const team = await loadTeamRecord(cwd, taskListId);
  if (!team) {
    return;
  }

  const member = team.members[task.owner];
  if (!member) {
    return;
  }

  const discovery = discoverAgents(cwd, "both");
  const agent = discovery.agents.find((candidate) => candidate.name === member.agentType);
  if (!agent) {
    return;
  }

  try {
    await runtimeManager.sendMessage({
      kind: "teammate",
      teamName: team.name,
      color: member.color,
      name: member.name,
      agent,
      message: buildAssignmentPrompt(taskListId, task, actingAgentName ?? "team-lead"),
      summary: `Task #${task.id} assigned`,
      defaultCwd: cwd,
      requestedCwd: member.cwd,
      modelRegistry: runtimeContext.modelRegistry,
      currentModel: runtimeContext.currentModel,
      modelOverride: member.model,
      persisted: toManagedTeammateRecord(team.name, member),
      customTools: buildCustomTools?.(member.name),
    });
  } catch {
    // Assignment should not fail just because the wake-up path could not resume a teammate.
  }
}

export async function executeTaskUpdateOperation(options: {
  cwd: string;
  taskListId: string;
  params: TaskUpdateParams;
  signal?: AbortSignal;
  actingAgentName?: string;
  runtimeContext?: ClaudeTodoRuntimeContext;
  buildCustomTools?: (actingAgentName: string) => ToolDefinition[];
}): Promise<TaskUpdateDetails> {
  const { cwd, taskListId, params, signal, actingAgentName, runtimeContext, buildCustomTools } = options;
  const existingTask = await getTask(cwd, taskListId, params.taskId);
  if (!existingTask) {
    return {
      success: false,
      taskId: params.taskId,
      taskListId,
      updatedFields: [],
      error: "Task not found",
    };
  }

  const updates: Partial<Omit<Task, "id">> = {};
  const updatedFields: string[] = [];

  if (params.subject !== undefined && params.subject !== existingTask.subject) {
    updates.subject = params.subject;
    pushUpdatedField(updatedFields, "subject");
  }
  if (params.description !== undefined && params.description !== existingTask.description) {
    updates.description = params.description;
    pushUpdatedField(updatedFields, "description");
  }
  if (params.activeForm !== undefined && params.activeForm !== existingTask.activeForm) {
    updates.activeForm = params.activeForm;
    pushUpdatedField(updatedFields, "activeForm");
  }
  if (params.owner !== undefined && params.owner !== existingTask.owner) {
    updates.owner = params.owner;
    pushUpdatedField(updatedFields, "owner");
  }
  if (
    params.status === "in_progress" &&
    params.owner === undefined &&
    !existingTask.owner &&
    actingAgentName
  ) {
    updates.owner = actingAgentName;
    pushUpdatedField(updatedFields, "owner");
  }
  if (params.metadata !== undefined) {
    updates.metadata = mergeTaskMetadata(existingTask, params.metadata);
    pushUpdatedField(updatedFields, "metadata");
  }

  if (params.status === "deleted") {
    const success = await deleteTask(cwd, taskListId, params.taskId);
    return {
      success,
      taskId: params.taskId,
      taskListId,
      updatedFields: success ? ["deleted"] : [],
      ...(success
        ? { statusChange: { from: existingTask.status, to: "deleted" } }
        : { error: "Failed to delete task" }),
    };
  }

  if (params.status !== undefined && params.status !== existingTask.status) {
    if (params.status === "completed") {
      const config = await loadClaudeTodoConfig(cwd);
      const hookResult = await runTaskHook(
        cwd,
        config.hooks?.taskCompleted,
        {
          hook_event_name: "TaskCompleted",
          task_id: existingTask.id,
          task_subject: existingTask.subject,
          task_description: existingTask.description,
          task_list_id: taskListId,
          teammate_name: actingAgentName,
          team_name: taskListId,
        },
        signal,
      );
      if (hookResult.blocked) {
        return {
          success: false,
          taskId: params.taskId,
          taskListId,
          updatedFields: [],
          error: `TaskCompleted hook feedback:\n${hookResult.message}`,
        };
      }
    }
    updates.status = params.status;
    pushUpdatedField(updatedFields, "status");
  }

  if (Object.keys(updates).length > 0) {
    await updateTask(cwd, taskListId, params.taskId, updates);
  }

  if (params.addBlocks && params.addBlocks.length > 0) {
    const newBlocks = params.addBlocks.filter((id) => !existingTask.blocks.includes(id));
    for (const blockedId of newBlocks) {
      await blockTask(cwd, taskListId, params.taskId, blockedId);
    }
    if (newBlocks.length > 0) {
      pushUpdatedField(updatedFields, "blocks");
    }
  }

  if (params.addBlockedBy && params.addBlockedBy.length > 0) {
    const newBlockedBy = params.addBlockedBy.filter((id) => !existingTask.blockedBy.includes(id));
    for (const blockerId of newBlockedBy) {
      await blockTask(cwd, taskListId, blockerId, params.taskId);
    }
    if (newBlockedBy.length > 0) {
      pushUpdatedField(updatedFields, "blockedBy");
    }
  }

  const latestTask = await getTask(cwd, taskListId, params.taskId);
  if (latestTask) {
    if (
      latestTask.owner &&
      latestTask.owner !== existingTask.owner &&
      latestTask.owner !== actingAgentName
    ) {
      emitRecentCollabEvent({
        type: "assignment",
        taskListId,
        timestamp: new Date().toISOString(),
        text: `#${latestTask.id} assigned to @${latestTask.owner} by ${actingAgentName ?? "team-lead"}`,
        teammateName: latestTask.owner,
        taskId: latestTask.id,
        assignedBy: actingAgentName ?? "team-lead",
      });
      emitTaskAssignmentNotification({
        taskId: latestTask.id,
        taskListId,
        subject: latestTask.subject,
        description: latestTask.description,
        owner: latestTask.owner,
        assignedBy: actingAgentName ?? "team-lead",
        timestamp: new Date().toISOString(),
      });
    }

    await maybeWakeAssignedTeammate({
      cwd,
      taskListId,
      task: latestTask,
      previousOwner: existingTask.owner,
      actingAgentName,
      runtimeContext,
      buildCustomTools,
    });
  }

  const { tasks } = await getAllDoneState(cwd, taskListId);
  if (updates.status === "completed") {
    emitRecentCollabEvent({
      type: "completion",
      taskListId,
      timestamp: new Date().toISOString(),
      text: `#${existingTask.id} completed${actingAgentName ? ` by @${actingAgentName}` : ""}`,
      ...(actingAgentName ? { teammateName: actingAgentName } : {}),
      taskId: existingTask.id,
      ...(actingAgentName ? { status: "completed" } : {}),
    });
  }

  return {
    success: true,
    taskId: params.taskId,
    taskListId,
    updatedFields,
    ...(updates.status !== undefined
      ? { statusChange: { from: existingTask.status, to: updates.status } }
      : {}),
    ...(actingAgentName && updates.status === "completed"
      ? { taskListFollowUpNeeded: true }
      : {}),
    verificationNudgeNeeded:
      params.status === "completed" && shouldAddVerificationNudge(filterExternalTasks(tasks)),
  };
}

export function buildTaskUpdateResultText(details: TaskUpdateDetails): string {
  if (!details.success) {
    return details.error ?? "Task operation failed";
  }

  let content = details.updatedFields.length > 0
    ? `Updated task #${details.taskId} ${details.updatedFields.join(", ")}`
    : `Updated task #${details.taskId}.`;

  if (details.taskListFollowUpNeeded) {
    content += "\n\nTask completed. Call TaskList now to find your next available task or see if your work unblocked others.";
  }
  if (details.verificationNudgeNeeded) {
    content += `\n\n${getVerificationNudge()}`;
  }
  return content;
}
