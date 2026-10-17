/* Swarm rail: pure logic plus DOM builders that take an injected `doc`.
 * Classic script (the view frame is an opaque-origin sandbox, so no ES modules): it assigns
 * globalThis.SwarmLogic. Tests load it with node:vm.
 * SECURITY: every string from a snapshot (names, last lines, commands, task text) reaches the DOM
 * only through textContent. No HTML-string API is used anywhere in this view. */
(() => {
    const CMD = 'local.swarm-view.';
    /** Y/N must be pressed twice within this window to act. */
    const ARM_MS = 3000;
    /** The rail gives up the keyboard after this long without a key or pointer event. */
    const IDLE_MS = 30000;
    /** Approve and Deny buttons stay disabled this long after their item or position changes. */
    const LOCK_MS = 500;
    /**
     * Approve, Deny and "Really stop?" stay disabled this long after a layout change the user caused under the
     * pointer (a card expanding or collapsing, Stop being armed or cancelled): the second click of a double-click
     * must never land on a button that just moved under the pointer.
     */
    const LAYOUT_LOCK_MS = 400;
    /** A window blur releases the rail only after lasting this long (see noteBlur). */
    const BLUR_GRACE_MS = 250;

    // ---- snapshots ----------------------------------------------------------------------
    const isSnapshot = value => Boolean(value) && typeof value === 'object' && value.version === 1
        && Number.isFinite(value.sequence) && Array.isArray(value.workers) && Array.isArray(value.attention);

    /** Keep the newer snapshot: drop invalid ones and any with a lower or equal sequence. */
    function acceptSnapshot(current, next) {
        if (!isSnapshot(next)) return current;
        if (current && next.sequence <= current.sequence) return current;
        return next;
    }

    // ---- elapsed ------------------------------------------------------------------------
    function formatElapsed(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '-';
        const s = Math.floor(seconds);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60);
        const rest = m % 60;
        if (h < 24) return rest ? `${h}h ${rest}m` : `${h}h`;
        const d = Math.floor(h / 24);
        return `${d}d ${h % 24}h`;
    }

    /** Elapsed shown now: live workers keep counting between snapshots, finished ones freeze. */
    function elapsedNow(worker, receivedAtMs, nowMs) {
        const base = Number.isFinite(worker.elapsedSeconds) ? worker.elapsedSeconds : 0;
        const live = worker.state === 'running' || worker.state === 'waiting';
        const extra = live && Number.isFinite(receivedAtMs) && Number.isFinite(nowMs) ? Math.max(0, Math.floor((nowMs - receivedAtMs) / 1000)) : 0;
        return base + extra;
    }

    // ---- grouping / lists ---------------------------------------------------------------
    const activeWorkers = snapshot => snapshot.workers.filter(worker => !worker.archived);

    /** The only cards the rail shows: permission requests. Complete and Error items are not shown; finished workers live in the list. */
    const requestItems = snapshot => snapshot.attention.filter(item => item.type === 'Request');

    const isFinished = worker => worker.state === 'done' || worker.state === 'error';

    /**
     * The three sections of the rail, in reading order. Each is { key, title, rows }; empty ones are not drawn.
     *   needs:   one 'request' row per permission card (a waiting worker with a card appears only here), then one
     *            'waiting' row per worker waiting for input whose prompt the backend cannot read (snapshot.waitingPanes);
     *   running: live workers (running, or waiting without a card);
     *   done:    no rows, only `count`: how many workers finished (done or error).
     * Archived workers are omitted everywhere.
     */
    function sections(snapshot) {
        if (!snapshot) return [];
        const needs = [];
        const carded = new Set();
        for (const item of requestItems(snapshot)) {
            if (carded.has(item.paneID)) continue;
            carded.add(item.paneID);
            needs.push({ kind: 'request', paneID: item.paneID, item });
        }
        for (const entry of Array.isArray(snapshot.waitingPanes) ? snapshot.waitingPanes : []) {
            if (!entry || carded.has(entry.paneID)) continue;
            carded.add(entry.paneID);
            needs.push({ kind: 'waiting', paneID: entry.paneID, entry });
        }
        const workers = activeWorkers(snapshot).map(worker => ({ kind: 'worker', ...worker }));
        const running = workers.filter(row => !isFinished(row) && !carded.has(row.paneID));
        return [
            { key: 'needs', title: 'Needs you', rows: needs },
            { key: 'running', title: 'Running', rows: running },
            { key: 'done', title: 'Done', rows: [], count: workers.filter(isFinished).length },
        ];
    }

    /** The flat list J/K walk: every section's rows in order. The coordinator is not a row; it is the header's ⌂ button. */
    const rowsOf = snapshot => sections(snapshot).flatMap(section => section.rows);

    /**
     * The header's home button target: open-thread on the orchestrator closes the thread view and gives the coordinator
     * its space back. With no coordinator known it still closes the thread view (close-thread), so ⌂ is never a dead end.
     */
    const homeEffect = snapshot => (snapshot && snapshot.orchestrator
        ? effect('open-thread', { paneID: snapshot.orchestrator.paneID })
        : effect('close-thread', {}));

    // ---- selection ----------------------------------------------------------------------
    function initialUI(railFocused = false) {
        return { selectedPaneID: null, railFocused };
    }

    /** Keep the selection on the same pane across snapshots; fall back to the first row. Expanded cards that left the snapshot are forgotten. */
    function reconcile(ui, snapshot) {
        const rows = rowsOf(snapshot);
        const base = pruneExpanded(armStillValid(ui, snapshot) ? ui : disarm(ui), snapshot);
        if (rows.some(row => row.paneID === base.selectedPaneID)) return base;
        return { ...disarm(base), selectedPaneID: rows.length ? rows[0].paneID : null };
    }

    // ---- two-step Y/N and idle focus ----------------------------------------------------
    const disarm = ui => (ui.armed || ui.closeAsk ? { ...ui, armed: null, closeAsk: null } : ui);
    /** An arm only survives while its Request item is still on the selected pane with the same prompt. */
    function armStillValid(ui, snapshot) {
        if (!ui.armed) return true;
        if (!snapshot || ui.armed.paneID !== ui.selectedPaneID) return false;
        const item = snapshot.attention.find(i => i.id === ui.armed.itemID);
        return !!item && item.type === 'Request' && item.paneID === ui.armed.paneID && item.promptHash === ui.armed.promptHash;
    }
    /** The armed action when it is still inside its window, else null. */
    const armedNow = (ui, nowMs) => (ui.armed && nowMs < ui.armed.until ? ui.armed : null);
    /** Drop an expired arm and an idle focus. Returns the same object when nothing changed. */
    function expire(ui, nowMs) {
        let next = ui;
        if (next.armed && !(nowMs < next.armed.until)) next = { ...next, armed: null };
        if (next.closeAsk && !(nowMs < next.closeAsk.until)) next = { ...next, closeAsk: null };
        if (next.railFocused && Number.isFinite(next.lastActivityAt) && nowMs - next.lastActivityAt >= IDLE_MS) next = { ...next, railFocused: false, armed: null };
        return next;
    }
    /** Record keyboard or pointer activity so the idle timer restarts. */
    const touch = (ui, nowMs) => ({ ...ui, lastActivityAt: nowMs });
    /** Focus changes always disarm (blur, or the rail being focused again). */
    const setRailFocused = (ui, value, nowMs) => ({ ...disarm(ui), railFocused: value, lastActivityAt: nowMs, blurAt: null });

    // ---- deferred blur ------------------------------------------------------------------
    // The host re-focuses the plugin iframe in a ~10 ms loop after focus-rail, and every iframe.focus() fires a
    // transient window blur then focus (observed live). So a blur alone never releases the rail: it is only
    // recorded, and released once it has lasted BLUR_GRACE_MS with document.hasFocus() still false and no
    // key, pointer or focus-rail event since.
    /** Record a window blur. Does nothing when the rail is not focused or an earlier blur is still undecided (no activity since). */
    const noteBlur = (ui, nowMs) => {
        if (!ui.railFocused) return ui;
        if (Number.isFinite(ui.blurAt) && !(ui.lastActivityAt > ui.blurAt)) return ui;
        return { ...ui, blurAt: nowMs };
    };
    /** Decide a pending blur. Returns the same object while nothing needs to change. */
    function resolveBlur(ui, nowMs, hasFocus) {
        if (!Number.isFinite(ui.blurAt)) return ui;
        if (hasFocus || (Number.isFinite(ui.lastActivityAt) && ui.lastActivityAt > ui.blurAt)) return { ...ui, blurAt: null };
        if (nowMs - ui.blurAt < BLUR_GRACE_MS) return ui;
        return setRailFocused(ui, false, nowMs);
    }

    function moveSelection(ui, snapshot, delta) {
        const rows = rowsOf(snapshot);
        if (!rows.length) return { ...ui, selectedPaneID: null };
        const at = rows.findIndex(row => row.paneID === ui.selectedPaneID);
        const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
        return { ...ui, selectedPaneID: rows[next].paneID };
    }

    const itemsForPane = (snapshot, paneID) => snapshot.attention.filter(item => item.paneID === paneID);
    const requestForPane = (snapshot, paneID) => itemsForPane(snapshot, paneID).find(item => item.type === 'Request') ?? null;
    /** Whether a card comes from a swarm other than the followed one (then the rail names that swarm). */
    const fromOtherSwarm = (item, snapshot) => Boolean(item.swarmName) && item.swarmWorkspaceID !== (snapshot && snapshot.workspaceID);
    /** The card heading: the worker label, plus the swarm name for a card from another swarm: "worker-2 · Kelpi UI". */
    function cardTitle(item, snapshot, label) {
        const name = label || item.paneLabel || String(item.paneID ?? '').slice(0, 8);
        return fromOtherSwarm(item, snapshot) ? `${name} · ${item.swarmName}` : name;
    }

    // ---- layout changes under the pointer -----------------------------------------------
    /** Record a layout change the user just caused (see LAYOUT_LOCK_MS). */
    const markLayout = (ui, nowMs) => ({ ...ui, layoutChangedAt: nowMs });
    /** Milliseconds until the layout lock lifts, 0 when none is active. */
    function layoutLockRemaining(ui, nowMs) {
        if (!ui || !Number.isFinite(ui.layoutChangedAt)) return 0;
        return Math.max(0, LAYOUT_LOCK_MS - (nowMs - ui.layoutChangedAt));
    }
    const layoutLocked = (ui, nowMs) => layoutLockRemaining(ui, nowMs) > 0;

    // ---- expanded cards -----------------------------------------------------------------
    const isExpanded = (ui, itemID) => Array.isArray(ui.expanded) && ui.expanded.includes(itemID);
    /** Show the whole command of one card, or clamp it again. Survives redraws: it lives in ui. Everything below the card moves, so the layout lock starts. */
    function toggleExpanded(ui, itemID, nowMs = Date.now()) {
        const list = Array.isArray(ui.expanded) ? ui.expanded : [];
        return markLayout({ ...ui, expanded: list.includes(itemID) ? list.filter(id => id !== itemID) : [...list, itemID] }, nowMs);
    }
    /** Forget expanded cards that are no longer in the snapshot. Returns the same object when nothing changed. */
    function pruneExpanded(ui, snapshot) {
        if (!Array.isArray(ui.expanded) || !ui.expanded.length) return ui;
        const live = new Set(snapshot ? requestItems(snapshot).map(item => item.id) : []);
        const kept = ui.expanded.filter(id => live.has(id));
        return kept.length === ui.expanded.length ? ui : { ...ui, expanded: kept };
    }

    // ---- two-step Stop -------------------------------------------------------------------
    /** Arm Stop on a worker: Keep and "Really stop?" replace the Stop button, so the layout lock starts. */
    const askClose = (ui, paneID, nowMs) => markLayout({ ...disarm(ui), selectedPaneID: paneID, closeAsk: { paneID, until: nowMs + ARM_MS } }, nowMs);
    /** Keep the worker: Stop comes back under the pointer, so the layout lock starts again. */
    const cancelClose = (ui, nowMs) => markLayout({ ...ui, closeAsk: null }, nowMs);

    // ---- commands -----------------------------------------------------------------------
    const effect = (name, args) => ({ command: CMD + name, args });

    // ---- auto-approve -------------------------------------------------------------------
    /** One click on the header toggle turns auto-approve on for this long. There is no duration picker. */
    const AUTO_DEFAULT_HOURS = 12;
    /** Local HH:MM for an ISO time, '?' when unreadable. */
    function formatClock(value) {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return '?';
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    /** The header toggle's label: "Auto: off", or "Auto: on · 14 ✓ · until 08:30". */
    function autoLabel(auto) {
        if (!auto || !auto.on) return 'Auto: off';
        const until = auto.until ? `until ${formatClock(auto.until)}` : 'until turned off';
        return `Auto: on · ${auto.approved} ✓ · ${until}`;
    }
    /** After a switch-off: says so, and why. '' while on or never used. */
    function autoEndedText(auto) {
        if (!auto || auto.on || !auto.ended) return '';
        const count = `${auto.approved} approved`;
        return auto.ended.reason === 'expired'
            ? `Auto-approve switched itself off at ${formatClock(auto.ended.at)}: the time ran out. ${count}.`
            : `Auto-approve turned off at ${formatClock(auto.ended.at)}. ${count}.`;
    }
    /** What auto-approve has to say beyond its label: prompts left for the user, refusals, paused panes, the last switch-off. */
    function autoNotes(auto) {
        if (!auto) return [];
        const notes = [];
        // Which path answers: Kelpi's permission requests (swarm-it the selected provider), or the screen, with the fix.
        if (auto.provider && auto.provider.warning) notes.push(auto.provider.warning);
        else if (auto.provider && auto.provider.active) notes.push("Answers Claude's permission requests through Kelpi, not from the screen");
        if (auto.on && auto.skipped) notes.push(`${auto.skipped} unrecognised prompt${auto.skipped === 1 ? '' : 's'} left for you`);
        if (auto.on && auto.failed) notes.push(`${auto.failed} refused by the live check (see the log)`);
        for (const p of (auto.on && auto.paused) || []) notes.push(`Stopped for ${p.label || p.paneID}: ${p.reason}`);
        const ended = autoEndedText(auto);
        if (ended) notes.push(ended);
        return notes;
    }
    /**
     * The two auto-approve events the user must not miss, as footer notices: a pane the rate guard stopped, and the
     * timer switching auto-approve off. Each has a stable key so app.js shows it once; afterwards it stays in the
     * toggle's tooltip (autoNotes). A switch-off by the user is not announced: they did it.
     */
    function autoAlerts(auto) {
        if (!auto) return [];
        const alerts = [];
        for (const p of (auto.on && auto.paused) || []) {
            alerts.push({ key: `paused:${p.paneID}:${p.at}`, text: `Auto-approve stopped for ${p.label || p.paneID}: ${p.reason}` });
        }
        if (!auto.on && auto.ended && auto.ended.reason === 'expired') alerts.push({ key: `ended:${auto.ended.at}`, text: autoEndedText(auto) });
        return alerts;
    }
    const autoOnEffect = (hours = AUTO_DEFAULT_HOURS) => effect('auto-approve', { on: true, hours });
    /** 9:00 local time next: today when it is before 9 now, else tomorrow. */
    function nextNineAm(nowMs) {
        const at = new Date(nowMs);
        at.setHours(9, 0, 0, 0);
        if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
        return at;
    }
    /** The Auto menu's choices (no "no limit" here: the rail always sets an end). */
    function autoChoices(nowMs) {
        const today = nextNineAm(nowMs).getDate() === new Date(nowMs).getDate();
        return [
            { key: '10m', label: '10 minutes' },
            { key: '4h', label: '4 hours' },
            { key: '12h', label: '12 hours' },
            { key: '9am', label: today ? 'Until 9am today' : 'Until 9am tomorrow' },
        ];
    }
    /** The auto-approve command for a menu choice, worked out when it is clicked. */
    function autoChoiceEffect(key, nowMs) {
        if (key === '10m') return autoOnEffect(10 / 60);
        if (key === '4h') return autoOnEffect(4);
        if (key === '12h') return autoOnEffect(12);
        if (key === '9am') return effect('auto-approve', { on: true, until: nextNineAm(nowMs).toISOString() });
        return null;
    }
    const autoOffEffect = () => effect('auto-approve', { on: false });
    const autoLogEffect = () => effect('auto-approve-log', {});
    const autoLogClearEffect = () => effect('auto-approve-log', { clear: true });

    /**
     * Key reducer. Returns { ui, effect, notice, handled, label?, reveal? }.
     * Keys act ONLY while the rail has focus and no modifier is held. `effect` is a backend
     * command to run ({command, args}); `notice` is a local message when a key has no target; `label` names the
     * verb for a failure notice when the command alone is ambiguous (close-worker is "Stop" or "Remove"); `reveal` is
     * a pane id to show (api.ui.reveal).
     */
    function reduceKey(ui0, snapshot, input) {
        const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
        const ui = expire(ui0, nowMs);
        const none = { ui, effect: null, notice: '', handled: false };
        if (!snapshot || !ui.railFocused) return none;
        if (input.ctrlKey || input.altKey || input.metaKey) return none;
        const key = String(input.key ?? '');
        const lower = key.length === 1 ? key.toLowerCase() : key;
        const rows = rowsOf(snapshot);
        const selected = rows.find(row => row.paneID === ui.selectedPaneID) ?? null;
        const active = touch(ui, nowMs);
        const handled = patch => ({ ...none, handled: true, ...patch, ui: patch.ui ?? active });
        // Any key other than Y/N cancels a pending approve or deny.
        const other = patch => handled({ ...patch, ui: patch.ui ?? disarm(active) });
        switch (lower) {
            case 'j': case 'ArrowDown': return other({ ui: disarm(moveSelection(active, snapshot, 1)) });
            case 'k': case 'ArrowUp': return other({ ui: disarm(moveSelection(active, snapshot, -1)) });
            case 'Enter':
                if (!selected) return other({});
                // On a card, Enter shows or shortens the command; on a worker it opens the thread.
                if (selected.kind === 'request') return other({ ui: toggleExpanded(disarm(active), selected.item.id, nowMs) });
                // A worker waiting on a prompt the rail cannot read: Enter goes to its pane.
                if (selected.kind === 'waiting') return other({ reveal: selected.paneID });
                return other({ effect: effect('open-thread', { paneID: selected.paneID }) });
            case 'e': {
                if (!selected || selected.kind !== 'worker') return other({ notice: 'Select a worker to archive.' });
                return other({ effect: effect('archive', { paneID: selected.paneID }) });
            }
            case 'x': {
                if (!selected || selected.kind !== 'worker') return other({ notice: 'Select a worker to stop.' });
                if (ui.closeAsk && ui.closeAsk.paneID === selected.paneID && nowMs < ui.closeAsk.until) {
                    return handled({ ui: { ...disarm(active), closeAsk: null }, label: 'Stop', effect: effect('close-worker', { paneID: selected.paneID }) });
                }
                return handled({ ui: askClose(active, selected.paneID, nowMs), notice: 'Press X again to stop and close this worker.' });
            }
            case 'y': case 'n': {
                if (selected && selected.kind === 'waiting') return other({ notice: 'The rail cannot read this prompt: answer it in the pane.' });
                const item = selected ? requestForPane(snapshot, selected.paneID) : null;
                if (!item) return other({ notice: 'No permission request on this worker.' });
                if (item.approvable === false) return handled({ notice: 'Unrecognised prompt: answer it in the pane.', ui: disarm(active) });
                const action = lower === 'y' ? 'approve' : 'deny';
                const armed = armedNow(ui, nowMs);
                if (armed && armed.action === action && armed.itemID === item.id && armed.promptHash === item.promptHash && armed.paneID === selected.paneID) {
                    return handled({ ui: disarm(active), effect: effect(action, { itemID: item.id, promptHash: item.promptHash }) });
                }
                // First press (or a different key / item): arm only. Nothing is sent.
                const arm = { action, itemID: item.id, paneID: selected.paneID, promptHash: item.promptHash, until: nowMs + ARM_MS };
                return handled({
                    ui: { ...active, armed: arm },
                    notice: action === 'approve' ? 'Press Y again to approve.' : 'Press N again to deny.'
                });
            }
            default: return none;
        }
    }

    const attentionEffect = (kind, item) => {
        switch (kind) {
            case 'approve': return effect('approve', { itemID: item.id, promptHash: item.promptHash });
            case 'deny': return effect('deny', { itemID: item.id, promptHash: item.promptHash });
            default: return null;
        }
    };

    /** Turn a CommandResult into the one-line message the rail shows. Refusals show the backend text verbatim. */
    function describeResult(label, result) {
        if (result && result.ok) return { ok: true, message: '' };
        const reason = result && typeof result.error === 'string' && result.error ? result.error : 'The command failed.';
        return { ok: false, message: `${label}: ${reason}` };
    }

    // ---- DOM builders (text only) -------------------------------------------------------
    function h(doc, tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }
    function button(doc, label, className, onClick, title) {
        const node = h(doc, 'button', className, label);
        node.setAttribute('type', 'button');
        if (title) node.setAttribute('title', title);
        node.addEventListener('click', event => { if (event && event.stopPropagation) event.stopPropagation(); onClick(); });
        return node;
    }

    /**
     * Approve and Deny stay disabled for LOCK_MS after the Request item, its prompt, or its position in the strip changes,
     * so a click aimed at one prompt cannot land on another that just slid under the pointer.
     */
    function createButtonGuard(delayMs = LOCK_MS) {
        const seen = new Map();
        return {
            /** Record the current Request items (id, prompt hash, strip position) at nowMs. */
            observe(attention, nowMs) {
                const live = new Set();
                attention.forEach((item, index) => {
                    if (item.type !== 'Request') return;
                    live.add(item.id);
                    const prev = seen.get(item.id);
                    if (!prev || prev.index !== index || prev.hash !== item.promptHash) seen.set(item.id, { index, hash: item.promptHash, since: nowMs });
                });
                for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
            },
            locked(itemID, nowMs) {
                const entry = seen.get(itemID);
                return !!entry && nowMs - entry.since < delayMs;
            },
            /** Milliseconds until the last lock lifts, 0 when none is active. */
            remaining(nowMs) {
                let wait = 0;
                for (const entry of seen.values()) wait = Math.max(wait, delayMs - (nowMs - entry.since));
                return Math.max(0, wait);
            }
        };
    }
    const defaultGuard = createButtonGuard();

    const STATE_LABEL = { running: 'running', waiting: 'waiting', done: 'done', error: 'error' };

    // Display only, never used to approve: the lines between the last two dashed rules, as newer Claude prompts draw them.
    const RULE = /^[─━╌╍┄┅┈┉-]{8,}$/u;
    function guessCommand(block) {
        const lines = String(block ?? '').split('\n').map(l => l.trim());
        const rules = lines.reduce((acc, l, i) => (RULE.test(l) ? [...acc, i] : acc), []);
        if (rules.length < 2) return '';
        const [a, b] = rules.slice(-2);
        return lines.slice(a + 1, b).filter(Boolean).join('\n');
    }

    /** Marks a line break the pane put inside a token, so a rejoined line still shows where it was split. */
    const JOIN_MARK = '⏎';

    /**
     * Display only, never used to approve: the raw lines are shown as captured. The one exception is a real
     * terminal wrap, recognised by every non-final line having the same width (two of them at least) and the last
     * being no wider: a line with no space in it was split mid-token ("/Users/maxmusterm" / "ann/gl/..."), so it is
     * rejoined with the next, with a visible mark at the join. Nothing else is rejoined: a widest line that happens
     * to be a comment must never swallow the command after it.
     */
    function displayCommand(command) {
        const lines = String(command ?? '').split('\n');
        if (lines.length < 3) return lines.join('\n');
        const body = lines.slice(0, -1);
        const width = body[0].length;
        const wrapped = width > 0 && body.every(l => l.length === width) && lines.at(-1).length <= width;
        if (!wrapped) return lines.join('\n');
        let out = '';
        lines.forEach((line, i) => {
            out += line;
            if (i === lines.length - 1) return;
            out += /\s/.test(line) ? '\n' : JOIN_MARK;
        });
        return out;
    }

    /**
     * The command a card shows. Display only, never used to approve. Recognised prompts show the captured command
     * (a real terminal wrap rejoined with ⏎ marks, see displayCommand); unrecognised ones show the best guess.
     */
    function cardCommand(item) {
        if (item.approvable === false) return guessCommand(item.promptBlock) || displayCommand(item.command) || String(item.text ?? '');
        return displayCommand(item.command);
    }

    // ---- other swarms --------------------------------------------------------------------
    /** Kelpi's Group colours. The tag's data-color is one of these or 'neutral' (the accent), never anything else. */
    const GROUP_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray', 'black', 'white'];
    const groupColor = value => (GROUP_COLORS.includes(value) ? value : 'neutral');
    const otherSwarmsOf = snapshot => (snapshot && Array.isArray(snapshot.otherSwarms) ? snapshot.otherSwarms.filter(s => s && s.workspaceID) : []);
    /** The tag a card or waiting row from another swarm carries: { name, color, coordinatorPaneID }, or null for the followed swarm's own. */
    function fromTag(snapshot, source) {
        if (!fromOtherSwarm(source, snapshot)) return null;
        const swarm = otherSwarmsOf(snapshot).find(s => s.workspaceID === source.swarmWorkspaceID);
        return { name: source.swarmName, color: groupColor(swarm && swarm.color), coordinatorPaneID: swarm ? swarm.orchestratorPaneID : null };
    }
    /** "Kelpi UI · 2 running · 1 need you · 3 done", zero parts left out. */
    function swarmSummary(swarm) {
        const parts = [[swarm.running, 'running'], [swarm.needYou, 'need you'], [swarm.done, 'done']]
            .filter(([n]) => Number(n) > 0).map(([n, what]) => `${n} ${what}`);
        return [swarm.name || swarm.workspaceID, ...parts].join(' · ');
    }
    /** The small "from <swarm>" tag in the swarm's Group colour; a click goes to that swarm's coordinator pane. */
    function buildSwarmTag(doc, from, handlers) {
        const text = `from ${from.name}`;
        const tag = from.coordinatorPaneID
            ? button(doc, text, 'swarm-tag', () => handlers.onReveal(from.coordinatorPaneID, 'Coordinator'), `Go to the ${from.name} coordinator`)
            : h(doc, 'span', 'swarm-tag', text);
        tag.dataset.color = groupColor(from.color);
        return tag;
    }
    /** One line per other live swarm, under the followed swarm's sections. A click goes to its coordinator pane. */
    function buildOtherSwarms(doc, snapshot, handlers) {
        const swarms = otherSwarmsOf(snapshot);
        if (!swarms.length) return [];
        const head = h(doc, 'div', 'sec-head sec-other', 'Other swarms');
        head.setAttribute('role', 'presentation');
        return [head, ...swarms.map(swarm => {
            const line = button(doc, swarmSummary(swarm), 'swarm-line', () => handlers.onReveal(swarm.orchestratorPaneID, 'Coordinator'), `Go to the ${swarm.name} coordinator`);
            line.dataset.color = groupColor(swarm.color);
            line.dataset.workspaceId = swarm.workspaceID;
            return line;
        })];
    }

    /**
     * A worker waiting for input whose prompt the backend cannot read (its pane is too narrow): "<label> is waiting
     * for you" and Go to pane. Nothing to approve here, and auto-approve never acts on it.
     */
    function buildWaitingRow(doc, row, selected, view, handlers) {
        const { snapshot } = view;
        const entry = row.entry;
        const worker = snapshot.workers.find(w => w.paneID === row.paneID);
        const label = (worker && worker.label) || entry.label || String(row.paneID).slice(0, 8);
        const node = h(doc, 'div', 'att att-waiting');
        node.setAttribute('role', 'option');
        node.setAttribute('tabindex', '-1');
        node.setAttribute('aria-current', selected ? 'true' : 'false');
        node.dataset.paneId = row.paneID;
        const from = fromTag(snapshot, entry);
        if (from) node.append(buildSwarmTag(doc, from, handlers));
        node.append(h(doc, 'div', 'att-text', `${label} is waiting for you`));
        const actions = h(doc, 'div', 'att-actions');
        actions.append(button(doc, 'Go to pane', 'btn btn-primary', () => handlers.onReveal(row.paneID, 'Go to pane'), 'Show the pane so you can answer it there (Enter)'));
        node.append(actions);
        node.addEventListener('click', () => handlers.onSelect(row.paneID));
        return node;
    }

    /**
     * A permission Request card: who is asking, the command clamped to two lines (click or Enter expands it in place),
     * Approve and Deny. An unrecognised prompt says "Answer in the pane" with a "Go to pane" button instead, which
     * reveals the pane itself (the thread view could not answer it either).
     * Only Request items reach here (see requestItems).
     */
    function buildAttentionItem(doc, item, handlers, opts = {}) {
        const root = h(doc, 'div', 'att att-request');
        root.dataset.itemId = item.id;
        if (opts.from) root.append(buildSwarmTag(doc, opts.from, handlers));
        // Name the worker; the pane id stays available as a tooltip.
        const pane = h(doc, 'div', 'att-pane', opts.title || String(item.paneID ?? '').slice(0, 8));
        pane.setAttribute('title', String(item.paneID ?? ''));
        root.append(pane);
        const unrecognised = item.approvable === false;
        const shown = cardCommand(item);
        if (shown) {
            const code = h(doc, 'code', opts.expanded ? 'att-command' : 'att-command att-clamp', shown);
            code.setAttribute('title', opts.expanded
                ? (shown !== item.command && !unrecognised ? `Wrapped lines rejoined for display, ${JOIN_MARK} marks each join. Click to shorten.` : 'Click to shorten')
                : 'Click to show the whole command');
            code.addEventListener('click', () => handlers.onExpand(item.id));
            root.append(code);
            // Never hide part of a command silently. A clamped card with more than two lines says how many are out of
            // sight. A long single line that wraps past two lines cannot be seen from here: app.js measures the real
            // overflow after layout and reveals the 'att-more-maybe' line (CSS hides it until then).
            if (!opts.expanded) {
                const hidden = shown.split('\n').length - 2;
                const more = hidden > 0
                    ? h(doc, 'div', 'att-more dim', `${hidden} more line${hidden === 1 ? '' : 's'} hidden, click to show`)
                    : h(doc, 'div', 'att-more att-more-maybe dim', 'Long command, click to show it all');
                more.addEventListener('click', () => handlers.onExpand(item.id));
                root.append(more);
            }
        }
        if (unrecognised) root.append(h(doc, 'div', 'att-text dim', 'Answer in the pane'));
        if (opts.armed) {
            const armed = h(doc, 'div', 'att-text att-armed', opts.armed === 'approve' ? 'Press Y again to approve' : 'Press N again to deny');
            armed.setAttribute('role', 'status');
            root.append(armed);
        }
        const actions = h(doc, 'div', 'att-actions');
        if (unrecognised) {
            actions.append(button(doc, 'Go to pane', 'btn btn-primary', () => handlers.onAnswer(item), 'Show the pane so you can answer the prompt there'));
        } else {
            const yes = button(doc, 'Approve', 'btn btn-primary', () => handlers.onAttention('approve', item), 'Approve (Y)');
            const no = button(doc, 'Deny', 'btn', () => handlers.onAttention('deny', item), 'Deny (N)');
            if (opts.locked) for (const b of [yes, no]) { b.disabled = true; b.setAttribute('disabled', ''); b.dataset.locked = 'true'; b.setAttribute('title', 'Just changed: wait a moment'); }
            actions.append(yes, no);
        }
        root.append(actions);
        return root;
    }

    // ---- status line --------------------------------------------------------------------
    // The one line under a worker's name. Never raw terminal decoration: box drawing and block characters go, a git
    // status such as "↑16 !10 ?3" goes, and a prompt line (the input box, a shortcut hint) is replaced by the state.
    const BOX_CHARS = /[─━│┃┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝▀▄█▌▐░▒▓╌╍┄┅┈┉]/gu;
    const GIT_STATUS = /(?:^|\s)(?:[↑↓⇡⇣][0-9]+|[!?+✘×*~][0-9]+)(?=\s|$)/gu;
    const PROMPT_LINE = /^(?:[>❯›$%#](?:\s|$)|\?\s*for shortcuts|⏵|esc to interrupt)/iu;
    function statusLine(row) {
        const text = String(row.lastLine ?? '').replace(BOX_CHARS, ' ').replace(GIT_STATUS, ' ').replace(/\s+/gu, ' ').trim();
        if (!text || PROMPT_LINE.test(text)) return STATE_LABEL[row.state] || '';
        return text;
    }

    /** Opening a finished worker's result counts as reviewing it: the accept effect, or null when there is nothing to mark. */
    function reviewEffect(snapshot, paneID) {
        const worker = snapshot && snapshot.workers.find(w => w.paneID === paneID);
        if (!worker || worker.archived || worker.accepted || !isFinished(worker)) return null;
        return effect('accept', { paneID });
    }

    /**
     * A worker row: dot, name, elapsed, then the one right verb. Running or waiting: a two-step Stop, shown only on the
     * selected or hovered row (CSS, class row-hover). Finished workers have no row: the Done head counts them.
     */
    function buildThreadRow(doc, row, selected, view, handlers) {
        const nowMs = Number.isFinite(view.nowMs) ? view.nowMs : Date.now();
        const node = h(doc, 'div', 'row');
        node.setAttribute('role', 'option');
        node.setAttribute('tabindex', '-1');
        node.setAttribute('aria-current', selected ? 'true' : 'false');
        node.dataset.paneId = row.paneID;
        node.dataset.state = row.state;
        const top = h(doc, 'span', 'row-top');
        top.append(h(doc, 'span', `dot dot-${row.state}`));
        top.append(h(doc, 'span', 'name', row.label || row.paneID));
        const time = h(doc, 'span', 'time', formatElapsed(elapsedNow(row, view.receivedAtMs, view.nowMs)));
        time.dataset.elapsedPane = row.paneID;
        top.append(time);
        {
            const asked = view.ui && view.ui.closeAsk && view.ui.closeAsk.paneID === row.paneID;
            {
                const actions = h(doc, 'span', 'row-actions row-hover');
                if (asked) {
                    // Two steps, so one stray click cannot end an agent. The actions sit at the row's right edge, so the
                    // LAST button takes the spot Stop had: that is Keep, the harmless one, and "Really stop?" is disabled
                    // for LAYOUT_LOCK_MS after arming so the second click of a double-click on Stop cannot end a worker.
                    const really = button(doc, 'Really stop?', 'btn btn-danger', () => handlers.onCloseConfirm(row.paneID), 'Ends this worker and closes its pane');
                    if (layoutLocked(view.ui, nowMs)) { really.disabled = true; really.setAttribute('disabled', ''); really.dataset.locked = 'true'; }
                    actions.append(really);
                    actions.append(button(doc, 'Keep', 'btn', () => handlers.onCloseCancel(), 'Keep the worker running'));
                } else {
                    actions.append(button(doc, 'Stop', 'btn', () => handlers.onCloseAsk(row.paneID), 'Stop this worker (X)'));
                }
                top.append(actions);
            }
        }
        node.append(top);
        node.append(h(doc, 'span', 'last', statusLine(row)));
        node.addEventListener('click', () => handlers.onSelect(row.paneID));
        node.addEventListener('dblclick', () => handlers.onOpen(row.paneID));
        return node;
    }

    /**
     * Auto-approve in one header control: "Auto: off" opens a menu of four durations (10 minutes, 4 hours, 12 hours, until 9am)
     * under the header, "Auto: on · 14 ✓ · until 08:30" turns it off in one click. Notes (prompts left for you,
     * refusals, paused panes, the last switch-off) are the tooltip. A small "log" link follows when the log has
     * entries; it expands the log under the header.
     */
    function buildAutoControls(doc, view, handlers) {
        const { snapshot, ui } = view;
        const auto = snapshot && snapshot.autoApprove;
        const on = Boolean(auto && auto.on);
        const notes = autoNotes(auto);
        const title = on
            ? ['Approving every recognised request without asking you. Click to turn off.', ...notes].join('\n')
            : ['Click to choose how long to approve every recognised request.', ...notes].join('\n');
        const toggle = button(doc, autoLabel(auto), on ? 'btn btn-auto btn-auto-on' : 'btn btn-auto', () => (on ? handlers.onAutoOff() : handlers.onAutoMenu()), title);
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', on ? 'true' : 'false');
        if (!on) toggle.setAttribute('aria-expanded', ui.autoMenuOpen ? 'true' : 'false');
        const nodes = [toggle];
        const count = auto ? auto.logCount : 0;
        if (count) {
            const link = button(doc, 'log', 'btn btn-link', () => handlers.onAutoLogToggle(), `Auto-approved (${count}): click to ${ui.autoLogOpen ? 'hide' : 'show'} the log`);
            link.setAttribute('aria-expanded', ui.autoLogOpen ? 'true' : 'false');
            nodes.push(link);
        }
        return nodes;
    }

    /** The expanded auto-approve log: notes first, then the fetched entries newest first, then Clear. */
    function buildAutoLog(doc, view, handlers) {
        const { snapshot, ui } = view;
        const auto = snapshot && snapshot.autoApprove;
        const count = auto ? auto.logCount : 0;
        if (!ui.autoLogOpen || !count) return [];
        const box = h(doc, 'div', 'panel-log');
        box.append(h(doc, 'p', 'dim', `Auto-approved (${count})`));
        for (const note of autoNotes(auto)) box.append(h(doc, 'p', /^Stopped for /.test(note) ? 'aa-note aa-paused' : 'aa-note', note));
        const entries = view.autoLog && Array.isArray(view.autoLog.entries) ? view.autoLog.entries : null;
        if (!entries) box.append(h(doc, 'p', 'empty dim', 'Loading...'));
        else {
            const list = h(doc, 'div', 'aa-entries');
            for (const e of entries) {
                const row = h(doc, 'div', e.ok ? 'aa-entry' : 'aa-entry aa-failed');
                row.append(h(doc, 'span', 'aa-when', formatClock(e.at)));
                row.append(h(doc, 'span', 'aa-who', e.swarmName ? `${e.swarmName}: ${e.label}` : e.label || e.paneID));
                if (e.command) row.append(h(doc, 'code', 'att-command', displayCommand(e.command)));
                if (!e.ok) row.append(h(doc, 'span', 'aa-reason', `Not approved: ${e.reason || 'refused'}`));
                list.append(row);
            }
            box.append(list);
        }
        box.append(button(doc, 'Clear', 'btn', () => handlers.onAutoLogClear(), 'Forget the auto-approve log'));
        return [box];
    }

    /** A permission card as a list row: selectable like a worker row, so J/K and Y/N land on it. */
    function buildRequestRow(doc, row, selected, view, handlers) {
        const { snapshot, ui } = view;
        const nowMs = Number.isFinite(view.nowMs) ? view.nowMs : Date.now();
        const labels = new Map(snapshot.workers.map(w => [w.paneID, w.label]));
        if (snapshot.orchestrator) labels.set(snapshot.orchestrator.paneID, snapshot.orchestrator.label);
        const armed = armedNow(ui, nowMs);
        const node = buildAttentionItem(doc, row.item, handlers, {
            title: cardTitle(row.item, snapshot, labels.get(row.paneID)),
            from: fromTag(snapshot, row.item),
            expanded: isExpanded(ui, row.item.id),
            // Locked while the item just changed or moved (guard), and while any layout change the user caused is fresh.
            locked: (view.guard || defaultGuard).locked(row.item.id, nowMs) || layoutLocked(ui, nowMs),
            armed: armed && armed.itemID === row.item.id ? armed.action : null
        });
        node.setAttribute('role', 'option');
        node.setAttribute('tabindex', '-1');
        node.setAttribute('aria-current', selected ? 'true' : 'false');
        node.dataset.paneId = row.paneID;
        node.addEventListener('click', () => handlers.onSelect(row.paneID));
        return node;
    }

    /** "Running · 2". The Done head is the whole Done section: a count, no rows. */
    const sectionSize = section => (Number.isFinite(section.count) ? section.count : section.rows.length);
    function buildSectionHead(doc, section) {
        const node = h(doc, 'div', `sec-head sec-${section.key}`);
        node.setAttribute('role', 'presentation');
        node.append(h(doc, 'span', 'sec-title', `${section.title} · ${sectionSize(section)}`));
        return node;
    }

    /** The keyboard hint lives in the header's tooltip, not in a footer line. */
    const KEY_HINT = 'Keys (Ctrl+Alt+J focuses the rail): J/K move, Enter open, E archive, X stop, Y/N twice to approve or deny';
    const warningsOf = snapshot => (snapshot && Array.isArray(snapshot.warnings) ? snapshot.warnings.filter(w => typeof w === 'string' && w) : []);

    /**
     * The header: ⌂ Coordinator, always one click home and never disabled (with no coordinator known it still closes
     * the worker view), and a small "⚠ N" when the snapshot carries warnings (tooltip lists them, click expands them
     * under the header).
     */
    function buildHead(doc, view, handlers) {
        const { snapshot, ui } = view;
        const home = button(doc, '⌂ Coordinator', 'btn btn-home', () => handlers.onHome(),
            snapshot && snapshot.orchestrator ? `Back to the coordinator pane (${snapshot.orchestrator.label})` : 'No coordinator pane known yet: closes the worker view');
        const nodes = [home];
        const warnings = warningsOf(snapshot);
        if (warnings.length) {
            const warn = button(doc, `⚠ ${warnings.length}`, 'btn btn-warn', () => handlers.onWarnings(), warnings.join('\n'));
            warn.setAttribute('aria-expanded', ui.warningsOpen ? 'true' : 'false');
            nodes.push(warn);
        }
        const auto = h(doc, 'span', 'head-auto');
        auto.append(...buildAutoControls(doc, view, handlers));
        nodes.push(auto);
        return nodes;
    }

    /** The panel under the header: the expanded warnings list and the expanded auto-approve log (nothing when closed). */
    function buildPanel(doc, view, handlers) {
        const { snapshot, ui } = view;
        const nodes = [];
        const warnings = warningsOf(snapshot);
        if (ui.warningsOpen && warnings.length) {
            const box = h(doc, 'div', 'panel-warnings');
            for (const warning of warnings) box.append(h(doc, 'p', 'warn', warning));
            nodes.push(box);
        }
        const auto = snapshot && snapshot.autoApprove;
        if (ui.autoMenuOpen && !(auto && auto.on)) {
            const menu = h(doc, 'div', 'auto-menu');
            menu.setAttribute('role', 'menu');
            menu.append(h(doc, 'span', 'dim', 'Auto-approve for'));
            const nowMs = Number.isFinite(view.nowMs) ? view.nowMs : Date.now();
            for (const choice of autoChoices(nowMs)) {
                const item = button(doc, choice.label, 'btn', () => handlers.onAutoOn(choice.key), `Approve every recognised request: ${choice.label.toLowerCase()}`);
                item.setAttribute('role', 'menuitem');
                menu.append(item);
            }
            nodes.push(menu);
        }
        nodes.push(...buildAutoLog(doc, view, handlers));
        return nodes;
    }

    /**
     * Rebuild the whole rail into `refs` = { head?, panel?, list, footer }.
     * view = { snapshot, ui, notice, receivedAtMs, nowMs, autoLog? }; view.autoLog = { entries, count } is the fetched
     * auto-approve log (app.js loads it while the log is open).
     */
    function render(doc, refs, view, handlers) {
        const { snapshot, ui } = view;
        if (refs.head) { refs.head.replaceChildren(...buildHead(doc, view, handlers)); refs.head.setAttribute('title', KEY_HINT); }
        if (refs.panel) refs.panel.replaceChildren(...buildPanel(doc, view, handlers));

        // Approve and Deny lock for a moment after a card appears, changes or moves (see createButtonGuard).
        const requests = snapshot ? requestItems(snapshot) : [];
        const nowMs = Number.isFinite(view.nowMs) ? view.nowMs : Date.now();
        (view.guard || defaultGuard).observe(requests, requests.length ? nowMs : 0);

        const list = [];
        if (!snapshot) {
            list.push(h(doc, 'p', 'empty', 'Connecting...'));
        } else {
            const secs = sections(snapshot);
            if (!secs.some(sectionSize)) list.push(h(doc, 'p', 'empty', 'No workers yet.'));
            const build = row => {
                const selected = row.paneID === ui.selectedPaneID;
                if (row.kind === 'request') return buildRequestRow(doc, row, selected, view, handlers);
                if (row.kind === 'waiting') return buildWaitingRow(doc, row, selected, view, handlers);
                return buildThreadRow(doc, row, selected, view, handlers);
            };
            for (const section of secs) {
                if (!sectionSize(section)) continue;
                list.push(buildSectionHead(doc, section));
                for (const row of section.rows) list.push(build(row));
            }
            list.push(...buildOtherSwarms(doc, snapshot, handlers));
        }
        refs.list.replaceChildren(...list);
        // Whether the rail holds the keyboard, readable from the DOM (the integration scenarios probe it).
        if (refs.list.dataset) refs.list.dataset.railFocused = ui.railFocused ? 'true' : 'false';

        // The footer carries only a transient notice. Warnings live behind the header's ⚠ (and go to console.warn in app.js).
        const footer = [];
        if (view.notice) { const n = h(doc, 'p', 'notice', view.notice); n.setAttribute('role', 'alert'); footer.push(n); }
        refs.footer.replaceChildren(...footer);
    }

    globalThis.SwarmLogic = {
        CMD,
        isSnapshot, acceptSnapshot, formatElapsed, elapsedNow,
        sections, rows: rowsOf, requestItems, homeEffect,
        initialUI, reconcile, moveSelection, itemsForPane, requestForPane, cardTitle, fromOtherSwarm, isExpanded, toggleExpanded, pruneExpanded, cardCommand,
        ARM_MS, IDLE_MS, LOCK_MS, LAYOUT_LOCK_MS, BLUR_GRACE_MS, armedNow, expire, touch, setRailFocused, noteBlur, resolveBlur, createButtonGuard,
        markLayout, layoutLocked, layoutLockRemaining, askClose, cancelClose,
        reduceKey, attentionEffect, describeResult, displayCommand, statusLine, reviewEffect, buildSectionHead,
        AUTO_DEFAULT_HOURS, formatClock, autoLabel, autoEndedText, autoNotes, autoAlerts, autoOnEffect, autoOffEffect, autoLogEffect, autoLogClearEffect, buildAutoControls, buildAutoLog,
        nextNineAm, autoChoices, autoChoiceEffect, groupColor, fromTag, swarmSummary, buildOtherSwarms, buildWaitingRow, buildSwarmTag,
        KEY_HINT, warningsOf, buildAttentionItem, buildThreadRow, buildRequestRow, buildHead, buildPanel, render,
    };
})();
