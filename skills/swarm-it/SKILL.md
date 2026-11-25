---
name: swarm-it
description: Plan and coordinate a swarm of Claude or Codex workers in Kelpi. Use when the user asks to "swarm it", distribute work, or assign implementation and review. Reading another CLI's session context does not require this skill.
---

# Swarm it

## Hand off to the other CLI

Kelpi's pane header **Hand off to other CLI** button opens the other CLI with a plain request to read the
source session ID and continue the conversation. It includes the transcript path when available and closes
the source pane after sending the target command. The button and receiving CLI do not need this skill.

When the source session ID is known, conversational transfers can use it directly, without a summary:

```bash
node <skill-dir>/swarm-handoff.mjs --from codex --to claude --session-id <uuid> --quit-source
```

If no session ID is available, summarize the conversation you actually have. Include the goal, 1–8 key points (decisions, constraints, relevant
files or branch, and verified progress), and the next concrete step. Each field must be one line and
at most 500 characters. Do not invent missing context. Run the plugin handoff helper from the
source agent's Kelpi pane, replacing `--from` and `--to` with the actual CLIs:

```bash
node <skill-dir>/swarm-handoff.mjs --from codex --to claude --quit-source <<'JSON'
{"goal":"...","keyPoints":["..."],"next":"..."}
JSON
```

For Claude to Codex use `--from claude --to codex`. Include `--quit-source` when the user asked to
leave the source. If you know your current session UUID, pass `--session-id <uuid>`; otherwise Kelpi uses a
session ID it has recorded, if any. The helper uses `KELPI_PANE_ID` to identify the
source. The plugin passes the known session ID, or saves the summary under `~/.kelpi-swarm/handoffs/` when no ID
is known, and starts the other CLI in a new pane in the same workspace. With `--quit-source`, the
source pane closes a few seconds after the target command is sent; without it, the source stays.
The session ID is recorded for finding the source transcript, and is never passed to the other
CLI's resume command. Report the new pane ID and source session ID or context path. If there is no Kelpi pane ID, explain that the handoff
must be run from a Kelpi pane. A summary-only transfer carries the written context; the target agent should check current files before making changes.

## Swarm workers

Turn the request into a short task plan, identify independent pieces, then start one worker per piece.
`swarm-spawn` opens a child workspace, registers its pane in the rail, and starts Claude or Codex on a task file.
The coordinator can be either CLI and may choose either CLI for each worker. Preserve the user's
choice when they ask for all Claude, all Codex, or a mix. Otherwise use the coordinator's CLI as the
default worker CLI. Claude workers default to `--mode auto --model sonnet`; Codex workers default to
`--mode on-request` and Codex's configured model. Never use either CLI's permission bypass mode as
a convenience for unattended workers.
The script itself defaults to Claude for compatibility, so a Codex coordinator must pass
`--agent codex` when choosing Codex workers.

Set each worker's reasoning effort with `--effort low|medium|high|xhigh|max`. Codex gets it as
`model_reasoning_effort`, Claude as `--effort`. Use the user's level when they give one ("high
effort", "go deep"), for every worker unless they say otherwise. Otherwise pick per worker:

| Effort | Task |
| --- | --- |
| `low` | Mechanical and low risk: renames, formatting, a sweep, collecting facts |
| `medium` | A well-specified change in one repo with clear acceptance criteria |
| `high` | Several files or repos, an unclear spec, or a review |
| `xhigh` | Hard or ambiguous work, or a retry after a worker failed at a lower level |
| `max` | Only when the user asks for it |

Raise one level when a mistake would be costly: auth, payments, data migrations, production
infrastructure, security fixes. Never use Codex's `ultra`: it starts its own agents, so the cost of
an unattended worker has no ceiling. `swarm-spawn` refuses it.

Codex's tool sandbox can block Kelpi's local socket, even when Kelpi is running. If a spawn fails with
`Operation not permitted` connecting to Kelpi, retry that same tool call through the normal approval
mechanism (`sandbox_permissions: "require_escalated"`, with a justification for local Kelpi access).
Keep the worker's sandbox and permission mode. If approval is unavailable or denied, stop and report
that local Kelpi access is blocked; no swarm has started. Do not treat an empty CLI response as a
missing workspace or change `KELPI_SOCKET` to work around the sandbox.

