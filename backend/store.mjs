// Pane snapshot plus swarm model. buildSnapshot is synchronous and uses caches filled by refreshWorker.
import { visibleItems, snoozedItems, toMs } from './attention.mjs';
import { checkResultPath, readResultSafely, withTimeout, READ_TIMEOUT_MS } from './safepath.mjs';
import { createHash } from 'node:crypto';

export const textHash = text => createHash('sha256').update(String(text)).digest('hex');
/** Claude session ids are UUIDs; anything else is never typed into a shell. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

const STATE_ORDER = { waiting: 0, error: 1, running: 2, done: 3 };
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const DECOR_ONLY = /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝▀▄█▌▐░▒▓·•>❯]*$/u;

export const DEFAULT_SETTINGS = { autoHide: true, snoozeMinutes: 15, coordinatorLabel: 'coordinator', manifestDir: '', worktreeRoots: '' };

/** A pane capture that has not answered by then counts as failed: one hung pane must never stall the serial queue. */
export const CAPTURE_TIMEOUT_MS = Number(process.env.SWARM_CAPTURE_TIMEOUT_MS) || 2000;

/** terminal.capture with CAPTURE_TIMEOUT_MS. Rejects (code TIMEOUT) like any failed capture. */
export function capturePane(api, paneID, lines) {
    return withTimeout(Promise.resolve().then(() => api.terminal.capture(paneID, { lines })), CAPTURE_TIMEOUT_MS, `capturing pane ${paneID}`);
}

/**
 * FAIL-CLOSED gate for every action on a manifest worker: the pane must be in the manifest, exist in the snapshot,
 * have a workspaceID, and that workspace must be allowed. An unknown pane or a missing workspaceID is refused.
 */
export function actionableWorker(store, paneID) {
    const w = store.manifestWorkers.find(x => x.paneID === paneID);
    if (!w) return null;
    const workspaceID = store.panes.get(paneID)?.workspaceID;
    if (typeof workspaceID !== 'string' || !workspaceID || !store.allowedWorkspace(workspaceID)) return null;
    return w;
}

/** An orchestrator pane may be acted on only when it exists, has a workspaceID and that workspace is allowed. */
export function actionableOrchestrator(store, paneID) {
    if (!store.orchestrator || store.orchestrator.paneID !== paneID) return false;
    const workspaceID = store.panes.get(paneID)?.workspaceID;
    return typeof workspaceID === 'string' && !!workspaceID && !!store.allowedWorkspace(workspaceID);
}

/** Live swarms other than the followed one. index.mjs fills store.swarms from every manifest it can read. */
export function otherSwarms(store) {
    return store.swarms.filter(s => !(store.manifest && s.workspaceID === store.workspaceID));
}

const workersName = swarm => `${swarm.name} · workers`;

/**
 * FAIL-CLOSED gate for a Request on a pane of another live swarm (approve, deny, notification, scan). The swarm's
 * orchestrator pane must still live in the workspace its manifest file is named after, and the pane must be that
 * swarm's orchestrator or a listed worker, living in the swarm's workspace or its `<name> · workers` workspace.
 * @returns {{ swarm: object, label: string, role: 'worker' | 'orchestrator' } | null}
 */
export function otherSwarmPane(store, paneID) {
    const workspaceID = store.panes.get(paneID)?.workspaceID;
    if (typeof paneID !== 'string' || typeof workspaceID !== 'string' || !workspaceID) return null;
    for (const swarm of otherSwarms(store)) {
        if (store.panes.get(swarm.orchestrator.paneID)?.workspaceID !== swarm.workspaceID) continue;
        const allowed = workspaceID === swarm.workspaceID || (!!swarm.name && store.workspaceNames.get(workspaceID) === workersName(swarm));
        if (!allowed) continue;
        if (swarm.orchestrator.paneID === paneID) return { swarm, label: swarm.orchestrator.label, role: 'orchestrator' };
        const worker = swarm.workers.find(w => w.paneID === paneID);
        if (worker) return { swarm, label: worker.label, role: 'worker' };
    }
    return null;
}

/**
 * While auto-approve is on, a Claude pane outside any swarm may raise and answer a Request too: the user asked for
 * every permission prompt to be approved, not only a swarm's. It must be a terminal with a live agent session.
 */
