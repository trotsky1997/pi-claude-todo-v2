import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTodoWriteOperation } from "../extensions/claude-todo-v2/todo-write-shared.js";
import { filterExternalTasks, listTasks } from "../extensions/claude-todo-v2/tasks.js";

const TASK_LIST_ID = "todowrite-roundtrip";

function printSection(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function readTaskFiles(cwd: string): Promise<Array<{ file: string; body: unknown }>> {
  const tasks = filterExternalTasks(await listTasks(cwd, TASK_LIST_ID));
  const files = await Promise.all(tasks.map(async (task) => {
    const file = join(cwd, ".pi", "claude-todo-v2", "tasklists", TASK_LIST_ID, `${task.id}.json`);
    const body = JSON.parse(await readFile(file, "utf8"));
    return { file, body };
  }));
  return files;
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-todo-v2-"));
  try {
    const initial = [
      { content: "Inspect TodoWrite reconciliation", status: "in_progress", activeForm: "Inspecting TodoWrite reconciliation" },
      { content: "Verify TaskList visibility", status: "pending", activeForm: "Verifying TaskList visibility" },
    ] as const;

    const initialResult = await executeTodoWriteOperation({
      cwd,
      taskListId: TASK_LIST_ID,
      todos: [...initial],
    });

    printSection("TodoWrite #1 result", initialResult);
    printSection("TaskList after TodoWrite #1", filterExternalTasks(await listTasks(cwd, TASK_LIST_ID)));
    printSection("Task files after TodoWrite #1", await readTaskFiles(cwd));

    const completedResult = await executeTodoWriteOperation({
      cwd,
      taskListId: TASK_LIST_ID,
      todos: initial.map((todo) => ({ ...todo, status: "completed" as const })),
    });

    printSection("TodoWrite #2 result", completedResult);
    printSection("TaskList after TodoWrite #2", filterExternalTasks(await listTasks(cwd, TASK_LIST_ID)));

    const remainingTaskFiles = await readTaskFiles(cwd);
    printSection("Task files after TodoWrite #2", remainingTaskFiles);

    if (remainingTaskFiles.length !== 0) {
      throw new Error("Expected all task files to be cleared after all-completed TodoWrite snapshot");
    }

    console.log("\nRound-trip regression passed.");
    console.log("Temporary workspace cleaned up.");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

await main();
