---
name: swarm-it
description: Create a swarm of headless Claude workers in Kelpi that show up in the swarm rail (local.swarm-view plugin). Use when the user asks for a swarm, workers, panes, "fan out", "swarm it", or "create swarm pane". Experimental; does not replace kelpi-agentic.
---

# Swarm it (experimental)

One command per worker. `swarm-spawn` splits a pane, registers it in the swarm rail, and starts
`claude -p` on a task file. Defaults: `--permission-mode auto`, `--model sonnet`. Do not ask the user
for a permission mode unless the work changes shared or production state.

Run the swarm from a workspace inside its own Group. The plugin creates a `<name> · workers`
workspace in the same Group, moves the workers there, and shows the swarm in the rail from any
workspace in that Group. `swarm-spawn` warns when the orchestrator's workspace is not in a Group: tell
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
4. Clean up: the user presses Stop in the rail, or per worker:

   ```bash
   kelpi pane close --target <pane-id>
   node ~/.claude/skills/swarm-it/manifest-writer.mjs remove-worker <workspace-id> <pane-id>
   ```

## Rules

- Labels, task paths and `--path` must contain no spaces or quotes (`kelpi pane send` drops quotes).
- Address workers by pane id, never by label: the plugin moves them to another workspace.
- Do NOT run `kelpi layout select`, `kelpi pane resize`, or pass `--focus`. The plugin places panes.
- Results must stay under `~/.kelpi-swarm/results/`; the rail refuses any other path (BAD_RESULT_PATH).
- Ask the user before `--mode bypassPermissions`, and say what the workers will touch.
- Never `kelpi pane close` without `--target`: it closes your own pane.
