# pi-claude-todo-v2

Claude Code Todo V2-style task system for Pi.

This package recreates the Claude Code Todo V2 / task-list workflow as closely as Pi currently allows:

- exact Claude public task tool names: `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`
- project-local file-backed task lists under `.pi/claude-todo-v2/tasklists/<taskListId>/`
- dependency tracking with `blocks` / `blockedBy`
- monotonic task IDs backed by `.highwatermark`
- task-list locking via `.lock`
- hidden task-management guidance and reminder nudges
- a persistent task widget that auto-hides and auto-clears after completion
- worker-loop automation that self-claims unblocked tasks using headless Pi child processes

## Install

Local install from this workspace:

```bash
pi install -l /home/aka/pi-playground/pi-claude-todo-v2
```

Install directly from GitHub:

```bash
pi install git:github.com/trotsky1997/pi-claude-todo-v2
```

Quick load without installing:

```bash
pi -e /home/aka/pi-playground/pi-claude-todo-v2/extensions/claude-todo-v2/index.ts
```

## Tools

The package registers these exact tool names:

- `TaskCreate`
- `TaskGet`
- `TaskList`
- `TaskUpdate`

## Commands

- `/claude-tasks` - show the current task list in an editor pane
- `/claude-tasks current` - show the active task-list ID
- `/claude-tasks use <id>` - switch to a shared task-list ID for this session branch
- `/claude-tasks use` - clear the session override and fall back to config/flags/session ID
- `/claude-tasks clear` - clear the current task list
- `/claude-tasks panel [on|off]` - toggle the persistent widget
- `/claude-tasks workers` - show worker status
- `/claude-tasks workers start <n>` - start `n` worker loops
- `/claude-tasks workers stop` - stop all workers

## Storage layout

Project-local root:

- `.pi/claude-todo-v2/tasklists/<taskListId>/`
- `.pi/claude-todo-v2/workers/`
- `.pi/claude-todo-v2/config.json`

Each task list directory contains:

- `<id>.json` - one task per file
- `.lock` - list-level lock
- `.highwatermark` - highest assigned numeric ID

## Optional config

Create `.pi/claude-todo-v2/config.json` to customize defaults:

```json
{
  "taskListId": "shared-project",
  "reminders": {
    "turnsSinceWrite": 10,
    "turnsBetweenReminders": 10
  },
  "panel": {
    "placement": "aboveEditor",
    "maxItems": 10
  },
  "hooks": {
    "taskCreated": {
      "command": "node",
      "args": ["scripts/task-created-hook.mjs"]
    },
    "taskCompleted": {
      "command": "node",
      "args": ["scripts/task-completed-hook.mjs"]
    }
  },
  "workers": {
    "model": "your-model-id",
    "tools": ["read", "write", "edit", "bash", "find", "grep", "ls"],
    "pollMs": 1000
  }
}
```

Hook commands receive JSON on stdin and can block by exiting with code `2`.

Worker `tools` are extra tools to keep active alongside the extension's own `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` tools.

## Worker failure semantics

- non-zero worker exits requeue the task to `pending` and clear the owner
- if a worker process exits successfully without marking the task `completed`, the task is also requeued as a protocol failure
- workers release stale pre-owned tasks instead of re-running them blindly
- a worker will not immediately retry the exact same failed task definition again until that task changes

## Known differences from real Claude Code

This package aims for close parity, but Pi does not expose Claude Code's native teammate panes, task hooks, or permission/classifier internals directly. The major behavior differences are:

- worker automation is implemented with spawned headless Pi child processes rather than Claude's internal teammate runtime
- hook parity is provided through extension-local command execution from `.pi/claude-todo-v2/config.json`
- the persistent task display is a Pi widget rather than Claude's built-in status-area renderer

Even with those differences, task naming, storage semantics, dependency behavior, reminders, and worker self-claim flow are designed to feel very close to Claude Todo V2.
