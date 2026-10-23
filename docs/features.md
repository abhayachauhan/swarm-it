# What swarm-it can do

Swarm-it combines a Kelpi sidebar plugin with one shared skill for Claude Code and Codex. The skill coordinates work; the plugin makes its workers, requests, and results visible.

## Pick the team

Tell the coordinator what outcome you want and, if you care, who should do each part:

| Request | Suggested allocation |
| --- | --- |
| “Swarm it, all Codex.” | Codex coordinates, implements, and reviews. |
| “Swarm it, all Claude.” | Claude coordinates, implements, and reviews. |
| “Have Codex implement and Claude review.” | Codex changes the code; Claude reviews the actual diff afterward. |
| “Have Claude implement, then get two Codex reviews.” | Claude changes the code; Codex workers can review separate concerns. |

The coordinator writes a task for each independent worker, starts workers in Kelpi, waits for their result files, and reconciles findings. A review should start after the implementation diff exists. The skill defaults to the coordinator's CLI when you do not specify an agent; worker creation defaults to Claude for compatibility, so a Codex coordinator passes `--agent codex` when choosing Codex workers.

## Follow the work from one rail

The rail groups active workers into **Needs you**, **Running**, and **Done**. A request card leads you to the exact pane. Claude's recognised permission menus can be approved or denied in the rail after the plugin rechecks the live prompt. Codex approval cards navigate to the Codex pane; Codex keeps control of its own approval menu. Timed **Auto** can answer eligible requests through the configured hooks. See [Permissions](permissions.md) for the boundary.

Workers live together in a shared **Workers** workspace inside a collapsed Group. The coordinator keeps its own pane. The rail also shows work from other live swarms when a permission request needs attention.

Each worker writes a result with **Goal**, **Done**, and **Next**. Open the result view to read it, reload the file, or send a follow-up to the same worker conversation. If a worker exits without a result, Kelpi hook events can turn that into a stopped row with a reason. `swarm-wait` reports the failure to the coordinator.

Web URLs and Markdown web links in a result are clickable and open in a Kelpi web pane. In a Codex terminal pane, Kelpi 0.2.22 supports a plain click on a web link to choose **Open in Kelpi**, **Open in Browser**, or **Copy Link**; ⌘-click opens it directly according to Settings → General → Links. Kelpi also recognises Codex's OSC 8 links, whose visible title may hide the URL. Local source-file references are not currently opened by Kelpi's terminal link handler; it opens existing Markdown and CSV/TSV paths. Copy a source path from the terminal if you need to open it elsewhere.

Finished worker panes close after 10 minutes by default. The result stays on disk. A dirty worktree stays open so it can be inspected. Set `autoCleanMinutes` to `0` to turn off automatic pane cleanup.

## Hand the goal to the other CLI

**Hand off to other CLI** in a pane's header or pane menu uses that pane's session ID to find its exact local transcript. The plugin opens a new pane in the same working directory, starts the other CLI with instructions to summarize the goal and continue, then closes the source after sending the target command. A missing ID or transcript leaves the source open.

For a conversational handoff, ask the current agent to “hand this goal to Codex” or “hand this goal to Claude.” It writes a short **Goal / Key points / Next** summary in a private file under `~/.kelpi-swarm/handoffs/`, and the receiving CLI starts with that file as context. The target checks current files before changing them. Neither CLI can resume the other CLI's session ID directly.

## Small pane conveniences

- **Run last suggested command:** when Claude suggests a shell command, `cmd+shift+u` opens an editable preview. Terminal line wraps are rejoined; you choose **Run** or **Copy**. Nothing executes until you choose Run.
- **Restart Claude/Codex:** detect the CLI in the pane, quit it, and resume the same conversation after changing hooks, settings, or MCP servers. Codex reports its current session through `/status`, so restart works even when its session hook was missed. Wait for it to finish and clear any draft before restarting.
- **Review and retry:** keep implementation and review in separate workers; `swarm-retry` restarts a dead worker from its saved task and settings when possible.

## Files and scope

- Manifests: `~/.kelpi-swarm/<workspace-id>.json` by default.
- Results: `~/.kelpi-swarm/results/` by default.
- Handoffs: `~/.kelpi-swarm/handoffs/` by default.
- Exit records: `~/.kelpi-swarm/exits/` by default.

The `manifestDir` plugin setting and `SWARM_MANIFEST_DIR` for CLI helpers can move the manifest root. The plugin checks result paths before reading them. It does not migrate a live conversation between Claude and Codex; handoff gives the receiving CLI a transcript or a summary so it can continue the goal.
