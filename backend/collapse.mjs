// Collapse strategy HIDE: move manifest workers into the shared `Workers` workspace (backend/workers.mjs).
// Only panes listed in a manifest are ever moved. Afterwards everything addresses them by pane id.
import { persist, actionableWorker } from './store.mjs';
import { ensureWorkersWorkspace, legacyName } from './workers.mjs';

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const message = error => String(error?.message ?? error);
const enabled = settings => settings?.autoHide !== false && settings?.collapse !== false;
const isManifestWorker = (store, paneID) => !!actionableWorker(store, paneID);

/** Find or create the shared Workers workspace. Respects the `autoHide` / `collapse` setting being off. */
export async function ensureHiddenWorkspace(api, store, settings) {
    if (!enabled(settings)) return fail('collapse is disabled', 'DISABLED');
    return ensureWorkersWorkspace(api, store);
}

/**
 * Hide the workers of a live swarm the rail is not following: move each listed worker still in the swarm's own
 * workspace, or in its old `<name> · workers` workspace, into the shared Workers workspace. `swarm` is a store.swarms
 * entry. Only listed workers are ever moved.
 * @returns {Promise<{ moved: string[], failed: { paneID: string, error: string }[] }>}
 */
export async function hideSwarmWorkers(api, store, swarm, paneIDs) {
    const result = { moved: [], failed: [] };
    if (!enabled(store.settings) || !swarm?.name || !paneIDs.length) return result;
    const listed = new Set(swarm.workers.map(w => w.paneID));
    const legacy = legacyName(swarm.name);
    const due = paneIDs.filter(id => {
        const ws = store.panes.get(id)?.workspaceID;
        return listed.has(id) && !!ws && (ws === swarm.workspaceID || store.workspaceNames?.get?.(ws) === legacy);
    });
    if (!due.length) return result;
    const shared = await ensureWorkersWorkspace(api, store);
    if (!shared.ok) {
        for (const paneID of due) result.failed.push({ paneID, error: shared.error });
        return result;
    }
    for (const paneID of due) {
        try {
            await api.panes.moveToWorkspace(paneID, shared.workspaceID);
            const pane = store.panes.get(paneID);
            if (pane) pane.workspaceID = shared.workspaceID;
            result.moved.push(paneID);
        } catch (error) {
            result.failed.push({ paneID, error: `move failed: ${message(error)}` });
        }
    }
    return result;
}

/** Move a manifest worker into the shared Workers workspace. Refuses any pane not in the manifest. */
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
