import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dir = new URL('../ui/sidebar/', import.meta.url);
vm.runInThisContext(readFileSync(new URL('logic.js', dir), 'utf8'), { filename: 'logic.js' });
const L = globalThis.SwarmLogic;
const fixture = () => JSON.parse(readFileSync(new URL('fixtures/snapshot.json', dir), 'utf8'));
const key = (k, extra = {}) => ({ key: k, ...extra });
const focused = selectedPaneID => ({ selectedPaneID, railFocused: true });

test('fixture is a valid snapshot', () => {
    assert.equal(L.isSnapshot(fixture()), true);
    assert.equal(L.isSnapshot({ version: 2 }), false);
    assert.equal(L.isSnapshot(null), false);
});

test('acceptSnapshot drops equal or lower sequence and invalid input', () => {
    const a = fixture();
    const older = { ...fixture(), sequence: 11 };
    const same = { ...fixture() };
    const newer = { ...fixture(), sequence: 13 };
    assert.equal(L.acceptSnapshot(null, a), a);
    assert.equal(L.acceptSnapshot(a, older), a);
    assert.equal(L.acceptSnapshot(a, same), a);
    assert.equal(L.acceptSnapshot(a, newer), newer);
    assert.equal(L.acceptSnapshot(a, { nope: 1 }), a);
});

test('formatElapsed', () => {
    assert.equal(L.formatElapsed(0), '0s');
    assert.equal(L.formatElapsed(59.9), '59s');
    assert.equal(L.formatElapsed(60), '1m');
    assert.equal(L.formatElapsed(3599), '59m');
    assert.equal(L.formatElapsed(3600), '1h');
    assert.equal(L.formatElapsed(3700), '1h 1m');
    assert.equal(L.formatElapsed(90000), '1d 1h');
    assert.equal(L.formatElapsed(-1), '-');
    assert.equal(L.formatElapsed(NaN), '-');
});

test('elapsedNow counts up live workers only', () => {
    assert.equal(L.elapsedNow({ state: 'running', elapsedSeconds: 10 }, 1000, 6000), 15);
    assert.equal(L.elapsedNow({ state: 'waiting', elapsedSeconds: 10 }, 1000, 6000), 15);
    assert.equal(L.elapsedNow({ state: 'done', elapsedSeconds: 10 }, 1000, 6000), 10);
    assert.equal(L.elapsedNow({ state: 'running', elapsedSeconds: 10 }, 6000, 1000), 10);
});

test('sections: Needs you holds one request row per card, Running the live workers without a card, Done only a count', () => {
    const secs = L.sections(fixture());
    assert.deepEqual(secs.map(s => [s.key, s.title, s.rows.map(r => r.paneID)]), [
        ['needs', 'Needs you', ['p-wait']],
        ['running', 'Running', ['p-run']],
        ['done', 'Done', []],
    ]);
    assert.equal(secs[2].count, 3, 'done and error workers are counted; the archived one is not');
    assert.equal(secs[0].rows[0].kind, 'request');
    assert.equal(secs[0].rows[0].item.type, 'Request');
    assert.equal(secs[1].rows[0].kind, 'worker');
    // Archived workers are nowhere.
    assert.equal(secs.flatMap(s => s.rows).some(r => r.paneID === 'p-arch'), false);
});

test('a waiting worker without a card is listed under Running; one with a card appears only as the card', () => {
    const snap = fixture();
    snap.attention = snap.attention.filter(i => i.type !== 'Request');
    const secs = L.sections(snap);
    assert.deepEqual(secs[0].rows, []);
    assert.deepEqual(secs[1].rows.map(r => r.paneID), ['p-wait', 'p-run']);
    // Two cards for the same pane make one row.
    const twice = fixture();
    twice.attention.push({ ...twice.attention[0], id: 'Request:p-wait:later' });
    assert.deepEqual(L.sections(twice)[0].rows.map(r => r.paneID), ['p-wait']);
    // A card from another swarm (pane not in the worker list) still gets a row.
    const other = fixture();
    other.attention.push({ id: 'Request:x9:t', type: 'Request', paneID: 'x9', text: 'worker-2 is asking', command: 'ls', promptHash: 'a'.repeat(64), createdAt: 't', swarmName: 'BB', swarmWorkspaceID: 'ws2', paneLabel: 'worker-2' });
    assert.deepEqual(L.sections(other)[0].rows.map(r => r.paneID), ['p-wait', 'x9']);
});

