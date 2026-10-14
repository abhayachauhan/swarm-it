// FROZEN at G1. Only the orchestrator may change this file.
// Types shared by backend modules and views. Views receive a SwarmSnapshot; they never compute state.

export type WorkerState = 'running' | 'waiting' | 'done' | 'error';
export type AttentionType = 'Request' | 'Error' | 'Complete';

export interface Worker {
    paneID: string;
    label: string;
    /** Task description from the manifest (may be empty). */
    task: string;
    state: WorkerState;
    /** Whole seconds since the worker was first seen (or since manifest spawn), computed by the backend at snapshot time. */
    elapsedSeconds: number;
    /** Last non-empty line of the pane output ('' when unknown). */
    lastLine: string;
    /** Absolute path of the worker's result markdown, or null. */
    resultPath: string | null;
    /** Absolute path of the worker's git worktree, or null. */
    worktreePath: string | null;
    /** paneID of the spawning worker, or null when spawned by the orchestrator. */
    parent: string | null;
    /** True while the pane lives in the shared Workers workspace (or the swarm's old `<name> · workers`). */
    hidden: boolean;
    /** True once the user pressed Accept (reviewed). */
    accepted?: boolean;
    /** True once archived; archived workers are omitted from the rail but kept in the snapshot. */
    archived?: boolean;
    /** ADDITIVE (rail tidy). True when the worker's pane is gone (seen closing, or missing with its result written).
     *  The rail's Done section then shows Open and ✕ (Remove), and ✕ sends dismiss-worker instead of close-worker.
     *  A pane never seen yet is not closed. */
    paneClosed?: boolean;
}

export interface AttentionItem {
    /** Stable id, `<type>:<paneID>:<createdAt>`. */
    id: string;
    type: AttentionType;
    paneID: string;
    text: string;
    /** Permission-request command read from the pane capture (Request only). */
    command?: string;
    /** sha256 hex of the whole prompt block (header through options, whitespace-normalised). Request only. approve must send it back. */
    promptHash?: string;
    /** ADDITIVE (hardening pass 2), Request only. Whole raw prompt block as captured, for display. */
    promptBlock?: string;
    /** ADDITIVE (hardening pass 2), Request only. false when the prompt shape was not recognised: the card offers no Approve or Deny,
     *  says "Answer in the pane" and has a "Go to pane" button that reveals the pane. Absent means approvable. */
    approvable?: boolean;
    /** ADDITIVE (global requests), Request only. Name of the swarm workspace the card came from. Set on cards from a
     *  swarm other than the followed one; the rail shows it when swarmWorkspaceID differs from the snapshot's workspaceID. */
    swarmName?: string;
    /** ADDITIVE (global requests), Request only. Workspace id of that swarm (its manifest file name). */
    swarmWorkspaceID?: string;
    /** ADDITIVE (global requests), Request only. The pane's manifest label in that swarm; the rail's card heading. */
    paneLabel?: string;
    /** ISO-8601 UTC. */
    createdAt: string;
    /** ISO-8601 UTC absolute due time. Item is hidden from the strip until then. */
    snoozedUntil?: string;
    /** ISO-8601 UTC. Set when approved, denied, accepted or cleared; the item then leaves the strip. */
    handledAt?: string;
}

export interface OrchestratorInfo {
    paneID: string;
    label: string;
    /** How it was identified. */
    source: 'manifest' | 'label' | 'pin';
}

export interface SwarmCounts {
    waiting: number;
    running: number;
    /** done + error, not yet archived. */
    finished: number;
}

/** Full model held by backend/store.mjs and persisted (attention + pins + accepted) in plugin storage. */
export interface SwarmState {
    workspaceID: string | null;
    /** Hidden sibling workspace id once created, else null. */
    hiddenWorkspaceID: string | null;
    orchestrator: OrchestratorInfo | null;
    workers: Worker[];
    attention: AttentionItem[];
    /** Manual pin, if any. */
    pinnedOrchestratorPaneID: string | null;
}

