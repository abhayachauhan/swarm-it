// Each worker lives in a child workspace. Manifests determine swarm membership.
import { handleItem } from './attention.mjs';
import { worktreeProblem } from './actions.mjs';
import { persist, deriveState, paneClosed, updateWorkspaceParents } from './store.mjs';

export const WORKERS_NAME = 'Workers';
/** Before the shared workspace, each swarm had its own `<name> · workers`. Still recognised so old workers move across. */
export const LEGACY_SUFFIX = ' · workers';
export const legacyName = swarmName => `${swarmName}${LEGACY_SUFFIX}`;
export const isWorkersName = name => typeof name === 'string' && (name === WORKERS_NAME || name.endsWith(LEGACY_SUFFIX));
export const DEFAULT_CLEAN_MINUTES = 10;
/** At most this many workers are moved, and this many closed, per scan: each brings a burst of host events, and Kelpi
 *  stops a plugin that sends over 512 messages a second. A bigger batch finishes over the next scans. */
export const BATCH_PER_SCAN = 8;

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const message = error => String(error?.message ?? error);

/** Structured local counters make migration and cleanup visible in the plugin log. */
export function recordPlacement(store, event, fields = {}) {
    const count = (store.placementCounts.get(event) ?? 0) + 1;
    store.placementCounts.set(event, count);
    console.info(JSON.stringify({ event: `swarm.worker-workspace.${event}`, count, ...fields }));
}

const panesIn = async (api, workspaceID) => (await api.panes.list({ workspaceID })).filter(p => p.workspaceID === workspaceID);
const emptyShell = p => (p.type ?? 'shell') === 'shell' && p.status === 'idle' && !p.agent && !p.agentKind && !p.agentSessionID && !p.label;

/** Close only the untouched initial shell this plugin observed creating, after the worker arrived. */
export async function removeSeedShell(api, store, workspaceID, workerID) {
    const seed = store.workerSeeds.get(workspaceID);
    if (!seed) return;
    try {
        const panes = await panesIn(api, workspaceID);
        const shell = panes.find(p => p.id === seed.paneID);
        if (panes.length !== 2 || !panes.some(p => p.id === workerID) || !shell || !emptyShell(shell)
            || (shell.isFocused && shell.isActiveWorkspace) || (shell.lastActivityAt ?? null) !== seed.lastActivityAt) return;
        await api.panes.close(shell.id);
        store.panes.delete(shell.id);
        store.workerSeeds.delete(workspaceID);
        recordPlacement(store, 'seed-closed', { paneID: shell.id, workspaceID });
    } catch (error) { recordPlacement(store, 'cleanup-failed', { workspaceID, error: message(error) }); }
}