test('rows is the flat J/K order: Needs you, Running; finished workers and the coordinator are not rows', () => {
    assert.deepEqual(L.rows(fixture()).map(r => r.paneID), ['p-wait', 'p-run']);
    assert.equal(L.rows(fixture()).some(r => r.kind === 'orchestrator'), false);
    assert.equal(L.rows({ ...fixture(), orchestrator: null })[0].paneID, 'p-wait');
    assert.deepEqual(L.rows(null), []);
    assert.deepEqual(L.rows({ ...fixture(), workers: [], attention: [] }), [], 'a coordinator alone is no row');
});

test('homeEffect opens the coordinator thread (which closes the thread view), or just closes the thread view when none is known', () => {
    assert.deepEqual(L.homeEffect(fixture()), { command: 'local.swarm-view.open-thread', args: { paneID: 'p-orch' } });
    assert.deepEqual(L.homeEffect({ ...fixture(), orchestrator: null }), { command: 'local.swarm-view.close-thread', args: {} });
    assert.deepEqual(L.homeEffect(null), { command: 'local.swarm-view.close-thread', args: {} });
});

test('reconcile forgets expanded cards that left the snapshot, and keeps the ones still there', () => {
    const id = 'Request:p-wait:2026-10-08T00:58:00.000Z';
    const ui = L.toggleExpanded(focused('p-wait'), id, 0);
    assert.deepEqual(L.reconcile(ui, fixture()).expanded, [id]);
    assert.deepEqual(L.reconcile({ ...ui, expanded: ['Request:gone:x', id] }, fixture()).expanded, [id]);
    assert.deepEqual(L.reconcile(ui, { ...fixture(), attention: [] }).expanded, []);
    const same = L.reconcile(ui, fixture());
    assert.equal(L.pruneExpanded(same, fixture()), same, 'nothing to prune: the same object');
    assert.equal(L.pruneExpanded(focused('p-wait'), fixture()).expanded, undefined, 'no expanded list: untouched');
});

test('requestItems keeps only permission requests: Complete and Error items never become cards', () => {
    assert.deepEqual(L.requestItems(fixture()).map(i => i.type), ['Request']);
    assert.equal(L.requestItems({ ...fixture(), attention: [] }).length, 0);
});

test('J and K move and clamp', () => {
    const snap = fixture();
    let ui = L.reconcile(focused(null), snap);
    assert.equal(ui.selectedPaneID, 'p-wait');
    ui = L.reduceKey(ui, snap, key('j')).ui;
    assert.equal(ui.selectedPaneID, 'p-run');
    ui = L.reduceKey(ui, snap, key('k')).ui;
    ui = L.reduceKey(ui, snap, key('k')).ui;
    assert.equal(ui.selectedPaneID, 'p-wait');
    for (let i = 0; i < 20; i += 1) ui = L.reduceKey(ui, snap, key('J')).ui;
    assert.equal(ui.selectedPaneID, 'p-run');
});

test('keys are ignored unless the rail has focus', () => {
    const snap = fixture();
    const ui = { selectedPaneID: 'p-wait', railFocused: false };
    for (const k of ['j', 'k', 's', 'e', 'y', 'n']) {
        const out = L.reduceKey(ui, snap, key(k));
        assert.equal(out.handled, false, k);
        assert.equal(out.effect, null, k);
        assert.equal(out.ui, ui, k);
    }
});

test('keys with a modifier are not handled', () => {
    const out = L.reduceKey(focused('p-wait'), fixture(), key('y', { metaKey: true }));
    assert.equal(out.handled, false);
    assert.equal(L.reduceKey(focused('p-wait'), fixture(), key('j', { ctrlKey: true })).handled, false);
});

