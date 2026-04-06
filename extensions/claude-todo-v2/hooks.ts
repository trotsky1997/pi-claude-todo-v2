import { spawn } from "node:child_process";
import type { ClaudeTodoConfig, HookCommandConfig, HookResult } from "./types.js";
import { getConfigPath, readJsonFile } from "./storage.js";

const DEFAULT_CONFIG: Required<Pick<ClaudeTodoConfig, "reminders" | "panel" | "workers">> = {
  reminders: {
    turnsSinceWrite: 10,
    turnsBetweenReminders: 10,
  },
  panel: {
    placement: "aboveEditor",
    maxItems: 10,
  },
  workers: {
    pollMs: 1000,
    tools: [],
  },
};

export async function loadClaudeTodoConfig(cwd: string): Promise<ClaudeTodoConfig> {
  const config = await readJsonFile<ClaudeTodoConfig>(getConfigPath(cwd));
  if (!config || typeof config !== "object") {
    return { ...DEFAULT_CONFIG };
  }

  return {
    ...config,
    reminders: {
      ...DEFAULT_CONFIG.reminders,
      ...(config.reminders ?? {}),
    },
    panel: {
      ...DEFAULT_CONFIG.panel,
      ...(config.panel ?? {}),
    },
    workers: {
      ...DEFAULT_CONFIG.workers,
      ...(config.workers ?? {}),
    },
  };
}

async function runCommand(
  cwd: string,
  hook: HookCommandConfig,
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(hook.command, hook.args ?? [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    if (signal) {
      const abort = () => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", abort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", abort));
    }

    child.stdin.write(`${JSON.stringify(payload, null, 2)}\n`);
    child.stdin.end();
  });
}

export async function runTaskHook(
  cwd: string,
  hook: HookCommandConfig | undefined,
  payload: unknown,
  signal?: AbortSignal,
): Promise<HookResult> {
  if (!hook) {
    return { blocked: false };
  }

  try {
    const result = await runCommand(cwd, hook, payload, signal);
    if (result.code === 0) {
      return { blocked: false };
    }
    if (result.code === 2) {
      return {
        blocked: true,
        message: result.stderr || result.stdout || "Hook blocked the action.",
      };
    }
    return {
      blocked: false,
      warning: result.stderr || result.stdout || `Hook exited with code ${result.code}.`,
    };
  } catch (error) {
    return {
      blocked: false,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
