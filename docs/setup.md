# Setup and first run

## Prerequisites

- [Kelpi](https://github.com/benfriebe/kelpi), with its daemon running.
- Claude Code, Codex CLI, or both, available on the terminal `PATH`.
- A Kelpi workspace inside a Group for the coordinator.

## Install the plugin and skill

```sh
git clone https://github.com/abhayachauhan/swarm-it
cd swarm-it
kelpi plugin validate .
kelpi plugin install . --trust
kelpi install-hooks
```

`--trust` grants the local plugin backend access under your account. Review the code before installing it. Link the skill into every CLI you plan to coordinate from:

```sh
ln -s "$PWD/skills/swarm-it" ~/.claude/skills/swarm-it
ln -s "$PWD/skills/swarm-it" ~/.codex/skills/swarm-it
```

Use only the link lines for CLIs you have installed. If a link already exists, check where it points before replacing it.

## Try a small run

In a Kelpi workspace inside a Group, ask your coordinator:

> Swarm it, all Codex: inspect this repository and give me one implementation idea and one independent review. Keep the tasks short.

Use “all Claude” instead if that is the CLI you installed. Open the **Swarm** status item or press `ctrl+alt+j` to see the rail. Workers appear in the shared Workers workspace; finished workers write Goal / Done / Next files in `~/.kelpi-swarm/results/`.

If Codex reports `Operation not permitted` connecting to Kelpi, its tool sandbox may be blocking the local control socket. Ask Codex to retry the failed spawn through its normal sandbox approval mechanism. Swarm-it's Auto setting does not itself grant that socket access. A failed connection starts no workers; it does not mean the workspace is missing. The helpers validate the coordinator and workspace before registering workers or archiving an earlier result.

## Set up timed Auto approval

Swarm-it's provider must be selected for Claude's structured permission requests:

```sh
kelpi plugin service-select kelpi.agent.permissions local.swarm-view.permissions
kelpi install-hooks
```

Restart Claude sessions that predate the hook change. To let Swarm-it's provider answer eligible Codex Bash requests, install the separate Codex hook:

```sh
node skills/swarm-it/install-codex-hook.mjs
```

Open `/hooks` inside Codex and trust the new hook definition. The installer preserves Kelpi's Codex notification hook. Auto is controlled from the rail and is off after each plugin install or reload. It does not bypass either CLI's normal permission boundary. Read [Permissions](permissions.md) before using it unattended.

## Check the installation

```sh
kelpi doctor --json
kelpi plugin list --json
kelpi plugin services --json
```

Kelpi's doctor can confirm that Codex hooks are installed, but it cannot verify their trust state. Check `/hooks` in Codex if an approval notification does not reach the rail. The plugin also scans a recognised Codex approval menu as a navigation-only fallback when Kelpi reports the pane as waiting or focused.

To update, pull the repository and run `kelpi plugin install . --trust` again. Reloading the plugin turns Auto off, so choose a new timed Auto window in the rail if you still want one.

## Where to go next

- [Feature guide](features.md) for worker allocation, results, handoff, and pane actions.
- [Permissions](permissions.md) for manual and timed approval behavior.
- [`swarm-it` skill](../skills/swarm-it/SKILL.md) for the coordinator's exact worker workflow.
