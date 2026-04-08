import { claimTask, findAvailableTask, getTask, listTasks, markTaskInProgress } from "./tasks.js";
import type { Task } from "./types.js";

function buildTaskSignature(task: Task): string {
  return JSON.stringify({
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    metadata: task.metadata ?? null,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
  });
}

export class TaskPickupManager {
  private readonly lastClaimedTaskByAgent = new Map<string, string>();
  private readonly lastClaimedSignatureByAgent = new Map<string, string>();

  constructor(private readonly cwd: string) {}

  async claimNextAvailableTask(options: {
    taskListId: string;
    ownerName: string;
    avoidRepeatingLastTask?: boolean;
  }): Promise<Task | null> {
    const { taskListId, ownerName, avoidRepeatingLastTask = true } = options;
    const tasks = await listTasks(this.cwd, taskListId);
    const nextTask = findAvailableTask(
      tasks.filter((task) => {
        if (!avoidRepeatingLastTask) return true;
        const lastTaskId = this.lastClaimedTaskByAgent.get(ownerName);
        const lastSignature = this.lastClaimedSignatureByAgent.get(ownerName);
        if (!lastTaskId || !lastSignature) return true;
        if (task.id !== lastTaskId) return true;
        return buildTaskSignature(task) !== lastSignature;
      }),
    );

    if (!nextTask) {
      return null;
    }

    const claimResult = await claimTask(this.cwd, taskListId, nextTask.id, ownerName, {
      checkAgentBusy: true,
    });
    if (!claimResult.success) {
      return null;
    }

    await markTaskInProgress(this.cwd, taskListId, nextTask.id, ownerName);
    const claimed = (await getTask(this.cwd, taskListId, nextTask.id)) ?? nextTask;
    this.lastClaimedTaskByAgent.set(ownerName, claimed.id);
    this.lastClaimedSignatureByAgent.set(ownerName, buildTaskSignature(claimed));
    return claimed;
  }
}