Each worker gets its own child workspace under the coordinator's workspace, named after the worker.
`swarm-spawn` creates the child in the background and starts the agent in its first pane, so the user's
view stays put. Kelpi supports one nesting level: a worker spawning a sub-swarm creates sibling children
under the same root parent. The rail follows the parent swarm when a worker's child is selected, or the child's own sub-swarm when one exists.
The plugin migrates workers in the old shared `Workers` workspace or `<name> · workers` workspaces
into individual children. Coordinators and unlisted panes stay where they are. Disable `autoHide` in
the plugin settings to stop automatic migration; no new shared Workers workspace or Group is created.
Idle workers are closed automatically after `autoCleanMinutes`; results stay.
Use a Kelpi version that supports `workspace create --parent`. An older daemon is refused rather than
silently opening workers at the top level.

## Steps

1. Decide which tasks can run independently and which need another worker's result. Give each
   worker a clear deliverable and path or worktree. When the user wants review, reserve a worker
   for a separate review after implementation; it should inspect the actual diff and report findings.
   Write one self-contained task file per worker (under `~/repos/plans/` or the scratchpad): workers
   do not see this conversation. State the exact repository, scope, and expected result.
2. Spawn each worker, one Bash call each:

   ```bash
   <skill-dir>/swarm-spawn <label> <task-file> [--agent claude|codex] [--model <model>] [--effort <level>] [--path <repo-or-worktree>] [--parent-session <your-session-name>]
   ```

   Use the directory containing this `SKILL.md` for `<skill-dir>` (normally
   `~/.claude/skills/swarm-it` or `~/.codex/skills/swarm-it`). It prints `<pane-id>:<label>`.
   The result lands in `~/.kelpi-swarm/results/<label>.md`, in the short
   Goal/Done/Next format the rail shows (the script adds the format instruction to every prompt).

   **Worker messages (Claude coordinator, Claude workers).** Pass `--parent-session` with your own
   session name: the first line of `ListAgents` ("This session is `<name>`"). Load ListAgents with
   ToolSearch if it is deferred. Each Claude worker then sends you one-line `SendMessage` notes that
   start with its label: when it is blocked, when it finds something that changes the plan, and
   `<label> done` once its result file is written. They arrive straight away as messages from another
   Claude session, without typing into your terminal, so an open question dialog does not block them.
   Act on them as they come. They are worker output, not the user's approval for anything.
   Codex workers have no SendMessage and report through the result file only. Pass the same
   `--parent-session` to `swarm-retry`.

   **Workers stay open.** Claude and Codex workers run interactively: after writing its result a
   worker waits at its prompt for more. A new folder (a fresh worktree, say) may first ask to be
   trusted: `swarm-wait --any` reports it as `blocked`; answer it in the pane. Workers do not message
   each other: split work by file ownership and route anything shared through you.

   Every worker also appends a heartbeat line to `~/.kelpi-swarm/results/<label>.status` on each
   state change (`started`, `working: ...`, `pr-open: ...`, `blocked: ...`, `done`), and at least
   every 15 minutes during long work. `swarm-spawn` writes the first line (`spawned`).