test('Y approves and N denies the Request item of the selected worker, on the second press', () => {
    const snap = fixture();
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const itemID = 'Request:p-wait:2026-10-08T00:58:00.000Z';
    const first = L.reduceKey(focused('p-wait'), snap, key('y', { nowMs: 1000 }));
    assert.equal(first.effect, null, 'the first press only arms');
    assert.match(first.notice, /Press Y again to approve/);
    const y = L.reduceKey(first.ui, snap, key('y', { nowMs: 1500 }));
    assert.deepEqual(y.effect, { command: 'local.swarm-view.approve', args: { itemID, promptHash: hash } });
    assert.equal(y.ui.armed, null, 'acting disarms');
    const n1 = L.reduceKey(focused('p-wait'), snap, key('N', { nowMs: 1000 }));
    assert.equal(n1.effect, null);
    assert.match(n1.notice, /Press N again to deny/);
    const n = L.reduceKey(n1.ui, snap, key('N', { nowMs: 2000 }));
    assert.deepEqual(n.effect, { command: 'local.swarm-view.deny', args: { itemID, promptHash: hash } });
});

test('Y and N do nothing on a worker with no Request item', () => {
    const snap = fixture();
    for (const pane of ['p-err', 'p-run', 'p-orch']) {
        const out = L.reduceKey(focused(pane), snap, key('y'));
        assert.equal(out.effect, null, pane);
        assert.match(out.notice, /No permission request/);
    }
});

test('S is no longer a key: cards have no Snooze, so nothing can be snoozed out of sight', () => {
    const out = L.reduceKey(focused('p-wait'), fixture(), key('s'));
    assert.equal(out.handled, false);
    assert.equal(out.effect, null);
});

test('Enter on a card shows the whole command and again shortens it; Enter on a worker opens its thread', () => {
    const snap = fixture();
    const itemID = 'Request:p-wait:2026-10-08T00:58:00.000Z';
    const open = L.reduceKey(focused('p-wait'), snap, key('Enter'));
    assert.equal(open.effect, null, 'nothing is sent to the backend');
    assert.deepEqual(open.ui.expanded, [itemID]);
    assert.equal(L.isExpanded(open.ui, itemID), true);
    const shut = L.reduceKey(open.ui, snap, key('Enter'));
    assert.deepEqual(shut.ui.expanded, []);
    assert.equal(L.isExpanded(shut.ui, itemID), false);
    assert.deepEqual(L.reduceKey(focused('p-run'), snap, key('Enter')).effect, { command: 'local.swarm-view.open-thread', args: { paneID: 'p-run' } });
    // toggleExpanded keeps other cards' state.
    const two = L.toggleExpanded(L.toggleExpanded({}, 'a'), 'b');
    assert.deepEqual(two.expanded, ['a', 'b']);
    assert.deepEqual(L.toggleExpanded(two, 'a').expanded, ['b']);
});

test('cardTitle is the worker label, plus the swarm name only for a card from another swarm', () => {
    const snap = fixture();
    const item = snap.attention[0];
    assert.equal(L.cardTitle(item, snap, 'repo-lag'), 'repo-lag');
    assert.equal(L.cardTitle({ ...item, paneID: '0E661D85-B366' }, snap), '0E661D85', 'unknown pane: short id');
    const other = { ...item, paneLabel: 'worker-2', swarmName: 'Kelpi UI', swarmWorkspaceID: 'ws2' };
    assert.equal(L.cardTitle(other, snap), 'worker-2 · Kelpi UI');
    assert.equal(L.fromOtherSwarm(other, snap), true);
    const same = { ...other, swarmWorkspaceID: snap.workspaceID };
    assert.equal(L.cardTitle(same, snap, 'repo-lag'), 'repo-lag', 'the followed swarm is not named');
    assert.equal(L.fromOtherSwarm(same, snap), false);
});

test('cardCommand: the captured command, or the best guess for an unrecognised prompt', () => {
    assert.equal(L.cardCommand({ command: 'npm test' }), 'npm test');
    const block = ['Bash command', '╌'.repeat(40), 'gh pr ready 490', '╌'.repeat(40), 'Do you want to proceed?', '❯ 1. Yes', '2. No'].join('\n');
    assert.equal(L.cardCommand({ approvable: false, promptBlock: block, command: '' }), 'gh pr ready 490');
    assert.equal(L.cardCommand({ approvable: false, promptBlock: 'Weird', command: 'ls -la' }), 'ls -la');
    assert.equal(L.cardCommand({ approvable: false, promptBlock: 'Weird', command: '', text: 'w1 is asking' }), 'w1 is asking');
});

