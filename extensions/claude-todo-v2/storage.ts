import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";

const LOCK_RETRIES = 30;
const LOCK_MIN_TIMEOUT_MS = 5;
const LOCK_MAX_TIMEOUT_MS = 100;
const STALE_LOCK_MS = 30_000;

export function sanitizePathComponent(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function getExtensionRoot(cwd: string): string {
  return resolve(cwd, ".pi", "claude-todo-v2");
}

export function getConfigPath(cwd: string): string {
  return join(getExtensionRoot(cwd), "config.json");
}

export function getTaskListsRoot(cwd: string): string {
  return join(getExtensionRoot(cwd), "tasklists");
}

export function getTaskListDir(cwd: string, taskListId: string): string {
  return join(getTaskListsRoot(cwd), sanitizePathComponent(taskListId));
}

export function getTaskPath(cwd: string, taskListId: string, taskId: string): string {
  return join(getTaskListDir(cwd, taskListId), `${sanitizePathComponent(taskId)}.json`);
}

export function getTaskListLockPath(cwd: string, taskListId: string): string {
  return join(getTaskListDir(cwd, taskListId), ".lock");
}

export function getTaskLockPath(cwd: string, taskListId: string, taskId: string): string {
  return join(getTaskListDir(cwd, taskListId), `.${sanitizePathComponent(taskId)}.lock`);
}

export function getHighWaterMarkPath(cwd: string, taskListId: string): string {
  return join(getTaskListDir(cwd, taskListId), ".highwatermark");
}

export function getWorkersDir(cwd: string): string {
  return join(getExtensionRoot(cwd), "workers");
}

export function getWorkerLogPath(cwd: string, workerName: string): string {
  return join(getWorkersDir(cwd), `${sanitizePathComponent(workerName)}.log`);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function ensureTaskListDir(cwd: string, taskListId: string): Promise<void> {
  await ensureDir(getTaskListDir(cwd, taskListId));
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await ensureDir(dirname(path));
  await withFileMutationQueue(path, async () => {
    await writeFile(path, content, "utf8");
  });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await withFileMutationQueue(path, async () => {
    await writeFile(path, content, "utf8");
  });
}

export async function readHighWaterMark(cwd: string, taskListId: string): Promise<number> {
  try {
    const content = (await readFile(getHighWaterMarkPath(cwd, taskListId), "utf8")).trim();
    const value = Number.parseInt(content, 10);
    return Number.isNaN(value) ? 0 : value;
  } catch {
    return 0;
  }
}

export async function writeHighWaterMark(
  cwd: string,
  taskListId: string,
  value: number,
): Promise<void> {
  await writeTextFile(getHighWaterMarkPath(cwd, taskListId), `${value}\n`);
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await ensureDir(dirname(lockPath));

  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      await writeFile(lockPath, `${process.pid}:${Date.now()}\n`, { flag: "wx" });
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Ignore release races.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      if (await isStaleLock(lockPath)) {
        try {
          await unlink(lockPath);
          continue;
        } catch {
          // Another process may have claimed it.
        }
      }

      const delay = Math.min(
        LOCK_MAX_TIMEOUT_MS,
        LOCK_MIN_TIMEOUT_MS + attempt * LOCK_MIN_TIMEOUT_MS,
      );
      await sleep(delay);
    }
  }

  throw new Error(`Timed out waiting for lock: ${lockPath}`);
}

export async function withListLock<T>(
  cwd: string,
  taskListId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(getTaskListLockPath(cwd, taskListId));
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function withTaskLock<T>(
  cwd: string,
  taskListId: string,
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(getTaskLockPath(cwd, taskListId, taskId));
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function withTaskLocks<T>(
  cwd: string,
  taskListId: string,
  taskIds: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const uniqueTaskIds = [...new Set(taskIds)]
    .filter((taskId) => taskId.trim().length > 0)
    .sort((a, b) => {
      const aNum = Number.parseInt(a, 10);
      const bNum = Number.parseInt(b, 10);
      if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
        return aNum - bNum;
      }
      return a.localeCompare(b);
    });

  const releases: Array<() => Promise<void>> = [];
  try {
    for (const taskId of uniqueTaskIds) {
      releases.push(await acquireLock(getTaskLockPath(cwd, taskListId, taskId)));
    }
    return await fn();
  } finally {
    while (releases.length > 0) {
      await releases.pop()?.();
    }
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
