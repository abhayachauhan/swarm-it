// Collapse strategy HIDE (G0): move manifest workers into a hidden sibling workspace `<name> · workers`.
// Only panes listed in the manifest are ever moved. Afterwards everything addresses them by pane id.
import { persist, actionableWorker } from './store.mjs';

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const message = error => String(error?.message ?? error);
const enabled = settings => settings?.autoHide !== false && settings?.collapse !== false;
const isManifestWorker = (store, paneID) => !!actionableWorker(store, paneID);

/** Move a workers workspace into the swarm's Group when it sits elsewhere. Best effort: hiding still works outside it. */
async function intoGroup(api, workspace, groupID) {
    if (!groupID || workspace.groupID === groupID || typeof api.workspaces.moveMany !== 'function') return;
    try { await api.workspaces.moveMany([workspace.id], { groupID }); } catch { /* leave it where it is */ }
}

/** Create (or find) the hidden sibling workspace. Respects the `autoHide` / `collapse` setting being off. */
export async function ensureHiddenWorkspace(api, store, settings) {
    if (!enabled(settings)) return fail('collapse is disabled', 'DISABLED');
    if (store.ensuring) return store.ensuring;
    store.ensuring = (async () => {
        try {
            const list = await api.workspaces.list();
            // The workers workspace lives in the swarm's Group, so the Group holds the whole swarm.
            const groupID = list.find(w => w.id === store.workspaceID)?.groupID ?? null;
            const baseName = store.workspaceName ?? list.find(w => w.id === store.workspaceID)?.name;
            if (!baseName) return fail('swarm workspace name unknown; cannot name the hidden workspace', 'NO_WORKSPACE');
            const name = `${baseName} · workers`;
            // The saved id survives reloads with no owner: reuse it only when it is this swarm's by name.
            const known = store.hiddenWorkspaceID ? list.find(w => w.id === store.hiddenWorkspaceID && w.name === name) : null;
            if (known) {
                await intoGroup(api, known, groupID);
                return { ok: true, workspaceID: known.id, created: false };
            }
            const existing = list.find(w => w.name === name && w.id !== store.workspaceID);
            let workspaceID = existing?.id;
            if (existing) await intoGroup(api, existing, groupID);
            else {
                workspaceID = (await api.workspaces.create(groupID ? { name, groupID } : { name })).workspaceID;
                // The host opens an empty shell pane in a new workspace. Remember it (and only it) so index.mjs can
                // close it once a worker has moved in. noteCreatedPane catches it when the listing is too early.
                store.createdHiddenWorkspaceID = workspaceID;
                store.createdHiddenAt = Date.now();
                store.hiddenShellPaneID = await solePaneOf(api, store, workspaceID);
            }
            store.hiddenWorkspaceID = workspaceID;
            await persist(store);
            return { ok: true, workspaceID, created: !existing };
        } catch (error) {
            return fail(`cannot create the hidden workspace: ${message(error)}`, 'CREATE_FAILED');
        } finally {
            store.ensuring = null;
        }
    })();
    return store.ensuring;
}

const isSwarmPane = (store, paneID) => store.manifestWorkers.some(w => w.paneID === paneID) || store.orchestrator?.paneID === paneID;

/** The one pane the host put in a workspace this plugin just created, or null when there is not exactly one. */
async function solePaneOf(api, store, workspaceID) {
    if (typeof api.panes?.list !== 'function') return null;
    try {
        const list = await api.panes.list({ workspaceID });
        const panes = (Array.isArray(list) ? list : []).filter(p => p?.workspaceID === workspaceID && typeof p.id === 'string' && !isSwarmPane(store, p.id));
        return panes.length === 1 ? panes[0].id : null;
    } catch {
        return null;
    }
}

/** A new pane may arrive before the listing saw it, so a pane first seen in our fresh workspace within this long is the shell it made. */
export const CREATED_PANE_WINDOW_MS = 30000;

/** index.mjs calls this for every pane first seen: records the shell pane of the workspace we created, nothing else. */
export function noteCreatedPane(store, paneID, now = Date.now()) {
    if (store.hiddenShellPaneID || !store.createdHiddenWorkspaceID) return false;
    if (now - (store.createdHiddenAt ?? 0) > CREATED_PANE_WINDOW_MS) { store.createdHiddenWorkspaceID = null; return false; }
    const pane = store.panes.get(paneID);
    if (!pane || pane.workspaceID !== store.createdHiddenWorkspaceID || isSwarmPane(store, paneID)) return false;
    store.hiddenShellPaneID = paneID;
    return true;
}