export function anyClaudePane(store, paneID) {
    if (!store.auto?.on || typeof paneID !== 'string') return false;
    const pane = store.panes.get(paneID);
    return !!pane && (pane.type ?? 'shell') === 'shell' && typeof pane.workspaceID === 'string' && !!pane.workspaceID && !!(pane.agent || pane.agentSessionID);
}

/** Does any ownership gate still accept a Request on this pane (a swarm's worker or orchestrator, or any Claude pane while auto-approve is on)? */
export const ownedRequestPane = (store, paneID) => !!actionableWorker(store, paneID) || actionableOrchestrator(store, paneID) || !!otherSwarmPane(store, paneID) || anyClaudePane(store, paneID);

export function createStore(api) {
    return {
        api,
        /** Monotonic across reloads: views drop snapshots with a lower or equal sequence. */
        sequence: Date.now(),
        workspaceID: null,
        workspaceName: null,
        hiddenWorkspaceID: null,
        /** The empty shell pane the host put in the workers workspace this plugin created; closed once a worker moved in. */
        hiddenShellPaneID: null,
        createdHiddenWorkspaceID: null,
        createdHiddenAt: 0,
        /** Set once a view reports the workspace the user is in: only that workspace's swarm is shown. */
        followWorkspaceID: null,
        orchestrator: null,
        manifest: null,
        manifestPath: null,
        /** Every worker the manifest lists; manifestWorkers is the subset living in the swarm's workspaces. */
        manifestAll: null,
        /** Is this workspace the orchestrator's or the plugin's hidden workers workspace? index.mjs replaces it. */
        allowedWorkspace: () => true,
        manifestWorkers: [],
        /** Every live swarm: { workspaceID, name, orchestrator, workers }. Only their Request cards are shown globally. */
        swarms: [],
        /** Worker pane id to { misses, label, swarmName, swarmWorkspaceID } while it waits for input with no prompt parsed. */
        unparsed: new Map(),
        panes: new Map(),
        workspaceNames: new Map(),
        lastLines: new Map(),
        resultExists: new Map(),
        errored: new Set(),
        gone: new Set(),
        seenRunning: new Set(),
        firstSeen: {},
        accepted: new Set(),
        archived: new Set(),
        restored: new Set(),
        /** paneID to the last Claude session id Kelpi reported for it. Kelpi clears its own copy when Claude exits; this one is kept so a finished worker can be resumed. */
        sessions: new Map(),
        /** paneID to the sha256 of the result file when the worker was restarted: that file does not count as done until it changes. */
        restarts: new Map(),
        /** Restarted panes whose new Claude has been seen running (in memory): its exit ends the restart. */
        restartRan: new Set(),
        attention: [],
        pinnedOrchestratorPaneID: null,
        warnings: [],
        /** Auto-approve state (backend/autoapprove.mjs createState); index.mjs fills it. */
        auto: null,
        settings: { ...DEFAULT_SETTINGS },
        att: null,
        /** Result file reader (path already policy-checked). The host may supply api.files.readVerified; default opens the file safely. */
        readFile: api?.files?.readVerified ?? null,
        /** Directory lister (file names). The host may supply api.files.list; default is fs.readdir. */
        listDir: api?.files?.list ?? null,
        /** "Is this a real git worktree" check; default looks for a .git entry. */
        isWorktree: api?.files?.isGitWorktree ?? null,
        readTimeoutMs: READ_TIMEOUT_MS
    };
}

/** Context checkResultPath needs about a worker's live pane. */
export const resultContext = (store, paneID) => ({ pane: store.panes.get(paneID), ...(store.isWorktree ? { isWorktree: store.isWorktree } : {}) });

/**
 * Read an already-checked result path through the safe reader, never throwing and never waiting longer than readTimeoutMs.
 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string, code: string }>}
 */
export async function readResultText(store, path) {
    const reader = store.readFile ?? readResultSafely;
    try {
        return await withTimeout(Promise.resolve(reader(path)), store.readTimeoutMs ?? READ_TIMEOUT_MS, 'reading the result file');
    } catch (error) {
        return { ok: false, code: error?.code === 'TIMEOUT' ? 'TIMEOUT' : 'NO_RESULT', error: String(error?.message ?? error) };
    }
}

/**
 * Apply one host state change (an element of `state.changed` event data).
 * @returns {{ kind: 'new' | 'status' | 'updated' | 'removed', paneID: string, from?: string, to?: string }[]}
 */
