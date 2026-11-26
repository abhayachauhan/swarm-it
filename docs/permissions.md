# Approval requests in Swarm-it

Swarm-it keeps Claude and Codex requests visible in the Kelpi rail. The two CLIs use different approval menus, so their manual actions differ.

| Request | In the rail | How it is answered |
| --- | --- | --- |
| Claude Code | Command card with **Approve** and **Deny** when the menu is recognised | The plugin captures the live prompt twice and sends a single key only if the prompt still matches the card. |
| Codex CLI | Navigation card with **Go to pane** | Answer the native Codex prompt in its pane. The plugin never presses Claude-style approval keys in Codex. |
| Codex queued question | **Needs you** card with the shortcut Codex displays | Open the pane and press the shown shortcut (currently **Shift+Left Arrow**) to see and answer the question. Questions are never automatically answered. |

When Kelpi's Codex hook announces a request, the card can appear even if Kelpi has not populated the pane's agent field. The plugin also recognises Codex's current approval menu while scanning a waiting or focused pane. An unrecognised Claude prompt is shown with **Answer in the pane** instead of unsafe approval buttons.

## Auto approve

Auto is on from the first start and stays on until you turn it off; your choice is saved, so a reload or a Kelpi restart keeps it. Turn it off in the rail and the **Auto** control offers five ways back on: 10 minutes, 4 hours, 12 hours, until 9am, or no time limit. A timed window saves its end time with the choice. After a reload during the window, Auto is on for the time that is left. Once the end has passed, Auto stays off and the rail says it expired. Approvals and refusals are recorded in the Auto log, each with the policy that decided it (`floor` or `careful`); the plugin also logs the policy once when it starts. The rail shows when the selected provider is not active.

For Claude, Kelpi's `kelpi.agent.permissions` service sends the structured request to Swarm-it when it is the selected provider. If the provider is unavailable, the plugin can use its screen fallback for recognised Claude menus. Only one path sends the answer. For Codex, Swarm-it's additional `PermissionRequest` hook asks the selected provider about Bash requests. An abstention leaves Codex's own prompt in place. Codex `apply_patch` and MCP approvals stay native.

### The floor

By default Auto uses the **floor** policy: it approves every Bash, Monitor, file and MCP request except these, which stay with you:

- **AWS writes.** Any `aws` call that is not known to read. Also AWS changes made without the AWS CLI: `cdk` deploy, destroy, bootstrap, watch, rollback and import, `sam` deploy, delete, sync, package and publish, `copilot` deploy and delete, `eb` deploy, create, terminate, swap and clone, `amplify` publish, push, delete and remove, and a `docker push` (or `--push`) that names an Amazon ECR registry or an image name the shell fills in.
- **Terraform.** `terraform`, `terragrunt` and `tofu` apply and destroy, and the commands that change state without an apply: `import`, `state rm`, `state mv`, `state push`, `state replace-provider`, `taint`, `untaint` and `force-unlock`. A pull request comment or MCP text that says `atlantis apply`, `atlantis import` or `atlantis state` is left too. `atlantis plan` is not.
- **Agent settings.** Writes to Claude and Codex settings and config, `~/.claude.json`, `.mcp.json` and the hooks folders, so an agent cannot change its own permission rules.
- **MCP tools that send, share or delete.** A tool name with send, post, reply, forward, share, publish, delete, trash, remove or archive in it, or schedule then message (`slack_send_message`, Gmail `forward`, Drive `share_file`). Drafts and reads stay approved.
- **Commands whose words the shell only builds at run time** (`$CMD apply`, `eval`, `git -c alias.x=…`, `env -S`), because they could spell any of the above. Also code handed to an interpreter that names `aws`, `terraform`, `terragrunt`, `tofu` or a deploy tool as a string (`spawnSync('terraform', ['apply'])`).
- **A script written now and run later.** `Write`, `Edit` and `MultiEdit` of a shell script are read as shell, so `terraform apply` inside `deploy.sh` is left when it is written. A Makefile, and any Python, JavaScript, TypeScript, Ruby, Perl or `package.json` file, are read for string literals that hold such a call, or for a bare program name beside a call that runs programs.
- **Anything that cannot be read in time or followed to where it lands:** input over 4,096 characters (shell scripts too), a file write whose real location cannot be found, an Edit or Write card seen only on the screen, and a Tool use card whose tool name cannot be read.

