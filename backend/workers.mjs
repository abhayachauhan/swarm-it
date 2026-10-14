// One shared `Workers` workspace (in a collapsed `Workers` Group) holds the workers of every swarm, and auto-clean
// closes finished workers after a delay. Which swarm a worker belongs to comes from the manifests, not from where it sits.
import { handleItem } from './attention.mjs';
import { worktreeProblem } from './actions.mjs';
import { persist, deriveState, paneClosed } from './store.mjs';

export const WORKERS_NAME = 'Workers';
export const WORKERS_GROUP = 'Workers';
/** Before the shared workspace, each swarm had its own `<name> · workers`. Still recognised so old workers move across. */
export const LEGACY_SUFFIX = ' · workers';
export const legacyName = swarmName => `${swarmName}${LEGACY_SUFFIX}`;
export const isWorkersName = name => typeof name === 'string' && (name === WORKERS_NAME || name.endsWith(LEGACY_SUFFIX));
export const DEFAULT_CLEAN_MINUTES = 10;

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const message = error => String(error?.message ?? error);

/**
 * Find or create the shared Workers workspace. A new one goes into the `Workers` Group (made when missing), which is
 * collapsed so the sidebar shows one row. The host's shell pane in a new workspace is kept: the workspace never empties,
 * so it is never recreated (creating a workspace switches the user's view).
 */
export async function ensureWorkersWorkspace(api, store) {
    if (store.ensuring) return store.ensuring;
    store.ensuring = (async () => {
        try {
            const list = await api.workspaces.list();
            let groups = [];
            try { groups = (await api.groups?.list?.()) ?? []; } catch { /* no Group: the workspace still works at the top level */ }
            let group = groups.find(g => g?.name === WORKERS_GROUP) ?? null;
            const named = list.filter(w => w.name === WORKERS_NAME);
            const known = named.find(w => w.id === store.hiddenWorkspaceID) ?? named.find(w => group && w.groupID === group.id) ?? named[0];
            if (known) {
                if (store.hiddenWorkspaceID !== known.id) { store.hiddenWorkspaceID = known.id; await persist(store); }
                return { ok: true, workspaceID: known.id, created: false };
            }
            if (!group && typeof api.groups?.create === 'function') {
                try { group = { id: (await api.groups.create(WORKERS_GROUP)).groupID }; } catch { group = null; }
            }
            const { workspaceID } = await api.workspaces.create(group ? { name: WORKERS_NAME, groupID: group.id } : { name: WORKERS_NAME });
            if (group && typeof api.groups?.setCollapsed === 'function') {
                try { await api.groups.setCollapsed(group.id, true); } catch { /* an open Group still works */ }
            }
            // The request gates know the workers workspace by name, so they must know this one before a move.
            store.workspaceNames?.set?.(workspaceID, WORKERS_NAME);
            store.hiddenWorkspaceID = workspaceID;
            await persist(store);
            return { ok: true, workspaceID, created: true };
        } catch (error) {
            return fail(`cannot create the Workers workspace: ${message(error)}`, 'CREATE_FAILED');
        } finally {
            store.ensuring = null;
        }
    })();
    return store.ensuring;
}

/** Is this workspace where a worker of the swarm called `swarmName` may live: the shared one, or the swarm's old `<name> · workers`? */
export function isWorkersWorkspaceOf(store, workspaceID, swarmName) {
    if (!workspaceID) return false;
    // By name, not by the saved id: a saved id from before the shared workspace points at one swarm's old workspace.
    const name = store.workspaceNames?.get?.(workspaceID);
    return name === WORKERS_NAME || (!!swarmName && name === legacyName(swarmName));
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
    for (const w of candidates) {
        const id = w.paneID;
        if (store.archived.has(id)) { store.doneSince.delete(id); continue; }
        const open = store.panes.has(id);
        const finished = open ? deriveState(store, w) === 'done' : paneClosed(store, id);
        if (!finished) { store.doneSince.delete(id); continue; }
        if (!store.doneSince.has(id)) store.doneSince.set(id, now);
        if (now - store.doneSince.get(id) < delay) continue;
        if (open) {
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