export function applyStateChange(store, change, now) {
    if (!change || typeof change !== 'object') return [];
    if (change.kind === 'workspace-upserted') {
        const id = change.workspace?.id ?? change.workspaceID ?? change.id;
        const name = change.workspace?.name ?? change.name;
        if (id && typeof name === 'string') store.workspaceNames.set(id, name);
        return [];
    }
    if (change.kind === 'workspace-removed') {
        store.workspaceNames.delete(change.id ?? change.workspaceID);
        return [];
    }
    if (change.kind === 'pane-removed') {
        const paneID = change.paneID;
        const prev = store.panes.get(paneID);
        // A move between workspaces can report a removal at the OLD location; ignore it.
        if (!prev || (change.workspaceID && prev.workspaceID && change.workspaceID !== prev.workspaceID)) return [];
        store.panes.delete(paneID);
        store.gone.add(paneID);
        return [{ kind: 'removed', paneID, from: prev.status }];
    }
    if (change.kind !== 'pane-upserted') return [];
    const pane = change.pane ?? {};
    const paneID = change.paneID ?? pane.id;
    if (typeof paneID !== 'string' || !paneID) return [];
    const prev = store.panes.get(paneID);
    const record = {
        id: paneID,
        label: pane.label ?? prev?.label ?? null,
        title: pane.title ?? prev?.title ?? null,
        status: pane.status ?? prev?.status ?? 'idle',
        workspaceID: change.workspaceID ?? pane.workspaceID ?? prev?.workspaceID ?? null,
        workspaceName: pane.workspaceName ?? prev?.workspaceName ?? null,
        agent: pane.agent ?? pane.agentKind ?? prev?.agent ?? null,
        // The live session: null once Claude exits (Kelpi clears it on session end).
        agentSessionID: 'agentSessionID' in pane ? (pane.agentSessionID ?? null) : (prev?.agentSessionID ?? null),
        type: pane.type ?? prev?.type ?? null,
        workingDirectory: pane.workingDirectory ?? prev?.workingDirectory ?? null
    };
    store.panes.set(paneID, record);
    store.gone.delete(paneID);
    rememberSession(store, paneID, pane.agentSessionID);
    if (!store.firstSeen[paneID]) {
        const created = Date.parse(pane.createdAt ?? '');
        store.firstSeen[paneID] = new Date(Number.isNaN(created) ? toMs(now) : created).toISOString();
    }
    if (record.status === 'running') { store.seenRunning.add(paneID); store.errored.delete(paneID); }
    // A restarted Claude that ran and has exited (session ended, pane back at its shell) ends the restart, so an
    // unchanged result reads done again instead of waiting forever.
    if (store.restarts.has(paneID)) {
        if (record.status === 'running' || record.agentSessionID) store.restartRan.add(paneID);
        else if (store.restartRan.has(paneID) && record.status === 'idle') {
            store.restarts.delete(paneID);
            store.restartRan.delete(paneID);
            store.sessionsDirty = true;
        }
    }
    if (!prev) return [{ kind: 'new', paneID, to: record.status }];
    if (prev.status !== record.status) return [{ kind: 'status', paneID, from: prev.status, to: record.status }];
    return [{ kind: 'updated', paneID }];
}

/**
 * Keep the last session id Kelpi reported for a pane (a null report, Claude exiting, keeps the old one). Returns true
 * when it changed. A worker's id is recorded only while it runs as that worker: once its result exists (and it was not
 * restarted), a `claude` the user started in that pane is never the one send-to-worker resumes.
 */
export function rememberSession(store, paneID, sessionID) {
    if (typeof sessionID !== 'string' || !SESSION_ID.test(sessionID) || store.sessions.get(paneID) === sessionID) return false;
    const finished = store.resultExists.get(paneID) === true && !store.restarts.has(paneID);
    if (finished && store.manifestWorkers.some(w => w.paneID === paneID)) return false;
    store.sessions.set(paneID, sessionID);
    store.sessionsDirty = true;
    return true;
}

/** Seed panes from `api.snapshot()` state (workspaces[].panes and parkedPanes). */
export function seedFromSnapshot(store, snapshot, now) {
    for (const ws of snapshot?.state?.workspaces ?? []) {
        if (ws.id && typeof ws.name === 'string') store.workspaceNames.set(ws.id, ws.name);
        for (const pane of [...(ws.panes ?? []), ...(ws.parkedPanes ?? [])]) {
            applyStateChange(store, { kind: 'pane-upserted', workspaceID: ws.id, paneID: pane.id, pane: { ...pane, workspaceName: ws.name } }, now);
        }
    }
}