/**
 * Hide the workers of a live swarm the rail is not following: move each listed worker still in the swarm's own
 * workspace into `<name> · workers` (made in the swarm's Group when missing), then close the empty shell the host
 * put in a workspace made here. `swarm` is a store.swarms entry. Only listed workers are ever moved.
 * @returns {Promise<{ moved: string[], failed: { paneID: string, error: string }[] }>}
 */
export async function hideSwarmWorkers(api, store, swarm, paneIDs) {
    const result = { moved: [], failed: [] };
    if (!enabled(store.settings) || !swarm?.name || !paneIDs.length) return result;
    const listed = new Set(swarm.workers.map(w => w.paneID));
    const due = paneIDs.filter(id => listed.has(id) && store.panes.get(id)?.workspaceID === swarm.workspaceID);
    if (!due.length) return result;
    let workspaceID;
    let created = false;
    try {
        const list = await api.workspaces.list();
        const groupID = list.find(w => w.id === swarm.workspaceID)?.groupID ?? null;
        const name = `${swarm.name} · workers`;
        const existing = list.find(w => w.name === name && w.id !== swarm.workspaceID);
        if (existing) { workspaceID = existing.id; await intoGroup(api, existing, groupID); }
        else { workspaceID = (await api.workspaces.create(groupID ? { name, groupID } : { name })).workspaceID; created = true; }
        // The request gate (otherSwarmPane) knows a workers workspace by name, so it must know this one before a move.
        store.workspaceNames?.set?.(workspaceID, name);
    } catch (error) {
        for (const paneID of due) result.failed.push({ paneID, error: `cannot create the hidden workspace: ${message(error)}` });
        return result;
    }
    for (const paneID of due) {
        try {
            await api.panes.moveToWorkspace(paneID, workspaceID);
            const pane = store.panes.get(paneID);
            if (pane) pane.workspaceID = workspaceID;
            result.moved.push(paneID);
        } catch (error) {
            result.failed.push({ paneID, error: `move failed: ${message(error)}` });
        }
    }
    if (created && result.moved.length && typeof api.panes?.list === 'function') {
        // The host's empty shell is the one pane there that is not this swarm's.
        try {
            const panes = (await api.panes.list({ workspaceID })).filter(p => p?.workspaceID === workspaceID && !listed.has(p.id) && p.id !== swarm.orchestrator?.paneID);
            if (panes.length === 1) await api.panes.close(panes[0].id);
        } catch { /* an empty shell left behind is harmless */ }
    }
    return result;
}

/** Move a manifest worker into the hidden workspace. Refuses any pane not in the manifest. */
export async function hideWorker(api, store, paneID) {
    if (!isManifestWorker(store, paneID)) return fail(`pane ${paneID} is not a manifest worker; not moving it`, 'NOT_MANIFEST_WORKER');
    const hidden = await ensureHiddenWorkspace(api, store, store.settings);
    if (!hidden.ok) return hidden;
    if (store.panes.get(paneID)?.workspaceID === hidden.workspaceID) return { ok: true, paneID, workspaceID: hidden.workspaceID, moved: false };
    try {
        await api.panes.moveToWorkspace(paneID, hidden.workspaceID);
    } catch (error) {
        return fail(`move failed: ${message(error)}`, 'MOVE_FAILED');
    }
    const pane = store.panes.get(paneID);
    if (pane) pane.workspaceID = hidden.workspaceID;
    store.restored.delete(paneID);
    await persist(store);
    return { ok: true, paneID, workspaceID: hidden.workspaceID, moved: true };
}

/** Reverse of hideWorker: move the worker back to the swarm workspace and stop auto-hiding it. */
export async function showWorker(api, store, paneID) {
    if (!isManifestWorker(store, paneID)) return fail(`pane ${paneID} is not a manifest worker; not moving it`, 'NOT_MANIFEST_WORKER');
    if (!store.workspaceID) return fail('swarm workspace unknown', 'NO_WORKSPACE');
    if (store.panes.get(paneID)?.workspaceID !== store.workspaceID) {
        try {
            await api.panes.moveToWorkspace(paneID, store.workspaceID);
        } catch (error) {
            return fail(`move failed: ${message(error)}`, 'MOVE_FAILED');
        }
        const pane = store.panes.get(paneID);
        if (pane) pane.workspaceID = store.workspaceID;
    }
    store.restored.add(paneID);
    await persist(store);
    return { ok: true, paneID, workspaceID: store.workspaceID };
}
