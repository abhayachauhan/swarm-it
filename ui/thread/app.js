// Thread view for one worker. All file- and pane-derived text is set with textContent only.
import {
    parseSummary, findWorker, pendingRequest, formatElapsed, stateLabel,
    availableActions, normalizeMessage, resultError, paneIDFromState, createChangeLock, requestOrigin, coordinatorPaneID,
} from './logic.js';

const api = window.kelpi;
await api.ready;
const $ = id => document.getElementById(id);
const paneID = paneIDFromState(api.state);
const PREFIX = 'local.swarm-view.';

let snapshot = null;
let sequence = -1;
let baseElapsed = 0;
let baseAt = Date.now();
let resultPath = null;
let refreshing = false;
let again = false;
const requestLock = createChangeLock();
let unlockTimer = null;

const showError = message => { $('error').textContent = message || ''; };
const fail = cause => showError(cause instanceof Error ? cause.message : String(cause));

async function run(command, args) {
    const result = await api.commands.execute(PREFIX + command, args);
    const problem = resultError(result);
    if (problem) throw new Error(result?.code ? `${result.code}: ${problem}` : problem);
    return result;
}

function renderHeader(worker) {
    $('name').textContent = worker ? (worker.label || worker.paneID) : (paneID ?? 'No worker selected');
    $('state').textContent = worker ? stateLabel(worker.state) : '';
    $('dot').className = `dot ${worker ? worker.state : ''}`;
    $('worktree').textContent = worker?.worktreePath ? `worktree: ${worker.worktreePath}` : '';
    $('task').textContent = worker?.task ?? '';
    baseElapsed = worker?.elapsedSeconds ?? 0;
    baseAt = Date.now();
    tick();
}

function tick() {
    const worker = findWorker(snapshot, paneID);
    if (!worker) { $('elapsed').textContent = ''; return; }
    const extra = worker.state === 'running' || worker.state === 'waiting' ? (Date.now() - baseAt) / 1000 : 0;
    $('elapsed').textContent = formatElapsed(baseElapsed + extra);
}

function renderActions(worker) {
    const can = availableActions(worker);
    $('accept').disabled = !can.accept;
    $('requestChanges').disabled = !can.requestChanges;
    $('dismiss').disabled = !can.dismiss;
    $('terminal').disabled = !can.terminal;
    $('send').disabled = !can.send;
    $('send').textContent = can.sendLabel;
}

function renderRequest() {
    const item = pendingRequest(snapshot, paneID);
    $('request').hidden = !item;
    clearTimeout(unlockTimer);
    requestLock.observe(snapshot, paneID, Date.now());
    if (!item) return;
    const unrecognised = item.approvable === false;
    $('requestOrigin').textContent = requestOrigin(findWorker(snapshot, paneID), item);
    $('requestCommand').textContent = unrecognised
        ? `Unrecognised prompt. Answer it in the pane.\n\n${item.promptBlock || item.text}`
        : item.command || item.text || '(command not captured)';
    // Disabled for 500 ms after the request, its prompt or its position changed.
    const locked = requestLock.locked(Date.now());
    $('approve').disabled = unrecognised || locked;
    $('deny').disabled = unrecognised || locked;
    $('request').dataset.itemId = item.id;
    $('request').dataset.promptHash = item.promptHash || '';
    const wait = requestLock.remaining(Date.now());
    if (wait > 0) unlockTimer = setTimeout(renderRequest, wait + 20);
}

function renderResult(result) {
    resultPath = result?.path ?? null;
    $('resultPath').textContent = resultPath ?? 'No result file yet';
    $('openResult').disabled = !resultPath;
    const summary = parseSummary(result?.text ?? '');
    $('goal').textContent = summary.goal;
    $('done').textContent = summary.done;
    $('next').textContent = summary.next;
    $('fallbackCard').hidden = summary.found || !summary.fallback;
    $('fallback').textContent = summary.fallback;
}

async function loadResult() {
    if (!paneID) return;
    try {
        renderResult(await run('read-result', { paneID }));
    } catch (cause) {
        renderResult(null);
        const worker = findWorker(snapshot, paneID);
        $('resultPath').textContent = worker?.resultPath ?? 'No result file yet';
        if (!String(cause.message).startsWith('NO_RESULT')) fail(cause);
    }
}

function applySnapshot(next) {
    if (!next || typeof next.sequence !== 'number' || next.sequence <= sequence) return;
    sequence = next.sequence;
    snapshot = next;
    const worker = findWorker(snapshot, paneID);
    renderHeader(worker);
    renderActions(worker);
    renderRequest();
}

async function refresh() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
        const result = await run('get-state', {});
        applySnapshot(result.snapshot);
        showError('');
    } catch (cause) { fail(cause); }
    finally { refreshing = false; if (again) { again = false; void refresh(); } }
}

api.events.on('*', (event, data) => {
    const name = String(event?.name ?? event?.type ?? (typeof event === 'string' ? event : ''));
    if (name === 'gap') { sequence = -1; void refresh(); return; }
    if (!name.endsWith('snapshot')) return;
    const payload = data ?? event?.data ?? event?.payload;
    if (payload && typeof payload.sequence === 'number') applySnapshot(payload);
    else void refresh();
});

async function guarded(button, action) {
    button.disabled = true;
    try { await action(); showError(''); }
    catch (cause) { fail(cause); }
    finally { applyButtonState(); }
}
function applyButtonState() { const worker = findWorker(snapshot, paneID); renderActions(worker); }

const message = () => normalizeMessage($('message').value);
async function sendToWorker(text) {
    if (!text) throw new Error('Type a message first');
    await run('send-to-worker', { paneID, text });
}

$('approve').onclick = () => guarded($('approve'), async () => {
    await run('approve', { itemID: $('request').dataset.itemId, promptHash: $('request').dataset.promptHash });
    await refresh();
});
$('deny').onclick = () => guarded($('deny'), async () => {
    await run('deny', { itemID: $('request').dataset.itemId, promptHash: $('request').dataset.promptHash });
    await refresh();
});
$('accept').onclick = () => guarded($('accept'), async () => { await run('accept', { paneID }); await refresh(); });
$('dismiss').onclick = () => guarded($('dismiss'), async () => { await run('archive', { paneID }); await refresh(); });
$('requestChanges').onclick = () => guarded($('requestChanges'), async () => {
    await sendToWorker(message());
    $('message').value = '';
});
$('terminal').onclick = () => guarded($('terminal'), async () => { await api.ui.reveal(paneID); });
// Same as the rail's ⌂ Coordinator button: the backend closes this thread pane and returns ok. Never disabled, not
// even while its command runs (guarded() would leave it disabled after a refusal): with no coordinator known it
// still closes this view.
$('back').onclick = async () => {
    try {
        const coordinator = coordinatorPaneID(snapshot);
        // Reveal first: closing the thread pane ends this view's script.
        if (coordinator && api.ui && typeof api.ui.reveal === 'function') await api.ui.reveal(coordinator);
        if (coordinator) await run('open-thread', { paneID: coordinator });
        else await run('close-thread', {});
        showError('');
    } catch (cause) { fail(cause); }
};
$('openResult').onclick = () => guarded($('openResult'), async () => {
    await run('open-result', { paneID });
});
$('reload').onclick = () => void loadResult();
$('composer').onsubmit = event => {
    event.preventDefault();
    void guarded($('send'), async () => { await sendToWorker(message()); $('message').value = ''; });
};

if (!paneID) {
    showError('No worker selected. Open this view from the Swarm sidebar.');
    renderActions(null);
} else {
    await refresh();
    await loadResult();
    setInterval(tick, 1000);
}
