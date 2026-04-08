import type { Model } from "@mariozechner/pi-ai";
import type { ModelRegistry, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { getSharedAgentRuntimeManager, getSharedChildRuntimeToolBuilder, getSharedManagedRuntimeCoordinator, getSharedManagedTaskRegistry, setSharedClaudeTodoBridge } from "pi-claude-runtime-core/runtime-bridge";
import { discoverAgents, type AgentConfig } from "pi-claude-runtime-core/agent-discovery";
import { formatTaskForPrompt, getWorkerSystemPrompt } from "./prompts.js";
import { ensureTaskListDir, getTaskListDir } from "./storage.js";
import { claimTask, filterExternalTasks, findAvailableTask, listTasks, markTaskInProgress, resetTaskList, unassignOwnerTasks } from "./tasks.js";
import { buildClaudeTodoCustomTools } from "./task-tools-bridge.js";
import type { ManagedTaskSnapshot, TeammateSnapshot } from "./types.js";

export function getSubagentRuntimeManager() {
  return getSharedManagedRuntimeCoordinator() ?? getSharedAgentRuntimeManager();
}

export function getManagedTaskRegistry() {
  return getSharedManagedTaskRegistry();
}

export function registerClaudeTodoBridge(): void {
  setSharedClaudeTodoBridge({
    ensureTaskListDir,
    getTaskListDir,
    resetTaskList,
    unassignOwnerTasks,
    listTasks,
    claimTask,
    markTaskInProgress,
    filterExternalTasks,
    findAvailableTask,
    formatTaskForPrompt,
    getWorkerSystemPrompt,
    buildClaudeTodoCustomTools: ({ cwd, taskListId, actingAgentName, runtimeContext }) =>
      buildClaudeTodoCustomTools(cwd, taskListId, {
        actingAgentName,
        runtimeContext,
      }),
  });
}

export function clearClaudeTodoBridge(): void {
  setSharedClaudeTodoBridge(null);
}

export function listLiveTeammates(taskListId: string): TeammateSnapshot[] {
  const runtimeManager = getSharedAgentRuntimeManager();
  if (!runtimeManager) {
    return [];
  }

  return runtimeManager
    .list()
    .filter((record) => record.kind === "teammate" && record.teamName === taskListId)
    .map((record) => ({
      name: record.name,
      agentType: record.agentType,
      status: record.status ?? "idle",
      ...(record.color ? { color: record.color } : {}),
      ...(typeof record.autoClaimTasks === "boolean" ? { autoClaimTasks: record.autoClaimTasks } : {}),
      ...(record.lastDescription ? { lastDescription: record.lastDescription } : {}),
      ...(record.lastResultText ? { lastResultText: record.lastResultText } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listManagedTasks(taskListId?: string): ManagedTaskSnapshot[] {
  const registry = getSharedManagedTaskRegistry();
  if (!registry) {
    return [];
  }

  return registry
    .list()
    .filter((entry) => entry.runtimeKind === "subagent")
    .filter((entry) => !taskListId || !entry.teamName || entry.teamName === taskListId)
    .map((entry) => ({
      taskId: entry.taskId,
      runtimeName: entry.runtimeName,
      runtimeKind: entry.runtimeKind,
      status: entry.status,
      agentType: entry.agentType,
      ...(entry.teamName ? { teamName: entry.teamName } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.resultText ? { resultText: entry.resultText } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      background: entry.background,
    }))
    .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
}

export function buildTeammateRuntimeTools(options: {
  cwd: string;
  taskListId: string;
  actingAgentName: string;
  runtimeContext: {
    modelRegistry: ModelRegistry;
    currentModel: Model<any> | undefined;
  };
}): ToolDefinition[] {
  const taskTools = buildClaudeTodoCustomTools(options.cwd, options.taskListId, {
    actingAgentName: options.actingAgentName,
    runtimeContext: options.runtimeContext,
  });
  const childToolBuilder = getSharedChildRuntimeToolBuilder();
  if (!childToolBuilder) {
    return taskTools;
  }

  return [
    ...taskTools,
    ...childToolBuilder({
      cwd: options.cwd,
      senderName: options.actingAgentName,
      senderKind: "teammate",
      teamName: options.taskListId,
      runtimeContext: options.runtimeContext,
    }),
  ];
}

export function resolveWorkerAgent(cwd: string, preferredAgentType?: string): AgentConfig {
  const discovery = discoverAgents(cwd, "both");
  const preferred = preferredAgentType?.trim();
  if (preferred) {
    const found = discovery.agents.find((agent) => agent.name === preferred);
    if (found) return found;
  }

  return discovery.agents.find((agent) => agent.name === "general-purpose") ?? discovery.agents[0]!;
}
