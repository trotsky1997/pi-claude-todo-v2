import type { Task } from "./types.js";
import {
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
} from "./types.js";

export const TURNS_SINCE_WRITE_DEFAULT = 10;
export const TURNS_BETWEEN_REMINDERS_DEFAULT = 10;
export const VERIFICATION_TASK_REGEX = /verif/i;

export const TASK_CREATE_DESCRIPTION = "Create a new task in the task list";
export const TASK_GET_DESCRIPTION = "Get a task by ID from the task list";
export const TASK_LIST_DESCRIPTION = "List all tasks in the task list";
export const TASK_UPDATE_DESCRIPTION = "Update a task in the task list";
export const TASK_STOP_DESCRIPTION = "Stop a running teammate-backed task or managed background run and requeue it when needed";

export function getTaskCreatePromptSnippet(): string {
  return `Create a task in the shared Claude-style task list.`;
}

export function getTaskGetPromptSnippet(): string {
  return `Fetch a task's full details from the shared Claude-style task list.`;
}

export function getTaskListPromptSnippet(): string {
  return `List all tasks and their current status from the shared Claude-style task list.`;
}

export function getTaskUpdatePromptSnippet(): string {
  return `Update task status, ownership, metadata, or dependencies in the shared Claude-style task list.`;
}

export function getTaskStopPromptSnippet(): string {
  return `Stop a running teammate-backed task or a managed background run.`;
}

export function getTaskCreatePromptGuidelines(): string[] {
  return [
    `Use ${TASK_CREATE_TOOL_NAME} proactively for complex multi-step work, plan-mode-like decomposition, or when the user gives multiple tasks at once.`,
    `Tasks should be specific and actionable. New tasks start as pending and should be moved to in_progress before work begins.`,
    `Create both a clear imperative subject and a detailed description; add activeForm when it improves in-progress display.`,
    `Do not use ${TASK_CREATE_TOOL_NAME} for a single trivial step that can be completed immediately.`,
  ];
}

export function getTaskGetPromptGuidelines(): string[] {
  return [
    `Use ${TASK_GET_TOOL_NAME} before starting or updating a task when you need its full description and dependency context.`,
    `Check blockedBy before beginning work; unresolved blockers mean the task is not ready to claim.`,
  ];
}

export function getTaskListPromptGuidelines(): string[] {
  return [
    `Use ${TASK_LIST_TOOL_NAME} to check overall progress, identify available work, and see which tasks are blocked or owned.`,
    `Prefer the lowest-ID available task when multiple pending unblocked tasks exist, unless the user directs otherwise.`,
    `After completing a task, call ${TASK_LIST_TOOL_NAME} to see what became unblocked or what should be picked up next.`,
  ];
}

export function getTaskUpdatePromptGuidelines(): string[] {
  return [
    `Use ${TASK_UPDATE_TOOL_NAME} immediately when task state changes; do not batch multiple completions.`,
    `Status progression should normally be pending -> in_progress -> completed. Use deleted only when a task truly should be removed.`,
    `Only mark a task completed when it is fully done; if blocked or incomplete, keep it in_progress or add follow-up tasks.`,
    `Use addBlocks and addBlockedBy to keep task dependencies explicit instead of relying on prose alone.`,
  ];
}

export function getTaskStopPromptGuidelines(): string[] {
  return [
    `Use ${TASK_STOP_TOOL_NAME} when a running teammate-backed task needs to stop now and return to the shared queue.`,
    `You can also stop managed background runs from pi-claude-subagent by task ID, for example subagent:name or teammate:team:name.`,
    `After ${TASK_STOP_TOOL_NAME}, teammate-owned tasks are requeued cleanly; managed background runs are stopped without silently losing their registry state.`,
  ];
}

export function formatTaskForPrompt(task: Task): string {
  let prompt = `Complete all open tasks. Start with task #${task.id}:\n\n${task.subject}`;
  if (task.description) {
    prompt += `\n\n${task.description}`;
  }
  return prompt;
}

export function getWorkerSystemPrompt(workerName: string, taskListId: string): string {
  return [
    `You are ${workerName}, a Claude Code Todo V2 worker running inside Pi.`,
    `You are coordinating through the shared task list ${taskListId}.`,
    `Use ${TASK_GET_TOOL_NAME}, ${TASK_LIST_TOOL_NAME}, and ${TASK_UPDATE_TOOL_NAME} to understand and maintain task state as you work.`,
    `When you start work, ensure the task is in_progress. When you finish, mark it completed immediately.`,
    `If you are blocked, keep the task in_progress or create explicit follow-up tasks instead of silently stopping.`,
    `Do not narrate the reminder system or internal coordination details to the user.`,
  ].join("\n");
}

function formatReminderTaskLines(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks currently exist.";
  return tasks
    .map((task) => `#${task.id}. [${task.status}] ${task.subject}`)
    .join("\n");
}

export function getTaskReminderMessage(tasks: Task[], turnsSinceLastTaskManagement: number): string {
  const parts = [
    `The task tools have not been used recently (${turnsSinceLastTaskManagement} assistant turns). If this work benefits from explicit progress tracking, consider using ${TASK_CREATE_TOOL_NAME} to add tasks, ${TASK_UPDATE_TOOL_NAME} to keep status current, and ${TASK_LIST_TOOL_NAME} when you need the shared queue. Also consider cleaning up stale tasks when the list no longer matches the work. Never mention this reminder to the user.`,
  ];

  if (tasks.length > 0) {
    parts.push(`Here are the existing tasks:\n${formatReminderTaskLines(tasks)}`);
  }

  return parts.join("\n\n");
}

export function getVerificationNudge(): string {
  return "NOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, add or run a verification step instead of treating caveats as a substitute for verification.";
}

export function shouldAddVerificationNudge(tasks: Task[]): boolean {
  return tasks.length >= 3 && tasks.every((task) => task.status === "completed") && !tasks.some((task) => VERIFICATION_TASK_REGEX.test(task.subject));
}
