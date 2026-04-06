import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  getTaskContextMessage,
  getTaskCreatePromptGuidelines,
  getTaskCreatePromptSnippet,
  getTaskGetPromptGuidelines,
  getTaskGetPromptSnippet,
  getTaskListPromptGuidelines,
  getTaskListPromptSnippet,
  getTaskUpdatePromptGuidelines,
  getTaskUpdatePromptSnippet,
  getVerificationNudge,
  shouldAddVerificationNudge,
  TURNS_BETWEEN_REMINDERS_DEFAULT,
  TURNS_SINCE_WRITE_DEFAULT,
  TASK_CREATE_DESCRIPTION,
  TASK_GET_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
} from "./prompts.js";
import { loadClaudeTodoConfig, runTaskHook } from "./hooks.js";
import {
  buildTaskSummary,
  blockTask,
  createTask,
  deleteTask,
  filterExternalTasks,
  getAllDoneState,
  getTask,
  listTasks,
  resetTaskList,
  updateTask,
} from "./tasks.js";
import {
  ensureTaskListDir,
  getTaskListDir,
  sanitizePathComponent,
} from "./storage.js";
import {
  buildStatusText,
  buildTaskWidgetLines,
  syncCompletionTimestamps,
} from "./ui.js";
import {
  STATE_ENTRY,
  TASK_CONTEXT_CUSTOM_TYPE,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  type PersistedState,
  type Task,
  type TaskCreateDetails,
  type TaskCreateParams,
  TaskCreateParamsSchema,
  type TaskGetDetails,
  type TaskGetParams,
  TaskGetParamsSchema,
  type TaskListDetails,
  type TaskListParams,
  TaskListParamsSchema,
  type TaskSummary,
  type TaskUpdateDetails,
  type TaskUpdateParams,
  TaskUpdateParamsSchema,
  type WorkerSnapshot,
} from "./types.js";
import { WorkerManager, getCurrentExtensionEntryPath } from "./workers.js";

const STATUS_KEY = "claude-todo-v2-status";
const WIDGET_KEY = "claude-todo-v2-widget";
const COMMAND_NAME = "claude-tasks";
const DEFAULT_STATE: PersistedState = {
  panelEnabled: true,
  lastReminderAssistantTurn: undefined,
};
const HIDE_DELAY_MS = 5000;
const FALLBACK_POLL_MS = 5000;
const TOOL_NAMES = [
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
] as const;

type MessageEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  message?: {
    role: string;
    toolName?: string;
  };
};

function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<PersistedState>;
  return typeof input.panelEnabled === "boolean";
}

function normalizeTaskListId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? sanitizePathComponent(trimmed) : undefined;
}

function formatTaskListText(taskListId: string, tasks: TaskSummary[]): string {
  if (tasks.length === 0) return `Task list ${taskListId}\n\nNo tasks found.`;
  const lines = tasks.map((task) => {
    const owner = task.owner ? ` (${task.owner})` : "";
    const blocked = task.blockedBy.length > 0 ? ` [blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}]` : "";
    return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
  });
  return `Task list ${taskListId}\n\n${lines.join("\n")}`;
}

function buildTaskResultText(details: TaskCreateDetails | TaskUpdateDetails): string {
  if (!details.success) {
    return details.error ?? "Task operation failed";
  }
  if ("task" in details && details.task) {
    return `Task #${details.task.id} created successfully: ${details.task.subject}`;
  }
  const update = details as TaskUpdateDetails;
  let content = `Updated task #${update.taskId} ${update.updatedFields.join(", ")}`;
  if (update.verificationNudgeNeeded) {
    content += `\n\n${getVerificationNudge()}`;
  }
  return content;
}

