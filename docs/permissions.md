# Approval requests in Swarm-it

Swarm-it keeps Claude and Codex requests visible in the Kelpi rail. The two CLIs use different approval menus, so their manual actions differ.

| Request | In the rail | How it is answered |
| --- | --- | --- |
| Claude Code | Command card with **Approve** and **Deny** when the menu is recognised | The plugin captures the live prompt twice and sends a single key only if the prompt still matches the card. |
| Codex CLI | Navigation card with **Go to pane** | Answer the native Codex prompt in its pane. The plugin never presses Claude-style approval keys in Codex. |
| Codex queued question | **Needs you** card with the shortcut Codex displays | Open the pane and press the shown shortcut (currently **Shift+Left Arrow**) to see and answer the question. Questions are never automatically answered. |

When Kelpi's Codex hook announces a request, the card can appear even if Kelpi has not populated the pane's agent field. The plugin also recognises Codex's current approval menu while scanning a waiting or focused pane. An unrecognised Claude prompt is shown with **Answer in the pane** instead of unsafe approval buttons.

## Timed Auto

The rail's **Auto** control offers 10 minutes, 4 hours, 12 hours, or until 9am. It is off after every plugin install or reload and never turns on by itself. Approvals and refusals are recorded in the Auto log; the rail shows when the selected provider is not active.

For Claude, Kelpi's `kelpi.agent.permissions` service sends the structured request to Swarm-it when it is the selected provider. If the provider is unavailable, the plugin can use its screen fallback for recognised Claude menus. Only one path sends the answer. For Codex, Swarm-it's additional `PermissionRequest` hook asks the selected provider about Bash requests. An abstention leaves Codex's own prompt in place. Codex `apply_patch` and MCP approvals stay native.

The policy leaves risky or unclear operations for you: examples include `sudo`, destructive Git commands, writes to AWS, infrastructure apply/delete commands, shell pipelines that fetch and run code, multiline or very long Bash input, paths that cannot be safely resolved, writes to agent settings or shell startup files, and tools whose effects are unclear. It also rate-limits a pane after repeated auto approvals. A harmless command can still be left for manual review when the policy cannot establish that it is safe.

Turning Auto off causes the provider to abstain. For a Claude pane where the agent has exited, the plugin will not press Enter even if an old prompt remains visible. The Auto log is available through **Swarm: list or clear the auto-approve log** in Kelpi's command palette.

## Hooks and headless workers

```sh
kelpi plugin service-select kelpi.agent.permissions local.swarm-view.permissions
kelpi install-hooks
node skills/swarm-it/install-codex-hook.mjs
```

Trust the new Codex hook with `/hooks` inside Codex. Restart Claude sessions started before a hook change. Kelpi's hook diagnostic checks installation, not trust.

Claude headless workers cannot display a prompt. If Kelpi asks the provider and Swarm-it abstains, the request may be denied by Claude rather than shown as a card. This case has not been verified live. Use a mode that asks in an interactive pane for work likely to need manual approval.