/** Each worker gets a child workspace. Reuse by pane id, never by a shared display name. */
export async function ensureWorkersWorkspace(api, store, worker, home = store.workspaceID) {
    if (!worker?.paneID || !home) return fail('worker and parent workspace required', 'NO_WORKSPACE');
    const key = `${home}:${worker.paneID}`;
    if (typeof api.workspaces.nest !== 'function') { store.blockedCreates.add(key); return fail('update Kelpi to use worker child workspaces', 'UNSUPPORTED'); }
    if (store.blockedCreates.has(key)) return fail('automatic migration stopped after an uncertain create; check Kelpi before reloading', 'CREATE_BLOCKED');
    if (store.ensuringWorkers.has(key)) return store.ensuringWorkers.get(key);
    const pending = (async () => {
        let parentID;
        let beforeIDs = new Set();
        try {
            const list = await api.workspaces.list();
            beforeIDs = new Set(list.map(w => w.id));
            for (const w of list) {
                store.workspaceNames.set(w.id, w.name);
                updateWorkspaceParents(store, { ...w, parentID: w.parentID ?? null });
            }
            parentID = store.workspaceParents.get(home) ?? home;
            const paneWorkspace = store.panes.get(worker.paneID)?.workspaceID;
            const saved = store.workerWorkspaces.get(key);
            const known = list.find(w => w.id === (saved ?? paneWorkspace) && w.parentID === parentID && (saved || inWorkerChild(store, worker.paneID, home)));
            if (known) return { ok: true, workspaceID: known.id, created: false };
            const { workspaceID } = await api.workspaces.create({ name: worker.label, parentID, focus: false });
            store.workspaceNames.set(workspaceID, worker.label);
            store.workspaceParents.set(workspaceID, parentID);
            store.workerWorkspaces.set(key, workspaceID);
            // Read before moving: this identity can never be confused with an unrelated user pane.
            try {
                const seeds = await panesIn(api, workspaceID);
                if (seeds.length === 1 && emptyShell(seeds[0])) store.workerSeeds.set(workspaceID, { paneID: seeds[0].id, lastActivityAt: seeds[0].lastActivityAt ?? null });
            } catch { /* a seed that cannot be identified is never closed */ }
            await persist(store);
            recordPlacement(store, 'created', { paneID: worker.paneID, workspaceID, parentID });
            return { ok: true, workspaceID, created: true };
        } catch (error) {
            // SDK errors after creation carry the created id. Stop automatic retries if the outcome is ambiguous:
            // repeating a create after an expired response can leak a new shell every scan.
            let createdID = error?.details?.workspaceID;
            if (!createdID && parentID) {
                try {
                    const added = (await api.workspaces.list()).filter(w => !beforeIDs.has(w.id) && w.parentID === parentID && w.name === worker.label);
                    if (added.length === 1) createdID = added[0].id;
                } catch { /* an uncertain create is blocked until reload */ }
            }
            if (typeof createdID === 'string') {
                try {
                    const panes = await panesIn(api, createdID);
                    if (panes.length === 0 || (panes.length === 1 && emptyShell(panes[0]) && !(panes[0].isFocused && panes[0].isActiveWorkspace))) await api.workspaces.remove(createdID);
                } catch { /* leave anything the user may have touched */ }
            }
            const code = error?.code === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'CREATE_FAILED';
            if (error?.code !== 'COMMAND_FAILED' || createdID) store.blockedCreates.add(key);
            recordPlacement(store, 'create-failed', { paneID: worker.paneID, workspaceID: createdID, error: message(error) });
            return fail(`cannot create the worker child workspace: ${message(error)}`, code);
        } finally { store.ensuringWorkers.delete(key); }
    })();
    store.ensuringWorkers.set(key, pending);
    return pending;
}

const coordinatorIn = (store, ws) => [store.manifest?.orchestrator, ...(store.swarms ?? []).map(s => s.orchestrator)]
    .some(o => o && store.panes.get(o.paneID)?.workspaceID === ws);

/** Children must be dedicated to a worker; a sibling coordinator or a personal child is never a worker workspace. */
export function isWorkersWorkspaceOf(store, workspaceID, swarmName, home = store.workspaceID) {
    if (!workspaceID || workspaceID === home || coordinatorIn(store, workspaceID)) return false;
    const parent = store.workspaceParents.get(workspaceID);
    if (parent) {
        if (!(parent === home || parent === store.workspaceParents.get(home))) return false;
        if ([...store.workerWorkspaces].some(([key, id]) => key.startsWith(`${home}:`) && id === workspaceID)) return true;
        const panes = [...store.panes.values()].filter(p => p.workspaceID === workspaceID);
        return panes.length === 1;
    }
    const name = store.workspaceNames?.get?.(workspaceID);
    return name === WORKERS_NAME || (!!swarmName && name === legacyName(swarmName));
}

/** Is this worker already alone in a child of its coordinator (or its root parent)? */
export function inWorkerChild(store, paneID, home = store.workspaceID) {
    const ws = store.panes.get(paneID)?.workspaceID;
    if (!store.workspaceParents.get(ws) || !isWorkersWorkspaceOf(store, ws, store.workspaceNames.get(home), home)) return false;
    const workers = [...store.manifestWorkers, ...(store.swarms ?? []).flatMap(s => s.workers)];
    return !workers.some(w => w.paneID !== paneID && store.panes.get(w.paneID)?.workspaceID === ws);
}

/** Remove only recorded worker children proven empty, after close or restore. */
export async function removeEmptyWorkerChildren(api, store) {
    if (!store.workerWorkspaces.size) return [];
    const removed = [];
    let list;
    try { list = await api.workspaces.list(); } catch { return removed; }
    for (const [key, workspaceID] of [...store.workerWorkspaces]) {
        const workspace = list.find(w => w.id === workspaceID);
        if (!workspace) { store.workerWorkspaces.delete(key); store.workerSeeds.delete(workspaceID); continue; }
        if (workspace.isActive) continue;
        try {
            if ((await panesIn(api, workspaceID)).length !== 0) continue;
            await api.workspaces.remove(workspaceID);
            store.workerWorkspaces.delete(key);
            store.workerSeeds.delete(workspaceID);
            store.workspaceParents.delete(workspaceID);
            store.workspaceNames.delete(workspaceID);
            removed.push(workspaceID);
            recordPlacement(store, 'removed', { workspaceID });
        } catch { /* active or nonempty children are retained */ }
    }
    await persist(store);
    return removed;
}

