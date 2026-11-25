# PR watch

When someone asks you to review a pull request, Swarm View starts a review worker for it. It also lists
your own open pull requests with their CI state and whether they wait on you.

Every decision is a fixed rule. No model reads a message to decide whether it is a request.

## Turn it on

1. Install the `review-pr` skill so that `~/.claude/skills/review-pr/SKILL.md` exists. Without it the
   watcher only notifies: it never lets a worker improvise a review.
2. Check `~/.claude/skills/swarm-it/swarm-spawn` and `gh auth status` work.
3. Turn on the plugin setting `prWatchEnabled`.

| Setting | Default | What it does |
| --- | --- | --- |
| `prWatchEnabled` | off | Checks every 3 minutes. Off means no timer and no calls. |
| `prWatchAutoStart` | on | Starts a review worker for each new request. Off only notifies. |
| `prWatchOrgs` | `mr-yum` | GitHub organisations to accept. Anything else is ignored. |
| `prWatchTeamRequests` | on | Also takes requests to your GitHub teams, see below. |
| `prWatchSlackChannels` | empty | Slack channels where any pull request link counts as a request. |

## What counts as a request

**GitHub**

- Requests naming you (`user-review-requested:@me`), however old.
- Requests to one of your teams (`--review-requested=@me`), only on pull requests opened after the first
  check, and at most 30 days back. A large organisation can have hundreds of old team requests, so those
  are never picked up. A team request added later to an older pull request is missed too.

**Slack** (only with a token): messages from the last 3 days that contain a pull request link and match
`github.com pull to:me`, `github.com pull in:@me` or `github.com pull in:#channel` for each listed
channel. Whether `to:me` also returns mentions in channels has not been tried against a real workspace.
List the channels you are asked in to be sure.

**Skipped:** drafts (picked up once ready), your own pull requests, closed ones, and a head commit you
or the watcher already reviewed.

A pull request is reviewed once. It is reviewed again only when the head commit has changed **and** you
are asked again: a re-request on GitHub, a draft turned ready, or a new Slack message with the link. New
commits alone do not start anything.

## What starts

- A worker labelled `review-<repo>-<number>`, model Sonnet, in a child of the `PR reviews` workspace that
  the plugin creates. It runs `/review-pr <url> [slack-permalink]` and writes
  `~/repos/reviews/<repo>-<number>.md`.
- Effort is `high` when `~/repos/swarm-it/skills/review-pr/risk.mjs` says the tier is `deep`, otherwise
  `medium`, including when the script is missing or fails.
- At most 3 review workers at once and 15 a day. The rest wait in order.
- A pull request from a fork is listed and announced, never started: its author may not have write access.
  Run `/review-pr` on it yourself if you want that.
- A new review waits while an earlier worker with the same label is still open. Swarm View's auto clean
  closes a finished worker after `autoCleanMinutes`.
- A worker that closes, or writes its result without a review, counts as failed. One with no heartbeat for
  2 hours is reported in the status bar and keeps its place until you close its pane.
- A failed start is tried 3 times, then the request shows as failed. A start that fails after the worker's
  pane was made is not repeated.
- To retry a failed review, ask for it again after a new commit, or delete its entry from `seen.json`.

### What the worker can be told by other people

The pull request link and Slack permalink are the only text from other people in the worker's task. The
worker then reads the pull request, its comments and the Slack thread itself, in Claude's `auto` permission
mode, with your GitHub and Slack access, like any swarm worker. The task and the `review-pr` skill tell it
to treat all of that as material, and to post nothing. Those are instructions, not a sandbox.

- The sender of a Slack message is not checked: anyone who can message you, including Slack Connect guests,
  can point the watcher at a pull request in your organisations, and can write the thread the worker reads.
- If Swarm View's Auto approve is on, it answers this worker's permission requests too.

Turn `prWatchAutoStart` off to read each request before anything runs.

## The inbox

The status bar shows `PRs <count>`. Clicking it, or running the command below, writes and opens
`~/.kelpi-swarm/pr-watch/inbox.md`: review requests (new, running, done with a link to the review,
failed) and your 30 most recently updated open pull requests, refreshed every 15 minutes.

```sh
kelpi plugin run local.swarm-view.pr-inbox
```

Each new request also raises a Kelpi notification from the `PR reviews` workspace. Muting that workspace
mutes them.

## Slack token

The watcher works on GitHub alone without one.

1. At <https://api.slack.com/apps>, create an app for your workspace.
2. Under **OAuth & Permissions**, add the **User Token Scope** `search:read`. A bot token cannot search.
3. Install the app to the workspace. A Slack admin may have to approve it first.
4. Copy the **User OAuth Token** (`xoxp-...`) and store it in the Keychain. The command prompts for the
   token, so it stays out of your shell history:

```sh
security add-generic-password -s swarm-pr-watch-slack -a slack -w
```

To replace it, add `-U` before `-w`. To remove it:
`security delete-generic-password -s swarm-pr-watch-slack`.

The token is read from the Keychain at each check and sent only to `slack.com` in the `Authorization`
header. It is never written to a file, an environment variable or a log. Any program running as you can
read it with the same `security` command.

## When something looks wrong

- The status bar tooltip and the top of the inbox show the last check's warnings.
- State is in `~/.kelpi-swarm/pr-watch/seen.json`. If it is damaged the watcher stops, so it cannot review
  everything again. Fix it, or delete it to start over.
- The backend logs one JSON line per check (`pr_watch.tick`, with running totals of started, done, failed
  and failed starts) and one per start, finish and failure.
- Only one check runs at a time, held by `~/.kelpi-swarm/pr-watch/lock`. A lock left by a stopped plugin
  is taken over.
- To stop it, turn `prWatchEnabled` off. Workers already running carry on until you close them.
