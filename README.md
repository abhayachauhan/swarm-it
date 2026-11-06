# swarm-it

**Give Claude or Codex a goal. Get a coordinated team in [Kelpi](https://github.com/benfriebe/kelpi).**

![Animated illustration of a coordinator, the Swarm rail, and Claude and Codex workers](docs/demo.svg)

Say **“swarm it”** to a Claude Code or Codex coordinator. The skill breaks your goal into tasks, starts workers, waits for results, and can route implementation and review to different CLIs. The Kelpi plugin keeps the work visible in one rail: who is running, who needs you, and what finished.

> The illustrations below explain the workflow. [Earlier Kelpi UI captures](docs/archive/README.md) show the original Claude-only interface.

## What you can do

| Ask for | What happens |
| --- | --- |
| **“Swarm it, all Codex.”** | Codex plans the work and starts Codex workers. |
| **“Swarm it, all Claude.”** | Claude plans the work and starts Claude workers. |
| **“Codex implements; Claude reviews.”** | The coordinator starts review after the implementation diff exists, returns findings to the implementer, and checks the fixes. Reverse the roles whenever you want. |
| **“Swarm it, high effort.”** | Workers think harder. Without a level, the coordinator picks one per worker from how complex and risky its task is. |
| **“Use both to review.”** | Separate Claude and Codex reviews can inspect the same change with different focuses. |
| **“Hand this goal to the other CLI.”** | The other CLI opens beside the source with its session ID as context. The pane's **Hand off to other CLI** action works without the skill. |

Each worker gets its own Kelpi pane in a shared **Workers** workspace. Your coordinator stays in place. Completed workers write a short **Goal / Done / Next** result; the rail keeps the result after the worker pane closes.

## Remember each workspace

![A single plain-language session status line with a Details button](docs/workspace-brief.png)

**Toolbar with session status** shows one sentence below the normal toolbar, such as “The changes are ready; waiting for your review.” There is no brief title or large header panel. **Details** opens the goal, plan, pull request changes, risk and validation evidence. User-pinned goals stay in Details.

The plugin reads a bounded slice of the selected workspace’s Claude or Codex conversation. A separate, tool-free Sonnet call uses your installed Claude login. This uses Claude usage and does not send prompts into your working session. Changed context is checked while visible, with one summary process and a two-minute automatic refresh limit per workspace.

Pull request assessments use the GitHub description, changed files, checks and a bounded diff excerpt. Risk is preliminary; live checks and reported runtime validation stay separate. Missing evidence stays Unknown, and a changed revision invalidates the old assessment.

Automatic briefs are off on a fresh install. Enable them in plugin settings, then choose **Toolbar with session status** for the toolbar view:

```sh
kelpi plugin settings local.swarm-view --key briefEnabled --value true
```

Existing brief layouts migrate automatically. **Hide status line** restores the native toolbar. Summaries survive restarts and handoffs; when shared plugin storage is full, private files under ~/.kelpi-swarm/briefs/ preserve them without pruning Swarm history.

## One rail for the whole run

![Illustration of Claude and Codex requests in the Swarm rail](docs/approvals.svg)

The rail shows **Needs you**, **Running**, and **Done**. Claude permission cards include **Approve** and **Deny**; before sending a key, the plugin checks that the live prompt still matches the card. Codex permission cards offer **Go to pane**, where you answer Codex's native prompt. The plugin never sends Claude-style approval keystrokes to Codex. For Codex clarification questions, choose **Answer here** to read the question, select an option or type a reply, and **Send answer** directly from Swarm. **Go to pane** remains available.

Expanded native Codex questions also appear directly on worker cards with their choices. Click a choice to answer in that worker, including workers outside the connected local server. The plugin verifies the question and terminal revision before each navigation key and submission; a changed question stops the action. **Other** opens the pane for a custom answer. Auto never chooses clarification answers.

Collapsed Codex questions require the question to belong to the connected local Codex server for central answers. Some terminal workers run through a separate server, which can leave their question marker visible while the connected server has no question to return. **Answer here** reports this limitation for the selected pane; use **Go to pane** for those workers. A notification without a visible approval menu is labelled as a notification, rather than an approval. Delayed notifications are ignored when the terminal visibly shows Codex working without a prompt.

The timed **Auto** control can approve eligible requests while you are away. It works through Kelpi's permission provider for Claude and through a separate Codex `PermissionRequest` hook for safe Bash requests. Other requests stay with you. Auto has a time limit, an activity log, and [documented safeguards](docs/permissions.md).

## Move between Claude and Codex

![Illustration of a handoff from Claude to Codex through the exact local transcript](docs/handoff.svg)

Choose **Hand off to other CLI** in a pane's header or pane menu. It opens the other CLI in the same working directory with a plain request: **“Read the Claude session &lt;id&gt; and continue the conversation from where it left off.”** The source transcript path is included when available. The action works in either direction and does not require a skill. The source pane closes after Kelpi sends the target command; a missing session ID leaves it open.

Conversational transfers also pass the source session ID when known. If no ID is available, a short **Goal / Key points / Next** context file can be used instead.

## More than a worker list

- **Reviewable results:** open a worker's Goal / Done / Next result, follow up in its own conversation, or send it back to work.
- **Visible failures:** a worker that stops without a result appears under Needs you with a reason when Kelpi supplies one.
- **Clean workspace:** finished worker panes close after 10 minutes by default; result files remain. Dirty worktrees stay open.
- **Useful pane actions:** run or copy a command Claude suggested, restart Claude after changing hooks, and hand off between CLIs.
- **No hidden permission bypass:** Codex workers use `workspace-write` and `on-request` by default; Claude workers use their configured asking mode.

## Install

You need Kelpi and at least one of Claude Code or Codex CLI. Install the plugin and link the skill into each CLI you want to use:

```sh
git clone https://github.com/abhayachauhan/swarm-it
cd swarm-it
kelpi plugin install . --trust
kelpi install-hooks
ln -s "$PWD/skills/swarm-it" ~/.claude/skills/swarm-it
ln -s "$PWD/skills/swarm-it" ~/.codex/skills/swarm-it
```

Run only the `ln -s` lines for CLIs you have installed. `--trust` allows this local plugin's backend to run with your account's access, so inspect the code before installation. For Codex Auto approval of eligible Bash requests, install and trust the additional hook:

```sh
node skills/swarm-it/install-codex-hook.mjs
```

Then open `/hooks` in Codex to trust the new hook definition. In Kelpi, select Swarm-it as the permission provider if you want timed Auto decisions from Claude:

```sh
kelpi plugin service-select kelpi.agent.permissions local.swarm-view.permissions
```

Start in a Kelpi workspace inside a Group and say **“swarm it.”** Open the rail from Kelpi's **Swarm** status item or with `ctrl+alt+j`.

For setup checks, troubleshooting, and the exact permission boundaries, see [Setup](docs/setup.md) and [Permissions](docs/permissions.md).

## Under the hood

Swarm-it has two parts: the `local.swarm-view` Kelpi plugin for the rail, results, approvals, and pane actions; and the shared [`swarm-it` skill](skills/swarm-it/SKILL.md) for planning and coordination. Worker results live under `~/.kelpi-swarm/results/`. The plugin has no build step or npm dependencies.

```sh
node --test
kelpi plugin validate .
```

[Feature guide](docs/features.md) · [Setup](docs/setup.md) · [Permissions](docs/permissions.md) · [Historical Claude/Codex implementation plan](docs/claude-codex-plan.md)

## Start fresh without losing the goal

Choose **Fresh session and continue (summarise context)** in a Claude or Codex pane header. A tool-free Sonnet call saves a private summary with the goal, progress, next step, original user goal and recent conversation. This uses your Claude login and usage. The same tool then starts a fresh conversation in the same pane and directory, without resuming the old session ID. The workspace layout and Swarm pane identity stay intact.

The summary comes from the saved transcript, so a conversation at its compaction limit does not need to answer another prompt. Claude starts Opus; Codex uses its configured default. Existing handoff-plan references are carried into the summary. The full old transcript stays on disk. A summary failure leaves the source conversation open. If the new CLI fails to launch after the old one exits, the saved summary and original session ID remain available for recovery. Leave the composer empty and finish background agents first. Historical approvals do not authorise new actions. A 10-second summary deadline keeps the operation within Kelpi's command time limit; a slow summary fails without clearing the conversation.

Disable this action with the **Allow the Fresh session and continue button** plugin setting.

Use this on a coordinator or ordinary conversation. Manifest workers must finish or stop first, so their result tracking cannot accidentally attach to a new session.
