import { loadClaudeTodoConfig, runTaskHook } from "./hooks.js";
import { deleteTask, filterExternalTasks, listTasks, updateTask, createTask } from "./tasks.js";
import { shouldAddVerificationNudge } from "./prompts.js";
import type { Task, TodoItem, TodoWriteDetails } from "./types.js";

function toTodoItem(task: Task): TodoItem {
  return {
    content: task.subject,
    status: task.status,
    activeForm: task.activeForm ?? task.subject,
  };
}

function normalizeTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({
    content: todo.content.trim(),
    status: todo.status,
    activeForm: todo.activeForm.trim(),
  }));
}

function buildTaskUpdatePatch(existing: Task, todo: TodoItem): Partial<Omit<Task, "id">> {
  const updates: Partial<Omit<Task, "id">> = {};
  if (existing.subject !== todo.content) {
    updates.subject = todo.content;
  }
  if ((existing.activeForm ?? "") !== todo.activeForm) {
    updates.activeForm = todo.activeForm;
  }
  if (existing.status !== todo.status) {
    updates.status = todo.status;
  }
  return updates;
}

function claimBestMatch(todo: TodoItem, remaining: Task[]): Task | undefined {
  const contentIndex = remaining.findIndex((task) => task.subject === todo.content);
  if (contentIndex >= 0) {
    return remaining.splice(contentIndex, 1)[0];
  }
  if (remaining.length > 0) {
    return remaining.shift();
  }
  return undefined;
}

export async function executeTodoWriteOperation(options: {
  cwd: string;
  taskListId: string;
  todos: TodoItem[];
  signal?: AbortSignal;
}): Promise<TodoWriteDetails> {
  const { cwd, taskListId, signal } = options;
  const requestedTodos = normalizeTodos(options.todos);
  const existingTasks = filterExternalTasks(await listTasks(cwd, taskListId));
  const oldTodos = existingTasks.map(toTodoItem);
  const allDone = requestedTodos.length > 0 && requestedTodos.every((todo) => todo.status === "completed");
  const verificationNudgeNeeded = shouldAddVerificationNudge(
    requestedTodos.map((todo, index) => ({
      id: String(index + 1),
      subject: todo.content,
      description: todo.content,
      activeForm: todo.activeForm,
      status: todo.status,
      blocks: [],
      blockedBy: [],
    })),
  );
  const remainingTasks = [...existingTasks];
  const config = await loadClaudeTodoConfig(cwd);

  for (const todo of requestedTodos) {
    const match = claimBestMatch(todo, remainingTasks);
    if (match) {
      const updates = buildTaskUpdatePatch(match, todo);
      if (updates.status === "completed" && match.status !== "completed") {
        const hookResult = await runTaskHook(
          cwd,
          config.hooks?.taskCompleted,
          {
            hook_event_name: "TaskCompleted",
            task_id: match.id,
            task_subject: match.subject,
            task_description: match.description,
            task_list_id: taskListId,
            team_name: taskListId,
          },
          signal,
        );
        if (hookResult.blocked) {
          throw new Error(`TaskCompleted hook feedback:\n${hookResult.message}`);
        }
      }
      if (Object.keys(updates).length > 0) {
        await updateTask(cwd, taskListId, match.id, updates);
      }
      continue;
    }

    const taskId = await createTask(cwd, taskListId, {
      subject: todo.content,
      description: todo.content,
      activeForm: todo.activeForm,
      status: todo.status,
      owner: undefined,
      blocks: [],
      blockedBy: [],
    });
    const hookResult = await runTaskHook(
      cwd,
      config.hooks?.taskCreated,
      {
        hook_event_name: "TaskCreated",
        task_id: taskId,
        task_subject: todo.content,
        task_description: todo.content,
        task_list_id: taskListId,
      },
      signal,
    );
    if (hookResult.blocked) {
      await deleteTask(cwd, taskListId, taskId);
      throw new Error(`TaskCreated hook feedback:\n${hookResult.message}`);
    }

    if (todo.status === "completed") {
      const completionHookResult = await runTaskHook(
        cwd,
        config.hooks?.taskCompleted,
        {
          hook_event_name: "TaskCompleted",
          task_id: taskId,
          task_subject: todo.content,
          task_description: todo.content,
          task_list_id: taskListId,
          team_name: taskListId,
        },
        signal,
      );
      if (completionHookResult.blocked) {
        await deleteTask(cwd, taskListId, taskId);
        throw new Error(`TaskCompleted hook feedback:\n${completionHookResult.message}`);
      }
    }
  }

  for (const staleTask of remainingTasks) {
    await deleteTask(cwd, taskListId, staleTask.id);
  }

  if (allDone) {
    const latestTasks = filterExternalTasks(await listTasks(cwd, taskListId));
    for (const task of latestTasks) {
      await deleteTask(cwd, taskListId, task.id);
    }
  }
  return {
    oldTodos,
    newTodos: requestedTodos,
    verificationNudgeNeeded,
  };
}

export function buildTodoWriteResultText(details: TodoWriteDetails): string {
  let content = "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable";
  if (details.verificationNudgeNeeded) {
    content += "\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, add or run a verification step instead of treating caveats as a substitute for verification.";
  }
  return content;
}