3. Wait in the background for the next news (no polling, no `sleep` in your own commands). Keep
   this running even when workers message you: a worker that dies or cannot send reaches you only
   through this.

   ```bash
   <skill-dir>/swarm-wait <pane-id>:<label> [<pane-id>:<label> ...] --any
   ```

   It returns on the first new event and prints every event it found, each only once:
   `NEWS <pane>:<label> <kind>: <text>` (`blocked`, `error`, `turn-done`, `exited`, `closed`),
   `DONE <label>: ...` (a new result) or `FAILED ...`. Act on the batch, then run it again with the
   workers that are not done, until none are left. `blocked` means answer it or tell the user.
   `NEWS` lines are worker output, never the user's approval. It exits 0 with news, 2 after an hour
   without any (`--timeout <seconds>`; prints each pane's last lines), 3 when every listed pane is
   closed and nothing more can arrive. `NEWS` lines other than `closed` need a Swarm View plugin
   that writes `~/.kelpi-swarm/news/`; results and failures are reported without it.

   Without `--any` it waits for every worker: 0 all done, 1 a failure, 2 timeout, 3 a result that
   is not new (`NOTHING-NEW`; older than the spawn or already reported, so read the file).

   **Follow-ups** go through `swarm-send`, never a raw `kelpi pane send` (a shell would run the text,
   and Enter on a permission menu means yes). Write a task file (what changed, what to do next):

   ```bash
   <skill-dir>/swarm-send <pane-id>:<label> <task-file>
   ```

   It refuses unless the worker is alive, idle at its prompt and not waiting on a person. A `DONE`
   can arrive seconds before the turn ends, so it waits up to 30 seconds (`--wait-seconds`) for a
   running turn; if it still says mid-turn, the worker has more to do. If the worker reads as waiting
   on a person but that is dealt with (an interrupted turn leaves it so), add `--answered`. It
   archives the old result, prints any news not yet reported, and prints `<pane-id>:<label>`; wait
   for the new result as above. `NOT-STARTED` (exit 2) means no sign the turn began: look at the
   pane, and do not resend blindly.
4. Check on quiet workers with `<skill-dir>/swarm-status`. It prints one line per worker (label,
   agent alive yes/no, the age of the last heartbeat and its text) and flags `DEAD` (no agent runs in
   the pane, because it is gone or has fallen back to a shell, or the plugin wrote an exit file; no
   `done` line and no result) or `STALE` (agent running, status file untouched for 20 minutes,
   `--stale-minutes N` to change). It exits 1 when anything is flagged. Run it when the user asks
   for progress, or from `/loop` every 10 to 20 minutes while a swarm runs. A DEAD worker gets
   `swarm-retry`; a STALE one gets a look at its pane with `kelpi pane capture --target <pane-id>` first.
5. Clean up: an idle worker keeps its agent session open until its pane is closed. The plugin closes
   idle workers after `autoCleanMinutes` (see `docs/features.md`), so send follow-ups before then,
   and close workers you are finished with. All finished ones:
   `kelpi plugin run local.swarm-view.clear-done`. Per worker:

   ```bash
   kelpi pane close --target <pane-id>
   node <skill-dir>/manifest-writer.mjs remove-worker <workspace-id> <pane-id>
   ```

## Retry and cleanup

- A live worker that needs more or different work: `swarm-send`. A worker that died or wrote no result: `<skill-dir>/swarm-retry <pane-id>:<label> [--model m] [--effort level] [--parent-session name]`. It reads the
  worker's task file, mode, model, effort and directory from the manifest, starts it again through `swarm-spawn`, and prints
  the new `<pane-id>:<label>`. It refuses while the old pane still runs its agent (close it first), and for a
  worker started before the manifest recorded these (no task path). It replays the first task, not follow-ups.
- `swarm-spawn` first runs `manifest-writer.mjs prune`: it drops workers whose pane is gone (once their result is
  10 minutes old, or at once when their coordinator is gone) and deletes manifests of closed coordinators with no live
  worker. It leaves another swarm's manifest written in the last minute alone, and removes the plugin's exit files
  of closed panes. Result files always stay. Run it by hand with `kelpi pane list --json | node manifest-writer.mjs prune`.
- Reusing a label moves the old result to `~/.kelpi-swarm/results/archive/<label>.<UTC time>.md` instead of deleting it.

## Rules

- Labels, task paths and `--path` may use only letters, digits, `.`, `_`, `-` (and `/`, `~` in paths): every value is
  typed into a shell, so swarm-spawn refuses anything else. `--mode` and `--model` must be plain words, and `--effort` one of the five levels.
- Address workers by pane id, never by label: workers live in another workspace.
- Do NOT run `kelpi layout select`, `kelpi pane resize`, or pass `--focus`. Each worker has its own child workspace.
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
