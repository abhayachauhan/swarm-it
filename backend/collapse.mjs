// Collapse strategy HIDE: move manifest workers into the worker child workspaces (backend/workers.mjs).
// Only panes listed in a manifest are ever moved. Afterwards everything addresses them by pane id.
import { persist, actionableWorker, otherSwarmPane } from './store.mjs';
import { ensureWorkersWorkspace, isWorkersWorkspaceOf, removeSeedShell, removeEmptyWorkerChildren, recordPlacement } from './workers.mjs';

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const message = error => String(error?.message ?? error);
const enabled = settings => settings?.autoHide !== false && settings?.collapse !== false;
const isManifestWorker = (store, paneID) => !!actionableWorker(store, paneID);

/** Find or create the worker child workspace. Respects the `autoHide` / `collapse` setting being off. */
export async function ensureHiddenWorkspace(api, store, settings, paneID) {
    if (!enabled(settings)) return fail('collapse is disabled', 'DISABLED');
    return ensureWorkersWorkspace(api, store, store.manifestWorkers.find(w => w.paneID === paneID));
}

/**
 * Hide the workers of a live swarm the rail is not following: move each listed worker still in the swarm's own
 * workspace, or in its old `<name> · workers` workspace, into the worker child workspace. `swarm` is a store.swarms
 * entry. Only listed workers are ever moved.
 * @returns {Promise<{ moved: string[], failed: { paneID: string, error: string }[] }>}
 */
export async function hideSwarmWorkers(api, store, swarm, paneIDs) {
    const result = { moved: [], failed: [] };
    if (!enabled(store.settings) || !swarm?.name || !paneIDs.length) return result;
    const listed = new Set(swarm.workers.map(w => w.paneID));
    const due = paneIDs.filter(id => {
        const ws = store.panes.get(id)?.workspaceID;
        return listed.has(id) && !!ws && (ws === swarm.workspaceID || isWorkersWorkspaceOf(store, ws, swarm.name, swarm.workspaceID));
    });
    if (!due.length) return result;
    for (const paneID of due) {
        if (otherSwarmPane(store, paneID)?.swarm.workspaceID !== swarm.workspaceID) continue;
        // A manifest cannot take a worker another live swarm also claims.
        if (store.swarms.some(s => s.workspaceID !== swarm.workspaceID && s.workers.some(w => w.paneID === paneID))) continue;
        const child = await ensureWorkersWorkspace(api, store, swarm.workers.find(w => w.paneID === paneID), swarm.workspaceID);
        if (!child.ok) { result.failed.push({ paneID, error: child.error }); continue; }
        try {
            await api.panes.moveToWorkspace(paneID, child.workspaceID, { focus: false });
            const pane = store.panes.get(paneID);
            if (pane) pane.workspaceID = child.workspaceID;
            await removeSeedShell(api, store, child.workspaceID, paneID);
            recordPlacement(store, 'moved', { paneID, workspaceID: child.workspaceID });
            result.moved.push(paneID);
        } catch (error) {
            recordPlacement(store, 'move-failed', { paneID, workspaceID: child.workspaceID, error: message(error) });
            result.failed.push({ paneID, error: `move failed: ${message(error)}` });
        }
    }
    return result;
}

/** Move a manifest worker into the worker child workspace. Refuses any pane not in the manifest. */
export async function hideWorker(api, store, paneID) {
    if (!isManifestWorker(store, paneID)) return fail(`pane ${paneID} is not a manifest worker; not moving it`, 'NOT_MANIFEST_WORKER');
    const hidden = await ensureHiddenWorkspace(api, store, store.settings, paneID);
    if (!hidden.ok) return hidden;
    if (store.panes.get(paneID)?.workspaceID === hidden.workspaceID) return { ok: true, paneID, workspaceID: hidden.workspaceID, moved: false };
    try {
        await api.panes.moveToWorkspace(paneID, hidden.workspaceID, { focus: false });
    } catch (error) {
        recordPlacement(store, 'move-failed', { paneID, workspaceID: hidden.workspaceID, error: message(error) });
        return fail(`move failed: ${message(error)}`, 'MOVE_FAILED');
    }
    const pane = store.panes.get(paneID);
    if (pane) pane.workspaceID = hidden.workspaceID;
    await removeSeedShell(api, store, hidden.workspaceID, paneID);
    recordPlacement(store, 'moved', { paneID, workspaceID: hidden.workspaceID });
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
    await removeEmptyWorkerChildren(api, store);
    await persist(store);
    return { ok: true, paneID, workspaceID: store.workspaceID };
}
