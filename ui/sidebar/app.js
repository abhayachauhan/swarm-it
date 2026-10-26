/* Swarm rail view (local.swarm-view.rail). All state comes from backend snapshots; this file only
 * wires window.kelpi to the pure logic in logic.js. Snapshot text is rendered with textContent only. */
(() => {
    const L = globalThis.SwarmLogic;
    const api = window.kelpi;
    const $ = id => document.getElementById(id);
    const refs = { head: $('head'), panel: $('panel'), list: $('list'), footer: $('footer') };
    const SNAPSHOT_EVENTS = ['local.swarm-view.snapshot', 'snapshot'];
    // The ONLY focus signal: the backend emits it when the focus-rail command runs (contracts/commands.md).
    const FOCUS_EVENT = 'local.swarm-view.focus-rail';

    const questionDrafts = Object.create(null);
    let snapshot = null, receivedAtMs = Date.now();
    let ui = L.initialUI(false);
    let notice = '', noticeTimer = null, pointerActive = false, renderPending = false, busy = false, disposed = false;
    const disposers = [];
    const guard = L.createButtonGuard();
    let unlockTimer = null;
    // The auto-approve log, fetched only while its fold is open and refetched when the backend's count changes.
    let autoLog = null, autoLogLoading = false;

    const draw = () => {
        if (pointerActive) { renderPending = true; return; }
        renderPending = false;
        const nowMs = Date.now();
        const app = $('app');
        const focusedQuestion = document.activeElement?.getAttribute?.('data-question-key');
        const selection = focusedQuestion ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
        const hadFocus = !!app && app.contains(document.activeElement);
        L.render(document, refs, { snapshot, ui, notice, receivedAtMs, nowMs, guard, autoLog, questionDrafts }, handlers);
        markOverflow();
        if (focusedQuestion) {
            for (const input of document.querySelectorAll('[data-question-key]')) if (input.getAttribute('data-question-key') === focusedQuestion) {
                input.focus();
                try { input.setSelectionRange(...selection); } catch { /* unsupported input */ }
            }
        }
        // render() replaces the rail's children: if the focused node went with them, keep the keyboard on #app.
        if (app && hadFocus && !app.contains(document.activeElement)) { try { app.focus({ preventScroll: true }); } catch { /* best effort */ } }
        // Approve and Deny unlock 500 ms after their item or position changed, and Approve, Deny and "Really stop?"
        // 400 ms after a layout change under the pointer: redraw when the next lock lifts (that redraw schedules the one after).
        clearTimeout(unlockTimer);
        const waits = [guard.remaining(nowMs), L.layoutLockRemaining(ui, nowMs)].filter(wait => wait > 0);
        if (waits.length) unlockTimer = setTimeout(draw, Math.min(...waits) + 20);
    };
    // A clamped command that wraps past two lines gets its "Long command, click to show it all" line. Measured after
    // layout, because logic.js cannot know how a long line wraps at this width, and again whenever the list is
    // resized (a narrower rail wraps more; see the ResizeObserver in boot).
    function markOverflow() {
        for (const code of document.querySelectorAll('.att-clamp')) {
            const maybe = code.nextElementSibling;
            if (!maybe || !maybe.classList.contains('att-more-maybe')) continue;
            maybe.classList.toggle('att-overflow', code.scrollHeight > code.clientHeight + 1);
        }
    }
    const setNotice = text => {
        notice = text;
        clearTimeout(noticeTimer);
        if (text) noticeTimer = setTimeout(() => { notice = ''; draw(); }, 8000);
        draw();
    };

    // Warnings are not footer noise: each new set goes to the console once, and the header shows a small ⚠ N.
    let warnedKey = '';
    function logWarnings() {
        const warnings = L.warningsOf(snapshot);
        const key = warnings.join('\n');
        if (key === warnedKey) return;
        warnedKey = key;
        for (const warning of warnings) console.warn('[swarm-view]', warning);
    }

    // Auto-approve events the user must not miss (a pane the rate guard stopped, the timer switching it off) are shown
    // once as a footer notice; afterwards they stay in the toggle's tooltip. Keyed so a repeat snapshot is silent.
    const announced = new Set();
    function announceAutoAlerts() {
        const fresh = [];
        for (const alert of L.autoAlerts(snapshot && snapshot.autoApprove)) {
            if (announced.has(alert.key)) continue;
            announced.add(alert.key);
            fresh.push(alert.text);
        }
        return fresh.join(' ');
    }

    function adopt(next) {
        const accepted = L.acceptSnapshot(snapshot, next);
        if (accepted === snapshot) return;
        snapshot = accepted; receivedAtMs = Date.now();
        ui = L.reconcile(ui, snapshot);
        // The duration menu belongs to the off state.
        if (ui.autoMenuOpen && snapshot.autoApprove && snapshot.autoApprove.on) ui = { ...ui, autoMenuOpen: false };
        const pendingDrafts = new Set((snapshot.codexQuestions || []).flatMap(r => r.questions.map(q => `${r.threadID}:${r.requestID}:${q.id}`)));
        for (const key of Object.keys(questionDrafts)) if (!pendingDrafts.has(key)) delete questionDrafts[key];
        logWarnings();
        const count = snapshot.autoApprove ? snapshot.autoApprove.logCount : 0;
        if (ui.autoLogOpen && (!autoLog || autoLog.count !== count)) void loadAutoLog();
        const alert = announceAutoAlerts();
        if (alert) setNotice(alert); else draw();
    }

    async function loadAutoLog() {
        if (autoLogLoading || disposed) return;
        autoLogLoading = true;
        try {
            const eff = L.autoLogEffect();
            const result = await api.commands.execute(eff.command, eff.args);
            if (result && result.ok) { autoLog = { entries: result.entries || [], count: result.count || 0 }; draw(); }
            else setNotice(L.describeResult('Auto-approve log', result).message);
        } catch (cause) {
            setNotice(`Auto-approve log: ${cause instanceof Error ? cause.message : String(cause)}`);
        } finally { autoLogLoading = false; }
    }

    // The workspace the user is in; the backend shows only that workspace's swarm.
    let activeWorkspaceID = null;

    async function loadState() {
        const result = await api.commands.execute(`${L.CMD}get-state`, activeWorkspaceID ? { workspaceID: activeWorkspaceID } : {});
        if (result && result.ok && result.snapshot) adopt(result.snapshot);
        else setNotice(L.describeResult('Load', result).message);
    }

    async function run(label, eff) {
        if (!eff || busy || disposed) return;
        busy = true;
        try {
            const result = await api.commands.execute(eff.command, eff.args);
            const outcome = L.describeResult(label, result);
            // A refusal (for example archive on a dirty worktree) is shown verbatim from the backend.
            setNotice(outcome.ok ? '' : outcome.message);
        } catch (cause) {
            setNotice(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
        } finally { busy = false; }
    }

    /** Open a worker's thread. Opening a finished worker's result also marks it reviewed (accept), once. */
    async function openWorker(paneID) {
        const review = L.reviewEffect(snapshot, paneID);
        await run('Open', { command: `${L.CMD}open-thread`, args: { paneID } });
        if (review && !notice) await run('Accept', review);
    }

    function reveal(paneID, label) {
        if (api.ui && typeof api.ui.reveal === 'function') Promise.resolve(api.ui.reveal(paneID)).catch(cause => setNotice(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`));
        else setNotice(`${label}: this Kelpi cannot reveal a pane from the rail.`);
    }

    const handlers = {
        onTrustFolder: item => { void run('Trust folder', { command: `${L.CMD}trust-folder`, args: { itemID: item.id, promptHash: item.promptHash, confirm: true } }); },
        onLoadQuestions: () => { void run('Codex questions', { command: `${L.CMD}load-codex-questions`, args: {} }); },
        onQuestionDraft: (key, value) => { questionDrafts[key] = value; },
        onQuestionAnswer: request => {
            const answers = Object.fromEntries(request.questions.map(q => [q.id, { answers: [questionDrafts[`${request.threadID}:${request.requestID}:${q.id}`] || ''] }]));
            void run('Answer', { command: `${L.CMD}answer-codex-question`, args: { requestID: request.requestID, threadID: request.threadID, answers } });
        },
        onSelect: paneID => {
            // Changing the selection cancels a pending Y/N.
            ui = L.setRailFocused({ ...ui, selectedPaneID: paneID }, true, Date.now());
            draw();
        },
        onOpen: paneID => { void openWorker(paneID); },
        // Home: open-thread on the coordinator closes the thread view and gives the coordinator its space back; with no
        // coordinator known it is close-thread, so the button is never disabled.
        // Then reveal the coordinator pane itself, so the click takes the user there from any workspace.
        onHome: () => {
            const coordinator = snapshot?.orchestrator?.paneID;
            void run('Home', L.homeEffect(snapshot)).then(() => {
                if (!coordinator || !api.ui || typeof api.ui.reveal !== 'function') return;
                return Promise.resolve(api.ui.reveal(coordinator)).catch(cause => setNotice(`Coordinator: ${cause instanceof Error ? cause.message : String(cause)}`));
            });
        },
        onWarnings: () => { ui = { ...ui, warningsOpen: !ui.warningsOpen }; draw(); },
        // Arming or cancelling Stop changes the buttons under the pointer: the layout lock (logic.js) starts.
        onCloseAsk: paneID => { ui = L.askClose(ui, paneID, Date.now()); draw(); },
        onCloseCancel: () => { ui = L.cancelClose(ui, Date.now()); draw(); },
        // "Really stop?" is drawn disabled during the layout lock; a click that still arrives inside it is ignored.
        onCloseConfirm: paneID => {
            if (L.layoutLocked(ui, Date.now())) return;
            ui = { ...ui, closeAsk: null }; draw(); void run('Stop', { command: `${L.CMD}close-worker`, args: { paneID } });
        },
        // ✕ "Remove": a done worker is closed in one click (nothing is running); a closed pane just leaves the rail.
        onClose: paneID => { void run('Remove', { command: `${L.CMD}close-worker`, args: { paneID } }); },
        onAttention: (kind, item) => { if (L.layoutLocked(ui, Date.now())) return; void run(kind, L.attentionEffect(kind, item)); },
        // A card's command: click (or Enter) shows the whole thing, click again shortens it. Everything below moves, so
        // Approve and Deny are locked for a moment (the second click of a double-click lands on nothing).
        onExpand: itemID => { ui = L.toggleExpanded(ui, itemID, Date.now()); draw(); },
        // An unrecognised prompt is answered in the pane: "Go to pane" reveals the pane itself, whichever swarm it is in.
        onAnswer: item => reveal(item.paneID, 'Go to pane'),
        // A waiting row's Go to pane, a "from <swarm>" tag and an other-swarm line: reveal that pane, whichever swarm it is in.
        onReveal: (paneID, label) => reveal(paneID, label),
        // Auto-approve: one header toggle. Off, it opens the duration menu; a choice turns it on; on, one click turns it
        // off. The backend keeps every guard.
        onAutoMenu: () => { ui = { ...ui, autoMenuOpen: !ui.autoMenuOpen }; draw(); },
        onAutoOn: key => {
            ui = { ...ui, autoMenuOpen: false }; draw();
            void run('Auto-approve', L.autoChoiceEffect(key, Date.now()));
        },
        onAutoOff: () => { void run('Auto-approve', L.autoOffEffect()); },
        onAutoLogToggle: () => {
            ui = { ...ui, autoLogOpen: !ui.autoLogOpen };
            if (ui.autoLogOpen) void loadAutoLog(); else draw();
        },
        onAutoLogClear: () => { void run('Clear log', L.autoLogClearEffect()).then(() => { autoLog = { entries: [], count: 0 }; draw(); }); },
    };

    // Failure notices name the verb the user pressed; the reducer says which when a command serves two (close-worker).
    const LABELS = { 'open-thread': 'Open', archive: 'Archive', 'close-worker': 'Stop', 'dismiss-worker': 'Remove', approve: 'Approve', deny: 'Deny' };

    function onKeydown(event) {
        if (event.isComposing) return;
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
        const out = L.reduceKey(ui, snapshot, { key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, nowMs: Date.now() });
        if (!out.handled) return;
        event.preventDefault();
        ui = out.ui;
        // An armed Y/N is shown on the item itself (and disappears with the arm), so it needs no 8 second notice.
        if (out.notice && !out.ui.armed) setNotice(out.notice); else draw();
        if (out.reveal) reveal(out.reveal, 'Go to pane');
        if (!out.effect) return;
        if (out.effect.command === `${L.CMD}open-thread`) void openWorker(out.effect.args.paneID);
        else void run(out.label ?? LABELS[out.effect.command.slice(L.CMD.length)] ?? 'Action', out.effect);
    }

    // A window blur only starts a grace period (see logic.js noteBlur): the host fires transient blur/focus pairs.
    let blurTimer = null;
    function checkBlur() {
        clearTimeout(blurTimer);
        if (disposed) return;
        const next = L.resolveBlur(ui, Date.now(), document.hasFocus());
        const changed = next !== ui;
        ui = next;
        if (Number.isFinite(ui.blurAt)) blurTimer = setTimeout(checkBlur, L.BLUR_GRACE_MS + 10);
        if (changed && !ui.railFocused) draw();
    }
    function onWindowBlur() {
        ui = L.noteBlur(ui, Date.now());
        if (Number.isFinite(ui.blurAt)) { clearTimeout(blurTimer); blurTimer = setTimeout(checkBlur, L.BLUR_GRACE_MS + 10); }
    }

    // The backend's focus-rail command asks this view to take the keyboard.
    function onFocusRequest() {
        try { window.focus(); $('app').focus({ preventScroll: true }); } catch { /* best effort */ }
        ui = L.reconcile(L.setRailFocused(ui, true, Date.now()), snapshot);
        draw();
    }

    // Elapsed text ticks in place so a live second never replaces a button mid-click.
    // Disarm an expired Y/N and release the keyboard after 30 s without a key or pointer event.
    function expireTimers() {
        if (disposed) return;
        if (Number.isFinite(ui.blurAt)) checkBlur();
        const next = L.expire(ui, Date.now());
        if (next !== ui) { ui = next; draw(); }
    }

    function tick() {
        if (!snapshot || disposed) return;
        const now = Date.now();
        for (const worker of snapshot.workers) {
            const node = document.querySelector(`[data-elapsed-pane="${CSS.escape(worker.paneID)}"]`);
            if (node) node.textContent = L.formatElapsed(L.elapsedNow(worker, receivedAtMs, now));
        }
    }

    async function boot() {
        await api.ready;
        for (const name of SNAPSHOT_EVENTS) disposers.push(api.events.on(name, event => adopt(event.data)));
        disposers.push(api.events.on(FOCUS_EVENT, onFocusRequest));
        disposers.push(api.events.on('gap', () => { void loadState(); }));
        disposers.push(api.events.on('services.invalidated', () => { void loadState(); }));
        // A narrower rail wraps a clamped command further: measure the overflow again whenever the list is resized.
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(() => markOverflow());
            observer.observe(refs.list);
            disposers.push(() => observer.disconnect());
        }
        draw();
        // Follow the workspace the user is in. Without navigation support the rail keeps showing the backend's swarm.
        try {
            if (api.ui && typeof api.ui.onNavigation === 'function') {
                disposers.push(api.ui.onNavigation(nav => {
                    const id = nav && nav.active ? nav.active.workspaceID : null;
                    if (id && id !== activeWorkspaceID) { activeWorkspaceID = id; void loadState(); }
                }, () => { /* navigation unavailable: keep the current swarm */ }));
            }
        } catch { /* best effort */ }
        await loadState();
    }

    window.addEventListener('keydown', onKeydown);
    window.addEventListener('blur', e => { if (e.target === window) onWindowBlur(); });
    window.addEventListener('pointerdown', () => { pointerActive = true; ui = L.touch(ui, Date.now()); }, true);
    window.addEventListener('pointermove', () => { if (ui.railFocused) ui = L.touch(ui, Date.now()); }, true);
    const release = () => setTimeout(() => { pointerActive = false; if (renderPending) draw(); }, 0);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    const timer = setInterval(tick, 5000);
    const expiry = setInterval(expireTimers, 500);
    window.addEventListener('pagehide', () => { disposed = true; clearInterval(timer); clearInterval(expiry); clearTimeout(unlockTimer); clearTimeout(noticeTimer); for (const off of disposers) off(); }, { once: true });
    void boot().catch(cause => setNotice(cause instanceof Error ? cause.message : String(cause)));
})();
