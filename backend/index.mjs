import { createCodexQuestions } from './codex-questions.mjs';
// Plugin backend entry. Wires modules and registers every command and event declared in kelpi.plugin.json.
// `registerAll` takes the API object so tests can drive it with a fake (no Kelpi runtime needed).
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import * as store from './store.mjs';
import { actionableWorker, ownedRequestPane } from './store.mjs';
import * as manifest from './manifest.mjs';
import { manifestDirectory } from './manifest.mjs';
import * as attention from './attention.mjs';
import * as actions from './actions.mjs';
import * as collapse from './collapse.mjs';
import * as notify from './notify.mjs';
import * as autoapprove from './autoapprove.mjs';
import * as suggested from './suggested.mjs';
import * as restart from './restart.mjs';
import * as workers from './workers.mjs';
import * as exits from './exits.mjs';
import * as handoff from './handoff.mjs';
import { withTimeout, READ_TIMEOUT_MS } from './safepath.mjs';

export const PLUGIN_ID = 'local.swarm-view';
export const COMMANDS = [
    'focus-rail', 'get-state', 'open-thread', 'read-result', 'capture-worker', 'approve', 'deny',
    'trust-folder', 'load-codex-questions', 'answer-codex-question', 'snooze', 'archive', 'close-worker', 'accept', 'pin-orchestrator', 'clear-attention', 'send-to-worker', 'open-result', 'open-web-link',
    'auto-approve', 'auto-approve-log', 'dismiss-worker', 'close-thread', 'clear-done',
    'run-suggested', 'copy-suggested', 'run-suggested-confirm', 'close-run-view', 'restart-claude', 'handoff', 'request-handoff'
].map(name => `${PLUGIN_ID}.${name}`);
export const COUNTS_ITEM = `${PLUGIN_ID}.counts`;
export const SNAPSHOT_EVENT = 'snapshot';
export const RAIL_VIEW = `${PLUGIN_ID}.rail`;
export const THREAD_VIEW = `${PLUGIN_ID}.thread`;
export const RUN_VIEW = `${PLUGIN_ID}.run`;
/** Backend to sidebar: the one signal that gives the rail the keyboard (emitted as 'focus-rail', host-prefixed). */
export const FOCUS_EVENT = 'focus-rail';

export const modules = { store, manifest, attention, actions, collapse, notify, autoapprove, suggested, restart, workers, exits, handoff };

const MANIFEST_RELOAD_MS = 1000;
/** Every other swarm's manifest is re-read at most this often (one directory listing, then one read per manifest). */
const SWARMS_RELOAD_MS = Number(process.env.SWARM_SWARMS_RELOAD_MS) || 3000;
const PROMPT_SCAN_MS = Number(process.env.SWARM_PROMPT_SCAN_MS) || 5000;
/** A failed hide (move) is retried after these delays in turn; the last one repeats. The host refuses a call whose
 *  invocation expired, so one failure is not final. */
export const HIDE_RETRY_MS = (process.env.SWARM_HIDE_RETRY_MS || '10000,30000,120000,300000').split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);
/** Kelpi's Group colours (WorkspaceColor). Anything else is dropped, so the rail only ever sees one of these names. */
const GROUP_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray', 'black', 'white']);
const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const text = error => String(error?.message ?? error);

const COUNTS_TOOLTIP = 'Swarm: waiting / running / finished';
/** While auto-approve is on, which path answers is re-checked on every scan; while off, at most this often. */
const PROVIDER_CHECK_MS = Number(process.env.SWARM_PROVIDER_CHECK_MS) || 60000;

/** Status bar patch for the counts item (contracts/commands.md). `note` (the auto-approve fallback warning) joins the tooltip. */
export function countsPatch(counts, hasError, note = null) {
    const tone = counts.waiting > 0 ? 'warning' : hasError ? 'error' : counts.running > 0 ? 'info' : 'default';
    return { text: `Swarm ${counts.waiting}/${counts.running}/${counts.finished}`, badge: counts.waiting > 0 ? String(counts.waiting) : '', tone, tooltip: note ? `${COUNTS_TOOLTIP}. ${note}` : COUNTS_TOOLTIP };
}

/**
 * Register all COMMANDS and subscribe to `state.changed`, `daemon.notification` and `settings.changed`.
 * Command handlers are registered for EVERY id in COMMANDS (the host rejects a mismatch with the manifest).
 * Returns dispose synchronously; `dispose.ready` resolves when the initial load finished.
 * @returns {(() => void) & { ready: Promise<void>, store: object }}
 */