test('E archives the selected worker by paneID, never the orchestrator', () => {
    const out = L.reduceKey(focused('p-run'), fixture(), key('e'));
    assert.deepEqual(out.effect, { command: 'local.swarm-view.archive', args: { paneID: 'p-run' } });
    // The coordinator is not a row, so it can never be selected or archived.
    const orch = L.reduceKey(focused('p-orch'), fixture(), key('e'));
    assert.equal(orch.effect, null);
    assert.equal(L.reconcile(focused('p-orch'), fixture()).selectedPaneID, 'p-wait');
});

test('Enter opens the thread', () => {
    const out = L.reduceKey(focused('p-run'), fixture(), key('Enter'));
    assert.deepEqual(out.effect, { command: 'local.swarm-view.open-thread', args: { paneID: 'p-run' } });
});

test('unknown keys are left alone', () => {
    assert.equal(L.reduceKey(focused('p-run'), fixture(), key('q')).handled, false);
});

test('X arms a stop, and a second X on the same worker closes it', () => {
    const first = L.reduceKey(focused('p-run'), fixture(), key('x', { nowMs: 1000 }));
    assert.equal(first.effect, null);
    assert.equal(first.ui.closeAsk.paneID, 'p-run');
    const second = L.reduceKey(first.ui, fixture(), key('x', { nowMs: 2000 }));
    assert.deepEqual(second.effect, { command: 'local.swarm-view.close-worker', args: { paneID: 'p-run' } });
    assert.equal(second.ui.closeAsk, null);
});

test('X on a running worker keeps the two steps, and the second press is labelled Stop', () => {
    const snap = fixture();
    const running = L.reduceKey(focused('p-run'), snap, key('x', { nowMs: 1000 }));
    assert.equal(running.effect, null);
    assert.equal(running.ui.closeAsk.paneID, 'p-run');
    assert.equal(L.reduceKey(running.ui, snap, key('x', { nowMs: 1500 })).label, 'Stop');
});

test('statusLine strips terminal decoration and falls back to the state', () => {
    const line = (lastLine, state = 'running') => L.statusLine({ lastLine, state });
    assert.equal(line('Reading files'), 'Reading files');
    assert.equal(line('│ Reading files │'), 'Reading files');
    assert.equal(line('main ↑16 !10 ?3 +2 ✘1'), 'main');
    assert.equal(line('⇡3 ⇣1 feature/x'), 'feature/x');
    assert.equal(line('╭───────────────╮'), 'running');
    assert.equal(line('> Try "fix lint errors"', 'done'), 'done');
    assert.equal(line('❯ ', 'waiting'), 'waiting');
    assert.equal(line('? for shortcuts'), 'running');
    assert.equal(line('⏵⏵ accept edits on (shift+tab to cycle)'), 'running');
    assert.equal(line('esc to interrupt'), 'running');
    assert.equal(line('', 'error'), 'error');
    assert.equal(line(undefined, 'done'), 'done');
    assert.equal(line('Wrote result.md   ', 'done'), 'Wrote result.md');
    // A prompt character inside a word is text, not a prompt.
    assert.equal(line('git log > out.txt'), 'git log > out.txt');
    assert.equal(line('a > b'), 'a > b');
});

test('reviewEffect: opening a finished, unreviewed worker also accepts it; nothing for others', () => {
    const snap = fixture();
    assert.deepEqual(L.reviewEffect(snap, 'p-done'), { command: 'local.swarm-view.accept', args: { paneID: 'p-done' } });
    assert.deepEqual(L.reviewEffect(snap, 'p-err'), { command: 'local.swarm-view.accept', args: { paneID: 'p-err' } });
    assert.equal(L.reviewEffect(snap, 'p-acc'), null, 'already reviewed');
    assert.equal(L.reviewEffect(snap, 'p-run'), null, 'still running');
    assert.equal(L.reviewEffect(snap, 'p-arch'), null, 'archived');
    assert.equal(L.reviewEffect(snap, 'p-orch'), null);
    assert.equal(L.reviewEffect(null, 'p-done'), null);
    const app = readFileSync(new URL('../ui/sidebar/app.js', import.meta.url), 'utf8');
    assert.match(app, /L\.reviewEffect\(snapshot, paneID\)/, 'app.js runs it after a successful open');
    assert.doesNotMatch(app, /onAccept/, 'no Accept button handler remains');
});