/**
 * A manifest cannot claim a worker outside its home while another live swarm also lists that pane.
 * This also protects legacy workers still waiting to leave the shared Workers workspace.
 */
export function claimedElsewhere(store, paneID, ownWorkspaceID) {
    return (store.swarms ?? []).some(s => s.workspaceID !== ownWorkspaceID && (s.orchestrator?.paneID === paneID || s.workers.some(w => w.paneID === paneID)));
}

/**
 * Close finished workers once they have been finished for `autoCleanMinutes` (0 turns it off). `candidates` are manifest
 * workers an ownership gate already accepts. A worker counts as finished when its result exists and its agent stopped,
 * or its pane is closed. Errored workers with an open pane are left for the user. A worker whose worktree is dirty, or
 * whose git status is unknown, is kept and tried again after another delay.
 * @returns {Promise<{ cleaned: string[], kept: { paneID: string, label: string, error: string }[] }>}
 */
export async function autoClean(api, store, candidates, now) {
    const result = { cleaned: [], kept: [] };
    const raw = Number(store.settings?.autoCleanMinutes ?? DEFAULT_CLEAN_MINUTES);
    const delay = (Number.isFinite(raw) ? raw : DEFAULT_CLEAN_MINUTES) * 60000;
    if (!(delay > 0)) { store.doneSince.clear(); return result; }
    const live = new Set(candidates.map(w => w.paneID));
    for (const id of [...store.doneSince.keys()]) if (!live.has(id)) store.doneSince.delete(id);
    let closes = 0;
    for (const w of candidates) {
        const id = w.paneID;
        if (store.archived.has(id)) { store.doneSince.delete(id); continue; }
        const open = store.panes.has(id);
        const finished = open ? deriveState(store, w) === 'done' : paneClosed(store, id);
        if (!finished) { store.doneSince.delete(id); continue; }
        if (!store.doneSince.has(id)) store.doneSince.set(id, now);
        if (now - store.doneSince.get(id) < delay) continue;
        if (open && closes >= BATCH_PER_SCAN) continue;
        if (open) {
            closes += 1;
            const problem = await worktreeProblem(api, w);
            if (problem) { store.doneSince.set(id, now); result.kept.push({ paneID: id, label: w.label, error: problem.error }); continue; }
        }
        store.archived.add(id);
        if (open) {
            try {
                await api.panes.close(id);
            } catch (error) {
                store.archived.delete(id);
                store.doneSince.set(id, now);
                result.kept.push({ paneID: id, label: w.label, error: `close failed: ${message(error)}` });
                continue;
            }
        }
        for (const item of store.attention) if (item.paneID === id && !item.handledAt) await handleItem(store.att, item.id);
        store.doneSince.delete(id);
        result.cleaned.push(id);
    }
    if (result.cleaned.length) await persist(store);
    return result;
}

/**
 * Remove the old per-swarm `<name> · workers` workspaces once they are empty and not the one on screen. Each is
 * tried once per plugin run. Only workspaces with that exact suffix are ever removed.
 * @returns {Promise<string[]>} the workspace ids removed
 */
export async function removeEmptyLegacy(api, store) {
    if (typeof api.workspaces?.remove !== 'function') return [];
    // Runs every scan: skip the host call when no known workspace has the old name (the usual case after migration).
    if (store.workspaceNames.size && ![...store.workspaceNames.values()].some(n => String(n).endsWith(LEGACY_SUFFIX))) return [];
    let list;
    try { list = await api.workspaces.list(); } catch { return []; }
    const removed = [];
    for (const w of list) {
        if (!String(w.name ?? '').endsWith(LEGACY_SUFFIX) || w.paneCount !== 0 || w.isActive || store.legacyTried.has(w.id)) continue;
        if ([...store.panes.values()].some(p => p.workspaceID === w.id)) continue;
        store.legacyTried.add(w.id);
        try { await api.workspaces.remove(w.id); removed.push(w.id); } catch { /* left in place; harmless */ }
    }
    return removed;
}