/**
 * After seeding from the host's full snapshot: a manifest worker whose pane the host does not have was closed while
 * the plugin was not running (swarm-spawn creates the pane before the manifest entry). Mark it gone, so it reads as
 * done or error instead of running forever. Returns the pane ids marked.
 */
export function markMissingWorkers(store) {
    const marked = [];
    for (const w of store.manifestWorkers) {
        if (store.panes.has(w.paneID) || store.gone.has(w.paneID)) continue;
        store.gone.add(w.paneID);
        marked.push(w.paneID);
    }
    return marked;
}

export function lastLineOf(text) {
    if (typeof text !== 'string') return '';
    const lines = text.replace(ANSI, '').split('\n').map(line => line.trim()).filter(line => line && !DECOR_ONLY.test(line));
    return lines.at(-1) ?? '';
}

/** Refresh the capture-derived caches for one worker: last line and result-file existence. Never throws. */
export async function refreshWorker(store, paneID) {
    const worker = store.manifestWorkers.find(w => w.paneID === paneID);
    if (!worker) return;
    try {
        store.lastLines.set(paneID, lastLineOf(await capturePane(store.api, paneID, 30)));
    } catch { /* pane may be gone; keep the previous line */ }
    await refreshResult(store, worker);
}

/** Refresh result-file existence for any manifest worker (another swarm's too, so a finished one is not scanned). Never throws. */
export async function refreshResult(store, worker) {
    const paneID = worker.paneID;
    // The path check needs the live pane's working directory to trust the worktree. A result proven while the pane
    // was live stays proven once the pane is gone (existence is sticky), so a finished worker does not turn into an error.
    if (!store.panes.has(paneID) && store.resultExists.get(paneID) === true) return;
    if (worker.resultPath) {
        // The manifest is untrusted: the same path policy and size cap as reading the result apply, so a FIFO, a device or a
        // symlink out of the worktree can never be opened (or stall the serial queue) just to learn whether it exists.
        let exists = false;
        try {
            const checked = await checkResultPath(worker, store.settings, undefined, resultContext(store, paneID));
            const read = checked.ok ? await readResultText(store, checked.path) : null;
            exists = !!read?.ok;
            // A restarted worker is done only once its result file changed from the one it had before.
            if (exists && store.restarts.has(paneID)) {
                if (textHash(read.text) === store.restarts.get(paneID)) exists = false;
                else { store.restarts.delete(paneID); await store.api.storage.set('restarts', Object.fromEntries(store.restarts)); }
            }
        } catch { /* treated as absent */ }
        store.resultExists.set(paneID, exists);
    }
}

/**
 * Derive a worker state from pane status, agent info and result-file existence.
 * - pane closed: done if the result file exists, else error
 * - reported error and not running again: error
 * - result file exists and the agent is not running: done
 * - running: running; waitingForInput: waiting
 * - idle: running until the pane has been seen running once (just started), then waiting
 */
export function deriveState(store, worker) {
    const pane = store.panes.get(worker.paneID);
    const hasResult = store.resultExists.get(worker.paneID) === true;
    if (!pane) return hasResult ? 'done' : (store.gone.has(worker.paneID) ? 'error' : 'running');
    if (pane.status === 'running') return 'running';
    // Restarted on its own conversation and the new result has not landed yet.
    if (store.restarts.has(worker.paneID)) return pane.status === 'waitingForInput' ? 'waiting' : 'running';
    if (store.errored.has(worker.paneID)) return 'error';
    if (hasResult) return 'done';
    if (pane.status === 'waitingForInput') return 'waiting';
    return store.seenRunning.has(worker.paneID) ? 'waiting' : 'running';
}

/** The worker's pane is gone: seen closing, or missing from the host with its result already written (a reload). A pane never seen yet is not "closed". */
export const paneClosed = (store, paneID) => !store.panes.has(paneID) && (store.gone.has(paneID) || store.resultExists.get(paneID) === true);

