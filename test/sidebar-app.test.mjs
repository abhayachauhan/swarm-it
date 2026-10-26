// The rail as the user drives it: app.js booted in a fake window (test/sidebar-app-harness.mjs). Each test clicks or
// types, lets the app's own timers run, and checks what reached the backend and what the footer says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, fixture } from './sidebar-app-harness.mjs';

const REQUEST_ID = 'Request:p-wait:2026-10-08T00:58:00.000Z';
const sent = (app, name) => app.calls.filter(c => c.command === `local.swarm-view.${name}`);
const labels = root => root.querySelectorAll('button').map(b => b.text);

test('a double-click that collapses a card cannot land on Approve: Approve and Deny lock for 400 ms after an expand or collapse', async () => {
    const snap = fixture();
    snap.attention[0].command = 'echo one\necho two\necho three\necho four';
    const app = await bootApp({ snapshot: snap });
    await app.advance(600); // the 500 ms new-item lock has lifted
    assert.equal(app.button(app.card(0), 'Approve').disabled, false, 'enabled once the item lock lifted');
    // Click 1 of a double-click on the expanded command's last line collapses it; the redraw lands after pointerup.
    await app.pointerClick(app.card(0).querySelector('code'));
    await app.advance(450);
    await app.pointerClick(app.card(0).querySelector('code'));
    const approve = app.button(app.card(0), 'Approve');
    assert.equal(approve.disabled, true, 'Approve is disabled right after the layout changed under the pointer');
    assert.equal(approve.dataset.locked, 'true');
    // Click 2 lands where Approve now is: nothing is sent.
    await app.pointerClick(approve);
    assert.equal(sent(app, 'approve').length, 0);
    assert.equal(app.button(app.card(0), 'Deny').disabled, true);
    // The rail redraws by itself once the lock lifts, and a deliberate click then works.
    await app.advance(450);
    const later = app.button(app.card(0), 'Approve');
    assert.equal(later.disabled, false);
    assert.equal(later.dataset.locked, undefined);
    await app.pointerClick(later);
    assert.deepEqual(sent(app, 'approve').map(c => c.args), [{ itemID: REQUEST_ID, promptHash: snap.attention[0].promptHash }]);
});

test('a double-click on Stop cannot end a worker: Keep takes the spot Stop had and "Really stop?" is locked for 400 ms', async () => {
    const app = await bootApp();
    await app.pointerClick(app.button(app.row('p-run'), 'Stop'));
    const row = app.row('p-run');
    // The actions sit at the row's right edge, so the last button is where Stop was: Keep.
    assert.deepEqual(labels(row), ['Really stop?', 'Keep']);
    const really = app.button(row, 'Really stop?');
    assert.equal(really.disabled, true);
    assert.equal(really.dataset.locked, 'true');
    await app.pointerClick(really);
    assert.equal(sent(app, 'close-worker').length, 0, 'the second click of the double-click did nothing');
    await app.advance(450);
    const armed = app.button(app.row('p-run'), 'Really stop?');
    assert.equal(armed.disabled, false);
    await app.pointerClick(armed);
    assert.deepEqual(sent(app, 'close-worker').map(c => c.args), [{ paneID: 'p-run' }]);
    // Keep brings Stop back under the pointer; arming again from there is harmless and locks "Really stop?" again.
    const again = await bootApp();
    await again.pointerClick(again.button(again.row('p-run'), 'Stop'));
    await again.advance(450);
    await again.pointerClick(again.button(again.row('p-run'), 'Keep'));
    assert.deepEqual(labels(again.row('p-run')), ['Stop']);
    await again.pointerClick(again.button(again.row('p-run'), 'Stop'));
    assert.equal(again.button(again.row('p-run'), 'Really stop?').disabled, true);
    assert.equal(sent(again, 'close-worker').length, 0);
});

test('a clamped command that wraps past two lines is marked after the draw, and measured again when the rail is resized', async () => {
    const snap = fixture();
    snap.attention[0].command = 'one\ntwo';
    const fits = node => { if (node.tag === 'code') { node.clientHeight = 32; node.scrollHeight = 32; } };
    const app = await bootApp({ snapshot: snap, onCreate: fits });
    const more = () => app.card(0).querySelector('.att-more-maybe');
    assert.equal(more().classList.contains('att-overflow'), false, 'two short lines fit: no "Long command" line');
    // The rail narrows: the same two lines now wrap to three. Nothing redraws; the resize must re-measure.
    app.card(0).querySelector('code').scrollHeight = 48;
    app.resize();
    assert.equal(more().classList.contains('att-overflow'), true);
    assert.equal(app.observers.length, 1);
    assert.ok(app.observers[0].targets.includes(app.refs.list), 'the list is what is observed');
    // Widening it again hides the line.
    app.card(0).querySelector('code').scrollHeight = 32;
    app.resize();
    assert.equal(more().classList.contains('att-overflow'), false);
    // A line that already wraps at the first draw is marked straight away.
    const wide = await bootApp({ snapshot: snap, onCreate: node => { if (node.tag === 'code') { node.clientHeight = 32; node.scrollHeight = 48; } } });
    assert.equal(wide.card(0).querySelector('.att-more-maybe').classList.contains('att-overflow'), true);
    // Leaving the page stops observing.
    app.dispatch('pagehide');
    assert.equal(app.observers[0].targets.length, 0);
});

