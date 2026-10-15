// Auto-approve for overnight runs: off by default, approves through the same path as the Approve button, logs, guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

// Set before the backend loads: scan interval, manifest reload and the rate guard are read once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
process.env.SWARM_AUTO_RATE_MAX = '2';
process.env.SWARM_AUTO_RATE_WINDOW_MS = '600000';
const { registerAll, SNAPSHOT_EVENT } = await import('../backend/index.mjs');
const { LOG_CAP, RATE_MAX } = await import('../backend/autoapprove.mjs');
const { parsePrompt, promptHash } = await import('../backend/notify.mjs');
const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const enters = (api, paneID) => api.callsTo('terminal.sendKey').filter(c => c.args[0] === paneID && c.args[1] === 'enter').length;
const openRequests = (dispose, paneID) => dispose.store.attention.filter(i => i.type === 'Request' && i.paneID === paneID && !i.handledAt);
/** A recognised prompt (the classic layout) whose command is exactly `cmd`. */
const prompt = cmd => ['╭──────────────────╮', ' Bash command', '', `   ${cmd}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
// No header: the shape is not recognised, so approvable is false.
const UNRECOGNISED = ['', ' Some tool wants something', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');

const SECOND = {
    version: 1,
    orchestrator: { paneID: 'orch2', label: 'coordinator' },
    workers: [{ paneID: 'x1', label: 'worker-2', task: 'UI', resultPath: null, worktreePath: null, parent: null }]
};
function makeApi(extra = {}) {
    return makeSwarmApi({
        otherWorkspaces: [{ id: 'ws2', name: 'Kelpi UI improvement' }, { id: 'ws3', name: 'Empty' }],
        otherPanes: [
            { id: 'orch2', label: 'coordinator2', workspaceID: 'ws2', status: 'idle', agentSessionID: '0f0f0f0f-0000-4000-8000-0000000c0de2' },
            { id: 'x1', label: 'worker-2', workspaceID: 'ws2', status: 'running' },
            { id: 'plain', label: 'shell', workspaceID: 'ws3', status: 'idle' }
        ],
        files: { '/m/ws2.json': JSON.stringify(SECOND) },
        captures: { orch2: '', x1: 'working', plain: '$' },
        ...extra
    });
}
async function start(extra) {
    const api = makeApi(extra);
    const dispose = registerAll(api);
    await dispose.ready;
    return { api, dispose };
}

test('off by default, and off again after a reload even if it was on; the log survives the reload', async () => {
    const storage = new Map();
    const { api, dispose } = await start({ storage });
    const before = (await api.command('get-state', {})).snapshot.autoApprove;
    assert.equal(before.on, false);
    assert.deepEqual([before.until, before.approved, before.skipped, before.logCount], [null, 0, 0, 0]);
    assert.equal((await api.command('auto-approve', { on: true, hours: 12 })).autoApprove.on, true);
    api.captureStore.w1 = prompt('npm test');
    await sleep(80);
    assert.equal(lastSnapshot(api).autoApprove.approved, 1);
    dispose();
    const again = makeApi({ storage });
    const reloaded = registerAll(again);
    await reloaded.ready;
    const after = (await again.command('get-state', {})).snapshot.autoApprove;
    assert.equal(after.on, false, 'never persisted as on');
    assert.equal(after.logCount, 1, 'the log is persisted');
    assert.equal(again.storageMap.has('autoApprove'), false, 'no on-state key is written');
    reloaded();
});

test('turning on: default 12 h, a chosen duration, until turned off; bad input is refused; off is one call', async () => {
    const { api, dispose } = await start();
    const t0 = Date.now();
    const twelve = await api.command('auto-approve', { on: true });
    assert.equal(twelve.ok, true);
    const untilMs = Date.parse(twelve.autoApprove.until);
    assert.ok(Math.abs(untilMs - (t0 + 12 * 3600000)) < 5000, 'default is 12 h');
    const four = await api.command('auto-approve', { on: true, hours: 4 });
    assert.ok(Math.abs(Date.parse(four.autoApprove.until) - (Date.now() + 4 * 3600000)) < 5000);
    assert.equal((await api.command('auto-approve', { on: true, hours: null })).autoApprove.until, null, 'until turned off');
    assert.equal((await api.command('auto-approve', { on: true, hours: 0 })).autoApprove.until, null);
    for (const hours of [-1, 'x', 999, Number.NaN]) assert.equal((await api.command('auto-approve', { on: true, hours })).code, 'BAD_ARGS', String(hours));
    assert.equal((await api.command('auto-approve', {})).code, 'BAD_ARGS');
    const off = await api.command('auto-approve', { on: false });
    assert.equal(off.autoApprove.on, false);
    assert.deepEqual(off.autoApprove.ended.reason, 'user');
    assert.equal(lastSnapshot(api).autoApprove.on, false, 'views are told');
    dispose();
});

test('while on, a recognised prompt from the followed swarm and from another swarm is approved through the approve path, and logged', async () => {
    const { api, dispose } = await start();
    await api.command('get-state', { workspaceID: 'ws1' });
    await api.command('auto-approve', { on: true, hours: 8 });
    api.captureStore.w1 = prompt('npm test');
    api.captureStore.x1 = prompt('git status --short');
    await sleep(100);
    // The agents move on after Enter.
    api.captureStore.w1 = 'running tests';
    api.captureStore.x1 = 'pushing';
    await sleep(60);
    assert.equal(enters(api, 'w1'), 1);
    assert.equal(enters(api, 'x1'), 1, "another live swarm's worker too");
    assert.equal(api.callsTo('terminal.sendKey').length, 2, 'Enter only, once per card');
    // approve verifies the live prompt twice before the key: three captures of w1 per approval (one scan, two checks) at least.
    assert.ok(api.callsTo('terminal.capture').filter(c => c.args[0] === 'w1').length >= 3);
    assert.equal(openRequests(dispose, 'w1').length, 0, 'the card is handled');
    assert.ok(dispose.store.attention.some(i => i.paneID === 'w1' && i.type === 'Request' && i.handledAt), 'handled by the approval');
    const auto = lastSnapshot(api).autoApprove;
    assert.equal(auto.approved, 2);
    assert.equal(auto.logCount, 2);
    const { entries, count } = await api.command('auto-approve-log', {});
    assert.equal(count, 2);
    const byPane = Object.fromEntries(entries.map(e => [e.paneID, e]));
    assert.deepEqual([byPane.w1.swarmName, byPane.w1.label, byPane.w1.command, byPane.w1.ok], ['Swarm', 'repo-lag', 'npm test', true]);
    assert.deepEqual([byPane.x1.swarmName, byPane.x1.label, byPane.x1.command], ['Kelpi UI improvement', 'worker-2', 'git status --short']);
    assert.match(byPane.w1.at, /^\d{4}-\d{2}-\d{2}T/);
    // Newest first.
    assert.ok(Date.parse(entries[0].at) >= Date.parse(entries[1].at));
    assert.deepEqual(api.destructive, []);
    dispose();
});

test('a coordinator prompt with no notification (the user is watching that pane) is approved only while auto-approve is on', async () => {
    const { api, dispose } = await start();
    await api.command('get-state', { workspaceID: 'ws1' });
    api.captureStore.orch = prompt('curl -s http://frigate:5000/');
    api.captureStore.orch2 = prompt('ls');
    await sleep(80);
    assert.equal(openRequests(dispose, 'orch').length, 0, 'off: no card for the pane the user is looking at');
    assert.equal(enters(api, 'orch'), 0);
    await api.command('auto-approve', { on: true, hours: 8 });
    await sleep(100);
    api.captureStore.orch = 'probing';
    api.captureStore.orch2 = 'listing';
    await sleep(60);
    assert.equal(enters(api, 'orch'), 1, 'the followed swarm coordinator');
    assert.equal(enters(api, 'orch2'), 1, "another swarm's coordinator");
    assert.equal(enters(api, 'stranger'), 0);
    dispose();
});

test('a prompt left on an idle shell (Claude exited, no session) never gets Enter', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    api.captureStore.w1 = prompt('npm test');
    await sleep(100);
    assert.equal(openRequests(dispose, 'w1').length, 0, 'a plain shell is not scanned');
    assert.equal(enters(api, 'w1'), 0);
    // A card raised while Claude ran, then left on screen after it exited, is refused at approve time too.
    await api.command('auto-approve', { on: false });
    await api.upsert('w1', { status: 'running' });
    await sleep(60);
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    const card = openRequests(dispose, 'w1')[0];
    assert.ok(card, 'raised while running');
    const result = await api.command('approve', { itemID: card.id, promptHash: card.promptHash });
    assert.equal(result.code, 'STALE');
    assert.equal(enters(api, 'w1'), 0);
    dispose();
});

test('an unrecognised prompt is left for the user and counted separately; a stranger pane never gets a key', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    api.captureStore.w1 = UNRECOGNISED;
    api.captureStore.stranger = prompt('rm -rf /');
    await sleep(100);
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    assert.equal(openRequests(dispose, 'w1').length, 1, 'the card stays for the user');
    assert.equal(openRequests(dispose, 'w1')[0].approvable, false);
    const auto = lastSnapshot(api).autoApprove;
    assert.deepEqual([auto.approved, auto.skipped, auto.logCount], [0, 1, 0]);
    await sleep(60);
    assert.equal(lastSnapshot(api).autoApprove.skipped, 1, 'counted once, not once per scan');
    dispose();
});

test('a refused approval is logged with the reason, leaves the card, and is not retried on that card', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    api.terminal.sendKey = async () => { throw new Error('pane is busy'); };
    api.captureStore.w1 = prompt('npm test');
    await sleep(100);
    assert.equal(openRequests(dispose, 'w1').length, 1, 'the card is left for the user');
    const auto = lastSnapshot(api).autoApprove;
    assert.deepEqual([auto.approved, auto.failed, auto.logCount], [0, 1, 1]);
    const { entries } = await api.command('auto-approve-log', {});
    assert.equal(entries[0].ok, false);
    assert.equal(entries[0].code, 'SEND_FAILED');
    assert.match(entries[0].reason, /pane is busy/);
    await sleep(60);
    assert.equal(lastSnapshot(api).autoApprove.failed, 1, 'not retried on the same card');
    dispose();
});

test('a prompt that changed between the card and the key is refused by the live check and nothing is sent', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    let reads = 0;
    // The scan sees a recognised prompt; the approve checks see an unrecognised one in its place.
    api.captureStore.w1 = () => (reads++ === 0 ? prompt('npm test') : UNRECOGNISED);
    await sleep(100);
    assert.equal(api.callsTo('terminal.sendKey').length, 0, 'no key');
    const { entries } = await api.command('auto-approve-log', {});
    assert.ok(entries.some(e => e.ok === false && e.code === 'NOT_APPROVABLE' && e.command === 'npm test'), JSON.stringify(entries));
    // The replacement is left for the user and counted as unrecognised.
    assert.equal(lastSnapshot(api).autoApprove.skipped, 1);
    dispose();
});

test('the same prompt still showing right after an approval is not fed Enter again within the grace period', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    api.captureStore.w1 = prompt('npm test');
    await sleep(120);
    assert.equal(enters(api, 'w1'), 1, 'one Enter although the fake pane keeps showing the prompt');
    api.captureStore.w1 = prompt('npm run build');
    await sleep(80);
    assert.equal(enters(api, 'w1'), 2, 'a different prompt is approved');
    dispose();
});

test('cards already open when it is turned on are approved at switch-on', async () => {
    const { api, dispose } = await start();
    api.captureStore.w1 = prompt('npm test');
    await sleep(80);
    assert.equal(openRequests(dispose, 'w1').length, 1);
    assert.equal(api.callsTo('terminal.sendKey').length, 0, 'nothing while off');
    const result = await api.command('auto-approve', { on: true, hours: 1 });
    assert.equal(result.autoApprove.approved, 1);
    assert.equal(enters(api, 'w1'), 1);
    dispose();
});

test('when the time runs out it switches itself off and says so', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true, hours: 0.00001 });
    await sleep(100);
    const auto = lastSnapshot(api).autoApprove;
    assert.equal(auto.on, false);
    assert.equal(auto.ended.reason, 'expired');
    api.captureStore.w1 = prompt('npm test');
    await sleep(80);
    assert.equal(api.callsTo('terminal.sendKey').length, 0, 'nothing approved after expiry');
    dispose();
});

test('rate guard: a pane that gets more than the limit in the window is paused, its card left, and the reason shown', async () => {
    assert.equal(RATE_MAX, 2);
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    for (const [n, cmd] of [['one', 'echo 1'], ['two', 'echo 2'], ['three', 'echo 3']].map((x, i) => [i + 1, x[1]])) {
        api.captureStore.w1 = prompt(cmd);
        await sleep(90);
        assert.equal(enters(api, 'w1'), Math.min(n, 2), `after prompt ${n}`);
    }
    assert.equal(openRequests(dispose, 'w1').length, 1, 'the third card is left');
    const auto = lastSnapshot(api).autoApprove;
    assert.equal(auto.paused.length, 1);
    assert.equal(auto.paused[0].paneID, 'w1');
    assert.equal(auto.paused[0].label, 'repo-lag');
    assert.match(auto.paused[0].reason, /more than 2 auto-approvals in 10 minutes/);
    // Another pane is unaffected.
    api.captureStore.w2 = prompt('ls');
    await sleep(90);
    assert.equal(enters(api, 'w2'), 1);
    // Turning it on again clears the pause.
    await api.command('auto-approve', { on: true });
    assert.equal(lastSnapshot(api).autoApprove.paused.length, 0);
    dispose();
});

test('the log is capped at 500, newest first, and Clear empties it', async () => {
    const storage = new Map();
    storage.set('autoApproveLog', Array.from({ length: 600 }, (_, i) => ({ at: new Date(i * 1000).toISOString(), paneID: `p${i}`, label: 'x', command: 'c', ok: true, swarmName: '', swarmWorkspaceID: '' })));
    const { api, dispose } = await start({ storage });
    const { entries, count } = await api.command('auto-approve-log', {});
    assert.equal(count, LOG_CAP);
    assert.equal(entries.length, LOG_CAP);
    assert.equal(entries[0].paneID, 'p599', 'newest first');
    assert.equal(lastSnapshot(api).autoApprove.logCount, LOG_CAP);
    const cleared = await api.command('auto-approve-log', { clear: true });
    assert.deepEqual([cleared.count, cleared.entries.length], [0, 0]);
    assert.deepEqual(api.storageMap.get('autoApproveLog'), []);
    assert.equal(lastSnapshot(api).autoApprove.logCount, 0);
    dispose();
});

test('a snoozed card is left alone', async () => {
    const { api, dispose } = await start();
    api.captureStore.w1 = prompt('npm test');
    await sleep(80);
    const [card] = openRequests(dispose, 'w1');
    await api.command('snooze', { itemID: card.id, minutes: 30 });
    await api.command('auto-approve', { on: true });
    await sleep(60);
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    dispose();
});

test('a prompt that changes between the first and the second live check gets no key', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    let reads = 0;
    // The scan and the first check see the card's prompt; the second check, right before the key, sees another command.
    // After that the pane has moved on, so no new card is raised.
    api.captureStore.w1 = () => { const n = reads++; return n < 2 ? prompt('npm test') : n === 2 ? prompt('rm -rf ~/repos') : 'working'; };
    await sleep(100);
    assert.equal(api.callsTo('terminal.sendKey').length, 0, 'no key');
    assert.ok(reads >= 3, 'the first check passed and the second ran');
    const { entries } = await api.command('auto-approve-log', {});
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0].ok, entries[0].code, entries[0].command], [false, 'STALE', 'npm test']);
    assert.equal(lastSnapshot(api).autoApprove.failed, 1);
    dispose();
});

test('a Request injected for a pane no swarm owns is skipped, not tried, even though its pane shows a prompt', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    // The stranger sits in the swarm workspace but is not in the manifest.
    api.captureStore.stranger = prompt('rm -rf /');
    const live = parsePrompt(prompt('rm -rf /'));
    dispose.store.attention.push({
        id: 'Request:stranger:t', type: 'Request', paneID: 'stranger', text: 'my-shell is asking', command: 'rm -rf /',
        promptHash: promptHash(live.block), promptBlock: live.block, createdAt: new Date().toISOString()
    });
    await sleep(100);
    assert.equal(enters(api, 'stranger'), 0);
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    const { entries } = await api.command('auto-approve-log', {});
    assert.deepEqual(entries, [], 'not tried, so nothing to log');
    const auto = lastSnapshot(api).autoApprove;
    assert.deepEqual([auto.approved, auto.failed], [0, 0]);
    assert.equal(openRequests(dispose, 'stranger').length, 0, 'settled by the scan as unowned');
    dispose();
});

test('while on, a Claude pane outside any swarm is approved too; off, it is left alone; a plain shell never is', async () => {
    const { api, dispose } = await start({
        otherPanes: [
            { id: 'solo', label: 'my-claude', workspaceID: 'ws3', status: 'running', agent: 'claude', agentSessionID: 's-solo' },
            { id: 'plain', label: 'shell', workspaceID: 'ws3', status: 'idle' }
        ],
        captures: { solo: prompt('npm test'), plain: prompt('npm test') }
    });
    await sleep(80);
    assert.equal(enters(api, 'solo'), 0, 'auto-approve off: a non-swarm Claude pane is not touched');
    assert.equal(openRequests(dispose, 'solo').length, 0, 'and raises no card');
    assert.equal((await api.command('auto-approve', { on: true, hours: 10 / 60 })).autoApprove.on, true);
    await sleep(80);
    assert.equal(enters(api, 'solo'), 1, 'approved once auto-approve is on');
    assert.equal(enters(api, 'plain'), 0, 'a shell with no Claude session never gets a key');
    const { entries } = await api.command('auto-approve-log', {});
    assert.deepEqual(entries.map(e => [e.ok, e.label, e.command]), [[true, 'my-claude', 'npm test']]);
    // The never list still applies outside a swarm.
    api.captureStore.solo = prompt('git push origin main');
    await sleep(80);
    assert.equal(enters(api, 'solo'), 1, 'git push is left for the user');
    assert.equal(lastSnapshot(api).autoApprove.skipped, 1);
    // Off again: the non-swarm card is no longer owned and the scan settles it.
    await api.command('auto-approve', { on: false });
    await sleep(120);
    assert.equal(openRequests(dispose, 'solo').length, 0);
    dispose();
});

test('auto-approve for 10 minutes ends 10 minutes after it was turned on', async () => {
    const { api, dispose } = await start();
    const before = Date.now();
    const { autoApprove } = await api.command('auto-approve', { on: true, hours: 10 / 60 });
    const minutes = (Date.parse(autoApprove.until) - before) / 60000;
    assert.ok(minutes > 9.9 && minutes <= 10.01, `until is ${minutes} minutes away`);
    dispose();
});

test('a card superseded by a newer open Request on the same pane is skipped, so no spurious STALE failure is logged', async () => {
    const { api, dispose } = await start();
    api.captureStore.w1 = prompt('npm test');
    await sleep(60);
    assert.equal(openRequests(dispose, 'w1').length, 1);
    // The pane moves to a second prompt. A notification raises its card before the scan settles the first one, and
    // auto-approve is turned on right behind it: both run back to back on the serial queue, ahead of the next scan.
    api.captureStore.w1 = prompt('npm run build');
    const raised = api.fire('daemon.notification', { name: 'daemon.notification', data: { type: 'notification', kind: 'agent-notification', paneID: 'w1', workspaceID: 'ws1', title: 'Claude', body: 'Claude needs your permission' } });
    const on = api.command('auto-approve', { on: true });
    await raised;
    await on;
    assert.equal(enters(api, 'w1'), 1, 'the newer card is approved');
    const { entries } = await api.command('auto-approve-log', {});
    assert.deepEqual(entries.map(e => [e.ok, e.command]), [[true, 'npm run build']], JSON.stringify(entries));
    assert.equal(lastSnapshot(api).autoApprove.failed, 0);
    // The agent moves on after Enter; the next scan settles the stale card.
    api.captureStore.w1 = 'building';
    await sleep(60);
    assert.equal(openRequests(dispose, 'w1').length, 0, 'the stale card is settled by the scan');
    assert.equal(enters(api, 'w1'), 1);
    dispose();
});