export function currentWorkers(store, now) {
    const nowMs = toMs(now);
    return store.manifestWorkers.map(mw => {
        const pane = store.panes.get(mw.paneID);
        const first = Date.parse(store.firstSeen[mw.paneID] ?? '');
        return {
            paneID: mw.paneID,
            label: mw.label,
            task: mw.task ?? '',
            state: deriveState(store, mw),
            elapsedSeconds: Number.isNaN(first) ? 0 : Math.max(0, Math.floor((nowMs - first) / 1000)),
            lastLine: store.lastLines.get(mw.paneID) ?? '',
            resultPath: mw.resultPath ?? null,
            worktreePath: mw.worktreePath ?? null,
            parent: mw.parent ?? null,
            hidden: !!pane && !!store.hiddenWorkspaceID && pane.workspaceID === store.hiddenWorkspaceID,
            accepted: store.accepted.has(mw.paneID),
            archived: store.archived.has(mw.paneID),
            paneClosed: paneClosed(store, mw.paneID)
        };
    });
}

/** A waiting pane needs two scans in a row with no prompt parsed before the rail shows it. */
export const UNPARSED_SCANS = 2;

/** Workers waiting for input whose prompt the scan cannot read (a very narrow hidden pane); never one with a card. */
function waitingRows(store, carded) {
    const rows = [];
    for (const [paneID, entry] of store.unparsed) {
        if (entry.misses < UNPARSED_SCANS || carded.has(paneID)) continue;
        rows.push({ paneID, label: entry.label, ...(entry.swarmWorkspaceID ? { swarmName: entry.swarmName, swarmWorkspaceID: entry.swarmWorkspaceID } : {}) });
    }
    return rows;
}

/** One line per other live swarm: running, need you (an open card or a waiting row) and done counts, plus its Group colour. */
function otherSwarmSummaries(store, carded, waitingPanes) {
    const waiting = new Set(waitingPanes.map(w => w.paneID));
    return otherSwarms(store).map(swarm => {
        const needs = new Set([swarm.orchestrator.paneID, ...swarm.workers.map(w => w.paneID)].filter(id => carded.has(id) || waiting.has(id)));
        let running = 0;
        let done = 0;
        for (const w of swarm.workers) {
            // A listed pane living outside the swarm's workspaces is not that swarm's worker (otherSwarmPane).
            if (needs.has(w.paneID) || store.archived.has(w.paneID) || (store.panes.has(w.paneID) && !otherSwarmPane(store, w.paneID))) continue;
            const state = deriveState(store, w);
            if (state === 'done' || state === 'error') done += 1; else running += 1;
        }
        return { workspaceID: swarm.workspaceID, name: swarm.name, orchestratorPaneID: swarm.orchestrator.paneID, color: swarm.color ?? null, running, needYou: needs.size, done };
    });
}

/** Build the SwarmSnapshot defined in contracts/state.d.ts. Increments the sequence. */
export function buildSnapshot(store, now) {
    const nowMs = toMs(now);
    const workers = currentWorkers(store, nowMs)
        .map((w, index) => ({ w, index }))
        .sort((a, b) => (Number(a.w.archived) - Number(b.w.archived)) || (STATE_ORDER[a.w.state] - STATE_ORDER[b.w.state]) || (a.index - b.index))
        .map(entry => entry.w);
    const live = workers.filter(w => !w.archived);
    // Attention items are kept for every pane; when following a workspace show only that swarm's, plus Request
    // cards from every other live swarm (a request blocks its worker), each tagged with the swarm it came from.
    const mine = store.followWorkspaceID ? new Set([...workers.map(w => w.paneID), store.orchestrator?.paneID]) : null;
    // A Request no gate accepts any more (pane, orchestrator or manifest gone) is never offered Approve; the scan settles it.
    const orphan = item => (item.type === 'Request' && !ownedRequestPane(store, item.paneID) ? { ...item, approvable: false } : item);
    const tag = item => {
        if (mine?.has(item.paneID)) return orphan(item);
        const other = item.type === 'Request' ? otherSwarmPane(store, item.paneID) : null;
        if (other) return { ...item, swarmName: other.swarm.name, swarmWorkspaceID: other.swarm.workspaceID, paneLabel: other.label };
        return mine ? null : orphan(item);
    };
    const inSwarm = items => items.map(tag).filter(Boolean);
    const attention = store.att ? inSwarm(visibleItems(store.att, nowMs)) : [];
    const carded = new Set(attention.filter(i => i.type === 'Request').map(i => i.paneID));
    const waitingPanes = waitingRows(store, carded);
    store.sequence += 1;
    return {
        version: 1,
        sequence: store.sequence,
        generatedAt: new Date(nowMs).toISOString(),
        workspaceID: store.workspaceID,
        orchestrator: store.orchestrator,
        workers,
        attention,
        snoozed: store.att ? inSwarm(snoozedItems(store.att, nowMs)) : [],
        waitingPanes,
        otherSwarms: otherSwarmSummaries(store, carded, waitingPanes),
        counts: {
            waiting: live.filter(w => w.state === 'waiting').length,
            running: live.filter(w => w.state === 'running').length,
            finished: live.filter(w => w.state === 'done' || w.state === 'error').length
        },
        warnings: [...store.warnings],
        // Plain data copied here so views never see the Sets and Maps behind it.
        autoApprove: store.auto ? {
            on: store.auto.on, until: store.auto.until, since: store.auto.since, approved: store.auto.approved, skipped: store.auto.skipped,
            failed: store.auto.failed, logCount: store.auto.log.length, paused: [...store.auto.paused.values()], ended: store.auto.ended
        } : null
    };
}