test('⌂ Coordinator closes the thread view and then takes the user to the coordinator pane', async () => {
    const app = await bootApp();
    await app.pointerClick(app.button(app.refs.head, '⌂ Coordinator'));
    await app.flush();
    assert.deepEqual(sent(app, 'open-thread').map(c => c.args), [{ paneID: 'p-orch' }]);
    assert.deepEqual(app.reveals, ['p-orch']);
    // With no coordinator known it still closes the thread view, and reveals nothing.
    const none = await bootApp({ snapshot: { ...fixture(), orchestrator: null } });
    await none.pointerClick(none.button(none.refs.head, '⌂ Coordinator'));
    await none.flush();
    assert.equal(sent(none, 'close-thread').length, 1);
    assert.deepEqual(none.reveals, []);
});

test('an unrecognised prompt says "Answer in the pane" and its "Go to pane" button reveals the pane itself', async () => {
    const snap = fixture();
    snap.attention[0].approvable = false;
    const app = await bootApp({ snapshot: snap });
    const card = app.card(0);
    assert.ok(card.querySelectorAll('.att-text').some(n => n.text === 'Answer in the pane'));
    assert.deepEqual(labels(card), ['Go to pane']);
    await app.pointerClick(app.button(card, 'Go to pane'));
    await app.flush();
    assert.deepEqual(app.reveals, ['p-wait']);
    assert.equal(sent(app, 'open-thread').length, 0, 'the thread view could not answer it either');
    // A card from another swarm goes to that pane too.
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: 13, attention: [{ ...snap.attention[0], paneID: 'x9', paneLabel: 'worker-2', swarmName: 'BB', swarmWorkspaceID: 'ws2' }] });
    await app.pointerClick(app.button(app.card(0), 'Go to pane'));
    await app.flush();
    assert.deepEqual(app.reveals, ['p-wait', 'x9']);
    // A refusal is reported under the verb on the button.
    const failing = await bootApp({ snapshot: snap, revealFails: 'no such pane' });
    await failing.pointerClick(failing.button(failing.card(0), 'Go to pane'));
    await failing.flush();
    assert.equal(failing.footerText(), 'Go to pane: no such pane');
});

const AUTO_ON = { on: true, until: '2026-10-11T08:30:00.000Z', since: '2026-10-10T20:30:00.000Z', approved: 31, skipped: 0, failed: 0, logCount: 31, paused: [], ended: null };
const PAUSED = { paneID: 'p-run', label: 'api-docs', reason: 'more than 30 auto-approvals in 10 minutes; its cards are left for you', at: '2026-10-10T21:00:00.000Z' };

test('a rate-guard pause and the timer switching auto-approve off are each announced once in the footer', async () => {
    const snap = { ...fixture(), autoApprove: { ...AUTO_ON, paused: [PAUSED] } };
    const app = await bootApp({ snapshot: snap });
    assert.equal(app.footerText(), `Auto-approve stopped for api-docs: ${PAUSED.reason}`);
    await app.advance(8100); // the notice clears by itself
    assert.equal(app.footerText(), '');
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: 13 });
    assert.equal(app.footerText(), '', 'the same pause is not announced again');
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: 14, autoApprove: { ...AUTO_ON, on: false, until: null, ended: { reason: 'expired', at: '2026-10-11T08:30:00.000Z' } } });
    assert.match(app.footerText(), /^Auto-approve switched itself off at \d\d:\d\d: the time ran out\. 31 approved\.$/);
    await app.advance(8100);
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: 15, autoApprove: { ...AUTO_ON, on: false, until: null, ended: { reason: 'expired', at: '2026-10-11T08:30:00.000Z' } } });
    assert.equal(app.footerText(), '', 'the same switch-off is not announced again');
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: 16, autoApprove: { ...AUTO_ON, on: false, until: null, ended: { reason: 'user', at: '2026-10-11T09:00:00.000Z' } } });
    assert.equal(app.footerText(), '', 'the user turning it off is not news');
    // Afterwards both still live in the toggle's tooltip.
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: 17, autoApprove: { ...AUTO_ON, paused: [PAUSED] } });
    assert.match(app.button(app.refs.head, app.L.autoLabel({ ...AUTO_ON, paused: [PAUSED] })).attrs.title, /Stopped for api-docs/);
});

