import type { Model } from "@mariozechner/pi-ai";
import { defineTool, type ModelRegistry, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  TODO_WRITE_DESCRIPTION,
  TASK_CREATE_DESCRIPTION,
  TASK_GET_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_STOP_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
} from "./prompts.js";
import { buildTodoWriteResultText, executeTodoWriteOperation } from "./todo-write-shared.js";
import {
  createTask,
  filterExternalTasks,
  getTask,
  listTasks,
} from "./tasks.js";
import {
  buildTaskStopResultText,
  executeTaskStopOperation,
} from "./task-stop-shared.js";
import {
  buildTaskUpdateResultText,
  executeTaskUpdateOperation,
} from "./task-update-shared.js";
import {
  TODO_WRITE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  type TodoWriteParams,
  TodoWriteParamsSchema,
  type TaskCreateParams,
  TaskCreateParamsSchema,
  type TaskGetParams,
  TaskGetParamsSchema,
  type TaskListParams,
  TaskListParamsSchema,
  type TaskStopParams,
  TaskStopParamsSchema,
  type TaskUpdateParams,
  TaskUpdateParamsSchema,
} from "./types.js";

type ClaudeTodoCustomToolOptions = {
  actingAgentName?: string;
  runtimeContext?: {
    modelRegistry: ModelRegistry;
    currentModel: Model<any> | undefined;
  };
};

export function buildClaudeTodoCustomTools(
  cwd: string,
  taskListId: string,
  options: ClaudeTodoCustomToolOptions = {},
): ToolDefinition[] {
  return [
    defineTool({
      name: TODO_WRITE_TOOL_NAME,
      label: TODO_WRITE_TOOL_NAME,
      description: TODO_WRITE_DESCRIPTION,
      parameters: TodoWriteParamsSchema,
      async execute(_toolCallId, params: TodoWriteParams) {
        const details = await executeTodoWriteOperation({
          cwd,
          taskListId,
          todos: params.todos,
        });
        return {
          content: [{ type: "text", text: buildTodoWriteResultText(details) }],
          details,
        };
      },
    }),
    defineTool({
      name: TASK_CREATE_TOOL_NAME,
      label: TASK_CREATE_TOOL_NAME,
      description: TASK_CREATE_DESCRIPTION,
      parameters: TaskCreateParamsSchema,
      async execute(_toolCallId, params: TaskCreateParams) {
        const taskId = await createTask(cwd, taskListId, {
          subject: params.subject,
          description: params.description,
          activeForm: params.activeForm,
          status: "pending",
          blocks: [],
          blockedBy: [],
          ...(params.metadata ? { metadata: params.metadata } : {}),
        });
        return {
          content: [{ type: "text", text: `Task #${taskId} created successfully: ${params.subject}` }],
          details: { taskId, taskListId },
        };
      },
    }),
    defineTool({
      name: TASK_GET_TOOL_NAME,
      label: TASK_GET_TOOL_NAME,
      description: TASK_GET_DESCRIPTION,
      parameters: TaskGetParamsSchema,
      async execute(_toolCallId, params: TaskGetParams) {
        const task = await getTask(cwd, taskListId, params.taskId);
        return {
          content: [{ type: "text", text: task ? JSON.stringify(task, null, 2) : `Task #${params.taskId} not found.` }],
          details: { taskListId, taskId: params.taskId },
          ...(task ? {} : { isError: true }),
        };
      },
    }),
    defineTool({
      name: TASK_LIST_TOOL_NAME,
      label: TASK_LIST_TOOL_NAME,
      description: TASK_LIST_DESCRIPTION,
      parameters: TaskListParamsSchema,
      async execute(_toolCallId, _params: TaskListParams) {
        const tasks = filterExternalTasks(await listTasks(cwd, taskListId));
        const text = tasks.length === 0
          ? `Task list ${taskListId}\n\nNo tasks found.`
          : `Task list ${taskListId}\n\n${tasks.map((task) => `#${task.id} [${task.status}] ${task.subject}${task.owner ? ` (${task.owner})` : ""}`).join("\n")}`;
        return {
          content: [{ type: "text", text }],
          details: { taskListId, count: tasks.length },
        };
      },
    }),
    defineTool({
      name: TASK_STOP_TOOL_NAME,
      label: TASK_STOP_TOOL_NAME,
      description: TASK_STOP_DESCRIPTION,
      parameters: TaskStopParamsSchema,
      async execute(_toolCallId, params: TaskStopParams) {
        const details = await executeTaskStopOperation({
          cwd,
          taskListId,
          taskId: params.taskId,
          actingAgentName: options.actingAgentName,
        });
        return {
          content: [{ type: "text", text: buildTaskStopResultText(details) }],
          details,
          ...(details.success ? {} : { isError: true }),
        };
      },
    }),
    defineTool({
      name: TASK_UPDATE_TOOL_NAME,
      label: TASK_UPDATE_TOOL_NAME,
      description: TASK_UPDATE_DESCRIPTION,
      parameters: TaskUpdateParamsSchema,
      async execute(_toolCallId, params: TaskUpdateParams) {
        const details = await executeTaskUpdateOperation({
          cwd,
          taskListId,
          params,
          actingAgentName: options.actingAgentName,
          runtimeContext: options.runtimeContext,
          buildCustomTools: options.runtimeContext
            ? (actingAgentName) => buildClaudeTodoCustomTools(cwd, taskListId, {
              actingAgentName,
              runtimeContext: options.runtimeContext,
            })
            : undefined,
        });
        return {
          content: [{ type: "text", text: buildTaskUpdateResultText(details) }],
          details,
          ...(details.success ? {} : { isError: true }),
        };
      },
    }),
  ];
}