const asArray = value => (Array.isArray(value) ? value : []);

export const HANDLED_KEEP_MAX = 50;

/**
 * Keep the stored cards small: Kelpi refuses plugin storage over 256 KiB, and auto-approve handles hundreds of
 * Requests a day. Only the newest 50 handled cards are kept, without their prompt block; open cards are all kept.
 */
export function compactAttention(store) {
    const recent = store.attention
        .filter(i => i.handledAt)
        .sort((a, b) => b.handledAt.localeCompare(a.handledAt))
        .slice(0, HANDLED_KEEP_MAX);
    const keep = new Set(recent);
    store.attention = store.attention.filter(i => !i.handledAt || keep.has(i));
    for (const item of recent) delete item.promptBlock;
}

/** Persist attention, pins, accepted, archived, firstSeen, hiddenWorkspaceID (and `restored`) to plugin storage. */
export async function persist(store) {
    const { storage } = store.api;
    compactAttention(store);
    await storage.set('attention', store.attention);
    await storage.set('pins', { orchestratorPaneID: store.pinnedOrchestratorPaneID });
    await storage.set('accepted', [...store.accepted]);
    await storage.set('archived', [...store.archived]);
    await storage.set('restored', [...store.restored]);
    await storage.set('firstSeen', store.firstSeen);
    await storage.set('hiddenWorkspaceID', store.hiddenWorkspaceID);
    // Panes seen closing, and results proven to exist: both outlive a reload so a finished worker keeps reading as done.
    await storage.set('gone', [...store.gone]);
    await storage.set('results', [...store.resultExists].filter(([, exists]) => exists === true).map(([id]) => id));
    await storage.set('sessions', Object.fromEntries(store.sessions));
    await storage.set('restarts', Object.fromEntries(store.restarts));
    store.sessionsDirty = false;
}

const stringMap = value => new Map(value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).filter(([k, v]) => typeof k === 'string' && typeof v === 'string') : []);

/** Load persisted state. Missing or malformed values fall back to empty. */
export async function load(store) {
    const { storage } = store.api;
    const [attention, pins, accepted, archived, restored, firstSeen, hidden, gone, results, sessions, restarts] = await Promise.all(
        ['attention', 'pins', 'accepted', 'archived', 'restored', 'firstSeen', 'hiddenWorkspaceID', 'gone', 'results', 'sessions', 'restarts'].map(key => storage.get(key))
    );
    // Sessions seen before the reload stay known; ids reported live since activation win.
    for (const [id, session] of stringMap(sessions)) if (!store.sessions.has(id) && SESSION_ID.test(session)) store.sessions.set(id, session);
    for (const [id, hash] of stringMap(restarts)) store.restarts.set(id, hash);
    for (const id of asArray(gone).filter(x => typeof x === 'string')) store.gone.add(id);
    for (const id of asArray(results).filter(x => typeof x === 'string')) store.resultExists.set(id, true);
    store.attention = asArray(attention).filter(i => i && typeof i.id === 'string' && typeof i.paneID === 'string' && typeof i.createdAt === 'string');
    store.pinnedOrchestratorPaneID = typeof pins?.orchestratorPaneID === 'string' ? pins.orchestratorPaneID : null;
    store.accepted = new Set(asArray(accepted).filter(x => typeof x === 'string'));
    store.archived = new Set(asArray(archived).filter(x => typeof x === 'string'));
    store.restored = new Set(asArray(restored).filter(x => typeof x === 'string'));
    store.firstSeen = firstSeen && typeof firstSeen === 'object' && !Array.isArray(firstSeen) ? { ...firstSeen } : {};
    store.hiddenWorkspaceID = typeof hidden === 'string' ? hidden : null;
    return store;
}