export default function claudeTodoV2(pi: ExtensionAPI): void {
  let state: PersistedState = { ...DEFAULT_STATE };
  let lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;
  let completionTimestamps = new Map<string, number>();
  let watcher: FSWatcher | null = null;
  let watchedTaskListId: string | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let currentSessionId = "tasklist";
  let cachedConfigTaskListId: string | undefined;

  const workerManager = new WorkerManager({
    cwd: process.cwd(),
    extensionEntryPath: getCurrentExtensionEntryPath(),
    getTaskListId: () => getResolvedTaskListId(),
    getConfig: async () => loadClaudeTodoConfig(process.cwd()),
    onChange: () => scheduleRefresh(),
  });

  function persistState(): void {
    pi.appendEntry<PersistedState>(STATE_ENTRY, state);
  }

  function applyWorkerToolSelection(): void {
    const rawTools = process.env.PI_CLAUDE_TODO_V2_WORKER_TOOLS;
    if (!rawTools) return;

    let parsedTools: unknown = [];
    try {
      parsedTools = JSON.parse(rawTools);
    } catch {
      parsedTools = [];
    }

    const configuredTools = Array.isArray(parsedTools)
      ? parsedTools.filter((tool): tool is string => typeof tool === "string")
      : [];

    const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
    const activeTools = [...new Set([...configuredTools, ...TOOL_NAMES])].filter((tool) =>
      availableTools.has(tool),
    );

    if (activeTools.length > 0) {
      pi.setActiveTools(activeTools);
    }
  }

  async function restoreState(ctx: ExtensionContext): Promise<void> {
    state = { ...DEFAULT_STATE };
    currentSessionId = sanitizePathComponent(ctx.sessionManager.getSessionId());
    for (const entry of ctx.sessionManager.getBranch()) {
      const customEntry = entry as MessageEntry;
      if (customEntry.type === "custom" && customEntry.customType === STATE_ENTRY && isPersistedState(customEntry.data)) {
        state = { ...DEFAULT_STATE, ...customEntry.data };
      }
    }
    const config = await getConfig();
    cachedConfigTaskListId = normalizeTaskListId(config.taskListId);
  }

  async function getConfig() {
    const config = await loadClaudeTodoConfig(process.cwd());
    cachedConfigTaskListId = normalizeTaskListId(config.taskListId);
    return config;
  }

  function getResolvedTaskListId(ctx?: { sessionManager: { getSessionId(): string } }): string {
    const flagValue = normalizeTaskListId(pi.getFlag("claude-todo-v2-task-list") as string | undefined);
    if (flagValue) return flagValue;

    const envValue = normalizeTaskListId(process.env.PI_CLAUDE_TODO_V2_TASK_LIST_ID ?? process.env.CLAUDE_CODE_TASK_LIST_ID);
    if (envValue) return envValue;

    const override = normalizeTaskListId(state.taskListIdOverride);
    if (override) return override;

    const configTaskListId = normalizeTaskListId(
      (pi.getFlag("claude-todo-v2-config-task-list") as string | undefined) ?? cachedConfigTaskListId,
    );
    if (configTaskListId) return configTaskListId;

    if (ctx) {
      return sanitizePathComponent(ctx.sessionManager.getSessionId());
    }

    return currentSessionId;
  }

  async function setTaskListOverride(taskListId: string | undefined): Promise<void> {
    state.taskListIdOverride = normalizeTaskListId(taskListId);
    persistState();
    scheduleRefresh();
  }

  function clearUi(ctx: ExtensionContext | ExtensionCommandContext): void {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function scheduleRefresh(delay = 50): void {
    if (!lastUiContext || !lastUiContext.hasUI) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void refreshUi(lastUiContext!);
    }, delay);
  }

  function clearHideTimer(): void {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide(taskListId: string): void {
    if (hideTimer) return;
    hideTimer = setTimeout(() => {
      void handleHideTimer(taskListId);
    }, HIDE_DELAY_MS);
  }

  async function handleHideTimer(taskListId: string): Promise<void> {
    hideTimer = null;
    const currentTaskListId = getResolvedTaskListId();
    if (currentTaskListId !== taskListId) return;
    const { allDone } = await getAllDoneState(process.cwd(), taskListId);
    if (!allDone) return;
    await resetTaskList(process.cwd(), taskListId);
    completionTimestamps = new Map<string, number>();
    scheduleRefresh();
  }

  async function ensureWatcher(taskListId: string): Promise<void> {
    if (watchedTaskListId === taskListId && watcher) return;
    watcher?.close();
    watcher = null;
    watchedTaskListId = taskListId;
    await ensureTaskListDir(process.cwd(), taskListId);
    try {
      watcher = watch(getTaskListDir(process.cwd(), taskListId), () => scheduleRefresh());
      watcher.unref();
    } catch {
      watcher = null;
    }
  }

  async function refreshUi(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) return;
    lastUiContext = ctx;

    const taskListId = getResolvedTaskListId(ctx);
    await ensureWatcher(taskListId);

    const config = await getConfig();
    const tasks = filterExternalTasks(await listTasks(process.cwd(), taskListId));
    syncCompletionTimestamps(tasks, completionTimestamps);

    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    const hasIncomplete = tasks.some((task) => task.status !== "completed");
    if (hasIncomplete || workerManager.list().some((worker) => worker.status === "running")) {
      pollTimer = setTimeout(() => scheduleRefresh(), FALLBACK_POLL_MS);
      pollTimer.unref?.();
    }

    if (tasks.length === 0) {
      clearHideTimer();
    } else if (hasIncomplete) {
      clearHideTimer();
    } else {
      scheduleHide(taskListId);
    }

    const workers = workerManager.list();
    if (!state.panelEnabled || (tasks.length === 0 && workers.length === 0)) {
      clearUi(ctx);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, buildStatusText(ctx.ui.theme, taskListId, tasks, workers));
    ctx.ui.setWidget(
      WIDGET_KEY,
      buildTaskWidgetLines(ctx.ui.theme, taskListId, tasks, workers, completionTimestamps, {
        maxItems: config.panel?.maxItems,
      }),
      { placement: config.panel?.placement ?? "aboveEditor" },
    );
  }

  async function formatCurrentTaskList(taskListId: string): Promise<string> {
    const tasks = filterExternalTasks(await listTasks(process.cwd(), taskListId));
    const resolvedIds = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
    return formatTaskListText(taskListId, tasks.map((task) => buildTaskSummary(task, resolvedIds)));
  }

  function getTurnsSinceLastTaskManagement(ctx: ExtensionContext): number {
    let assistantTurns = 0;
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as MessageEntry;
      if (entry.type !== "message" || !entry.message) continue;
      if (entry.message.role === "toolResult") {
        if (
          entry.message.toolName === TASK_CREATE_TOOL_NAME ||
          entry.message.toolName === TASK_UPDATE_TOOL_NAME
        ) {
          break;
        }
      }
      if (entry.message.role === "assistant") {
        assistantTurns += 1;
      }
    }
    return assistantTurns;
  }

  function getAssistantTurnCount(ctx: ExtensionContext): number {
    return ctx
      .sessionManager
      .getBranch()
      .filter((entry) => {
        const messageEntry = entry as MessageEntry;
        return messageEntry.type === "message" && messageEntry.message?.role === "assistant";
      })
      .length;
  }

  function shouldSendReminder(
    turnsSinceLastTaskManagement: number,
    assistantTurnCount: number,
    config: Awaited<ReturnType<typeof getConfig>>,
  ): boolean {
    const sinceWrite = config.reminders?.turnsSinceWrite ?? TURNS_SINCE_WRITE_DEFAULT;
    const between = config.reminders?.turnsBetweenReminders ?? TURNS_BETWEEN_REMINDERS_DEFAULT;
    if (turnsSinceLastTaskManagement < sinceWrite) return false;
    if (state.lastReminderAssistantTurn === undefined) return true;
    return assistantTurnCount - state.lastReminderAssistantTurn >= between;
  }

  function renderToolCall(toolName: string, args: Record<string, unknown>, theme: Theme): Text {
    let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
    if (toolName === TASK_LIST_TOOL_NAME) {
      text += theme.fg("muted", "list tasks");
    } else if (toolName === TASK_GET_TOOL_NAME) {
      text += theme.fg("accent", `#${String(args.taskId ?? "?")}`);
    } else if (toolName === TASK_CREATE_TOOL_NAME) {
      text += theme.fg("muted", String(args.subject ?? "create task"));
    } else if (toolName === TASK_UPDATE_TOOL_NAME) {
      text += theme.fg("accent", `#${String(args.taskId ?? "?")}`);
      if (typeof args.status === "string") {
        text += theme.fg("muted", ` ${args.status}`);
      }
    }
    return new Text(text, 0, 0);
  }

  function registerTools(): void {
    pi.registerTool({
      name: TASK_CREATE_TOOL_NAME,
      label: TASK_CREATE_TOOL_NAME,
      description: TASK_CREATE_DESCRIPTION,
      promptSnippet: getTaskCreatePromptSnippet(),
      promptGuidelines: getTaskCreatePromptGuidelines(),
      parameters: TaskCreateParamsSchema,
      async execute(_toolCallId: string, params: TaskCreateParams, _signal, _onUpdate, ctx: ExtensionContext) {
        const taskListId = getResolvedTaskListId(ctx);
        const taskId = await createTask(process.cwd(), taskListId, {
          subject: params.subject,
          description: params.description,
          activeForm: params.activeForm,
          status: "pending",
          owner: undefined,
          blocks: [],
          blockedBy: [],
          metadata: params.metadata,
        });

        const config = await getConfig();
        const hookResult = await runTaskHook(
          process.cwd(),
          config.hooks?.taskCreated,
          {
            hook_event_name: "TaskCreated",
            task_id: taskId,
            task_subject: params.subject,
            task_description: params.description,
            task_list_id: taskListId,
          },
          ctx.signal,
        );

        const details: TaskCreateDetails = {
          success: !hookResult.blocked,
          taskListId,
          task: { id: taskId, subject: params.subject },
          ...(hookResult.blocked ? { error: `TaskCreated hook feedback:\n${hookResult.message}` } : {}),
        };

        if (hookResult.blocked) {
          await deleteTask(process.cwd(), taskListId, taskId);
        }

        await refreshUi(ctx);
        return {
          content: [{ type: "text", text: buildTaskResultText(details) }],
          details,
        };
      },
      renderCall(args, theme) {
        return renderToolCall(TASK_CREATE_TOOL_NAME, args as Record<string, unknown>, theme);
      },
      renderResult(result, _options, theme) {
        const details = result.details as TaskCreateDetails | undefined;
        const text = details
          ? buildTaskResultText(details)
          : (result.content[0]?.type === "text" ? result.content[0].text : "");
        return new Text(details?.success === false ? theme.fg("error", text) : text, 0, 0);
      },
    });

    pi.registerTool({
      name: TASK_GET_TOOL_NAME,
      label: TASK_GET_TOOL_NAME,
      description: TASK_GET_DESCRIPTION,
      promptSnippet: getTaskGetPromptSnippet(),
      promptGuidelines: getTaskGetPromptGuidelines(),
      parameters: TaskGetParamsSchema,
      async execute(_toolCallId: string, params: TaskGetParams, _signal, _onUpdate, ctx: ExtensionContext) {
        const taskListId = getResolvedTaskListId(ctx);
        const task = await getTask(process.cwd(), taskListId, params.taskId);
        const details: TaskGetDetails = {
          taskListId,
          task: task
            ? {
                id: task.id,
                subject: task.subject,
                description: task.description,
                status: task.status,
                blocks: task.blocks,
                blockedBy: task.blockedBy,
              }
            : null,
        };
        const text = !task
          ? "Task not found"
          : [
              `Task #${task.id}: ${task.subject}`,
              `Status: ${task.status}`,
              `Description: ${task.description}`,
              ...(task.blockedBy.length > 0 ? [`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`] : []),
              ...(task.blocks.length > 0 ? [`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`] : []),
            ].join("\n");
        return {
          content: [{ type: "text", text }],
          details,
        };
      },
      renderCall(args, theme) {
        return renderToolCall(TASK_GET_TOOL_NAME, args as Record<string, unknown>, theme);
      },
      renderResult(result) {
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      },
    });

    pi.registerTool({
      name: TASK_LIST_TOOL_NAME,
      label: TASK_LIST_TOOL_NAME,
      description: TASK_LIST_DESCRIPTION,
      promptSnippet: getTaskListPromptSnippet(),
      promptGuidelines: getTaskListPromptGuidelines(),
      parameters: TaskListParamsSchema,
      async execute(_toolCallId: string, _params: TaskListParams, _signal, _onUpdate, ctx: ExtensionContext) {
        const taskListId = getResolvedTaskListId(ctx);
        const tasks = filterExternalTasks(await listTasks(process.cwd(), taskListId));
        const resolvedIds = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
        const summaries = tasks.map((task) => buildTaskSummary(task, resolvedIds));
        const details: TaskListDetails = {
          taskListId,
          tasks: summaries,
        };
        return {
          content: [{ type: "text", text: formatTaskListText(taskListId, summaries) }],
          details,
        };
      },
      renderCall(args, theme) {
        return renderToolCall(TASK_LIST_TOOL_NAME, args as Record<string, unknown>, theme);
      },
      renderResult(result, { expanded }, theme) {
        const details = result.details as TaskListDetails | undefined;
        if (!details) {
          return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
        }
        const tasks = expanded ? details.tasks : details.tasks.slice(0, 8);
        let text = theme.fg("muted", `${details.tasks.length} task(s)`);
        for (const task of tasks) {
          const owner = task.owner ? ` (${task.owner})` : "";
          const blocked = task.blockedBy.length > 0 ? ` [blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}]` : "";
          text += `\n#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
        }
        if (!expanded && details.tasks.length > tasks.length) {
          text += `\n${theme.fg("dim", `... ${details.tasks.length - tasks.length} more`)}`;
        }
        return new Text(text, 0, 0);
      },
    });

    pi.registerTool({
      name: TASK_UPDATE_TOOL_NAME,
      label: TASK_UPDATE_TOOL_NAME,
      description: TASK_UPDATE_DESCRIPTION,
      promptSnippet: getTaskUpdatePromptSnippet(),
      promptGuidelines: getTaskUpdatePromptGuidelines(),
      parameters: TaskUpdateParamsSchema,
      async execute(_toolCallId: string, params: TaskUpdateParams, _signal, _onUpdate, ctx: ExtensionContext) {
        const taskListId = getResolvedTaskListId(ctx);
        const existingTask = await getTask(process.cwd(), taskListId, params.taskId);
        if (!existingTask) {
          const details: TaskUpdateDetails = {
            success: false,
            taskId: params.taskId,
            taskListId,
            updatedFields: [],
            error: "Task not found",
          };
          return {
            content: [{ type: "text", text: buildTaskResultText(details) }],
            details,
          };
        }

        const updates: Partial<Omit<Task, "id">> = {};
        const updatedFields: string[] = [];

        if (params.subject !== undefined && params.subject !== existingTask.subject) {
          updates.subject = params.subject;
          updatedFields.push("subject");
        }
        if (params.description !== undefined && params.description !== existingTask.description) {
          updates.description = params.description;
          updatedFields.push("description");
        }
        if (params.activeForm !== undefined && params.activeForm !== existingTask.activeForm) {
          updates.activeForm = params.activeForm;
          updatedFields.push("activeForm");
        }
        if (params.owner !== undefined && params.owner !== existingTask.owner) {
          updates.owner = params.owner;
          updatedFields.push("owner");
        }
        const workerName = process.env.PI_CLAUDE_TODO_V2_WORKER_NAME?.trim();
        if (
          params.status === "in_progress" &&
          params.owner === undefined &&
          !existingTask.owner &&
          workerName
        ) {
          updates.owner = workerName;
          updatedFields.push("owner");
        }
        if (params.metadata !== undefined) {
          const merged = { ...(existingTask.metadata ?? {}) };
          for (const [key, value] of Object.entries(params.metadata)) {
            if (value === null) {
              delete merged[key];
            } else {
              merged[key] = value;
            }
          }
          updates.metadata = merged;
          updatedFields.push("metadata");
        }

        if (params.status === "deleted") {
          const success = await deleteTask(process.cwd(), taskListId, params.taskId);
          const details: TaskUpdateDetails = {
            success,
            taskId: params.taskId,
            taskListId,
            updatedFields: success ? ["deleted"] : [],
            ...(success
              ? { statusChange: { from: existingTask.status, to: "deleted" } }
              : { error: "Failed to delete task" }),
          };
          await refreshUi(ctx);
          return {
            content: [{ type: "text", text: buildTaskResultText(details) }],
            details,
          };
        }

        if (params.status !== undefined && params.status !== existingTask.status) {
          if (params.status === "completed") {
            const config = await getConfig();
            const hookResult = await runTaskHook(
              process.cwd(),
              config.hooks?.taskCompleted,
              {
                hook_event_name: "TaskCompleted",
                task_id: existingTask.id,
                task_subject: existingTask.subject,
                task_description: existingTask.description,
                task_list_id: taskListId,
              },
              ctx.signal,
            );
            if (hookResult.blocked) {
              const details: TaskUpdateDetails = {
                success: false,
                taskId: params.taskId,
                taskListId,
                updatedFields: [],
                error: `TaskCompleted hook feedback:\n${hookResult.message}`,
              };
              return {
                content: [{ type: "text", text: buildTaskResultText(details) }],
                details,
              };
            }
          }
          updates.status = params.status;
          updatedFields.push("status");
        }

        if (Object.keys(updates).length > 0) {
          await updateTask(process.cwd(), taskListId, params.taskId, updates);
        }

        if (params.addBlocks && params.addBlocks.length > 0) {
          const newBlocks = params.addBlocks.filter((id) => !existingTask.blocks.includes(id));
          for (const blockedId of newBlocks) {
            await blockTask(process.cwd(), taskListId, params.taskId, blockedId);
          }
          if (newBlocks.length > 0) {
            updatedFields.push("blocks");
          }
        }

        if (params.addBlockedBy && params.addBlockedBy.length > 0) {
          const newBlockedBy = params.addBlockedBy.filter((id) => !existingTask.blockedBy.includes(id));
          for (const blockerId of newBlockedBy) {
            await blockTask(process.cwd(), taskListId, blockerId, params.taskId);
          }
          if (newBlockedBy.length > 0) {
            updatedFields.push("blockedBy");
          }
        }

        const { tasks } = await getAllDoneState(process.cwd(), taskListId);
        const verificationNudgeNeeded =
          params.status === "completed" && shouldAddVerificationNudge(filterExternalTasks(tasks));

        const details: TaskUpdateDetails = {
          success: true,
          taskId: params.taskId,
          taskListId,
          updatedFields,
          ...(updates.status !== undefined
            ? { statusChange: { from: existingTask.status, to: updates.status } }
            : {}),
          verificationNudgeNeeded,
        };
        await refreshUi(ctx);
        return {
          content: [{ type: "text", text: buildTaskResultText(details) }],
          details,
        };
      },
      renderCall(args, theme) {
        return renderToolCall(TASK_UPDATE_TOOL_NAME, args as Record<string, unknown>, theme);
      },
      renderResult(result, _options, theme) {
        const details = result.details as TaskUpdateDetails | undefined;
        const text = details
          ? buildTaskResultText(details)
          : (result.content[0]?.type === "text" ? result.content[0].text : "");
        return new Text(details?.success === false ? theme.fg("error", text) : text, 0, 0);
      },
    });
  }

  function registerCommands(): void {
    pi.registerCommand(COMMAND_NAME, {
      description: "Inspect, share, clear, and run Claude Todo V2 task lists",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        lastUiContext = ctx;
        const [first = "show", second, third] = args.trim().split(/\s+/).filter(Boolean);
        const taskListId = getResolvedTaskListId(ctx);

        if (first === "use") {
          await setTaskListOverride(second || undefined);
          ctx.ui.notify(
            second ? `Task list override set to ${normalizeTaskListId(second)}` : "Task list override cleared.",
            "info",
          );
          await refreshUi(ctx);
          return;
        }

        if (first === "panel") {
          if (second === "off") {
            state.panelEnabled = false;
          } else if (second === "on") {
            state.panelEnabled = true;
          } else {
            state.panelEnabled = !state.panelEnabled;
          }
          persistState();
          await refreshUi(ctx);
          ctx.ui.notify(`Task panel ${state.panelEnabled ? "enabled" : "disabled"}.`, "info");
          return;
        }

        if (first === "clear") {
          await resetTaskList(process.cwd(), taskListId);
          completionTimestamps = new Map<string, number>();
          await refreshUi(ctx);
          ctx.ui.notify(`Cleared task list ${taskListId}.`, "info");
          return;
        }

        if (first === "current") {
          ctx.ui.notify(`Current task list: ${taskListId}`, "info");
          return;
        }

        if (first === "workers") {
          if (second === "start") {
            const parsedCount = Number.parseInt(third ?? "1", 10);
            await workerManager.start(Number.isNaN(parsedCount) ? 1 : parsedCount);
            await refreshUi(ctx);
            ctx.ui.notify(`Started workers for ${taskListId}.`, "info");
            return;
          }
          if (second === "stop") {
            await workerManager.stopAll();
            await refreshUi(ctx);
            ctx.ui.notify("Stopped all workers.", "info");
            return;
          }
          const text = workerManager.list().length === 0
            ? "No workers running."
            : workerManager
                .list()
                .map((worker) => `${worker.name}: ${worker.status}${worker.currentTaskId ? ` #${worker.currentTaskId}` : ""}${worker.message ? ` - ${worker.message}` : ""}`)
                .join("\n");
          await ctx.ui.editor("Claude Todo V2 workers", text);
          return;
        }

        await ctx.ui.editor(`Claude Todo V2 task list: ${taskListId}`, await formatCurrentTaskList(taskListId));
      },
    });
  }

  pi.registerFlag("claude-todo-v2-task-list", {
    description: "Use a specific Claude Todo V2 task list ID",
    type: "string",
  });
  pi.registerFlag("claude-todo-v2-config-task-list", {
    description: "Internal override used by wrappers/tests to seed a default task list ID",
    type: "string",
  });

  registerTools();
  registerCommands();

  pi.on("context", async (event: any, ctx: ExtensionContext) => {
    const filteredMessages = event.messages.filter(
      (message: { customType?: string }) => message.customType !== TASK_CONTEXT_CUSTOM_TYPE,
    );

    const activeTools = new Set(pi.getActiveTools());
    const hasTaskTools = TOOL_NAMES.some((name) => activeTools.has(name));
    if (!hasTaskTools) {
      return { messages: filteredMessages };
    }

    const taskListId = getResolvedTaskListId(ctx);
    const tasks = filterExternalTasks(await listTasks(process.cwd(), taskListId));
    const turnsSinceLastTaskManagement = getTurnsSinceLastTaskManagement(ctx);
    const assistantTurnCount = getAssistantTurnCount(ctx);
    const config = await getConfig();
    const reminder = shouldSendReminder(turnsSinceLastTaskManagement, assistantTurnCount, config);
    if (reminder && state.lastReminderAssistantTurn !== assistantTurnCount) {
      state.lastReminderAssistantTurn = assistantTurnCount;
      persistState();
    }
    const content = getTaskContextMessage(taskListId, tasks, workerManager.list(), {
      reminder,
      turnsSinceLastTaskManagement,
    });

    filteredMessages.push({
      customType: TASK_CONTEXT_CUSTOM_TYPE,
      content,
      display: false,
    });

    return { messages: filteredMessages };
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    await restoreState(ctx);
    applyWorkerToolSelection();
    lastUiContext = ctx;
    await refreshUi(ctx);
  });

  pi.on("session_switch", async (_event: unknown, ctx: ExtensionContext) => {
    await workerManager.stopAll();
    await restoreState(ctx);
    lastUiContext = ctx;
    await refreshUi(ctx);
  });

  pi.on("session_fork", async (_event: unknown, ctx: ExtensionContext) => {
    await workerManager.stopAll();
    await restoreState(ctx);
    lastUiContext = ctx;
    await refreshUi(ctx);
  });

  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
    await workerManager.stopAll();
    await restoreState(ctx);
    lastUiContext = ctx;
    await refreshUi(ctx);
  });

  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    lastUiContext = ctx;
    await refreshUi(ctx);
    const taskListId = getResolvedTaskListId(ctx);
    const path = getTaskListDir(process.cwd(), taskListId);
    const hasTasks = existsSync(path) && (await readdir(path).catch(() => [])).some((file) => file.endsWith(".json"));
    return {
      message: {
        customType: TASK_CONTEXT_CUSTOM_TYPE,
        content: `Claude Todo V2 is active for task list ${taskListId}. ${hasTasks ? "Existing shared tasks are available." : "No tasks exist yet."}`,
        display: false,
      },
    };
  });

  pi.on("session_shutdown", async () => {
    watcher?.close();
    watcher = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (pollTimer) clearTimeout(pollTimer);
    clearHideTimer();
    await workerManager.dispose();
  });
}
