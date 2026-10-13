# swarm-it

Run a swarm of Claude Code workers in [Kelpi](https://github.com/benfriebe/kelpi), and keep track of them
from one sidebar.

You ask your coordinator Claude to "swarm it". It splits the work into tasks and starts one headless Claude
per task. Each worker gets its own pane, out of your way. The **Swarm rail** shows what every worker is
doing, raises their permission prompts so you can answer them in one place, and shows each worker's
result when it finishes.

swarm-it is two parts that work together:

- **The Kelpi plugin** (`local.swarm-view`): the rail, the result view and a few pane tools.
- **The `swarm-it` Claude Code skill** (`skills/swarm-it`): how your coordinator Claude starts and waits for workers.

![The Swarm rail beside a coordinator Claude session](docs/rail.png)

## Features

### Swarm rail

A sidebar list of every worker, grouped by what it needs from you:

- **Needs you**: a worker stopped on a permission prompt. The card shows the exact command. Approve or
  Deny it here without leaving the pane you're working in. Before sending anything, the plugin checks that
  the prompt on screen is still the one you saw.
- **Running**: workers still going, and how long they've taken.
- **Done**: finished workers. Open shows the result, ✕ closes the worker.

Workers move to a separate `<name> · workers` workspace in the same Kelpi Group, so your coordinator keeps
its space. **⌂ Coordinator** takes you back to it. The status bar shows the waiting / running / finished
counts, and `ctrl+alt+j` gives the rail the keyboard.

### Worker results

![A finished worker's result: Goal, Done and Next](docs/thread.png)

Every worker writes a short result with three headings: **Goal**, **Done** and **Next**. The result view
shows them as cards, with buttons to open or reload the file. Send a follow-up from the same view: a
finished worker picks up its own conversation again with your message.

### Auto-approve

For an unattended run, the rail's **Auto** button approves permission prompts for a set time: 10 minutes,
4 hours, 12 hours, or until 9am. It covers every Claude pane, not only swarm workers.

- It's off after every install or reload, and never turns on by itself.
- Some commands are never auto-approved: for example `sudo`, `git reset --hard`, `kubectl delete`,
  `terraform apply`, writes to AWS, and a download piped into a shell. Those stay on the rail for you.
- Every approval and refusal goes in a log (**Swarm: list or clear the auto-approve log** in the palette).

### Run last suggested command

![Run suggested command: check, edit, then run](docs/run-suggested.png)

When Claude asks you to run a command yourself (a line starting `! `, a code block, or a command in its
reply), press `cmd+shift+u` or the pane header button. The plugin finds the last suggestion, rejoins it
where the terminal wrapped it, and shows it in an editable box. Nothing runs until you press **Run**. It can
run in a new shell pane beside Claude, or in another shell pane in the same workspace. **Copy** puts the
fixed command on the clipboard instead.

### Restart Claude

**Restart Claude (quit and resume)** in the pane header or the pane menu quits Claude in that pane and starts
it again on the same conversation. Useful after changing settings, hooks or MCP servers.

## Install

You need Kelpi, Claude Code, and Kelpi's Claude Code hooks (`kelpi install-hooks`).

1. Install the plugin:

   ```sh
   git clone https://github.com/abhayachauhan/swarm-it
   cd swarm-it
   kelpi plugin install . --trust
   ```

   `--trust` lets the plugin's backend run with full access to your machine, so read the code first. To
   share a single file instead, run `kelpi plugin pack . --out swarm-view.kelpi-plugin` and install that.

2. Link the skill into Claude Code:

   ```sh
   ln -s "$PWD/skills/swarm-it" ~/.claude/skills/swarm-it
   ```

3. In a Kelpi workspace that sits inside a Group, ask Claude to "swarm it". Open the rail from the
   status bar's **Swarm** counter or with `ctrl+alt+j`.

## How it works

- `skills/swarm-it/swarm-spawn` splits a pane, adds it to the swarm manifest (`~/.kelpi-swarm/<workspace>.json`),
  and starts `claude -p` on a task file. `swarm-wait` waits until every result file exists.
- Results live in `~/.kelpi-swarm/results/`. The rail refuses to read files outside that folder or a worker's
  trusted worktree.
- The plugin reads worker screens to spot Claude's permission prompts. Approving sends a single Enter, and
  only after a fresh capture confirms the prompt hasn't changed.

Plugin settings (`kelpi plugin settings local.swarm-view`): hide workers in the swarm workspace, default snooze,
coordinator label, manifest folder, and the folders worker worktrees must live in.

## Development

No build step and no npm dependencies.

```sh
node --test               # unit tests, no Kelpi needed
kelpi plugin validate .   # check the manifest offline
```

`scenarios/` holds integration scenarios that run against a private Kelpi instance through `bin/k`, which
refuses to talk to anything but a loopback socket. `contracts/` documents every command and the manifest
format.

## License

[MIT](LICENSE)
