import { watch, type FSWatcher } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import {
  getTaskCreatePromptGuidelines,
  getTaskCreatePromptSnippet,
  getTaskGetPromptGuidelines,
  getTaskGetPromptSnippet,
  getTaskListPromptGuidelines,
  getTaskListPromptSnippet,
  getTaskReminderMessage,
  getTaskStopPromptGuidelines,
  getTaskStopPromptSnippet,
  getTaskUpdatePromptGuidelines,
  getTaskUpdatePromptSnippet,
  TURNS_BETWEEN_REMINDERS_DEFAULT,
  TURNS_SINCE_WRITE_DEFAULT,
  TASK_CREATE_DESCRIPTION,
  TASK_GET_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_STOP_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
} from "./prompts.js";
import { loadClaudeTodoConfig, runTaskHook } from "./hooks.js";
import { setRecentCollabNotifier } from "./recent-collab-bridge.js";
import { setTaskAssignmentNotifier } from "./task-assignment-bridge.js";
import { buildTaskStopResultText, executeTaskStopOperation } from "./task-stop-shared.js";
import { buildTaskUpdateResultText, executeTaskUpdateOperation } from "./task-update-shared.js";
import { loadClaudeSubagentActiveTeamName, loadClaudeSubagentActiveTeamNameSync } from "./claude-subagent-integration.js";
import { buildTeammateRuntimeTools, clearClaudeTodoBridge, listLiveTeammates, listManagedTasks, registerClaudeTodoBridge } from "./subagent-runtime-integration.js";
import {
  buildTaskSummary,
  createTask,
  deleteTask,
  filterExternalTasks,
  getAllDoneState,
  getTask,
  listTasks,
  resetTaskList,
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
import { TeammateLifecycleManager } from "./teammate-lifecycle.js";
import {
  STATE_ENTRY,
  TASK_CONTEXT_CUSTOM_TYPE,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  type PersistedState,
  type ManagedTaskSnapshot,
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
  type TaskStopDetails,
  type TaskStopParams,
  TaskStopParamsSchema,
  type TaskSummary,
  type TaskAssignmentNotification,
  type RecentCollabEvent,
  type TaskUpdateDetails,
  type TaskUpdateParams,
  TaskUpdateParamsSchema,
  type WorkerSnapshot,
} from "./types.js";
import { WorkerManager } from "./workers.js";
import { TaskPickupManager } from "./task-pickup.js";

const STATUS_KEY = "claude-todo-v2-status";
const WIDGET_KEY = "claude-todo-v2-widget";
const COMMAND_NAME = "claude-tasks";
const TASK_ASSIGNMENT_CUSTOM_TYPE = "claude-todo-v2-task-assignment";
const DEFAULT_STATE: PersistedState = {
  panelEnabled: true,
  lastReminderAssistantTurn: undefined,
};
const RECENT_EVENT_LIMIT = 6;
const RECENT_EVENT_TTL_MS = 120_000;
const HIDE_DELAY_MS = 5000;
const FALLBACK_POLL_MS = 5000;
const TOOL_NAMES = [
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
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
  return buildTaskUpdateResultText(details as TaskUpdateDetails);
}

function renderTaskAssignmentMessage(message: any, options: { expanded?: boolean }, theme: Theme) {
  const details = message.details as TaskAssignmentNotification | undefined;
  if (!details) {
    return new Text(typeof message.content === "string" ? message.content : "Task assigned", 0, 0);
  }

  let text = theme.fg("accent", theme.bold(`Task #${details.taskId} assigned to @${details.owner}`));
  text += `\n${theme.bold(details.subject)}`;
  text += `\n${theme.fg("dim", `Assigned by ${details.assignedBy} in ${details.taskListId}`)}`;
  if (options.expanded && details.description.trim()) {
    text += `\n${theme.fg("muted", details.description)}`;
  }

  const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
  box.addChild(new Text(text, 0, 0));
  return box;
}

function trimRecentEvents(events: RecentCollabEvent[], now = Date.now()): RecentCollabEvent[] {
  return events
    .filter((event) => {
      const timestamp = Date.parse(event.timestamp);
      return Number.isNaN(timestamp) ? true : now - timestamp <= RECENT_EVENT_TTL_MS;
    })
    .slice(0, RECENT_EVENT_LIMIT);
}

export default function claudeTodoV2(pi: ExtensionAPI): void {
  registerClaudeTodoBridge();
  let recentEvents: RecentCollabEvent[] = [];

  const rememberRecentEvent = (event: RecentCollabEvent): void => {
    const next = trimRecentEvents([
      event,
      ...recentEvents.filter((existing) => !(
        existing.type === event.type &&
        existing.text === event.text &&
        existing.taskListId === event.taskListId
      )),
    ]);
    recentEvents = next;

    const currentTaskListId = normalizeTaskListId(lastUiContext ? getResolvedTaskListId(lastUiContext) : getResolvedTaskListId());
    if (!currentTaskListId || currentTaskListId === event.taskListId) {
      scheduleRefresh();
    }
  };

  setTaskAssignmentNotifier((notification) => {
    rememberRecentEvent({
      type: "assignment",
      taskListId: notification.taskListId,
      timestamp: notification.timestamp,
      text: `#${notification.taskId} assigned to @${notification.owner} by ${notification.assignedBy}`,
      teammateName: notification.owner,
      taskId: notification.taskId,
      assignedBy: notification.assignedBy,
    });
    pi.sendMessage(
      {
        customType: TASK_ASSIGNMENT_CUSTOM_TYPE,
        content: `Task #${notification.taskId} assigned to @${notification.owner}`,
        display: true,
        details: notification,
      },
      {
        deliverAs: "followUp",
      },
    );
  });

  setRecentCollabNotifier((event) => {
    rememberRecentEvent(event);
  });

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
  let cachedSubagentTeamTaskListId: string | undefined;
  const teammateLifecycleManager = new TeammateLifecycleManager(process.cwd());
  const idleTaskPickupManager = new TaskPickupManager(process.cwd());

  const workerManager = new WorkerManager({
    cwd: process.cwd(),
    getTaskListId: () => getResolvedTaskListId(),
    getConfig: async () => loadClaudeTodoConfig(process.cwd()),
    getRuntimeContext: () => lastUiContext ? {
      modelRegistry: lastUiContext.modelRegistry,
      currentModel: lastUiContext.model,
    } : null,
    onChange: () => scheduleRefresh(),
  });

  pi.events.on("claude-subagent:teammates-changed", (event) => {
    const payload = event as {
      teamName?: unknown;
      name?: unknown;
      status?: unknown;
      lastResultText?: unknown;
      lastError?: unknown;
    } | undefined;
    void teammateLifecycleManager.handleRuntimeEvent(payload ?? {});
    const teamName = typeof payload?.teamName === "string"
      ? normalizeTaskListId(payload.teamName)
      : undefined;

    if (teamName && typeof payload?.name === "string") {
      if (payload.status === "completed") {
        const summary = typeof payload.lastResultText === "string" && payload.lastResultText.trim()
          ? payload.lastResultText.trim()
          : "finished work";
        rememberRecentEvent({
          type: "teammate_update",
          taskListId: teamName,
          timestamp: new Date().toISOString(),
          text: `@${payload.name} ${summary}`,
          teammateName: payload.name,
          status: "completed",
        });
      } else if (payload.status === "failed" || payload.status === "interrupted") {
        const detail = typeof payload.lastError === "string" && payload.lastError.trim()
          ? payload.lastError.trim()
          : payload.status;
        rememberRecentEvent({
          type: "teammate_update",
          taskListId: teamName,
          timestamp: new Date().toISOString(),
          text: `@${payload.name} ${detail}`,
          teammateName: payload.name,
          status: String(payload.status),
        });
      }
    }

    const currentTaskListId = getResolvedTaskListId();
    if (!teamName || teamName === currentTaskListId) {
      scheduleRefresh();
    }
  });

  pi.events.on("claude-subagent:managed-task-changed", () => {
    scheduleRefresh();
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

  async function refreshLinkedTaskListContext(cwd: string): Promise<void> {
    cachedSubagentTeamTaskListId = normalizeTaskListId(await loadClaudeSubagentActiveTeamName(cwd));
  }

  async function restoreState(ctx: ExtensionContext): Promise<void> {
    state = { ...DEFAULT_STATE };
    recentEvents = [];
    currentSessionId = sanitizePathComponent(ctx.sessionManager.getSessionId());
    for (const entry of ctx.sessionManager.getBranch()) {
      const customEntry = entry as MessageEntry;
      if (customEntry.type === "custom" && customEntry.customType === STATE_ENTRY && isPersistedState(customEntry.data)) {
        state = { ...DEFAULT_STATE, ...customEntry.data };
      }
    }
    const config = await getConfig();
    cachedConfigTaskListId = normalizeTaskListId(config.taskListId);
    await refreshLinkedTaskListContext(process.cwd());
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

    const liveTeamTaskListId = normalizeTaskListId(loadClaudeSubagentActiveTeamNameSync(process.cwd()));
    if (liveTeamTaskListId) {
      cachedSubagentTeamTaskListId = liveTeamTaskListId;
      return liveTeamTaskListId;
    }

    if (cachedSubagentTeamTaskListId) return cachedSubagentTeamTaskListId;

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
      watcher = watch(getTaskListDir(process.cwd(), taskListId), () => {
        scheduleRefresh();
        void maybeAutoClaimIdleTeammates(taskListId);
      });
      watcher.unref();
    } catch {
      watcher = null;
    }
  }

  function getManagedTaskStatusColor(status: ManagedTaskSnapshot["status"]): keyof Theme {
    switch (status) {
      case "running":
        return "accent";
      case "completed":
        return "success";
      case "failed":
        return "error";
      case "interrupted":
        return "warning";
      case "idle":
      default:
        return "muted";
    }
  }

  function previewManagedText(text: string | undefined, max = 42): string | undefined {
    if (!text) return undefined;
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, Math.max(0, max - 3))}...`;
  }

  function buildManagedTaskLines(theme: Theme, managedTasks: ManagedTaskSnapshot[]): string[] {
    if (managedTasks.length === 0) return [];

    const lines = ["", theme.fg("accent", theme.bold("Managed Runs"))];
    for (const task of managedTasks) {
      const color = getManagedTaskStatusColor(task.status);
      const detail = previewManagedText(task.error ?? task.resultText ?? task.description);
      const suffix = detail ? ` - ${detail}` : "";
      lines.push(theme.fg(color, `${task.runtimeName} [${task.taskId}]: ${task.status} (${task.agentType})${suffix}`));
    }
    return lines;
  }

  async function maybeAutoClaimIdleTeammates(taskListId: string): Promise<void> {
    if (!lastUiContext) return;

    const teammates = listLiveTeammates(taskListId)
      .filter((teammate) => teammate.autoClaimTasks === true)
      .filter((teammate) => teammate.status === "idle" || teammate.status === "completed");

    for (const teammate of teammates) {
      const claimedTask = await idleTaskPickupManager.claimNextAvailableTask({
        taskListId,
        ownerName: teammate.name,
      });
      if (!claimedTask) continue;
      scheduleRefresh();
    }
  }

  async function refreshUi(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) return;
    lastUiContext = ctx;

    const taskListId = getResolvedTaskListId(ctx);
    await ensureWatcher(taskListId);
    await maybeAutoClaimIdleTeammates(taskListId);

    const config = await getConfig();
    const tasks = filterExternalTasks(await listTasks(process.cwd(), taskListId));
    const teammates = listLiveTeammates(taskListId);
    const managedTasks = listManagedTasks(taskListId);
    recentEvents = trimRecentEvents(recentEvents);
    const relevantRecentEvents = recentEvents.filter((event) => event.taskListId === taskListId);
    syncCompletionTimestamps(tasks, completionTimestamps);

    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    const hasIncomplete = tasks.some((task) => task.status !== "completed");
    if (
      hasIncomplete
      || workerManager.list().some((worker) => worker.status === "running")
      || teammates.some((teammate) => teammate.status === "running")
      || managedTasks.some((task) => task.status === "running")
    ) {
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
    if (!state.panelEnabled || (tasks.length === 0 && workers.length === 0 && teammates.length === 0 && managedTasks.length === 0 && relevantRecentEvents.length === 0)) {
      clearUi(ctx);
      return;
    }

    const baseStatus = buildStatusText(ctx.ui.theme, taskListId, tasks, workers, teammates);
    const runningManaged = managedTasks.filter((task) => task.status === "running").length;
    const statusText = managedTasks.length > 0
      ? `${baseStatus} ${ctx.ui.theme.fg("muted", `runs:${runningManaged}/${managedTasks.length}`)}`
      : baseStatus;
    ctx.ui.setStatus(STATUS_KEY, statusText);
    const widgetLines = buildTaskWidgetLines(
      ctx.ui.theme,
      taskListId,
      tasks,
      workers,
      teammates,
      relevantRecentEvents,
      completionTimestamps,
      {
        maxItems: config.panel?.maxItems,
      },
    );
    ctx.ui.setWidget(
      WIDGET_KEY,
      [...widgetLines, ...buildManagedTaskLines(ctx.ui.theme, managedTasks)],
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

  function hasActiveTaskTools(): boolean {
    const activeTools = new Set(pi.getActiveTools());
    return TOOL_NAMES.some((name) => activeTools.has(name));
  }

  function getTaskActivationKey(taskListId: string): string {
    return `${currentSessionId}:${taskListId}`;
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
    } else if (toolName === TASK_STOP_TOOL_NAME) {
      text += theme.fg("accent", `#${String(args.taskId ?? "?")}`);
      text += theme.fg("warning", " stop");
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
        const details = await executeTaskUpdateOperation({
          cwd: process.cwd(),
          taskListId,
          params,
          signal: ctx.signal,
          runtimeContext: {
            modelRegistry: ctx.modelRegistry,
            currentModel: ctx.model,
          },
          buildCustomTools: (actingAgentName) => buildTeammateRuntimeTools({
            cwd: process.cwd(),
            taskListId,
            actingAgentName,
            runtimeContext: {
              modelRegistry: ctx.modelRegistry,
              currentModel: ctx.model,
            },
          }),
        });
        await refreshUi(ctx);
        return {
          content: [{ type: "text", text: buildTaskResultText(details) }],
          details,
          ...(details.success ? {} : { isError: true }),
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


    pi.registerTool({
      name: TASK_STOP_TOOL_NAME,
      label: TASK_STOP_TOOL_NAME,
      description: TASK_STOP_DESCRIPTION,
      promptSnippet: getTaskStopPromptSnippet(),
      promptGuidelines: getTaskStopPromptGuidelines(),
      parameters: TaskStopParamsSchema,
      async execute(_toolCallId: string, params: TaskStopParams, _signal, _onUpdate, ctx: ExtensionContext) {
        const taskListId = getResolvedTaskListId(ctx);
        const details = await executeTaskStopOperation({
          cwd: process.cwd(),
          taskListId,
          taskId: params.taskId,
        });
        await refreshUi(ctx);
        return {
          content: [{ type: "text", text: buildTaskStopResultText(details) }],
          details,
          ...(details.success ? {} : { isError: true }),
        };
      },
      renderCall(args, theme) {
        return renderToolCall(TASK_STOP_TOOL_NAME, args as Record<string, unknown>, theme);
      },
      renderResult(result, _options, theme) {
        const details = result.details as TaskStopDetails | undefined;
        const text = details
          ? buildTaskStopResultText(details)
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

    if (!hasActiveTaskTools()) {
      return { messages: filteredMessages };
    }

    const turnsSinceLastTaskManagement = getTurnsSinceLastTaskManagement(ctx);
    const assistantTurnCount = getAssistantTurnCount(ctx);
    const config = await getConfig();
    const reminder = shouldSendReminder(turnsSinceLastTaskManagement, assistantTurnCount, config);
    if (!reminder) {
      return { messages: filteredMessages };
    }

    if (state.lastReminderAssistantTurn !== assistantTurnCount) {
      state.lastReminderAssistantTurn = assistantTurnCount;
      persistState();
    }
    const taskListId = getResolvedTaskListId(ctx);
    const tasks = filterExternalTasks(await listTasks(process.cwd(), taskListId));
    const content = getTaskReminderMessage(tasks, turnsSinceLastTaskManagement);

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
    await refreshLinkedTaskListContext(process.cwd());
    await refreshUi(ctx);

    if (!hasActiveTaskTools()) {
      return;
    }

    const taskListId = getResolvedTaskListId(ctx);
    const activationKey = getTaskActivationKey(taskListId);
    if (state.lastActivationKey === activationKey) {
      return;
    }

    state.lastActivationKey = activationKey;
    persistState();

    const taskCount = filterExternalTasks(await listTasks(process.cwd(), taskListId)).length;
    return {
      message: {
        customType: TASK_CONTEXT_CUSTOM_TYPE,
        content: taskCount > 0
          ? `Claude Todo V2 task tools are active for task list ${taskListId}. ${taskCount} shared task(s) already exist. Use ${TASK_LIST_TOOL_NAME} when you need the queue.`
          : `Claude Todo V2 task tools are active for task list ${taskListId}. No shared tasks exist yet.`,
        display: false,
      },
    };
  });

  pi.on("session_shutdown", async () => {
    clearClaudeTodoBridge();
    watcher?.close();
    watcher = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (pollTimer) clearTimeout(pollTimer);
    clearHideTimer();
    await workerManager.dispose();
    setRecentCollabNotifier(null);
    setTaskAssignmentNotifier(null);
  });

  pi.registerMessageRenderer(TASK_ASSIGNMENT_CUSTOM_TYPE, (message, options, theme) =>
    renderTaskAssignmentMessage(message, options, theme),
  );
}
