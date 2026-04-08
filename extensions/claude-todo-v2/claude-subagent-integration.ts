import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as path from "node:path";

function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function getClaudeSubagentStateDir(cwd: string): string {
  return path.resolve(cwd, ".pi", "claude-subagent");
}

export function getClaudeSubagentActiveTeamPath(cwd: string): string {
  return path.join(getClaudeSubagentStateDir(cwd), "active-team.json");
}

export function getClaudeSubagentTeamFilePath(cwd: string, teamName: string): string {
  return path.join(getClaudeSubagentStateDir(cwd), "teams", `${sanitizeTeamName(teamName)}.json`);
}

export function loadClaudeSubagentActiveTeamNameSync(cwd: string): string | undefined {
  try {
    const raw = syncFs.readFileSync(getClaudeSubagentActiveTeamPath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { teamName?: unknown }).teamName === "string") {
      const teamName = (parsed as { teamName: string }).teamName.trim();
      return teamName || undefined;
    }
  } catch {
    // Ignore missing or malformed integration state.
  }
  return undefined;
}

export async function loadClaudeSubagentActiveTeamName(cwd: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(getClaudeSubagentActiveTeamPath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { teamName?: unknown }).teamName === "string") {
      const teamName = (parsed as { teamName: string }).teamName.trim();
      return teamName || undefined;
    }
  } catch {
    // Ignore missing or malformed integration state.
  }
  return undefined;
}

export async function claudeSubagentTeamExists(cwd: string, teamName: string): Promise<boolean> {
  try {
    await fs.access(getClaudeSubagentTeamFilePath(cwd, teamName));
    return true;
  } catch {
    return false;
  }
}
