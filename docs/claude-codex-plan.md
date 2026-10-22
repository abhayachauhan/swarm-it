# Claude and Codex support plan

> Historical implementation plan from October 2026. Versions and remaining checks below describe that planning snapshot. For current behavior, see the [README](../README.md), [feature guide](features.md), and [setup guide](setup.md).

## Current baseline (22 October 2026)

- This checkout is `local.swarm-view` 0.1.0. Worker creation and retry launch `claude -p`; the manifest has no agent kind. Follow-up, restart, prompt recognition, auto-approve fallback, and “run suggested command” contain Claude-specific behavior.
- The installed terminal is Kelpi 0.2.19; the latest published release is 0.2.20. The installed Codex CLI is 0.163.0. `kelpi install-hooks --dry-run --json` reports both Claude and Codex hooks unchanged, and `kelpi doctor --json` passes both hook checks. A live daemon check through `tcp:127.0.0.1:54680` also succeeded once access was granted.
- Kelpi's current lifecycle API reports Codex agent status and session IDs. Its installed Codex `PermissionRequest` hook currently calls `kelpi event notification --agent codex`, and its documented `permission-request --agent codex` path exits without asking a provider. Codex itself supports typed `PermissionRequest` hook decisions, so this is a missing bridge in Kelpi's integration, not a missing Codex capability.

## Target behavior

The coordinator can be Claude or Codex, and each worker can be Claude or Codex. The rail identifies the worker's agent, tracks progress and exit, shows results, and resumes the correct conversation. The same Swarm-it Auto policy handles approval requests from either CLI through their structured hooks. A missing or untrusted Codex permission bridge leaves the native Codex prompt for the user. Existing Claude swarms and version 1 manifests continue to work.

## Implementation sequence

1. **Introduce an agent adapter and manifest field.** Add `agent: "claude" | "codex"` to worker records, defaulting absent values to `claude` for old manifests. Include the agent kind in snapshots, result views, retry records, and ownership checks. Centralize launch, resume, session validation, and input detection by agent instead of branching throughout the backend. Keep the manifest version at 1 if the new field is optional; change the schema, validator, writer, and contract together.
2. **Make spawning and retrying explicit.** Add `swarm-spawn --agent claude|codex` and preserve the kind in `swarm-retry`. Keep Claude's current command. For Codex, use `codex exec` with a task prompt read safely from a file or stdin, a workspace-write sandbox, optional `--model`, and `--output-last-message` to write the existing Goal/Done/Next result file. Do not map Claude's `--permission-mode auto` to a Codex bypass flag. Capture the exact Codex session ID from structured `--json` events, never select `--last` from a shared directory. Record process exit and missing-result reasons in the wrapper because Kelpi's Codex hooks have no `SessionEnd` event.
3. **Use the right agent for follow-up and restart.** Route Claude workers through the existing `claude -p --resume <id>` flow. Route Codex workers through `codex exec resume <id>` and write the updated result atomically. Restrict the existing Restart Claude action to Claude panes; add a Codex restart/resume action only after its input and exit detection can be verified. The rail and thread should show `Claude` or `Codex` and use agent-neutral labels elsewhere.
4. **Connect Codex's structured approval hook.** Prefer a small Kelpi change: have its Codex `PermissionRequest` hook call a request/reply CLI path, normalize `tool_name` and `tool_input` to `kelpi.agent.permissions`, and translate `allow`/`deny`/`abstain` back to Codex's hook JSON. Preserve the existing waiting notification when the provider abstains. Alternatively, a Swarm-it hook wrapper can call the selected provider through `kelpi plugin service-call` if that path is verified to fit Codex's hook timeout and selection rules; this could ship without an upstream Kelpi release. Extend the policy evaluator to Codex's `Bash`, `apply_patch`, and MCP input shapes, retaining its current rate and never-approve rules. Test the exact hook payload and response against the installed Codex CLI before enabling Auto for Codex.
5. **Keep terminal input agent-specific.** Keep Claude's screen parser and Enter-based approval Claude-only as a fallback. Use Codex's hook payload for approval decisions; screen capture can show a Codex prompt in the rail, but simulated approval keystrokes should not be the decision path. Treat Codex suggested commands as text to copy or run in a new shell pane. Do not send Claude's `!` syntax into a Codex pane. Test both agent UI shapes before allowing direct input into an idle pane.
6. **Update coordinator installation.** Make `skills/swarm-it/SKILL.md` usable from both `~/.claude/skills/swarm-it` and `~/.codex/skills/swarm-it`, with CLI paths resolved from the skill directory rather than a hard-coded `~/.claude` path. Document mixed swarms, per-agent flags, permission behavior, and the required Codex hook trust step. Update the README and examples.
7. **Kelpi terminal work.** Update the installed app from 0.2.19 to the published 0.2.20 release, preserving the running daemon and panes via Kelpi's update path. Add the Codex approval bridge to Kelpi or install the verified Swarm-it hook wrapper. Re-run `kelpi install-hooks --dry-run --json`, apply only needed hook changes, then use `/hooks` in Codex to trust changed hooks. Run `kelpi doctor --json` from a Kelpi pane to verify daemon routing and both hook chains. If the bridge is unavailable, show Codex requests in its native UI and keep Swarm-it Auto limited to Claude.

## Verification and release gates

- Unit tests: old manifest loads as Claude; mixed manifest round-trips; spawn/retry commands and session IDs are agent-specific; Codex never takes Claude's keystroke approval or `!` command path; a missing result or interrupted approval produces a visible stopped state; both hook formats produce the same policy outcome.
- Integration: run one Claude worker, one Codex worker, and a mixed swarm in a private Kelpi instance; verify status, results, follow-up, restart, auto-clean, and pane targeting. Exercise real Codex allow, abstain, and deny requests before enabling Auto for Codex.
- Deployment: `node --test`, `kelpi plugin validate .`, install/reload the updated plugin, install the Codex skill, run Kelpi doctor from the live terminal, and verify one end-to-end Codex worker. Record the Kelpi and Codex versions used.

## Decisions to make during implementation

- Choose the default worker agent: preserve Claude for existing users; let a Codex coordinator explicitly request Codex workers until a user-facing default setting is added.
- Choose the approval bridge after measuring the existing `plugin service-call` path against Codex's hook timeout. Prefer the upstream Kelpi path if the wrapper would require a separate configuration lifecycle or weaken provider selection.

## Implementation notes

The initial implementation uses interactive Codex workers with `--sandbox workspace-write` and `--ask-for-approval on-request`. This keeps the native approval UI and Kelpi's existing Codex lifecycle hooks available. A separate Swarm-it `PermissionRequest` hook calls the selected Kelpi permission provider for Bash requests; abstentions leave Codex's native prompt. Other Codex tool types are left to Codex. Follow-up uses `codex queue --thread <session-id>`; the existing Claude restart action remains Claude-only.

The shared skill and Codex hook are installed locally. Codex still requires the user to trust the new hook with `/hooks` in a Codex session. The app update to Kelpi 0.2.20 and an end-to-end worker trial remain deployment checks.
