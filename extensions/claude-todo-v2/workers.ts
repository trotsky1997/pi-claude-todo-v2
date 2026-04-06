import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterExternalTasks,
  findAvailableTask,
  getTask,
  listTasks,
  markTaskInProgress,
  unassignWorkerTasks,
  claimTask,
  updateTask,
} from "./tasks.js";
import {
  ensureDir,
  getWorkerLogPath,
  getWorkersDir,
  sleep,
} from "./storage.js";
import { formatTaskForPrompt, getWorkerSystemPrompt } from "./prompts.js";
import type { ClaudeTodoConfig, Task, WorkerSnapshot } from "./types.js";

interface WorkerRuntime {
  snapshot: WorkerSnapshot;
  stopRequested: boolean;
  failedTaskSignatures: Map<string, string>;
  loopPromise?: Promise<void>;
  child?: ChildProcessWithoutNullStreams;
}

export interface WorkerManagerOptions {
  cwd: string;
  extensionEntryPath: string;
  getTaskListId: () => string;
  getConfig: () => Promise<ClaudeTodoConfig>;
  onChange?: () => void;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = process.execPath.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writePromptToTempFile(workerName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.mkdtemp(join(os.tmpdir(), "pi-claude-todo-v2-"));
  const filePath = join(tmpDir, `${workerName}.md`);
  await fs.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

async function findOwnedTask(cwd: string, taskListId: string, workerName: string): Promise<Task | undefined> {
  const tasks = filterExternalTasks(await listTasks(cwd, taskListId));
  return tasks.find((task) => task.status !== "completed" && task.owner === workerName);
}

function getTaskSignature(task: Task): string {
  return JSON.stringify({
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    metadata: task.metadata ?? null,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
  });
}

export class WorkerManager {
  private readonly workers = new Map<string, WorkerRuntime>();

  constructor(private readonly options: WorkerManagerOptions) {}

  list(): WorkerSnapshot[] {
    return [...this.workers.values()].map((runtime) => ({ ...runtime.snapshot }));
  }

  async start(count: number): Promise<WorkerSnapshot[]> {
    const total = Math.max(1, count);
    for (let i = 1; i <= total; i += 1) {
      const name = `worker-${i}`;
      if (this.workers.has(name)) continue;
      const runtime: WorkerRuntime = {
        snapshot: {
          name,
          status: "idle",
          message: "starting",
        },
        stopRequested: false,
        failedTaskSignatures: new Map<string, string>(),
      };
      this.workers.set(name, runtime);
      runtime.loopPromise = this.runWorkerLoop(runtime).catch((error) => {
        runtime.snapshot.status = "error";
        runtime.snapshot.message = error instanceof Error ? error.message : String(error);
        runtime.snapshot.currentTaskId = undefined;
        runtime.snapshot.currentTaskSubject = undefined;
        this.emitChange();
      });
    }
    this.emitChange();
    return this.list();
  }

  async stopAll(): Promise<void> {
    const runtimes = [...this.workers.values()];
    for (const runtime of runtimes) {
      runtime.stopRequested = true;
      runtime.snapshot.status = runtime.child ? "stopping" : "stopped";
      runtime.snapshot.message = "stopping";
      runtime.child?.kill("SIGTERM");
    }
    this.emitChange();
    await Promise.all(runtimes.map((runtime) => runtime.loopPromise));
    this.workers.clear();
    this.emitChange();
  }

  async dispose(): Promise<void> {
    await this.stopAll();
  }

  private emitChange(): void {
    this.options.onChange?.();
  }

  private async runWorkerLoop(runtime: WorkerRuntime): Promise<void> {
    const { cwd } = this.options;
    await ensureDir(getWorkersDir(cwd));

    while (!runtime.stopRequested) {
      const taskListId = this.options.getTaskListId();
      const config = await this.options.getConfig();
      const pollMs = Math.max(250, config.workers?.pollMs ?? 1000);

      const ownedTask = await findOwnedTask(cwd, taskListId, runtime.snapshot.name);
      if (ownedTask) {
        await this.requeueTask(
          runtime,
          taskListId,
          ownedTask,
          `released stale ownership for #${ownedTask.id}`,
        );
        await sleep(pollMs);
        continue;
      }

      const tasks = filterExternalTasks(await listTasks(cwd, taskListId));
      const nextTask = findAvailableTask(
        tasks.filter((task) => {
          const failedSignature = runtime.failedTaskSignatures.get(task.id);
          return failedSignature === undefined || failedSignature !== getTaskSignature(task);
        }),
      );
      if (!nextTask) {
        runtime.snapshot.status = "idle";
        runtime.snapshot.message = "waiting for work";
        runtime.snapshot.currentTaskId = undefined;
        runtime.snapshot.currentTaskSubject = undefined;
        this.emitChange();
        await sleep(pollMs);
        continue;
      }

      const claimResult = await claimTask(cwd, taskListId, nextTask.id, runtime.snapshot.name, {
        checkAgentBusy: true,
      });
      if (!claimResult.success) {
        await sleep(250);
        continue;
      }

      await markTaskInProgress(cwd, taskListId, nextTask.id, runtime.snapshot.name);
      const claimedTask = (await getTask(cwd, taskListId, nextTask.id)) ?? nextTask;
      await this.runTask(runtime, taskListId, claimedTask, config);
      await sleep(pollMs);
    }

    const taskListId = this.options.getTaskListId();
    await unassignWorkerTasks(cwd, taskListId, runtime.snapshot.name);
    runtime.snapshot.status = "stopped";
    runtime.snapshot.currentTaskId = undefined;
    runtime.snapshot.currentTaskSubject = undefined;
    runtime.snapshot.message = "stopped";
    this.emitChange();
  }

  private async runTask(
    runtime: WorkerRuntime,
    taskListId: string,
    task: Task,
    config: ClaudeTodoConfig,
  ): Promise<void> {
    runtime.snapshot.status = "running";
    runtime.snapshot.currentTaskId = task.id;
    runtime.snapshot.currentTaskSubject = task.subject;
    runtime.snapshot.message = task.subject;
    this.emitChange();

    const child = await this.spawnTaskProcess(runtime.snapshot.name, taskListId, task, config);
    runtime.child = child;
    runtime.snapshot.pid = child.pid;
    this.emitChange();

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    }).catch((_error) => 1);

    runtime.child = undefined;
    runtime.snapshot.pid = undefined;
    runtime.snapshot.lastExitCode = exitCode;

    const latestTask = await getTask(this.options.cwd, taskListId, task.id);
    if (!latestTask) {
      runtime.failedTaskSignatures.delete(task.id);
      runtime.snapshot.status = "idle";
      runtime.snapshot.currentTaskId = undefined;
      runtime.snapshot.currentTaskSubject = undefined;
      runtime.snapshot.message = "task disappeared";
      this.emitChange();
      return;
    }

    if (latestTask.status === "completed") {
      runtime.failedTaskSignatures.delete(task.id);
      runtime.snapshot.status = "idle";
      runtime.snapshot.currentTaskId = undefined;
      runtime.snapshot.currentTaskSubject = undefined;
      runtime.snapshot.message = `completed #${task.id}`;
      this.emitChange();
      return;
    }

    if (exitCode !== 0) {
      await this.requeueTask(
        runtime,
        taskListId,
        latestTask,
        `exit ${exitCode}; task requeued`,
      );
      return;
    }

    await this.requeueTask(
      runtime,
      taskListId,
      latestTask,
      `worker exited without completing #${task.id}; task requeued`,
    );
  }

