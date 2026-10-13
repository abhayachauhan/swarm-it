// The rail fixes as the user meets them (test/sidebar-app-harness.mjs): a waiting worker the rail cannot read, the
// other-swarms lines, the "from <swarm>" tag on another swarm's card, and the Auto duration menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, fixture } from './sidebar-app-harness.mjs';
import { find } from './sidebar-fake-dom.mjs';

const sent = (app, name) => app.calls.filter(c => c.command === `local.swarm-view.${name}`);
const OTHER = { workspaceID: 'ws2', name: 'Kelpi UI', orchestratorPaneID: 'o2', color: 'purple', running: 2, needYou: 1, done: 0 };
const waitingRow = (app, paneID) => find(app.refs.list, n => n.className.includes('att-waiting') && n.dataset.paneId === paneID)[0] ?? null;

test('a waiting worker the rail cannot read is under Needs you with Go to pane, not under Running, and never offers Approve', async () => {
    const snap = fixture();
    snap.waitingPanes = [{ paneID: 'p-run', label: 'api-docs' }];
    const app = await bootApp({ snapshot: snap });
    const row = waitingRow(app, 'p-run');
    assert.ok(row, 'the waiting row is drawn');
    assert.match(row.textContent, /api-docs is waiting for you/);
    assert.equal(app.row('p-run'), null, 'not also a Running row');
    assert.equal(app.button(row, 'Approve'), null);
    await app.pointerClick(app.button(row, 'Go to pane'));
    assert.deepEqual(app.reveals, ['p-run']);
    // Keyboard: Enter on the selected waiting row goes to the pane too; Y says to answer in the pane.
    app.emit('local.swarm-view.focus-rail', {});
    await app.pointerClick(row);
    await app.press('Enter');
    assert.deepEqual(app.reveals, ['p-run', 'p-run']);
    await app.press('y');
    assert.match(app.footerText(), /answer it in the pane/);
    assert.equal(sent(app, 'approve').length, 0);
    // The row goes when the backend drops it.
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: snap.sequence + 1, waitingPanes: [] });
    await app.flush();
    assert.equal(waitingRow(app, 'p-run'), null);
    assert.ok(app.row('p-run'), 'back under Running');
});

test('a waiting row from another swarm carries the "from" tag', async () => {
    const snap = fixture();
    snap.waitingPanes = [{ paneID: 'x1', label: 'worker-2', swarmName: 'Kelpi UI', swarmWorkspaceID: 'ws2' }];
    snap.otherSwarms = [OTHER];
    const app = await bootApp({ snapshot: snap });
    const row = waitingRow(app, 'x1');
    assert.match(row.textContent, /^from Kelpi UIworker-2 is waiting for you/);
});

test('other live swarms: one line each under the sections, zero parts left out, a click goes to that coordinator', async () => {
    const snap = fixture();
    snap.otherSwarms = [OTHER, { ...OTHER, workspaceID: 'ws3', name: 'Quiet', orchestratorPaneID: 'o3', color: null, running: 0, needYou: 0, done: 4 }];
    const app = await bootApp({ snapshot: snap });
    const lines = find(app.refs.list, n => n.className === 'swarm-line');
    assert.deepEqual(lines.map(l => l.text), ['Kelpi UI · 2 running · 1 need you', 'Quiet · 4 done']);
    assert.deepEqual(lines.map(l => l.dataset.color), ['purple', 'neutral']);
    const children = app.refs.list.children;
    assert.equal(children.indexOf(lines[0]), children.length - 2, 'below the followed swarm');
    await app.pointerClick(lines[1]);
    assert.deepEqual(app.reveals, ['o3']);
    // None at all: no heading either.
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: snap.sequence + 1, otherSwarms: [] });
    await app.flush();
    assert.equal(find(app.refs.list, n => n.text === 'Other swarms').length, 0);
});

test('a card from another swarm has a "from <swarm>" tag in its Group colour; the tag goes to that coordinator', async () => {
    const snap = fixture();
    snap.attention[0] = { ...snap.attention[0], swarmName: 'Kelpi UI', swarmWorkspaceID: 'ws2' };
    snap.otherSwarms = [OTHER];
    const app = await bootApp({ snapshot: snap });
    const tag = find(app.card(0), n => n.className === 'swarm-tag')[0];
    assert.equal(tag.text, 'from Kelpi UI');
    assert.equal(tag.dataset.color, 'purple');
    assert.equal(app.card(0).children[0], tag, 'at the top of the card');
    await app.pointerClick(tag);
    assert.deepEqual(app.reveals, ['o2']);
    // An unknown colour falls back to the neutral accent; the followed swarm's own card has no tag.
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: snap.sequence + 1, otherSwarms: [{ ...OTHER, color: 'javascript:x' }] });
    await app.flush();
    assert.equal(find(app.card(0), n => n.className === 'swarm-tag')[0].dataset.color, 'neutral');
    app.emit('local.swarm-view.snapshot', { ...fixture(), sequence: snap.sequence + 2 });
    await app.flush();
    assert.equal(find(app.card(0), n => n.className === 'swarm-tag').length, 0);
});

test('Auto off: the toggle opens the duration menu, a choice turns it on; on, one click turns it off', async () => {
    const snap = { ...fixture(), autoApprove: { on: false, until: null, since: null, approved: 0, skipped: 0, failed: 0, logCount: 0, paused: [], ended: null } };
    const app = await bootApp({ snapshot: snap });
    const toggle = () => find(app.refs.head, n => n.tag === 'button' && n.text.startsWith('Auto:'))[0];
    await app.pointerClick(toggle());
    assert.equal(sent(app, 'auto-approve').length, 0, 'opening the menu turns nothing on');
    const nine = new Date(app.clock.now);
    nine.setHours(9, 0, 0, 0);
    if (nine.getTime() <= app.clock.now) nine.setDate(nine.getDate() + 1);
    const choice = find(app.refs.panel, n => n.tag === 'button' && n.text.startsWith('Until 9am'))[0];
    assert.ok(choice);
    await app.pointerClick(choice);
    assert.deepEqual(sent(app, 'auto-approve').map(c => c.args), [{ on: true, until: nine.toISOString() }]);
    assert.equal(find(app.refs.panel, n => n.tag === 'button' && /hours/.test(n.text)).length, 0, 'the menu closes');
    await app.pointerClick(toggle());
    await app.pointerClick(find(app.refs.panel, n => n.tag === 'button' && n.text === '4 hours')[0]);
    assert.deepEqual(sent(app, 'auto-approve').at(-1).args, { on: true, hours: 4 });
    // On: one click turns it off.
    app.emit('local.swarm-view.snapshot', { ...snap, sequence: snap.sequence + 1, autoApprove: { ...snap.autoApprove, on: true, until: nine.toISOString() } });
    await app.flush();
    await app.pointerClick(toggle());
    assert.deepEqual(sent(app, 'auto-approve').at(-1).args, { on: false });
});