/** ADDITIVE (auto-approve). Off by default and after every reload; never persisted as on. */
export interface AutoApproveState {
    on: boolean;
    /** ISO-8601 UTC end time, or null for "until turned off" (and while off). */
    until: string | null;
    /** ISO-8601 UTC when it was last turned on, null if never. */
    since: string | null;
    /** Auto-approvals since it was turned on (the counts survive a switch-off until the next switch-on). */
    approved: number;
    /** Unrecognised prompts (approvable false) left for the user while on, counted once each. */
    skipped: number;
    /** Approvals the live check refused (STALE, NOT_WORKER, ...); logged with the reason, the card stays. */
    failed: number;
    /** Entries in the persisted log (last 500); `auto-approve-log` returns them newest first. */
    logCount: number;
    /** Panes the rate guard stopped (more than 30 auto-approvals in 10 minutes); their cards are left for the user.
     *  The rail announces each pause once as a footer notice, then keeps it in the Auto toggle's tooltip. */
    paused: { paneID: string; label: string; reason: string; at: string }[];
    /** Set by the last switch-off: by the timer ('expired', announced once in the rail footer) or the user. Null while on or never used. */
    ended: { reason: 'expired' | 'user'; at: string } | null;
}

/** ADDITIVE (auto-approve). One line of the auto-approve log. */
export interface AutoApproveEntry {
    at: string;
    swarmName: string;
    swarmWorkspaceID: string;
    paneID: string;
    label: string;
    command: string;
    ok: boolean;
    /** Present when ok is false: the approve refusal, or 'on the never-auto-approve list'. */
    reason?: string;
    code?: string;
    /** True when the card was left for the user without trying (code 'NEVER'); `rule` names the list entry it matched. */
    skipped?: boolean;
    rule?: string;
}

/** What the backend pushes to views: command `get-state` result and event `local.swarm-view.snapshot` data. */
export interface SwarmSnapshot {
    version: 1;
    /** Monotonic; views drop snapshots with a lower or equal sequence. */
    sequence: number;
    /** ISO-8601 UTC when built. */
    generatedAt: string;
    workspaceID: string | null;
    orchestrator: OrchestratorInfo | null;
    /** Orchestrator is NOT in this list. Order: waiting, error, running, done. */
    workers: Worker[];
    /** Unhandled, not currently snoozed, oldest first. The followed swarm's items, plus Request items from every other
     *  live swarm (tagged with swarmName and swarmWorkspaceID). */
    attention: AttentionItem[];
    /** Unhandled but snoozed. */
    snoozed: AttentionItem[];
    counts: SwarmCounts;
    /** Non-fatal problems (e.g. manifest invalid). The rail logs each new set to the console once and shows a small
     *  "⚠ N" in its header whose click expands them; the footer carries only transient notices. */
    warnings: string[];
    /** ADDITIVE (auto-approve). */
    autoApprove: AutoApproveState | null;
    /** ADDITIVE (rail fixes). Workers (any live swarm) waiting for input whose prompt did not parse on two scans in a row;
     *  never a pane with an open Request, never a worker whose result file exists. Not approvable. */
    waitingPanes?: WaitingPane[];
    /** ADDITIVE (rail fixes). One entry per live swarm other than the followed one. */
    otherSwarms?: OtherSwarmSummary[];
}

/** ADDITIVE (rail fixes). The rail shows "<label> is waiting for you" under Needs you with a Go to pane button. */
export interface WaitingPane {
    paneID: string;
    label: string;
    /** Set when the worker belongs to another live swarm. */
    swarmName?: string;
    swarmWorkspaceID?: string;
}

/** ADDITIVE (rail fixes). */
export interface OtherSwarmSummary {
    workspaceID: string;
    name: string;
    orchestratorPaneID: string;
    /** The swarm workspace's Group colour, one of Kelpi's WorkspaceColor names, or null. */
    color: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray' | 'black' | 'white' | null;
    /** Live workers neither needing you nor finished. */
    running: number;
    /** Panes (workers or coordinator) with an open Request card or a waiting row. */
    needYou: number;
    /** Workers done or stopped with an error. */
    done: number;
}

/** Swarm manifest file, see manifest.schema.json. */
export interface SwarmManifest {
    version: 1;
    orchestrator: { paneID: string; label: string };
    workers: ManifestWorker[];
}

export interface ManifestWorker {
    paneID: string;
    label: string;
    task: string;
    resultPath: string | null;
    worktreePath: string | null;
    parent: string | null;
}

/** Standard command result envelope for every `local.swarm-view.*` command. */
export type CommandResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string; code?: string };
