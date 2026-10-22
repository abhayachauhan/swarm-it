---
name: swarm-it
description: Plan and coordinate a swarm of Claude or Codex workers in Kelpi using the Swarm-it rail. Use when the user asks to "swarm it", distribute work, fan out tasks, or assign implementation and review to agents.
---

# Swarm it

Turn the request into a short task plan, identify independent pieces, then start one worker per piece.
`swarm-spawn` opens a pane, registers it in the rail, and starts Claude or Codex on a task file.
The coordinator can be either CLI and may choose either CLI for each worker. Preserve the user's
choice when they ask for all Claude, all Codex, or a mix. Otherwise use the coordinator's CLI as the
default worker CLI. Claude workers default to `--mode auto --model sonnet`; Codex workers default to
`--mode on-request` and Codex's configured model. Never use either CLI's permission bypass mode as
a convenience for unattended workers.
The script itself defaults to Claude for compatibility, so a Codex coordinator must pass
`--agent codex` when choosing Codex workers.

Run the swarm from a workspace inside its own Group. Every swarm's workers live in one shared
`Workers` workspace (in a collapsed `Workers` Group), and the rail shows the swarm from any workspace
in the coordinator's Group. `swarm-spawn` opens each worker straight in `Workers`, so the user's view
never switches. Only before `Workers` exists does a worker open beside the coordinator: the plugin then
creates `Workers` and moves it there, which switches the view once. Finished workers are closed
automatically 10 minutes after they finish (plugin setting `autoCleanMinutes`); their results stay. `swarm-spawn` warns when the orchestrator's workspace is not in a Group: tell
the user before spawning more.

## Steps

1. Decide which tasks can run independently and which need another worker's result. Give each
   worker a clear deliverable and path or worktree. When the user wants review, reserve a worker
   for a separate review after implementation; it should inspect the actual diff and report findings.
   Write one self-contained task file per worker (under `~/repos/plans/` or the scratchpad): workers
   do not see this conversation. State the exact repository, scope, and expected result.
2. Spawn each worker, one Bash call each:

   ```bash
   <skill-dir>/swarm-spawn <label> <task-file> [--agent claude|codex] [--model <model>] [--path <repo-or-worktree>]
   ```

   Use the directory containing this `SKILL.md` for `<skill-dir>` (normally
   `~/.claude/skills/swarm-it` or `~/.codex/skills/swarm-it`). It prints `<pane-id>:<label>`.
   The result lands in `~/.kelpi-swarm/results/<label>.md`, in the short
   Goal/Done/Next format the rail shows (the script adds the format instruction to every prompt).
3. Wait for all of them in one background call (no polling, no `sleep` in your own commands):

   ```bash
   <skill-dir>/swarm-wait <pane-id>:<label> [<pane-id>:<label> ...]
   ```

   Run it in the background. It exits when every result exists, a pane closes, or a worker's agent
   ends with no result, and prints each result's first lines. A worker that stopped prints
   `FAILED <pane>:<label> <reason>` (for example "usage limit reached") when a reason is known.
   It gives up after an hour (`--timeout <seconds>` to change) and prints `TIMEOUT`
   with the pane's last lines; a TIMEOUT worker may still be working, so check before retrying. Read the result
   files for the detail.
4. Clean up: the rail only counts finished workers, so nothing needs clearing there. To close their panes:
   `kelpi plugin run local.swarm-view.clear-done`. Per worker:

   ```bash
   kelpi pane close --target <pane-id>
   node <skill-dir>/manifest-writer.mjs remove-worker <workspace-id> <pane-id>
   ```

## Retry and cleanup

- A worker died or wrote no result: `<skill-dir>/swarm-retry <pane-id>:<label> [--model m]`. It reads the
  worker's task file, mode, model and directory from the manifest, starts it again through `swarm-spawn`, and prints
  the new `<pane-id>:<label>`. It refuses while the old pane still runs Claude, and for a worker started before the
  manifest recorded these (no task path).
- `swarm-spawn` first runs `manifest-writer.mjs prune`: it drops workers whose pane is gone (once their result is
  10 minutes old, or at once when their coordinator is gone) and deletes manifests of closed coordinators with no live
  worker. It leaves another swarm's manifest written in the last minute alone, and removes the plugin's exit files
  of closed panes. Result files always stay. Run it by hand with `kelpi pane list --json | node manifest-writer.mjs prune`.
- Reusing a label moves the old result to `~/.kelpi-swarm/results/archive/<label>.<UTC time>.md` instead of deleting it.

## Rules

- Labels, task paths and `--path` may use only letters, digits, `.`, `_`, `-` (and `/`, `~` in paths): every value is
  typed into a shell, so swarm-spawn refuses anything else. `--mode` and `--model` must be plain words.
- Address workers by pane id, never by label: workers live in another workspace.
- Do NOT run `kelpi layout select`, `kelpi pane resize`, or pass `--focus`. The plugin places panes.
- Results must stay under `~/.kelpi-swarm/results/`; the rail refuses any other path (BAD_RESULT_PATH).
- `--agent codex` uses Codex's workspace-write sandbox and requests approval when needed. The
  current Kelpi release notifies on Codex approval requests. Swarm-it Auto can handle Codex Bash
  approvals after its separate Codex hook is installed and trusted; other Codex approvals remain
  in the native pane.
- Ask the user before `--mode bypassPermissions` for Claude, and say what the workers will touch.
- Never `kelpi pane close` without `--target`: it closes your own pane.

## Allocation patterns

- **All Codex:** choose `--agent codex` for implementation and review workers, including when a
  Codex coordinator plans the swarm.
- **All Claude:** omit `--agent` or choose `--agent claude` for every worker.
- **Cross-review:** give implementation to one CLI, then give a different CLI a task file that names
  the branch or diff and asks for defects, risks, and missing tests. Pass its findings back to the
  implementer, then verify the fixes. Review runs after the relevant changes exist.
- **Parallel reviews:** for a large change, give separate review tasks to both CLIs with distinct
  lenses (for example correctness and usability); the coordinator reconciles duplicate or
  conflicting findings and checks the code before reporting completion.
