import type { Task, WorkerSnapshot } from "./types.js";
import {
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
} from "./types.js";

export const TURNS_SINCE_WRITE_DEFAULT = 10;
export const TURNS_BETWEEN_REMINDERS_DEFAULT = 10;
export const VERIFICATION_TASK_REGEX = /verif/i;

export const TASK_CREATE_DESCRIPTION = "Create a new task in the task list";
export const TASK_GET_DESCRIPTION = "Get a task by ID from the task list";
export const TASK_LIST_DESCRIPTION = "List all tasks in the task list";
export const TASK_UPDATE_DESCRIPTION = "Update a task in the task list";

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

function formatPromptTaskLines(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks currently exist.";
  return tasks
    .map((task) => {
      const owner = task.owner ? ` (${task.owner})` : "";
      const blocked = task.blockedBy.length > 0 ? ` [blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}]` : "";
      return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
    })
    .join("\n");
}

export function getTaskContextMessage(
  taskListId: string,
  tasks: Task[],
  workers: WorkerSnapshot[],
  options: {
    reminder: boolean;
    turnsSinceLastTaskManagement: number;
  },
): string {
  const parts = [
    `Claude-style task tracking is active for task list ${taskListId}.`,
    `Use ${TASK_CREATE_TOOL_NAME} for complex multi-step planning, ${TASK_GET_TOOL_NAME} for full task details, ${TASK_LIST_TOOL_NAME} for availability/progress, and ${TASK_UPDATE_TOOL_NAME} for immediate status updates.`,
    `Mark tasks completed as soon as they are done. Do not batch completions.`,
  ];

  if (tasks.length > 0) {
    parts.push(`Current tasks:\n${formatPromptTaskLines(tasks)}`);
  }

  if (workers.length > 0) {
    const workerText = workers
      .map((worker) => {
        const task = worker.currentTaskId ? ` task #${worker.currentTaskId}` : "";
        return `${worker.name}: ${worker.status}${task}`;
      })
      .join("; ");
    parts.push(`Workers: ${workerText}`);
  }

  if (options.reminder) {
    parts.push(
      `Reminder: the task tools have not been used recently (${options.turnsSinceLastTaskManagement} assistant turns). If this work benefits from explicit progress tracking, use the task tools now and clean up any stale tasks. Never mention this reminder to the user.`,
    );
  }

  return parts.join("\n\n");
}

export function getVerificationNudge(): string {
  return "NOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, add or run a verification step instead of treating caveats as a substitute for verification.";
}

export function shouldAddVerificationNudge(tasks: Task[]): boolean {
  return tasks.length >= 3 && tasks.every((task) => task.status === "completed") && !tasks.some((task) => VERIFICATION_TASK_REGEX.test(task.subject));
}