export function registerAll(api, deps = modules) {
    const { store: S, manifest: M, attention: A, actions: X, collapse: C, notify: N, autoapprove: AA = autoapprove, suggested: R = suggested, restart: RS = restart, workers: W = workers, exits: E = exits, handoff: H = handoff } = deps;
    /** Writes text to the system clipboard; resolves true when it worked. Tests inject one. */
    const clipboard = deps.clipboard ?? R.pbcopy;
    const st = S.createStore(api);
    const att = A.createAttention(api, st);
    // Always starts off: only the log is loaded from storage (init).
    st.auto = AA.createState();
    const disposers = [];
    const lastStates = new Map();
    /** Worker pane id to { failures, nextAt, error } while its move into the hidden workspace keeps failing. */
    const hideFailed = new Map();
    const hideRetryDue = now => [...hideFailed.values()].some(f => now >= f.nextAt);
    let queue = Promise.resolve();
    let seqFloor = 0;
    let manifestReadAt = 0;
    let swarmsReadAt = 0;
    let threadViewPaneID = null;
    let lastFollowArg = null;
    /** Open Request id to the number of consecutive scans on which no ownership gate accepted its pane. */
    const orphanMisses = new Map();
    let disposed = false;

    const serial = fn => {
        const run = queue.then(fn, fn);
        queue = run.catch(() => {});
        return run;
    };

    const emit = (name, data) => (typeof api.emit === 'function' ? api.emit(name, data) : api.events.emit(name, data));

    let codexQuestions = null;
    function snapshotNow() {
        const snapshot = S.buildSnapshot(st, Date.now());
        if (codexQuestions) snapshot.warnings.push(...(codexQuestions.warnings?.() ?? []));
        if (codexQuestions) snapshot.codexQuestionsConnected = codexQuestions.connected?.() ?? true;
        if (codexQuestions) snapshot.codexQuestions = codexQuestions.list().map(question => {
            const pane = [...st.panes.values()].find(p => p.agentSessionID === question.threadID || st.sessions.get(p.id) === question.threadID);
            return { ...question, ...(pane ? { paneID: pane.id, paneLabel: pane.label } : {}) };
        });
        return snapshot;
    }

    async function publish() {
        if (disposed) return null;
        // The screen fallback only matters while auto-approve is on: then the rail's ⚠ and the status bar say how to fix it.
        const fallback = st.auto.on ? st.auto.provider.warning : null;
        setWarning('auto-approve', fallback);
        const snapshot = snapshotNow();
        const hasError = snapshot.workers.some(w => !w.archived && w.state === 'error');
        const patch = countsPatch(snapshot.counts, hasError, fallback);
        const patchJSON = JSON.stringify(patch);
        if (patchJSON !== lastCounts) {
            try { await api.contributions.update({ items: { [COUNTS_ITEM]: patch } }); lastCounts = patchJSON; } catch { /* status bar is best effort */ }
        }
        try { await emit(SNAPSHOT_EVENT, snapshot); } catch { /* views re-call get-state */ }
        return snapshot;
    }
    let lastCounts = null;

    // Many cards can change in one pass (a swarm closing settles all of its cards): queue one publish, not one per card.
    let publishQueued = false;
    att.onChange = () => {
        if (publishQueued) return;
        publishQueued = true;
        serial(async () => { publishQueued = false; await publish(); });
    };

    const setWarning = (key, message) => {
        st.warnings = st.warnings.filter(w => !w.startsWith(`${key}:`));
        if (message) st.warnings.push(`${key}: ${message}`);
    };

    function wsName(id) {
        return st.workspaceNames.get(id) ?? [...st.panes.values()].find(p => p.workspaceID === id && p.workspaceName)?.workspaceName ?? null;
    }

    /** An old `<name> · workers` workspace belongs to the swarm workspace called `<name>`. The shared Workers one belongs to none. */
    function homeOf(id) {
        const name = wsName(id);
        if (!name || !name.endsWith(W.LEGACY_SUFFIX)) return id;
        const base = name.slice(0, -W.LEGACY_SUFFIX.length);
        for (const [otherID, otherName] of st.workspaceNames) if (otherName === base) return otherID;
        return id;
    }

    /**
     * A swarm owns its Group: any workspace in the Group resolves to the Group workspace that has a manifest, the
     * given one first. A workspace outside any Group, or a Group with no swarm, resolves to itself.
     */
    async function groupHome(id) {
        let list;
        try { list = await api.workspaces.list(); } catch { return id; }
        const groupID = list.find(w => w.id === id)?.groupID;
        if (!groupID) return id;
        const members = list.filter(w => w.groupID === groupID && w.id !== id && !W.isWorkersName(w.name));
        for (const w of [{ id }, ...members]) {
            const result = await M.readManifest(api, M.manifestPath(w.id, homedir(), st.settings.manifestDir));
            if (result.ok) return w.id;
        }
        return id;
    }

    /**
     * Retarget the rail to the workspace the user is in. Only the swarm of that workspace is shown; with no manifest
     * there the rail is empty rather than showing another workspace's swarm. Returns true when the target changed.
     */
    async function follow(workspaceID) {
        if (typeof workspaceID !== 'string' || !workspaceID || !st.workspaceNames.has(workspaceID)) return false;
        // Same view, swarm already found: skip the Group scan. Without a swarm, scan again in case one started.
        if (workspaceID === lastFollowArg && st.manifest) return false;
        lastFollowArg = workspaceID;
        const home = await groupHome(homeOf(workspaceID));
        if (home === st.followWorkspaceID) return false;
        // Pending hide retries belong to the swarm being left; the new one starts clean.
        hideFailed.clear();
        st.followWorkspaceID = home;
        st.workspaceID = home;
        st.workspaceName = wsName(home);
        st.manifest = null;
        st.manifestPath = null;
        st.manifestAll = [];
        st.manifestWorkers = [];
        st.orchestrator = null;
        await loadManifest();
        return true;
    }

    function candidateWorkspaces() {
        if (st.followWorkspaceID) return [st.followWorkspaceID];
        const ids = [];
        const add = id => { if (id && !W.isWorkersName(wsName(id)) && !ids.includes(id)) ids.push(id); };
        add(st.workspaceID);
        const label = st.settings.coordinatorLabel || 'coordinator';
        for (const p of st.panes.values()) if (p.label === label) add(p.workspaceID);
        add(st.panes.get(st.pinnedOrchestratorPaneID)?.workspaceID);
        for (const p of st.panes.values()) add(p.workspaceID);
        return ids;
    }

    /**
     * Read every workspace's manifest (at most every SWARMS_RELOAD_MS) and keep the live ones: the orchestrator pane
     * exists and lives in the workspace the file is named after (the scopeWorkers ownership rule). The directory is
     * listed once and only files that exist are read; a manifest whose workspace is gone is never read.
     */
    async function loadSwarms({ force = false } = {}) {
        if (!force && Date.now() - swarmsReadAt < SWARMS_RELOAD_MS) return;
        swarmsReadAt = Date.now();
        let names = null;
        try {
            const dir = manifestDirectory(homedir(), st.settings.manifestDir);
            names = new Set(await withTimeout(Promise.resolve().then(() => (st.listDir ?? readdir)(dir)), READ_TIMEOUT_MS, 'listing manifests'));
        } catch (error) {
            // No directory means no swarm; any other failure falls back to reading one path per workspace.
            if (/ENOENT|no such file/i.test(`${error?.code ?? ''} ${text(error)}`)) names = new Set();
        }
        const swarms = [];
        const dead = [];
        for (const [id, name] of st.workspaceNames) {
            if (W.isWorkersName(name) || (names && !names.has(`${id}.json`))) continue;
            const result = await M.readManifest(api, M.manifestPath(id, homedir(), st.settings.manifestDir));
            if (!result.ok) continue;
            const swarm = { workspaceID: id, name, orchestrator: result.manifest.orchestrator, workers: result.manifest.workers };
            // A swarm whose coordinator pane is gone is not shown, but auto-clean still tidies its closed workers.
            if (st.panes.get(result.manifest.orchestrator.paneID)?.workspaceID !== id) dead.push(swarm);
            else swarms.push(swarm);
        }
        st.deadSwarms = dead;
        const colors = swarms.some(s => s.workspaceID !== st.workspaceID) ? await groupColors() : new Map();
        for (const swarm of swarms) swarm.color = colors.get(swarm.workspaceID) ?? null;
        st.swarms = swarms;
    }

    /** Workspace id to its Group's colour token (Kelpi's WorkspaceColor names only). Best effort: empty on any failure. */
    async function groupColors() {
        const colors = new Map();
        try {
            const [workspaces, groups] = await withTimeout(Promise.all([api.workspaces.list(), api.groups?.list?.() ?? []]), READ_TIMEOUT_MS, 'listing groups');
            const byGroup = new Map((groups ?? []).filter(g => GROUP_COLORS.has(g?.color)).map(g => [g.id, g.color]));
            for (const w of workspaces ?? []) if (byGroup.has(w.groupID)) colors.set(w.id, byGroup.get(w.groupID));
        } catch { /* the rail falls back to a neutral tag */ }
        return colors;
    }

    /** Find and read the manifest. Fallbacks (label, pin) are applied by resolveOrchestrator. */
    async function loadManifest() {
        manifestReadAt = Date.now();
        // Always search every candidate workspace (the remembered one first): the swarm may live in another
        // workspace than the one a `coordinator` label first matched.
        const ids = candidateWorkspaces();
        let sawProblem = null;
        for (const id of ids) {
            const path = M.manifestPath(id, homedir(), st.settings.manifestDir);
            const result = await M.readManifest(api, path);
            if (result.ok) {
                st.manifest = result.manifest;
                st.manifestPath = path;
                st.manifestAll = result.manifest.workers;
                st.manifestWorkers = result.manifest.workers;
                st.workspaceID = id;
                st.workspaceName = wsName(id);
                setWarning('manifest', null);
                return true;
            }
            if (!result.missing) sawProblem = `${result.path}: ${result.error}`;
        }
        if (st.manifest && sawProblem === null && ids.length) {
            // Manifest removed everywhere: drop it so the orchestrator falls back to the label, then the pin.
            st.manifest = null;
            st.manifestPath = null;
            st.manifestAll = [];
            st.manifestWorkers = [];
            setWarning('manifest', null);
            setWarning('manifest-owner', null);
            return false;
        }
        setWarning('manifest', sawProblem);
        return false;
    }

    /**
     * A manifest worker must be a pane in the orchestrator's workspace, the shared Workers workspace, or the swarm's
     * old `<name> · workers` workspace. A pane known to live in any other workspace is ignored (never messaged, captured or moved)
     * and surfaced as a warning. A pane the model has not seen yet is kept: it cannot be acted on, and a reload runs
     * when it appears.
     */
    function scopeWorkers() {
        // The home workspace is anchored to something a rogue process cannot choose: the workspace the manifest FILE is named
        // after (manifest id = workspace id), or the user's pin when there is no manifest. The manifest's own orchestrator pane
        // must live in that workspace, otherwise the whole manifest is ignored.
        const orchPane = st.manifest?.orchestrator ? st.panes.get(st.manifest.orchestrator.paneID) : null;
        if (st.manifest && orchPane && orchPane.workspaceID !== st.workspaceID) {
            setWarning('manifest-owner', `ignored manifest ${st.manifestPath ?? ''}: its orchestrator pane is not in workspace ${st.workspaceID}`);
            st.manifest = null;
            st.manifestAll = [];
            st.manifestWorkers = [];
        } else if (st.manifest) setWarning('manifest-owner', null);
        const all = st.manifestAll ?? st.manifestWorkers;
        const home = st.followWorkspaceID ?? (st.manifest ? st.workspaceID : (st.panes.get(st.pinnedOrchestratorPaneID)?.workspaceID ?? st.workspaceID));
        const homeName = home ? wsName(home) : null;
        const allowed = id => !!home && (id === home || W.isWorkersWorkspaceOf(st, id, homeName));
        st.allowedWorkspace = allowed;
        const kept = [];
        const ignored = [];
        for (const w of all) {
            const pane = st.panes.get(w.paneID);
            // A worker outside the home workspace (in Workers) must not also be listed by another swarm's manifest.
            const contested = !!pane?.workspaceID && pane.workspaceID !== home && W.claimedElsewhere(st, w.paneID, home);
            if ((pane?.workspaceID && !allowed(pane.workspaceID)) || contested) ignored.push(w.label); else kept.push(w);
        }
        st.manifestWorkers = kept;
        setWarning('workers', ignored.length ? `ignored ${ignored.length} manifest worker(s) in another workspace: ${ignored.join(', ')}` : null);
    }

    function resolveOrchestrator() {
        scopeWorkers();
        const workerIDs = new Set(st.manifestWorkers.map(w => w.paneID));
        const panes = [...st.panes.values()].filter(p => !workerIDs.has(p.id) && (!st.followWorkspaceID || (p.workspaceID && st.allowedWorkspace(p.workspaceID))));
        const model = { panes, workspaceID: st.workspaceID };
        st.orchestrator = M.resolveOrchestrator(model, st.manifest, st.settings, st.pinnedOrchestratorPaneID);
        if (!st.workspaceID && st.orchestrator) {
            st.workspaceID = st.panes.get(st.orchestrator.paneID)?.workspaceID ?? null;
            st.workspaceName = st.workspaceID ? wsName(st.workspaceID) : null;
        }
        setWarning('swarm', st.orchestrator && !st.manifest ? 'no swarm manifest found; workers are unknown' : null);
    }

    /** Raise Complete/Error on transitions, and settle items the user answered in the terminal. */
    async function evaluate() {
        for (const w of S.currentWorkers(st, Date.now())) {
            const prev = lastStates.get(w.paneID);
            lastStates.set(w.paneID, w.state);
            if (w.state === prev) continue;
            if (w.state === 'running') {
                for (const item of st.attention) {
                    if (item.paneID === w.paneID && !item.handledAt && (item.type === 'Request' || item.type === 'Complete')) await A.handleItem(att, item.id);
                }
            }
            if ((w.state === 'done' || w.state === 'error') && !w.archived && !w.accepted) {
                const type = w.state === 'done' ? 'Complete' : 'Error';
                const seenBefore = st.attention.some(i => i.type === type && i.paneID === w.paneID);
                if (prev !== undefined || !seenBefore) {
                    await A.addItem(att, {
                        type, paneID: w.paneID,
                        text: w.state === 'done' ? `${w.label} finished` : `${w.label} stopped without a result`
                    });
                }
            }
        }
    }

    async function autoHide() {
        const skipped = [];
        const now = Date.now();
        // A retry entry lives only as long as its pane is open and still a worker of the followed swarm. Otherwise the
        // loop below never reaches it, the collapse warning never clears and hideRetryDue keeps settle + publish running
        // on every scan tick.
        for (const paneID of [...hideFailed.keys()]) {
            if (!st.panes.has(paneID) || !st.manifestWorkers.some(w => w.paneID === paneID)) hideFailed.delete(paneID);
        }
        for (const w of st.manifestWorkers) {
            const pane = st.panes.get(w.paneID);
            const failed = hideFailed.get(w.paneID);
            // A closed pane is nothing to warn about; only a pane never seen is.
            if (!pane) { if (!S.paneClosed(st, w.paneID)) skipped.push(`${w.label}: pane not in the plugin's pane list`); continue; }
            if (st.restored.has(w.paneID)) { skipped.push(`${w.label}: restored by the user`); continue; }
            // Already in the shared Workers workspace. One in the swarm's old `<name> · workers` is moved across.
            if (wsName(pane.workspaceID) === W.WORKERS_NAME) { hideFailed.delete(w.paneID); continue; }
            // A failed move is retried with backoff (HIDE_RETRY_MS), not abandoned: the plugin host refuses a call whose
            // invocation has expired, and the next attempt runs under a fresh one.
            if (failed && now < failed.nextAt) { skipped.push(`${w.label}: move failed, retrying in ${Math.ceil((failed.nextAt - now) / 1000)} s`); continue; }
            const result = await C.hideWorker(api, st, w.paneID);
            if (result.ok) { hideFailed.delete(w.paneID); continue; }
            if (result.code === 'DISABLED') { setWarning('autohide', 'collapse is switched off in the plugin settings'); return; }
            const failures = (failed?.failures ?? 0) + 1;
            const wait = HIDE_RETRY_MS[Math.min(failures - 1, HIDE_RETRY_MS.length - 1)] ?? 300000;
            hideFailed.set(w.paneID, { failures, nextAt: now + wait, error: result.error });
        }
        // The collapse warning clears once every pending move has worked.
        setWarning('collapse', hideFailed.size ? [...hideFailed.values()].at(-1).error : null);
        setWarning('autohide', skipped.length ? skipped.join('; ') : null);
    }

    /**
     * Hide the workers of every other live swarm too, so a swarm started in a workspace the user is not looking at
     * does not leave its workers there until the user opens it. A failed move backs off like autoHide's.
     * @returns {Promise<boolean>} whether any pane moved
     */
    const otherHideFailed = new Map();
    async function hideOtherSwarms() {
        const now = Date.now();
        let moved = false;
        for (const paneID of [...otherHideFailed.keys()]) if (!st.panes.has(paneID)) otherHideFailed.delete(paneID);
        // Each move also brings a burst of host events to react to: a big batch (a first install moving dozens of
        // workers) is spread over several scans so the plugin stays under Kelpi's message rate limit.
        let budget = W.BATCH_PER_SCAN;
        for (const swarm of S.otherSwarms(st)) {
            if (budget <= 0) break;
            const legacy = W.legacyName(swarm.name);
            const due = swarm.workers.map(w => w.paneID).filter(id => {
                const ws = st.panes.get(id)?.workspaceID;
                return !!ws && (ws === swarm.workspaceID || wsName(ws) === legacy) && !st.restored.has(id) && !(otherHideFailed.get(id)?.nextAt > now);
            }).slice(0, budget);
            if (!due.length) continue;
            budget -= due.length;
            const result = await C.hideSwarmWorkers(api, st, swarm, due);
            for (const id of result.moved) otherHideFailed.delete(id);
            for (const { paneID } of result.failed) {
                const failures = (otherHideFailed.get(paneID)?.failures ?? 0) + 1;
                otherHideFailed.set(paneID, { failures, nextAt: now + (HIDE_RETRY_MS[Math.min(failures - 1, HIDE_RETRY_MS.length - 1)] ?? 300000) });
            }
            if (result.moved.length) moved = true;
        }
        return moved;
    }

    /**
     * Auto-clean: close every swarm's finished workers after the delay (workers.mjs autoClean), then remove old
     * `<name> · workers` workspaces left empty. Only workers an ownership gate accepts are candidates: the followed
     * swarm's (actionableWorker) and other live swarms' (otherSwarmPane); a closed pane needs no gate, nothing is closed.
     * @returns {Promise<boolean>} whether anything was cleaned
     */
    async function cleanFinished(others, followed) {
        const closed = id => !st.panes.has(id);
        // Workers of a closed coordinator: only the ones whose pane is already gone. An open pane is left running.
        const orphans = st.deadSwarms.filter(s => !(st.manifest && s.workspaceID === st.workspaceID))
            .flatMap(s => s.workers).filter(w => closed(w.paneID) && !followed.has(w.paneID));
        for (const w of orphans) st.gone.add(w.paneID);
        const candidates = [
            ...st.manifestWorkers.filter(w => closed(w.paneID) || actionableWorker(st, w.paneID)),
            ...others.flatMap(s => s.workers).filter(w => !followed.has(w.paneID) && (closed(w.paneID) || S.otherSwarmPane(st, w.paneID))),
            ...orphans
        ];
        const result = await W.autoClean(api, st, candidates, Date.now());
        setWarning('autoclean', result.kept.length ? `kept ${result.kept.map(k => `${k.label} (${k.error})`).join('; ')}` : null);
        await W.removeEmptyLegacy(api, st);
        return result.cleaned.length > 0;
    }

    async function settle({ publishAlways = false } = {}) {
        resolveOrchestrator();
        await evaluate();
        await autoHide();
        resolveOrchestrator();
        if (publishAlways) await publish();
    }

    async function loadSettings() {
        try { st.settings = { ...S.DEFAULT_SETTINGS, ...(await api.settings.get()) }; } catch { /* keep defaults */ }
    }

    async function init() {
        await loadSettings();
        await S.load(st);
        await AA.load(st);
        await AA.checkProvider(api, st);
        const snap = await api.snapshot();
        seqFloor = snap?.sequence ?? 0;
        S.seedFromSnapshot(st, snap, Date.now());
        await loadManifest();
        await loadSwarms({ force: true });
        resolveOrchestrator();
        // Workers whose pane closed while the plugin was down would otherwise read as running forever.
        S.markMissingWorkers(st);
        for (const w of st.manifestWorkers) await S.refreshWorker(st, w.paneID);
        A.rearm(att, Date.now());
        // A reload may find cards whose pane closed while the plugin was down.
        await settleOrphans();
        await settle({ publishAlways: true });
    }

    /**
     * Settle open Requests nobody can answer from the rail: at once when the pane is gone, and when no ownership gate
     * (followed swarm, or another live swarm) accepts the pane on two consecutive calls (orchestrator closed, manifest
     * deleted). One miss is tolerated: a manifest being rewritten fails the gates for a moment.
     * @returns {Promise<boolean>} true when a card was settled
     */
    async function settleOrphans() {
        let changed = false;
        const open = st.attention.filter(i => i.type === 'Request' && !i.handledAt);
        for (const id of orphanMisses.keys()) if (!open.some(i => i.id === id)) orphanMisses.delete(id);
        for (const item of open) {
            if (st.panes.has(item.paneID) && ownedRequestPane(st, item.paneID)) { orphanMisses.delete(item.id); continue; }
            const misses = (orphanMisses.get(item.id) ?? 0) + 1;
            orphanMisses.set(item.id, misses);
            if (st.panes.has(item.paneID) && misses < 2) continue;
            orphanMisses.delete(item.id);
            await A.handleItem(att, item.id);
            changed = true;
        }
        return changed;
    }

    async function onStateChanged(event) {
        if (typeof event?.sequence === 'number') {
            if (event.sequence <= seqFloor) return;
            seqFloor = event.sequence;
        }
        const changes = Array.isArray(event?.data) ? event.data : [];
        const touched = new Set();
        const removed = new Set();
        let sawNewPane = false;
        let relevant = false;
        for (const change of changes) {
            for (const e of S.applyStateChange(st, change, Date.now())) {
                touched.add(e.paneID);
                if (e.kind === 'new') sawNewPane = true;
                if (e.kind === 'removed') removed.add(e.paneID);
                // A waiting row lasts only while the status stays the same; the scan raises it again if still needed.
                if ((e.kind === 'status' || e.kind === 'removed') && st.unparsed.has(e.paneID)) {
                    if (st.unparsed.get(e.paneID).misses >= S.UNPARSED_SCANS) relevant = true;
                    st.unparsed.delete(e.paneID);
                }
            }
        }
        if (!touched.size) return;
        // A closed pane is remembered across reloads (store.gone is persisted) so its worker keeps reading as closed.
        // So is a pane's Claude session id: Kelpi forgets it when Claude exits, and send-to-worker resumes it.
        if (removed.size || st.sessionsDirty) { try { await S.persist(st); } catch { /* kept in memory */ } }
        // A pane with an open Request, in any swarm: publish so its card updates, and settle the card when the pane closed.
        for (const item of st.attention.filter(i => i.type === 'Request' && !i.handledAt && touched.has(i.paneID))) {
            relevant = true;
            if (removed.has(item.paneID)) await A.handleItem(att, item.id);
        }
        const known = id => st.manifestWorkers.some(w => w.paneID === id) || st.orchestrator?.paneID === id;
        // Another swarm's worker closing changes its done count in the other-swarms summary.
        if ([...removed].some(id => S.otherSwarms(st).some(s => s.workers.some(w => w.paneID === id)))) relevant = true;
        // A pane the swarm does not know may have been registered since the last read (add-worker runs after the split).
        if ((!st.manifest || [...touched].some(id => !known(id))) && Date.now() - manifestReadAt > MANIFEST_RELOAD_MS) {
            const knownBefore = st.manifestWorkers.length;
            await loadManifest();
            if (st.manifestWorkers.length !== knownBefore) relevant = true;
        }
        for (const id of touched) {
            if (st.manifestWorkers.some(w => w.paneID === id)) { await S.refreshWorker(st, id); relevant = true; }
            else if (known(id)) relevant = true;
        }
        const before = st.orchestrator?.paneID;
        resolveOrchestrator();
        if (st.orchestrator?.paneID !== before) relevant = true;
        await settle();
        if (relevant) await publish();
    }

    async function onNotification(event) {
        await loadSwarms();
        await N.onNotification(api, st, att, event);
        // A new Request is auto-approved as soon as it is raised, while auto-approve is on.
        await AA.run(api, st, Date.now());
        await settle();
        await publish();
    }

    // Kelpi notifies only for panes nobody is looking at, and a prompt does not always flip the status to waiting,
    // so read each live worker's screen on a timer too: raise a Request for a new prompt, settle one that is gone.
    // Workers of every live swarm are scanned, not only the followed one: a request blocks its worker until answered.
    async function scanPrompts() {
        let changed = false;
        // Focus belongs to the pane list, not the state-change DTO; hooks may never identify this Codex pane.
        try {
            for (const pane of await api.panes.list()) {
                const known = st.panes.get(pane.id);
                if (known) Object.assign(known, { isFocused: !!pane.isFocused, isActiveWorkspace: !!pane.isActiveWorkspace, title: pane.title ?? known.title });
            }
        } catch { /* keep the last known focus */ }
        /** Workers scanned this round; a waiting row for any other pane is dropped. */
        const scanned = new Set();
        const scanWorker = async (paneID, worker = null) => {
            if (worker) scanned.add(paneID);
            const knownCodex = S.anyCodexPane(st, paneID) || worker?.worker?.agent === 'codex';
            // Codex can show folder trust before hooks or session metadata exist. Skip other idle shells
            // unless a card or waiting row for it still needs settling.
            const pane = st.panes.get(paneID);
            const pending = st.unparsed.has(paneID) || st.attention.some(i => i.paneID === paneID && i.type === 'Request' && !i.handledAt);
            if (pane?.status === 'idle' && !knownCodex && !pane.agentSessionID && !pending && !(pane.isFocused && pane.isActiveWorkspace) && !/\bAction Required\b/i.test(pane.title ?? '')) return;
            let screen;
            try { screen = await S.capturePane(api, paneID, N.PROMPT_CAPTURE_LINES); } catch { return; }
            const codexPrompt = st.panes.get(paneID)?.agent === 'claude' ? null : N.parseCodexPrompt(screen);
            const codex = knownCodex || !!codexPrompt;
            const prompt = codex ? codexPrompt : N.parsePrompt(screen);
            const hash = prompt ? N.promptHash(prompt.block) : null;
            for (const item of st.attention) {
                if (item.paneID !== paneID || item.type !== 'Request' || item.handledAt || item.promptHash === hash) continue;
                // The Codex hook may fire before its menu is drawn. Keep its navigation card through that brief gap.
                if (codex && !prompt && !item.promptBlock && Date.now() - Date.parse(item.createdAt) < 10000) continue;
                await A.handleItem(att, item.id); changed = true;
            }
            const open = st.attention.some(i => i.paneID === paneID && i.type === 'Request' && !i.handledAt && i.promptHash === hash);
            if (prompt && !open) { await N.onNotification(api, st, att, { data: { paneID, kind: 'prompt-scan' } }, { screen }); changed = true; }
            if (worker && await noteUnparsed(worker, !prompt)) changed = true;
        };
        /**
         * A worker waiting for input whose prompt does not parse (a pane a few columns wide wraps it one word per line)
         * gets a "waiting for you" row after UNPARSED_SCANS scans in a row. A worker whose result file exists is done:
         * its shell can also report waitingForInput. Returns true when the row appeared or went.
         */
        async function noteUnparsed({ worker, swarm }, unparsed) {
            const paneID = worker.paneID;
            const shownBefore = (st.unparsed.get(paneID)?.misses ?? 0) >= S.UNPARSED_SCANS;
            let waiting = unparsed && st.panes.get(paneID)?.status === 'waitingForInput';
            if (waiting && worker.resultPath && st.resultExists.get(paneID) !== true) await S.refreshResult(st, worker);
            if (waiting && st.resultExists.get(paneID) === true) waiting = false;
            if (!waiting) { st.unparsed.delete(paneID); return shownBefore; }
            const misses = (st.unparsed.get(paneID)?.misses ?? 0) + 1;
            st.unparsed.set(paneID, { misses, label: worker.label, swarmName: swarm?.name ?? null, swarmWorkspaceID: swarm?.workspaceID ?? null });
            return !shownBefore && misses >= S.UNPARSED_SCANS;
        }
        for (const w of S.currentWorkers(st, Date.now())) {
            if (w.archived || w.state === 'done' || !st.panes.has(w.paneID)) continue;
            const worker = st.manifestWorkers.find(m => m.paneID === w.paneID);
            await scanWorker(w.paneID, worker ? { worker, swarm: null } : null);
        }
        await loadSwarms();
        const others = S.otherSwarms(st);
        const followed = new Set(st.manifestWorkers.map(w => w.paneID));
        for (const swarm of others) {
            for (const w of swarm.workers) {
                if (followed.has(w.paneID) || st.archived.has(w.paneID) || st.accepted.has(w.paneID)) continue;
                if (!S.otherSwarmPane(st, w.paneID)) continue;
                // A finished worker (its result file exists) is not scanned; existence is sticky, so a done one costs nothing.
                if (st.resultExists.get(w.paneID) !== true) {
                    await S.refreshResult(st, w);
                    // The other-swarms summary counts it as done now.
                    if (st.resultExists.get(w.paneID) === true) changed = true;
                }
                if (S.deriveState(st, w) === 'done') continue;
                await scanWorker(w.paneID, { worker: w, swarm });
            }
        }
        if (await hideOtherSwarms()) changed = true;
        if (await cleanFinished(others, followed)) changed = true;
        for (const [paneID, entry] of [...st.unparsed]) {
            if (scanned.has(paneID)) continue;
            st.unparsed.delete(paneID);
            if (entry.misses >= S.UNPARSED_SCANS) changed = true;
        }
        // Orchestrators: settle only. Their cards come from notifications; the user is usually looking at that pane.
        // With auto-approve on they are scanned like workers: Kelpi sends no notification for the pane being watched.
        const orchestrators = new Set([st.orchestrator?.paneID, ...others.map(s => s.orchestrator.paneID)]);
        if (st.auto.on) {
            for (const orch of orchestrators) if (orch && st.panes.has(orch)) await scanWorker(orch);
            // Auto-approve covers every Claude pane, not only a swarm's: scan the ones no swarm loop above reached.
            const swarmPanes = new Set([...orchestrators, ...st.manifestWorkers.map(w => w.paneID), ...others.flatMap(s => s.workers.map(w => w.paneID))]);
            for (const pane of [...st.panes.values()]) if (!swarmPanes.has(pane.id) && S.anyClaudePane(st, pane.id)) await scanWorker(pane.id);
            orchestrators.clear();
        }
        // Codex cards are navigation only and should appear regardless of the Auto setting.
        const scannedCodex = new Set([...scanned, ...st.manifestWorkers.map(w => w.paneID)]);
        for (const pane of [...st.panes.values()]) if (!scannedCodex.has(pane.id) && S.anyCodexPane(st, pane.id)) await scanWorker(pane.id);
        // Hooks can be unavailable in an older Codex session. Scan an unknown shell when Kelpi says it is
        // waiting, or when it is the focused pane, and recognise only Codex's navigation-only menu.
        for (const pane of [...st.panes.values()]) {
            if (scannedCodex.has(pane.id) || pane.agent || (pane.type ?? 'shell') !== 'shell') continue;
            if (pane.status !== 'waitingForInput' && !(pane.isFocused && pane.isActiveWorkspace) && !/\bAction Required\b/i.test(pane.title ?? '')) continue;
            await scanWorker(pane.id);
        }
        for (const orch of orchestrators) {
            const orchOpen = orch && st.panes.has(orch) ? st.attention.filter(i => i.paneID === orch && i.type === 'Request' && !i.handledAt) : [];
            if (!orchOpen.length) continue;
            let screen = null;
            try { screen = await S.capturePane(api, orch, N.PROMPT_CAPTURE_LINES); } catch { /* keep the cards */ }
            if (screen === null) continue;
            const prompt = N.parseCodexPrompt(screen) ?? N.parsePrompt(screen);
            const hash = prompt ? N.promptHash(prompt.block) : null;
            for (const item of orchOpen) if (item.promptHash !== hash) { await A.handleItem(att, item.id); changed = true; }
        }
        if (await settleOrphans()) changed = true;
        // Which path answers can change at any time (`kelpi plugin service-select`): re-check before auto-approving.
        if (st.auto.on || Date.now() - st.auto.provider.checkedAt >= PROVIDER_CHECK_MS) {
            if (await AA.checkProvider(api, st)) changed = true;
        }
        // Auto-approve newly raised cards (and switch itself off when its time ran out) on this timer too.
        if (await AA.run(api, st, Date.now())) changed = true;
        // A due hide retry also runs through settle (autoHide), on this timer.
        if (changed || hideRetryDue(Date.now())) { await settle(); await publish(); }
    }
    // One scan at a time: a tick while a scan is still queued or running is skipped, so slow captures never pile up.
    let scanQueued = false;
    const scanTimer = setInterval(() => {
        if (scanQueued) return;
        scanQueued = true;
        serial(scanPrompts).catch(() => {}).finally(() => { scanQueued = false; });
    }, PROMPT_SCAN_MS);
    scanTimer.unref?.();
    disposers.push(() => clearInterval(scanTimer));

    // kelpi.agent.permissions@1 (Kelpi 0.2.18+): Claude's PermissionRequest hook asks `decide` once the user selects it.
    // `decide` answers from memory (a write also looks up its path); the publish, and a selection re-check when it was asked
    // unconfirmed, is queued.
    let providerPublishQueued = false;
    const decide = async args => {
        let decision = { behavior: 'abstain' };
        const wasOn = st.auto.on;
        try { decision = await AA.decide(st, args); } catch { /* abstain */ }
        // Off before and after: nothing was logged or counted, so there is nothing to show.
        if ((wasOn || st.auto.on) && !providerPublishQueued) {
            providerPublishQueued = true;
            serial(async () => {
                providerPublishQueued = false;
                if (!st.auto.provider.active) await AA.checkProvider(api, st);
                await publish();
            }).catch(() => {});
        }
        return decision;
    };
    try {
        if (typeof api.providers?.register === 'function') {
            const off = api.providers.register(AA.PROVIDER_ID, { decide });
            if (typeof off === 'function') disposers.push(off);
            st.auto.provider.registered = true;
        }
    } catch { /* an older Kelpi: auto-approve keeps reading the screen */ }

    // Subscribe after queueing init so no event can run before the initial load.
    const ready = serial(init).catch(error => { setWarning('init', text(error)); });
    const listen = (name, handler) => {
        try {
            const off = api.events.on(name, event => serial(() => handler(event)).catch(() => {}));
            if (typeof off === 'function') disposers.push(off);
        } catch { /* unknown event name on an old host */ }
    };
    listen('state.changed', onStateChanged);
    listen('daemon.notification', onNotification);
    listen('settings.changed', async () => { await loadSettings(); await settle({ publishAlways: true }); });

    async function onAgentEvent(event) {
        if (!await E.onAgentEvent(st, event, Date.now())) return;
        try { await S.persist(st); } catch { /* kept in memory */ }
        await publish();
    }
    // Kelpi 0.2.18+ only; on an older host the rail keeps reading the screen.
    if (typeof api.agents?.onEvent === 'function') {
        try {
            const off = api.agents.onEvent(event => serial(() => onAgentEvent(event)).catch(() => {}));
            if (typeof off === 'function') disposers.push(off);
        } catch { /* host refused the subscription */ }
    }

    const command = (name, run) => {
        const id = `${PLUGIN_ID}.${name}`;
        const handler = async (args, context) => {
            try {
                await ready;
                return await serial(() => run(args && typeof args === 'object' ? args : {}, context && typeof context === 'object' ? context : {}));
            } catch (error) {
                return fail(text(error), 'INTERNAL');
            }
        };
        disposers.push(api.commands.register(id, handler));
    };
    const needPane = args => (typeof args.paneID === 'string' && args.paneID ? null : fail('paneID is required', 'BAD_ARGS'));
    const needItem = args => (typeof args.itemID === 'string' && args.itemID ? null : fail('itemID is required', 'BAD_ARGS'));
    const after = async result => { if (result?.ok) { await settle(); await publish(); } return result; };

    command('get-state', async args => {
        // A view that knows the workspace the user is in passes it, and the rail follows.
        const moved = await follow(args.workspaceID);
        if (!moved && Date.now() - manifestReadAt > 2000) await loadManifest();
        await loadSwarms();
        await settle();
        if (moved) await publish();
        return { ok: true, snapshot: snapshotNow() };
    });
    command('load-codex-questions', async () => {
        codexQuestions ??= (deps.createCodexQuestions ?? createCodexQuestions)({ onChange: () => {
            if (!disposed) serial(publish).catch(() => {});
        } });
        try { await codexQuestions.refresh(); await publish(); return { ok: true }; }
        catch (error) { return fail(`${text(error)}. Go to pane is still available; local shared-daemon Codex sessions are required.`, 'CODEX_UNAVAILABLE'); }
    });
    command('answer-codex-question', async args => {
        if (!codexQuestions) return fail('Load questions first.', 'CODEX_UNAVAILABLE');
        try { const result = await codexQuestions.answer(args); await publish(); return result; }
        catch (error) { return fail(text(error), 'QUESTION_CHANGED'); }
    });
    command('focus-rail', async () => {
        try { await api.openView(RAIL_VIEW, st.workspaceID ? { workspaceID: st.workspaceID } : {}); } catch (error) { return fail(text(error), 'OPEN_FAILED'); }
        try { await emit(FOCUS_EVENT, {}); } catch { /* the view is opened; keys stay inert until it hears the signal */ }
        return { ok: true };
    });
    /** Close the thread pane this plugin opened last (only ever an id openView returned to us). Returns its id or null. */
    async function closeThreadView() {
        if (!threadViewPaneID) return null;
        const previous = threadViewPaneID;
        threadViewPaneID = null;
        try { await api.panes.close(previous); } catch { /* already closed by the user */ }
        return previous;
    }
    command('open-thread', async args => {
        const bad = needPane(args);
        if (bad) return bad;
        // The coordinator has no thread view: opening it closes the worker thread, so the coordinator gets its space back.
        if (st.orchestrator && args.paneID === st.orchestrator.paneID) {
            return { ok: true, orchestrator: true, closedViewPaneID: await closeThreadView() };
        }
        if (!actionableWorker(st, args.paneID)) return fail(`pane ${args.paneID} is not a swarm worker`, 'NOT_WORKER');
        // One thread pane at a time.
        await closeThreadView();
        let opened;
        try {
            opened = await api.openView(THREAD_VIEW, { ...(st.workspaceID ? { workspaceID: st.workspaceID } : {}), state: { paneID: args.paneID } });
            threadViewPaneID = opened.paneID ?? null;
        } catch (error) {
            return fail(text(error), 'OPEN_FAILED');
        }
        // The user is looking at the worker's result now: its Complete card has done its job. The row stays.
        if (await X.settleComplete(st, args.paneID)) await publish();
        return { ok: true, viewPaneID: opened.paneID, workspaceID: opened.workspaceID };
    });
    // The thread view's Back button when no coordinator is known: just close the thread pane this plugin opened.
    command('close-thread', async () => ({ ok: true, closedViewPaneID: await closeThreadView() }));
    /** read-result and open-result also count as opening the result: settle the worker's Complete card. */
    const opensResult = async (args, run) => {
        const bad = needPane(args);
        if (bad) return bad;
        const result = await run();
        if (result.ok && await X.settleComplete(st, args.paneID)) await publish();
        return result;
    };
    command('read-result', async args => opensResult(args, () => X.readResult(api, st, args.paneID)));
    command('capture-worker', async args => needPane(args) ?? X.captureWorker(api, st, args.paneID, args.lines));
    command('send-to-worker', async args => needPane(args) ?? X.sendToWorker(api, st, args.paneID, args.text));
    command('handoff', async args => H.handoff(api, st, args));
    command('request-handoff', async (args, context) => H.requestHandoff(api, st, args, context));
    command('open-result', async args => opensResult(args, () => X.openResult(api, st, args.paneID)));
    command('open-web-link', async args => needPane(args) ?? X.openWebLink(api, st, args.paneID, args.url));
    command('dismiss-worker', async args => needPane(args) ?? after(await X.dismissWorker(api, st, args.paneID)));
    command('trust-folder', async args => needItem(args) ?? after(await X.trustFolder(api, st, args)));
    command('approve', async args => needItem(args) ?? after(await X.approve(api, st, args.itemID, args.promptHash)));
    command('deny', async args => needItem(args) ?? after(await X.deny(api, st, args.itemID)));
    command('snooze', async args => {
        const bad = needItem(args);
        if (bad) return bad;
        const minutes = args.minutes === undefined ? Number(st.settings.snoozeMinutes) : Number(args.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60 * 24 * 14) return fail('minutes must be between 0 and 20160', 'BAD_ARGS');
        const item = await A.snoozeItem(att, args.itemID, minutes, Date.now());
        if (!item) return fail(`no open attention item ${args.itemID}`, 'NOT_FOUND');
        await publish();
        return { ok: true, itemID: item.id, snoozedUntil: item.snoozedUntil };
    });
    command('archive', async args => needPane(args) ?? after(await X.archive(api, st, args.paneID)));
    command('close-worker', async args => needPane(args) ?? after(await X.closeWorker(api, st, args.paneID)));
    // A partial clear still changed the rail, so it publishes whenever anything was cleared.
    command('clear-done', async () => {
        const result = await X.clearDone(api, st);
        if (result.cleared.length) { await settle(); await publish(); }
        return result;
    });
    command('accept', async args => needPane(args) ?? after(await X.accept(api, st, args.paneID)));
    command('pin-orchestrator', async args => {
        const bad = needPane(args);
        if (bad) return bad;
        const result = await X.pinOrchestrator(api, st, args.paneID);
        if (!result.ok) return result;
        resolveOrchestrator();
        await publish();
        return { ok: true, orchestrator: st.orchestrator };
    });
    command('clear-attention', async args => {
        const bad = needItem(args);
        if (bad) return bad;
        const item = await A.handleItem(att, args.itemID, Date.now());
        if (!item) return fail(`no attention item ${args.itemID}`, 'NOT_FOUND');
        await publish();
        return { ok: true, itemID: item.id };
    });
    // `{ on: true, hours?: number | null }` (default 12 h; null or 0: until turned off), `{ on: true, until: ISO }`
    // (in the future, at most 7 days away) or `{ on: false }`.
    command('auto-approve', async args => {
        if (args.on === true) {
            const now = Date.now();
            let endAt = null;
            if (args.until !== undefined) {
                if (args.hours !== undefined) return fail('give hours or until, not both', 'BAD_ARGS');
                endAt = typeof args.until === 'string' ? Date.parse(args.until) : NaN;
                if (!Number.isFinite(endAt) || endAt <= now || endAt - now > autoapprove.MAX_HOURS * 3600000) {
                    return fail(`until must be an ISO time in the future, at most ${autoapprove.MAX_HOURS} hours away`, 'BAD_ARGS');
                }
            }
            const result = AA.turnOn(st, endAt === null ? args.hours : (endAt - now) / 3600000, now);
            if (!result.ok) return result;
            // Exactly the time asked for, not one recomputed from fractional hours.
            if (endAt !== null) AA.setUntil(st, endAt, now);
            // Provider or screen: decided before anything is approved.
            await AA.checkProvider(api, st);
            // Cards already open are approved now; the user opted in knowing that.
            await AA.run(api, st, Date.now());
        } else if (args.on === false) {
            AA.turnOff(st, 'user', Date.now());
        } else return fail('on must be true or false', 'BAD_ARGS');
        await settle();
        await publish();
        return { ok: true, autoApprove: AA.snapshotPart(st) };
    });
    // `{}` lists the log newest first; `{ clear: true }` empties it.
    command('auto-approve-log', async args => {
        if (args.clear === true) { await AA.clearLog(st); await publish(); }
        return { ok: true, entries: AA.logEntries(st), count: st.auto.log.length };
    });

    // Run last suggested command. These commands never type anything: only run-suggested-confirm does, and only with
    // `confirmed: true`, which the run view sends from its Run button.
    let runViewPaneID = null;
    async function closeRunView() {
        if (!runViewPaneID) return null;
        const previous = runViewPaneID;
        runViewPaneID = null;
        try { await api.panes.close(previous); } catch { /* already closed by the user */ }
        return previous;
    }
    const findSuggestion = async (args, context) => {
        const { pane, panes, error } = await R.sourcePane(api, args, context);
        if (error) return { result: error };
        const found = await R.suggestionIn(api, pane.id);
        return { pane, panes, found, result: found.ok ? null : found };
    };
    async function openRunView(pane, panes, found, mode) {
        await closeRunView();
        try {
            const state = { mode, sourcePaneID: pane.id, command: found.command, kind: found.kind, targets: R.runTargets(panes, pane), defaultTarget: R.defaultTarget(found, pane) };
            const opened = await api.openView(RUN_VIEW, { workspaceID: pane.workspaceID, state });
            runViewPaneID = opened?.paneID ?? null;
            return { ok: true, command: found.command, viewPaneID: runViewPaneID };
        } catch (error) {
            return fail(text(error), 'OPEN_FAILED');
        }
    }
    command('run-suggested', async (args, context) => {
        const { pane, panes, found, result } = await findSuggestion(args, context);
        return result ?? openRunView(pane, panes, found, 'run');
    });
    command('copy-suggested', async (args, context) => {
        // The run view's Copy button sends the text as edited: copy exactly that.
        if (args.text !== undefined) {
            const problem = R.commandProblem(args.text);
            if (problem) return fail(problem, 'BAD_TEXT');
            return await clipboard(args.text) ? { ok: true, command: args.text, copied: true } : fail('the clipboard is not available', 'NO_CLIPBOARD');
        }
        const { pane, panes, found, result } = await findSuggestion(args, context);
        if (result) return result;
        if (await clipboard(found.command)) return { ok: true, command: found.command, copied: true };
        // No clipboard: show it in the view, selected, so the user can copy it themselves.
        return openRunView(pane, panes, found, 'copy');
    });
    command('run-suggested-confirm', async args => {
        const result = await R.runConfirmed(api, args);
        if (result.ok) await closeRunView();
        return result;
    });
    command('close-run-view', async () => ({ ok: true, closedViewPaneID: await closeRunView() }));

    // Restart the detected CLI on the same conversation. The reply waits for the resume line (the host refuses calls made after
    // a command replied; commands get 30 s, the exit wait 15 s), outside the serial queue so the rail keeps updating.
    // A refusal is thrown: the pane menu shows a thrown error as a toast and drops an { ok: false } reply.
    disposers.push(api.commands.register(`${PLUGIN_ID}.restart-claude`, async (args, context) => {
        await ready;
        const { pane, error } = await R.sourcePane(api, args && typeof args === 'object' ? args : {}, context);
        const result = error ?? await RS.restartAgent(api, st, pane.id).then(r => (r.result.ok && r.result.restarting ? r.finished : r.result));
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
        return result;
    }));

    const dispose = () => {
        disposed = true;
        codexQuestions?.dispose();
        for (const off of disposers.splice(0)) { try { off(); } catch { /* already gone */ } }
        A.stop(att);
    };
    dispose.ready = ready;
    dispose.store = st;
    return dispose;
}

/** Host entry. Returns the dispose function. */
export async function activate(api) {
    const dispose = registerAll(api, modules);
    await dispose.ready;
    return dispose;
}