test('finished workers have no row to remove; a failed two-step stop by the X key says "Stop:"', async () => {
    const refuse = command => (/close-worker/.test(command) ? { ok: false, error: 'the host refused' } : null);
    const app = await bootApp({ snapshot: fixture(), execute: refuse });
    assert.equal(app.row('p-done'), null);
    // Selecting a row by click gives the rail the keyboard; X twice on a running worker is Stop.
    await app.pointerClick(app.row('p-run'));
    assert.equal(app.refs.list.dataset.railFocused, 'true');
    await app.press('x');
    assert.match(app.footerText(), /^Press X again/);
    await app.press('x');
    assert.equal(app.footerText(), 'Stop: the host refused');
});

test('⌂ Coordinator is never disabled: with no coordinator known it closes the worker view', async () => {
    const app = await bootApp({ snapshot: { ...fixture(), orchestrator: null } });
    const home = app.button(app.refs.head, '⌂ Coordinator');
    assert.equal(home.disabled, false);
    assert.equal(home.attrs.title, 'No coordinator pane known yet: closes the worker view');
    await app.pointerClick(home);
    await app.flush();
    assert.deepEqual(sent(app, 'close-thread').map(c => c.args), [{}]);
    const known = await bootApp();
    await known.pointerClick(known.button(known.refs.head, '⌂ Coordinator'));
    await known.flush();
    assert.deepEqual(sent(known, 'open-thread').map(c => c.args), [{ paneID: 'p-orch' }]);
    assert.equal(sent(known, 'close-thread').length, 0);
});

test('each new set of warnings goes to the console once; the footer stays quiet', async () => {
    const snap = { ...fixture(), warnings: ['manifest: invalid json'] };
    const app = await bootApp({ snapshot: snap });
    assert.deepEqual(app.warned, ['[swarm-view] manifest: invalid json']);
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: 13 });
    assert.equal(app.warned.length, 1, 'the same set again is silent');
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: 14, warnings: ['manifest: invalid json', 'autohide: 1 worker waiting for a retry'] });
    assert.equal(app.warned.length, 3);
    assert.equal(app.footerText(), '');
    assert.equal(app.button(app.refs.head, '⚠ 2').attrs.title, 'manifest: invalid json\nautohide: 1 worker waiting for a retry');
});

test('the rail says in the DOM whether it holds the keyboard: focus-rail takes it, an idle half minute releases it', async () => {
    const app = await bootApp();
    assert.equal(app.refs.list.dataset.railFocused, 'false');
    app.emit('local.swarm-view.focus-rail', {});
    await app.flush();
    assert.equal(app.refs.list.dataset.railFocused, 'true');
    await app.press('j');
    assert.equal(app.refs.list.querySelectorAll('[aria-current="true"]')[0].dataset.paneId, 'p-run');
    await app.advance(app.L.IDLE_MS + 600);
    assert.equal(app.refs.list.dataset.railFocused, 'false');
    assert.equal((await app.press('j')).prevented, undefined, 'keys are inert again');
});


test('central Codex answer keeps a typed draft across snapshots and sends the matching request', async () => {
    const snap = fixture();
    snap.codexQuestions = [{ requestID: 17, threadID: 'thread-a', paneID: 'p-wait', questions: [{ id: 'q', question: 'Which environment?', options: [{ label: 'Staging' }] }] }];
    const app = await bootApp({ snapshot: snap });
    await app.pointerClick(app.button(app.refs.list, 'Staging'));
    let input = app.refs.list.querySelector('input');
    input.value = 'Staging, then ask me';
    for (const fn of input.listeners.input || []) fn();
    app.emit('snapshot', { ...snap, sequence: snap.sequence + 1 });
    input = app.refs.list.querySelector('input');
    assert.equal(input.value, 'Staging, then ask me');
    await app.pointerClick(app.button(app.refs.list, 'Send answer'));
    assert.deepEqual(sent(app, 'answer-codex-question').at(-1).args, { requestID: 17, threadID: 'thread-a', answers: { q: { answers: ['Staging, then ask me'] } } });
    await app.pointerClick(app.button(app.refs.list, 'Go to pane'));
    assert.equal(app.reveals.at(-1), 'p-wait');
});


test('Trust folder and continue sends an explicit consent command after the card lock lifts', async () => {
    const snap = fixture();
    Object.assign(snap.attention[0], { agent: 'codex', approvable: false, promptBlock: 'Trust this folder?\n› 1. Trust and continue\n2. Quit' });
    const app = await bootApp({ snapshot: snap });
    assert.equal(app.button(app.card(0), 'Trust folder and continue').disabled, true);
    await app.advance(600);
    await app.pointerClick(app.button(app.card(0), 'Trust folder and continue'));
    assert.deepEqual(sent(app, 'trust-folder').map(c => c.args), [{ itemID: snap.attention[0].id, promptHash: snap.attention[0].promptHash, confirm: true }]);
});