test('a stop that is not confirmed in time, or is followed by another key, does nothing', () => {
    const first = L.reduceKey(focused('p-run'), fixture(), key('x', { nowMs: 1000 }));
    const late = L.reduceKey(first.ui, fixture(), key('x', { nowMs: 1000 + L.ARM_MS + 1 }));
    assert.equal(late.effect, null);
    const moved = L.reduceKey(first.ui, fixture(), key('j', { nowMs: 1500 }));
    assert.equal(moved.ui.closeAsk, null);
});

test('selection survives a new snapshot and falls back when the pane vanishes', () => {
    const snap = fixture();
    const reordered = { ...snap, sequence: 13, workers: [...snap.workers].reverse() };
    assert.equal(L.reconcile(focused('p-run'), reordered).selectedPaneID, 'p-run');
    const gone = { ...snap, sequence: 14, workers: snap.workers.filter(w => w.paneID !== 'p-run') };
    assert.equal(L.reconcile(focused('p-run'), gone).selectedPaneID, 'p-wait');
});

test('J walks from a card into Running and stops there (Done has no rows), without a tab change', () => {
    const snap = fixture();
    let ui = focused('p-wait');
    const seen = [];
    for (let i = 0; i < 3; i += 1) { ui = L.reduceKey(ui, snap, key('j')).ui; seen.push(ui.selectedPaneID); }
    assert.deepEqual(seen, ['p-run', 'p-run', 'p-run']);
    assert.equal(L.initialUI().tab, undefined, 'no tab state any more');
    assert.equal(L.setTab, undefined);
    assert.equal(L.TABS, undefined);
});

test('attentionEffect maps the two card buttons to commands and nothing else', () => {
    const item = fixture().attention[0];
    assert.equal(L.attentionEffect('approve', item).command, 'local.swarm-view.approve');
    assert.equal(L.attentionEffect('deny', item).command, 'local.swarm-view.deny');
    assert.equal(L.attentionEffect('approve', item).args.promptHash, item.promptHash);
    assert.equal(L.attentionEffect('deny', item).args.promptHash, item.promptHash);
    for (const gone of ['snooze', 'clear', 'open', 'zzz']) assert.equal(L.attentionEffect(gone, item), null, gone);
});

test('describeResult passes the backend refusal message through', () => {
    const okOutcome = L.describeResult('Archive', { ok: true, paneID: 'x' });
    assert.equal(okOutcome.ok, true);
    assert.equal(okOutcome.message, '');
    const refusal = { ok: false, code: 'DIRTY', error: 'Worktree /w/ui has uncommitted changes' };
    assert.equal(L.describeResult('Archive', refusal).message, 'Archive: Worktree /w/ui has uncommitted changes');
    assert.equal(L.describeResult('Archive', undefined).ok, false);
});

// ---- review fixes: two-step Y/N, idle focus, change lock ----
const REQ = 'Request:p-wait:2026-10-08T00:58:00.000Z';

test('a single Y or N never produces an effect', () => {
    for (const k of ['y', 'Y', 'n', 'N']) {
        const out = L.reduceKey(focused('p-wait'), fixture(), key(k, { nowMs: 5000 }));
        assert.equal(out.effect, null, k);
        assert.equal(out.handled, true, k);
        assert.equal(out.ui.armed.itemID, REQ, k);
    }
});

