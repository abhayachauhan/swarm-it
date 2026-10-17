// Agent hook events (api.agents.onEvent) for swarm workers: Claude's last reply, its errors, and why it stopped
// without a result. A stopped worker is also written to <manifestDir>/exits/<paneID>.json for swarm-wait.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { lastLineOf, refreshResult } from './store.mjs';
import { manifestDirectory } from './manifest.mjs';

const LINE_CAP = 200;
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const USAGE_LIMIT = /usage limit|hit your (?:\w+ )?limit|out of (?:extra )?usage|credit balance|limit (?:reached|will reset|resets)/i;
const RATE_LIMIT = /rate limit|too many requests|\b429\b/i;

const cap = text => (text.length > LINE_CAP ? `${text.slice(0, LINE_CAP - 1)}…` : text);

/** The last line of a reply or error message, capped; '' when there is none. */
export const lastMessageLine = text => cap(lastLineOf(text));

/** Plain-words reason a Claude stopped without a result, from its error message and last reply. */
export function exitReason(error, lastLine) {
    const said = `${error ?? ''}\n${lastLine ?? ''}`;
    if (USAGE_LIMIT.test(said)) return 'usage limit reached';
    if (RATE_LIMIT.test(said)) return 'rate limit reached';
    if (error) return cap(`stopped with an error: ${error}`);
    return 'Claude exited without writing a result';
}

/** Where swarm-wait looks for a stopped worker (same default directory as manifests). */
export const exitsDirectory = (store, home = homedir()) => join(manifestDirectory(home, store.settings?.manifestDir), 'exits');

/** A worker of the followed swarm or of any other live swarm, by pane id. */
function workerOf(store, paneID) {
    return store.manifestWorkers.find(w => w.paneID === paneID) ?? store.swarms.flatMap(s => s.workers).find(w => w.paneID === paneID) ?? null;
}

async function forget(store, paneID) {
    const had = store.exits.delete(paneID);
    store.agentErrors.delete(paneID);
    if (PANE_ID.test(paneID)) await rm(join(exitsDirectory(store), `${paneID}.json`), { force: true }).catch(() => {});
    return had;
}

async function remember(store, worker, entry) {
    store.exits.set(worker.paneID, entry);
    if (!PANE_ID.test(worker.paneID)) return;
    const dir = exitsDirectory(store);
    try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${worker.paneID}.json`), JSON.stringify({ paneID: worker.paneID, label: worker.label, ...entry }), { mode: 0o600 });
    } catch { /* the rail still shows it; swarm-wait falls back to its other checks */ }
}

/**
 * Apply one agent hook event. Events for panes that are not a swarm worker are ignored.
 * @returns {Promise<boolean>} true when the snapshot may have changed
 */
export async function onAgentEvent(store, event, now = Date.now()) {
    const paneID = event?.paneID;
    const worker = typeof paneID === 'string' ? workerOf(store, paneID) : null;
    if (!worker) return false;
    switch (event.type) {
        case 'start':
        case 'session-start': {
            // A new turn or a restarted Claude: the old reply, error and stop no longer apply.
            store.agentLines.delete(paneID);
            return forget(store, paneID);
        }
        case 'stop': {
            const line = lastMessageLine(event.lastAssistantMessage);
            if (!line) return false;
            store.agentLines.set(paneID, line);
            store.lastLines.set(paneID, line);
            return true;
        }
        case 'error': {
            const line = lastMessageLine(event.message);
            if (!line) return false;
            store.agentErrors.set(paneID, line);
            store.lastLines.set(paneID, line);
            return true;
        }
        case 'session-end': {
            // Without a result path "no result" cannot be told, so such a worker is never marked stopped.
            if (!worker.resultPath) return false;
            await refreshResult(store, worker);
            if (store.resultExists.get(paneID) === true) return forget(store, paneID);
            await remember(store, worker, { reason: exitReason(store.agentErrors.get(paneID), store.agentLines.get(paneID)), at: new Date(now).toISOString() });
            return true;
        }
        default:
            return false;
    }
}
