---
name: swarm-it
description: Create a swarm of headless Claude workers in Kelpi that show up in the swarm rail (local.swarm-view plugin). Use when the user asks for a swarm, workers, panes, "fan out", "swarm it", or "create swarm pane". Experimental; does not replace kelpi-agentic.
---

# Swarm it (experimental)

One command per worker. `swarm-spawn` splits a pane, registers it in the swarm rail, and starts
`claude -p` on a task file. Defaults: `--permission-mode auto`, `--model sonnet`. Do not ask the user
for a permission mode unless the work changes shared or production state.

Run the swarm from a workspace inside its own Group. Every swarm's workers live in one shared
`Workers` workspace (in a collapsed `Workers` Group), and the rail shows the swarm from any workspace
in the coordinator's Group. `swarm-spawn` opens each worker straight in `Workers`, so the user's view
never switches. Only before `Workers` exists does a worker open beside the coordinator: the plugin then
creates `Workers` and moves it there, which switches the view once. Finished workers are closed
automatically 10 minutes after they finish (plugin setting `autoCleanMinutes`); their results stay. `swarm-spawn` warns when the orchestrator's workspace is not in a Group: tell
the user before spawning more.

## Steps

1. Write one task file per worker (under `~/repos/plans/` or the scratchpad). The task must be
   self-contained: the worker sees nothing of this conversation.
2. Spawn each worker, one Bash call each:

   ```bash
   ~/.claude/skills/swarm-it/swarm-spawn <label> <task-file> [--model haiku|sonnet|opus] [--path <repo-or-worktree>]
   ```

   It prints `<pane-id>:<label>`. The result lands in `~/.kelpi-swarm/results/<label>.md`, in the short
   Goal/Done/Next format the rail shows (the script adds the format instruction to every prompt).
3. Wait for all of them in one background call (no polling, no `sleep` in your own commands):

   ```bash
   ~/.claude/skills/swarm-it/swarm-wait <pane-id>:<label> [<pane-id>:<label> ...]
   ```

   Run it with `run_in_background`. It exits when every result exists or a pane closes, and prints
   each result's first lines. Read the result files for the detail.
4. Clean up: the rail only counts finished workers, so nothing needs clearing there. To close their panes:
   `kelpi plugin run local.swarm-view.clear-done`. Per worker:

   ```bash
   kelpi pane close --target <pane-id>
   node ~/.claude/skills/swarm-it/manifest-writer.mjs remove-worker <workspace-id> <pane-id>
   ```

## Retry and cleanup

- A worker died or wrote no result: `~/.claude/skills/swarm-it/swarm-retry <pane-id>:<label> [--model m]`. It reads the
  worker's task file, mode, model and directory from the manifest, starts it again through `swarm-spawn`, and prints
  the new `<pane-id>:<label>`. It refuses while the old pane still runs Claude, and for a worker started before the
  manifest recorded these (no task path).
- `swarm-spawn` first runs `manifest-writer.mjs prune`: it drops workers whose pane is gone (once their result is
  10 minutes old, or at once when their coordinator is gone) and deletes manifests of closed coordinators with no live
  worker. Result files always stay. Run it by hand with `kelpi pane list --json | node manifest-writer.mjs prune`.
- Reusing a label moves the old result to `~/.kelpi-swarm/results/archive/<label>.<UTC time>.md` instead of deleting it.

## Rules

- Labels, task paths and `--path` may use only letters, digits, `.`, `_`, `-` (and `/`, `~` in paths): every value is
  typed into a shell, so swarm-spawn refuses anything else. `--mode` and `--model` must be plain words.
- Address workers by pane id, never by label: workers live in another workspace.
- Do NOT run `kelpi layout select`, `kelpi pane resize`, or pass `--focus`. The plugin places panes.
- Results must stay under `~/.kelpi-swarm/results/`; the rail refuses any other path (BAD_RESULT_PATH).
- Ask the user before `--mode bypassPermissions`, and say what the workers will touch.
- Never `kelpi pane close` without `--target`: it closes your own pane.