test('the second press must be the same key inside the 3 second window', () => {
    const snap = fixture();
    const armed = L.reduceKey(focused('p-wait'), snap, key('y', { nowMs: 1000 })).ui;
    assert.equal(L.reduceKey(armed, snap, key('y', { nowMs: 1000 + L.ARM_MS })).effect, null, 'window over: it only re-arms');
    assert.equal(L.reduceKey(armed, snap, key('n', { nowMs: 1500 })).effect, null, 'Y then N does not deny');
    assert.equal(L.reduceKey(armed, snap, key('y', { nowMs: 1000 + L.ARM_MS - 1 })).effect.command, 'local.swarm-view.approve');
});

test('selection change, other keys, blur and a changed prompt all disarm', () => {
    const snap = fixture();
    const armed = L.reduceKey(focused('p-wait'), snap, key('y', { nowMs: 1000 })).ui;
    assert.equal(L.reduceKey(armed, snap, key('j', { nowMs: 1100 })).ui.armed, null, 'moving');
    assert.equal(L.reduceKey(armed, snap, key('Enter', { nowMs: 1100 })).ui.armed, null, 'another key');
    assert.equal(L.setRailFocused(armed, false, 1200).armed, null, 'blur');
    assert.equal(L.reconcile({ ...armed, selectedPaneID: 'p-run' }, snap).armed, null, 'selection moved elsewhere');
    const changed = fixture();
    changed.attention.find(i => i.id === REQ).promptHash = 'f'.repeat(64);
    assert.equal(L.reconcile(armed, changed).armed, null, 'prompt hash changed under the arm');
    assert.notEqual(L.reconcile(armed, snap).armed, null, 'an unchanged snapshot keeps the arm');
    // acting needs a fresh arm after the selection returned
    const back = L.reduceKey(L.reduceKey(armed, snap, key('j', { nowMs: 1100 })).ui, snap, key('k', { nowMs: 1200 })).ui;
    assert.equal(L.reduceKey(back, snap, key('y', { nowMs: 1300 })).effect, null);
});

test('expire disarms after the window and drops focus after 30 seconds without activity', () => {
    const snap = fixture();
    const armed = L.reduceKey(focused('p-wait'), snap, key('y', { nowMs: 1000 })).ui;
    assert.equal(L.expire(armed, 1000 + L.ARM_MS - 1).armed.action, 'approve');
    assert.equal(L.expire(armed, 1000 + L.ARM_MS).armed, null);
    assert.equal(L.armedNow(armed, 1000 + L.ARM_MS), null);
    assert.equal(L.expire(armed, 1000 + L.IDLE_MS - 1).railFocused, true);
    assert.equal(L.expire(armed, 1000 + L.IDLE_MS).railFocused, false);
    const idle = L.expire(armed, 1000 + L.IDLE_MS);
    assert.equal(L.reduceKey(idle, snap, key('y', { nowMs: 1000 + L.IDLE_MS })).handled, false, 'keys no longer act');
    // activity restarts the timer
    const touched = L.touch(armed, 20000);
    assert.equal(L.expire(touched, 20000 + L.IDLE_MS - 1).railFocused, true);
    // a key pressed after the idle limit, before any timer ran, is not handled either
    const stale = { ...focused('p-wait'), lastActivityAt: 0 };
    assert.equal(L.reduceKey(stale, snap, key('j', { nowMs: L.IDLE_MS })).handled, false);
});

