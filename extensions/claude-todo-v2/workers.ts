import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import {
  filterExternalTasks,
  getTask,
  listTasks,
  unassignWorkerTasks,
  updateTask,
} from "./tasks.js";
import {
  ensureDir,
  getWorkerLogPath,
  getWorkersDir,
  sleep,
} from "./storage.js";
import type { Model } from "@mariozechner/pi-ai";
import { type ModelRegistry } from "@mariozechner/pi-coding-agent";
import { formatTaskForPrompt, getWorkerSystemPrompt } from "./prompts.js";
import { loadClaudeSubagentActiveTeamName } from "./claude-subagent-integration.js";
import { buildTeammateRuntimeTools, getSubagentRuntimeManager, resolveWorkerAgent } from "./subagent-runtime-integration.js";
import { TaskPickupManager } from "./task-pickup.js";
import type { ClaudeTodoConfig, Task, WorkerSnapshot } from "./types.js";

interface WorkerRuntimeSessionContext {
  modelRegistry: ModelRegistry;
  currentModel: Model<any> | undefined;
}

interface WorkerRuntime {
  snapshot: WorkerSnapshot;
  stopRequested: boolean;
  failedTaskSignatures: Map<string, string>;
  loopPromise?: Promise<void>;
  teamName?: string;
  sessionContext?: WorkerRuntimeSessionContext;
}

export interface WorkerManagerOptions {
  cwd: string;
  getTaskListId: () => string;
  getConfig: () => Promise<ClaudeTodoConfig>;
  getRuntimeContext: () => WorkerRuntimeSessionContext | null;
  onChange?: () => void;
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
  private readonly taskPickupManager: TaskPickupManager;

  constructor(private readonly options: WorkerManagerOptions) {
    this.taskPickupManager = new TaskPickupManager(options.cwd);
  }

  list(): WorkerSnapshot[] {
    return [...this.workers.values()].map((runtime) => ({ ...runtime.snapshot }));
  }

  async start(count: number): Promise<WorkerSnapshot[]> {
    const runtimeManager = getSubagentRuntimeManager();
    const teamName = await loadClaudeSubagentActiveTeamName(this.options.cwd);
    const sessionContext = this.options.getRuntimeContext();
    if (!runtimeManager || !teamName || !sessionContext) {
      const missing = [
        !runtimeManager ? "runtimeManager" : undefined,
        !teamName ? "activeTeam" : undefined,
        !sessionContext ? "sessionContext" : undefined,
      ].filter(Boolean).join(", ");
      throw new Error(`Claude-style workers require pi-claude-subagent plus an active local team. Missing: ${missing || "unknown"}. Create a team with TeamCreate before starting workers.`);
    }

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
        teamName,
        sessionContext,
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
    const runtimeManager = getSubagentRuntimeManager();
    for (const runtime of runtimes) {
      runtime.stopRequested = true;
      runtime.snapshot.status = "stopping";
      runtime.snapshot.message = "stopping";
      if (runtimeManager && runtime.teamName) {
        await runtimeManager.abort(runtime.snapshot.name, { kind: "teammate", teamName: runtime.teamName });
      }
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

      const nextTask = await this.taskPickupManager.claimNextAvailableTask({
        taskListId,
        ownerName: runtime.snapshot.name,
      });
      if (!nextTask) {
        runtime.snapshot.status = "idle";
        runtime.snapshot.message = "waiting for work";
        runtime.snapshot.currentTaskId = undefined;
        runtime.snapshot.currentTaskSubject = undefined;
        this.emitChange();
        await sleep(pollMs);
        continue;
      }
      await this.runTask(runtime, taskListId, nextTask, config);
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

    const exitCode = await this.runTaskWithManagedTeammate(runtime, taskListId, task, config);

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

  private async runTaskWithManagedTeammate(
    runtime: WorkerRuntime,
    taskListId: string,
    task: Task,
    config: ClaudeTodoConfig,
  ): Promise<number> {
    const teamName = runtime.teamName ?? await loadClaudeSubagentActiveTeamName(this.options.cwd);
    const runtimeManager = getSubagentRuntimeManager();
    const sessionContext = runtime.sessionContext ?? this.options.getRuntimeContext();
    if (!teamName || !runtimeManager || !sessionContext) {
      runtime.snapshot.message = "missing subagent team/runtime context";
      this.emitChange();
      return 1;
    }

    const agent = resolveWorkerAgent(this.options.cwd, config.workers?.agentType);
    const prompt = `${getWorkerSystemPrompt(runtime.snapshot.name, taskListId)}

${formatTaskForPrompt(task)}`;

    await runtimeManager.launchBackground({
      kind: "teammate",
      teamName,
      autoClaimTasks: false,
      color: agent.color,
      name: runtime.snapshot.name,
      agent,
      task: prompt,
      description: task.subject,
      defaultCwd: this.options.cwd,
      requestedCwd: this.options.cwd,
      modelRegistry: sessionContext.modelRegistry,
      currentModel: sessionContext.currentModel,
      modelOverride: config.workers?.model,
      customTools: buildTeammateRuntimeTools({
        cwd: this.options.cwd,
        taskListId,
        actingAgentName: runtime.snapshot.name,
        runtimeContext: sessionContext,
      }),
    });

    runtime.snapshot.message = `teammate launched for #${task.id}`;
    this.emitChange();

    while (!runtime.stopRequested) {
      await sleep(250);
      const record = runtimeManager.get(runtime.snapshot.name, { kind: "teammate", teamName });
      if (!record || record.status === "running") {
        continue;
      }
      runtime.snapshot.message = record.lastResultText ?? `${record.status}`;
      this.emitChange();
      return record.status === "completed" ? 0 : 1;
    }

    await runtimeManager.abort(runtime.snapshot.name, { kind: "teammate", teamName });
    return 1;
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
}