  private async requeueTask(
    runtime: WorkerRuntime,
    taskListId: string,
    task: Task,
    message: string,
  ): Promise<void> {
    runtime.failedTaskSignatures.set(task.id, getTaskSignature(task));
    await updateTask(this.options.cwd, taskListId, task.id, {
      owner: undefined,
      status: "pending",
    });
    await fs.writeFile(
      getWorkerLogPath(this.options.cwd, runtime.snapshot.name),
      `${message}\n`,
      { encoding: "utf8", flag: "a" },
    );
    runtime.snapshot.status = "error";
    runtime.snapshot.currentTaskId = undefined;
    runtime.snapshot.currentTaskSubject = undefined;
    runtime.snapshot.message = message;
    this.emitChange();
  }

  private async spawnTaskProcess(
    workerName: string,
    taskListId: string,
    task: Task,
    config: ClaudeTodoConfig,
  ): Promise<ChildProcessWithoutNullStreams> {
    const promptFile = await writePromptToTempFile(workerName, getWorkerSystemPrompt(workerName, taskListId));
    const tools = config.workers?.tools && config.workers.tools.length > 0
      ? config.workers.tools
      : [
          "read",
          "write",
          "edit",
          "bash",
          "find",
          "grep",
          "ls",
          "TaskCreate",
          "TaskGet",
          "TaskList",
          "TaskUpdate",
        ];

    const args = [
      "-e",
      this.options.extensionEntryPath,
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--claude-todo-v2-task-list",
      taskListId,
      "--append-system-prompt",
      promptFile.filePath,
      ...(config.workers?.model ? ["--model", config.workers.model] : []),
      formatTaskForPrompt(task),
    ];

    const invocation = getPiInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_CLAUDE_TODO_V2_WORKER_NAME: workerName,
        PI_CLAUDE_TODO_V2_TASK_LIST_ID: taskListId,
        PI_CLAUDE_TODO_V2_WORKER_TOOLS: JSON.stringify(tools),
      },
    });

    const logPath = getWorkerLogPath(this.options.cwd, workerName);
    await ensureDir(dirname(logPath));
    const stream = createWriteStream(logPath, { flags: "a" });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on("close", async () => {
      stream.end();
      await fs.rm(promptFile.dir, { recursive: true, force: true });
    });

    return child;
  }
}

export function getCurrentExtensionEntryPath(): string {
  return fileURLToPath(new URL("./index.ts", import.meta.url));
}