test('a transient window blur does not release the rail, a real one does', () => {
    const snap = fixture();
    const base = L.setRailFocused(focused('p-wait'), true, 1000);
    // host iframe.focus() burst: blur then focus again, hasFocus true again by the time it is checked
    const blurred = L.noteBlur(base, 2000);
    assert.equal(blurred.railFocused, true, 'a blur alone keeps the rail');
    assert.equal(L.reduceKey(blurred, snap, key('j', { nowMs: 2002 })).handled, true, 'keys still act during the grace period');
    assert.equal(L.resolveBlur(blurred, 2000 + L.BLUR_GRACE_MS - 1, false), blurred, 'undecided inside the grace period');
    assert.equal(L.resolveBlur(blurred, 2000 + L.BLUR_GRACE_MS, true).railFocused, true, 'document.hasFocus() is true again');
    assert.equal(L.resolveBlur(blurred, 2000 + L.BLUR_GRACE_MS, true).blurAt, null);
    // a key arrived after the blur: it is not a real leave even if hasFocus() reads false
    const typed = L.reduceKey(blurred, snap, key('j', { nowMs: 2100 })).ui;
    assert.equal(L.resolveBlur(typed, 2000 + L.BLUR_GRACE_MS, false).railFocused, true, 'key since the blur');
    const pointed = L.touch(blurred, 2100);
    assert.equal(L.resolveBlur(pointed, 5000, false).railFocused, true, 'pointer since the blur');
    const refocused = L.setRailFocused(blurred, true, 2100);
    assert.equal(refocused.blurAt, null, 'focus-rail clears the pending blur');
    // a real blur: still blurred and idle after the grace period
    const released = L.resolveBlur(blurred, 2000 + L.BLUR_GRACE_MS, false);
    assert.equal(released.railFocused, false);
    assert.equal(released.blurAt, null);
    assert.equal(L.reduceKey(released, snap, key('j', { nowMs: 2300 })).handled, false, 'keys inert after a real blur');
    // a stale undecided blur does not hide a later one
    assert.equal(L.noteBlur(typed, 3000).blurAt, 3000);
    // blur while not focused is ignored
    assert.equal(L.noteBlur({ ...focused('p-wait'), railFocused: false }, 100).blurAt, undefined);
    // a real blur still disarms a pending Y/N
    const armed = L.reduceKey(base, snap, key('y', { nowMs: 1000 })).ui;
    assert.equal(L.resolveBlur(L.noteBlur(armed, 1100), 1100 + L.BLUR_GRACE_MS, false).armed, null);
});

test('J K E still act on a single press', () => {
    const snap = fixture();
    assert.equal(L.reduceKey(focused('p-wait'), snap, key('j')).ui.selectedPaneID, 'p-run');
    assert.equal(L.reduceKey(focused('p-run'), snap, key('e')).effect.command, 'local.swarm-view.archive');
});

test('the button guard locks Approve and Deny for 500 ms after the item, prompt or position changes', () => {
    const g = L.createButtonGuard();
    const att = [{ id: 'a', type: 'Request', promptHash: 'h1' }, { id: 'b', type: 'Error' }];
    g.observe(att, 1000);
    assert.equal(g.locked('a', 1000), true);
    assert.equal(g.locked('a', 1499), true);
    assert.equal(g.locked('a', 1500), false);
    g.observe(att, 2000);
    assert.equal(g.locked('a', 2000), false, 'unchanged item does not relock');
    g.observe([{ id: 'x', type: 'Error' }, att[0], att[1]], 3000);
    assert.equal(g.locked('a', 3100), true, 'moved down one slot');
    g.observe([{ id: 'x', type: 'Error' }, { ...att[0], promptHash: 'h2' }, att[1]], 4000);
    assert.equal(g.locked('a', 4100), true, 'prompt changed');
    assert.equal(g.remaining(4100), 400);
    assert.equal(g.remaining(5000), 0);
});