A pane is paused after repeated automatic approvals.

The floor guards against honest mistakes by a well-meaning agent, not against one that deliberately disguises a command. These limits are accepted: a command spelled with string joins in Python, `git -c`, `npx --call`, `env --split`, a quote placed inside `atlantis`, an `Edit` of a script that has no known file extension (the `#!` line is not in the edit), a `docker buildx bake` with no push flag whose file pushes, tools such as `serverless` and `pulumi` that are not named above, and MCP tools whose names are outside the send list (`create_comment`, `add_reaction`, `respond_to_event`). Writes to git hooks and shell startup files, and requests to run outside the sandbox, are approved.

### The careful policy

Start Kelpi with `SWARM_AUTO_APPROVE_POLICY=careful` for the stricter policy that Auto used before the floor. It also leaves `sudo`, destructive Git commands, shell pipelines that fetch and run code, multiline or very long Bash input, writes to git config and shell startup files, requests to run outside the sandbox, and MCP tools whose name does not say they only read.

Turning Auto off causes the provider to abstain. For a Claude pane where the agent has exited, the plugin will not press Enter even if an old prompt remains visible. The Auto log is available through **Swarm: list or clear the auto-approve log** in Kelpi's command palette.

## Hooks and headless workers

```sh
kelpi plugin service-select kelpi.agent.permissions local.swarm-view.permissions
kelpi install-hooks
node skills/swarm-it/install-codex-hook.mjs
```

Trust the new Codex hook with `/hooks` inside Codex. Restart Claude sessions started before a hook change. Kelpi's hook diagnostic checks installation, not trust.

Claude headless workers cannot display a prompt. If Kelpi asks the provider and Swarm-it abstains, the request may be denied by Claude rather than shown as a card. This case has not been verified live. Use a mode that asks in an interactive pane for work likely to need manual approval.

## Answer Codex questions centrally

A queued Codex question card offers **Answer here** and **Go to pane**. **Answer here** connects to the existing local Codex shared daemon and lists its pending structured questions, labelled with their session names and IDs. Select an option or type your own clarification, then press **Send answer**. Swarm supports both blocking question dialogs and the non-blocking questions shown under **Queued follow-up inputs**, including questions asked before **Answer here** was opened. Codex accepts the reply and the terminal clears its matching question too. Auto mode never supplies clarification answers.

The connection continues receiving questions from those sessions. Answers from another client remove the matching questions. Finished turns and ordinary follow-up messages clear older queued questions. Press **Refresh** to discover newly started sessions or reconnect. The list covers sessions on that local daemon, including sessions outside the current Kelpi workspace. **Go to pane** is also offered on a structured question when Kelpi knows its exact session ID; the original notification always retains its pane link. Swarm never guesses a session from a shared working directory.

Requires a recent shared-daemon Codex CLI and Node with native WebSocket support (validated with Codex 0.164.0 and Node 24). Remote Codex servers and `--no-daemon` sessions retain **Go to pane**. This feature handles structured clarification questions; native Codex permission approvals still use their existing path. Drafts stay in memory. Answers are sent to Codex and become part of its conversation, without being saved in plugin storage or its approval log. Secret fields use password inputs.


Codex can pause on **Trust this folder?** before a worker session starts. Swarm shows **Folder trust required** with **Trust folder and continue** and **Go to pane**, even if Kelpi reports an idle shell with no session ID. The card shows Codex’s folder and repository scope. Clicking **Trust folder and continue** explicitly saves repository trust; the plugin verifies the same live prompt and sends one guarded Enter. Auto never answers this prompt. If a retry created another attempt, approve only the worker you intend to run so both do not edit the same worktree.
