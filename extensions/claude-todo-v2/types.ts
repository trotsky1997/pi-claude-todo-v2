import { Type, type Static } from "@sinclair/typebox";

export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_GET_TOOL_NAME = "TaskGet";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";
export const TASK_STOP_TOOL_NAME = "TaskStop";

export const STATE_ENTRY = "claude-todo-v2-state";
export const TASK_CONTEXT_CUSTOM_TYPE = "claude-todo-v2-context";

export const TASK_STATUS_VALUES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export const TASK_STATUS_SCHEMA = Type.Union(
  TASK_STATUS_VALUES.map((status) => Type.Literal(status)),
);
export const TASK_UPDATE_STATUS_SCHEMA = Type.Union([
  TASK_STATUS_SCHEMA,
  Type.Literal("deleted"),
]);

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskSummary {
  id: string;
  subject: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];
}

export interface ClaimTaskOptions {
  checkAgentBusy?: boolean;
}

export interface ClaimTaskResult {
  success: boolean;
  reason?:
    | "task_not_found"
    | "already_claimed"
    | "already_resolved"
    | "blocked"
    | "agent_busy";
  task?: Task;
  busyWithTasks?: string[];
  blockedByTasks?: string[];
}

export const TaskStopParamsSchema = Type.Object({
  taskId: Type.String({ description: "The ID of the running task to stop" }),
});
export type TaskStopParams = Static<typeof TaskStopParamsSchema>;

export interface WorkerSnapshot {
  name: string;
  status: "idle" | "running" | "stopping" | "stopped" | "error";
  currentTaskId?: string;
  currentTaskSubject?: string;
  message?: string;
  pid?: number;
  lastExitCode?: number;
}

export interface TeammateSnapshot {
  name: string;
  agentType: string;
  status: "idle" | "running" | "completed" | "failed" | "interrupted";
  color?: string;
  autoClaimTasks?: boolean;
  lastDescription?: string;
  lastResultText?: string;
  lastError?: string;
}

export interface ManagedTaskSnapshot {
  taskId: string;
  runtimeName: string;
  runtimeKind: "subagent" | "teammate";
  status: "idle" | "running" | "completed" | "failed" | "interrupted";
  agentType: string;
  teamName?: string;
  description?: string;
  resultText?: string;
  error?: string;
  background: boolean;
}

export interface PersistedState {
  panelEnabled: boolean;
  taskListIdOverride?: string;
  lastReminderAssistantTurn?: number;
  lastActivationKey?: string;
}

export interface HookCommandConfig {
  command: string;
  args?: string[];
}

export interface ClaudeTodoConfig {
  taskListId?: string;
  reminders?: {
    turnsSinceWrite?: number;
    turnsBetweenReminders?: number;
  };
  panel?: {
    placement?: "aboveEditor" | "belowEditor";
    maxItems?: number;
  };
  hooks?: {
    taskCreated?: HookCommandConfig;
    taskCompleted?: HookCommandConfig;
    teammateIdle?: HookCommandConfig;
  };
  workers?: {
    model?: string;
    agentType?: string;
    tools?: string[];
    pollMs?: number;
  };
}

export interface HookResult {
  blocked: boolean;
  message?: string;
  warning?: string;
}

export const TaskCreateParamsSchema = Type.Object({
  subject: Type.String({ description: "A brief title for the task" }),
  description: Type.String({ description: "What needs to be done" }),
  activeForm: Type.Optional(
    Type.String({
      description:
        "Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")",
    }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arbitrary metadata to attach to the task",
    }),
  ),
});
export type TaskCreateParams = Static<typeof TaskCreateParamsSchema>;

export const TaskGetParamsSchema = Type.Object({
  taskId: Type.String({ description: "The ID of the task to retrieve" }),
});
export type TaskGetParams = Static<typeof TaskGetParamsSchema>;

export const TaskListParamsSchema = Type.Object({});
export type TaskListParams = Static<typeof TaskListParamsSchema>;

export const TaskUpdateParamsSchema = Type.Object({
  taskId: Type.String({ description: "The ID of the task to update" }),
  subject: Type.Optional(Type.String({ description: "New subject for the task" })),
  description: Type.Optional(Type.String({ description: "New description for the task" })),
  activeForm: Type.Optional(
    Type.String({
      description:
        "Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")",
    }),
  ),
  status: Type.Optional(
    Type.Union([
      TASK_STATUS_SCHEMA,
      Type.Literal("deleted"),
    ], { description: "New status for the task" }),
  ),
  addBlocks: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs that this task blocks" }),
  ),
  addBlockedBy: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs that block this task" }),
  ),
  owner: Type.Optional(Type.String({ description: "New owner for the task" })),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Metadata keys to merge into the task. Set a key to null to delete it.",
    }),
  ),
});
export type TaskUpdateParams = Static<typeof TaskUpdateParamsSchema>;

export interface TaskCreateDetails {
  success: boolean;
  taskListId: string;
  task?: { id: string; subject: string };
  error?: string;
}

export interface TaskGetDetails {
  taskListId: string;
  task: Pick<Task, "id" | "subject" | "description" | "status" | "blocks" | "blockedBy"> | null;
}

export interface TaskListDetails {
  taskListId: string;
  tasks: TaskSummary[];
}

export interface TaskStopDetails {
  success: boolean;
  taskId: string;
  taskListId: string;
  owner?: string;
  error?: string;
  runtimeStopRequested?: boolean;
}

export interface TaskUpdateDetails {
  success: boolean;
  taskId: string;
  taskListId: string;
  updatedFields: string[];
  error?: string;
  statusChange?: {
    from: string;
    to: string;
  };
  taskListFollowUpNeeded?: boolean;
  verificationNudgeNeeded?: boolean;
}

export interface TaskAssignmentNotification {
  taskId: string;
  taskListId: string;
  subject: string;
  description: string;
  owner: string;
  assignedBy: string;
  timestamp: string;
}

export interface RecentCollabEvent {
  type: "assignment" | "completion" | "stop" | "teammate_update";
  taskListId: string;
  timestamp: string;
  text: string;
  teammateName?: string;
  taskId?: string;
  assignedBy?: string;
  status?: string;
}