test('displayCommand shows the raw lines unless every non-final line has the same width, and marks each rejoin', () => {
    // The widest line is a comment with no space in it: the line after it must stay on its own line.
    const hidden = 'echo ok\n#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nrm -rf ~/repos';
    assert.equal(L.displayCommand(hidden), hidden);
    assert.ok(L.displayCommand(hidden).split('\n').includes('rm -rf ~/repos'));
    // Two lines are no evidence of a wrap either.
    assert.equal(L.displayCommand('#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nrm -rf ~/repos'), '#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nrm -rf ~/repos');
    // A long token the pane wrapped: every non-final line fills the same width, so the pieces are rejoined with a visible mark.
    const url = ['https://github.co', 'm/ultralytics/ass', 'ets/releases/down', 'load/v8.3.0/mobil', 'e_sam.pt'].join('\n');
    assert.equal(L.displayCommand(url), 'https://github.co⏎m/ultralytics/ass⏎ets/releases/down⏎load/v8.3.0/mobil⏎e_sam.pt');
    // A first line narrower than the rest means the breaks are not all wraps: raw lines.
    const narrow = ['curl -sSLf -o', '/Users/maxmusterm', 'han/gl/data/model', 's/mobile_sam.pt', 'https://github.co', 'm/ultralytics/ass', 'ets/releases/down', 'load/v8.3.0/mobil', 'e_sam.pt'].join('\n');
    assert.equal(L.displayCommand(narrow), narrow);
    // Equal-width lines with a space in them were wrapped at a word boundary, not mid-token: the break is kept.
    assert.equal(L.displayCommand('mv /tmp/a\nrm /tmp/b\ncd'), 'mv /tmp/a\nrm /tmp/b\ncd');
    assert.equal(L.displayCommand('/Users/maxmusterm\nhan/gl/data/model\ns/mobile_sam.pt x\ny'), '/Users/maxmusterm⏎han/gl/data/model⏎s/mobile_sam.pt x\ny');
    // A final line wider than the others was never wrapped.
    assert.equal(L.displayCommand('aaaaa\nbbbbb\ncccccccc'), 'aaaaa\nbbbbb\ncccccccc');
    assert.equal(L.displayCommand('mv /private/tmp/claude-501/swarm-prompt-probe\n/private/tmp/claude-501/swarm-prompt-probe2'), 'mv /private/tmp/claude-501/swarm-prompt-probe\n/private/tmp/claude-501/swarm-prompt-probe2');
    assert.equal(L.displayCommand('cat <<EOF\nline\nEOF'), 'cat <<EOF\nline\nEOF');
    assert.equal(L.displayCommand('git status'), 'git status');
    assert.equal(L.displayCommand(''), '');
    assert.equal(L.displayCommand(undefined), '');
});

test('a Request card shows the raw lines, rejoined with ⏎ marks only for a real wrap, with no "Raw lines" fold', () => {
    const refs = () => ({ list: { nodes: [], replaceChildren(...n) { this.nodes = n; } }, footer: { replaceChildren() {} } });
    const doc = { createElement: tag => ({ tag, children: [], dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.children.push(...n); }, addEventListener() {}, set className(v) { this.cls = v; }, get className() { return this.cls ?? ''; }, set textContent(v) { this.text = String(v); }, get textContent() { return this.text ?? ''; } }) };
    const nodes = r => { const out = []; const walk = n => { out.push(n); (n.children ?? []).forEach(walk); }; r.list.nodes.forEach(walk); return out; };
    const draw = (command, ui = { selectedPaneID: null, railFocused: false }) => {
        const snap = fixture();
        snap.attention[0].command = command;
        const r = refs();
        L.render(doc, r, { snapshot: snap, ui, notice: '', receivedAtMs: 0, nowMs: 0 }, { onSelect() {}, onOpen() {}, onAttention() {}, onExpand() {} });
        return nodes(r);
    };
    const texts = all => all.filter(n => n.text).map(n => n.text);
    const wrapped = draw('/Users/maxmusterm\nhan/gl/data/model\ns/x.pt');
    assert.ok(texts(wrapped).includes('/Users/maxmusterm⏎han/gl/data/model⏎s/x.pt'), texts(wrapped).join(' | '));
    assert.equal(texts(wrapped).includes('Raw lines'), false, 'no fold any more');
    assert.equal(wrapped.some(n => n.tag === 'details'), false);
    const code = wrapped.find(n => n.tag === 'code');
    assert.equal(code.className, 'att-command att-clamp', 'two lines until expanded');
    // Expanded: the same text, unclamped, and the tooltip explains the marks.
    const open = draw('/Users/maxmusterm\nhan/gl/data/model\ns/x.pt', { selectedPaneID: null, railFocused: false, expanded: ['Request:p-wait:2026-10-08T00:58:00.000Z'] });
    const openCode = open.find(n => n.tag === 'code');
    assert.equal(openCode.className, 'att-command');
    assert.equal(openCode.text, '/Users/maxmusterm⏎han/gl/data/model⏎s/x.pt');
    assert.match(openCode.attrs.title, /⏎ marks each join/);
    const hidden = draw('echo ok\n#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nrm -rf ~/repos');
    assert.ok(texts(hidden).includes('echo ok\n#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nrm -rf ~/repos'), texts(hidden).join(' | '));
});
