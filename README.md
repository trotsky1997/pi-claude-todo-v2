# pi-claude-todo-v2

Claude Code Todo V2-style task system for Pi.

This package recreates the Claude Code Todo V2 / task-list workflow as closely as Pi currently allows, and can now integrate directly with `pi-claude-subagent` for local Claude-style team/task coordination.

Core task-list behavior:

- exact Claude public task tool names: `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskStop`
- project-local file-backed task lists under `.pi/claude-todo-v2/tasklists/<taskListId>/`
- dependency tracking with `blocks` / `blockedBy`
- monotonic task IDs backed by `.highwatermark`
- task-list locking via `.lock`
- lightweight hidden reminder nudges instead of full per-turn task-list injection
- a persistent task widget that auto-hides and auto-clears after completion
- the widget/status line now shows live teammate presence and task-owner activity, not just raw worker rows
- the widget also keeps a short-lived `Recent` strip for assignment/completion/team coordination events, compacting consecutive related updates into a tighter timeline

Claude-style local coordination integration when used together with `pi-claude-subagent`:

- active local team name becomes the default taskListId (`Team = TaskList`)
- new local `TeamCreate` calls initialize/reset that team task list immediately
- `/claude-tasks workers start` uses teammate-backed managed runtimes instead of raw subprocess workers
- worker names match task `owner` values
- teammate-backed workers can use the same `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `TaskStop` tools inside their child session, and now inherit the subagent package's bridged `SendMessage` tool when available
- the task widget folds manual teammates and worker-backed teammates into one live `Teammates` view
- the task widget/status line can also surface named background subagent runs from the shared managed-task registry when `pi-claude-subagent` is loaded
- `TaskUpdate(owner=<teammate>)` immediately wakes or resumes that local teammate with the assigned task context and emits a dedicated assignment notification
- manually spawned teammates (`Agent(team_name + name)`) can also auto-claim shared team tasks while idle
- interrupted or failed local teammates release unfinished owned tasks back to `pending`, and teammate records are pruned across shutdown/startup because in-process teammate runtimes do not survive Pi exit

## Install

Local install from this workspace:

```bash
pi install -l /home/aka/pi-playground/pi-claude-todo-v2
pi install -l /home/aka/pi-playground/pi-claude-subagent
```

Install directly from GitHub:

```bash
pi install git:github.com/trotsky1997/pi-claude-todo-v2
```

Quick load without installing:

```bash
pi -e /home/aka/pi-playground/pi-claude-todo-v2/extensions/claude-todo-v2/index.ts \
  -e /home/aka/pi-playground/pi-claude-subagent/extensions/claude-subagent/index.ts
```

## Tools

The package registers these exact tool names:

- `TaskCreate`
- `TaskGet`
- `TaskList`
- `TaskUpdate`
- `TaskStop`

## Commands

- `/claude-tasks` - show the current task list in an editor pane
- `/claude-tasks current` - show the active task-list ID
- `/claude-tasks use <id>` - switch to a shared task-list ID for this session branch
- `/claude-tasks use` - clear the session override and fall back to config/flags/team/session resolution
- `/claude-tasks clear` - clear the current task list
- `/claude-tasks panel [on|off]` - toggle the persistent widget
- `/claude-tasks workers` - show worker status
- `/claude-tasks workers start <n>` - start `n` teammate-backed worker loops
- `/claude-tasks workers stop` - stop all worker loops

## Storage layout

Project-local root:

- `.pi/claude-todo-v2/tasklists/<taskListId>/`
- `.pi/claude-todo-v2/workers/`
- `.pi/claude-todo-v2/config.json`

When used with `pi-claude-subagent`, task-list resolution also consults:

- `.pi/claude-subagent/active-team.json`
- `.pi/claude-subagent/teams/*.json`

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
    },
    "teammateIdle": {
      "command": "node",
      "args": ["scripts/teammate-idle-hook.mjs"]
    }
  },
  "workers": {
    "model": "your-model-id",
    "agentType": "general-purpose",
    "tools": ["read", "write", "edit", "bash", "find", "grep", "ls"],
    "pollMs": 1000
  }
}
```

`workers.agentType` selects which Claude-style agent definition to use for teammate-backed workers.

Hook commands receive JSON on stdin and can block by exiting with code `2`.

Reminder behavior is intentionally lightweight: the extension emits a brief hidden activation note once per session/task-list pairing, then falls back to Claude-style reminder nudges only after enough assistant turns pass without `TaskCreate` or `TaskUpdate` activity.

## Worker semantics

- teammate-backed workers claim pending, unowned, unblocked tasks and set them `in_progress`
- idle auto-claim teammates now also react to task-list watcher changes, not only their own periodic loops
- task owners match teammate names such as `worker-1`
- `TaskStop` and worker stop both interrupt the teammate-backed runtime and release unfinished owned tasks back to `pending`
- non-zero worker exits requeue the task to `pending` and clear the owner
- if a worker finishes without the task reaching `completed`, the task is also requeued as a protocol failure
- a worker will not immediately retry the exact same failed task definition again until that task changes
- when a teammate transitions out of `running`, `taskCompleted` hooks are also evaluated for any still-owned in-progress tasks, and `teammateIdle` hooks run when the teammate settles to `completed`/`idle`

## Recommended Claude-style flow

When used together with `pi-claude-subagent`, the closest local Claude-style workflow is:

1. Create a local team with `TeamCreate`
2. Use `TaskCreate` / `TaskUpdate` / `TaskList` to define and manage shared work
3. Start teammate-backed workers with `/claude-tasks workers start <n>` or spawn explicit teammates with `Agent(team_name + name)`
4. Use `SendMessage` for follow-up coordination with named teammates

## Known differences from real Claude Code

This package is now much closer to Claude Code’s local team/task model, but still differs in a few ways:

- local team/task coordination is implemented across two Pi packages instead of one integrated product runtime
- teammate-backed workers are built on local managed runtimes rather than Claude’s exact internal in-process runner implementation
- `TaskStop` can now also stop managed background runs from the shared subagent registry, but the wider Claude Code background-task surface is still broader
- tmux / split-pane teammate backends and CCR remote worker backends are still out of scope
