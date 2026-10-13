# swarm-it

Kelpi plugin `local.swarm-view`: a right-sidebar thread list for an orchestrator and its workers.
Build-free, no npm dependencies. Do not run npm or pnpm here.

## Install

    kelpi plugin pack . --out swarm-view.kelpi-plugin
    kelpi plugin install swarm-view.kelpi-plugin --trust

`--trust` runs the plugin's backend with full access to your machine, so read it first.

## Contracts (frozen at G1)

`kelpi.plugin.json`, `contracts/commands.md`, `contracts/state.d.ts`, `contracts/manifest.schema.json`.
Only the orchestrator changes them. Focus chord: `ctrl+alt+j`.

## Skill

`skills/swarm-it` is the Claude Code skill that spawns workers into the rail. Install it once with a link,
so edits here are live:

    ln -s "$PWD/skills/swarm-it" ~/.claude/skills/swarm-it

## Validate (offline, no daemon, allowed without the wrapper)

    kelpi plugin validate .

## Tests

    node --test

Backend modules take the API object as an argument, so unit tests need no Kelpi runtime.

## Private Kelpi CLI

Never call bare `kelpi` except `plugin validate`. Use the wrapper, which refuses to run unless
`SWARM_VIEW_SOCKET` starts with `tcp:127.0.0.1:` and sets `KELPI_SOCKET` and `KELPI_REQUIRE_SOCKET=1`.
Point `KELPI_CLI` at a Kelpi checkout's built CLI:

    KELPI_CLI=~/src/kelpi/packages/cli/dist/kelpi.js SWARM_VIEW_SOCKET=tcp:127.0.0.1:56353 bin/k plugin list

Never install into a live daemon from this repo.
