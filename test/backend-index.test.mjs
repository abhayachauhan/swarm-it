import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerAll, activate, modules, COMMANDS, COUNTS_ITEM, SNAPSHOT_EVENT, countsPatch } from '../backend/index.mjs';
import { makeSwarmApi, makeFakeApi, PROMPT_TEXT } from './backend-fake-api.mjs';

const plugin = JSON.parse(readFileSync(new URL('../kelpi.plugin.json', import.meta.url), 'utf8'));
const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(extra) {
    const api = makeSwarmApi(extra);
    const dispose = registerAll(api);
    await dispose.ready;
    return { api, dispose };
}

test('registers exactly the commands declared in kelpi.plugin.json', async () => {
    const { api, dispose } = await start();
    assert.deepEqual(api.registeredCommands().sort(), plugin.contributes.commands.map(c => c.id).sort());
    assert.deepEqual([...COMMANDS].sort(), api.registeredCommands().sort());
    dispose();
    assert.deepEqual(api.registeredCommands(), [], 'dispose unregisters');
});

test('activate returns a dispose function after the initial load', async () => {
    const api = makeSwarmApi();
    const dispose = await activate(api);
    assert.equal(typeof dispose, 'function');
    assert.ok(lastSnapshot(api));
    dispose();
});

test('orchestrator from the manifest is first-class and workers exclude it (acceptance 1)', async () => {
    const { api, dispose } = await start();
    const { snapshot } = await api.command('get-state');
    assert.deepEqual(snapshot.orchestrator, { paneID: 'orch', label: 'coordinator', source: 'manifest' });
    assert.deepEqual(snapshot.workers.map(w => w.paneID).sort(), ['w1', 'w2']);
    assert.equal(snapshot.workspaceID, 'ws1');
    dispose();
});

test('no manifest: orchestrator falls back to the coordinator label, then to the pin', async () => {
    const byLabel = makeFakeApi({
        workspaces: [{ id: 'ws1', name: 'S' }],
        panes: [{ id: 'c', label: 'coordinator', workspaceID: 'ws1' }, { id: 'p', label: 'x', workspaceID: 'ws1' }]
    });
    const d1 = registerAll(byLabel);
    await d1.ready;
    let state = (await byLabel.command('get-state')).snapshot;
    assert.deepEqual(state.orchestrator, { paneID: 'c', label: 'coordinator', source: 'label' });
    assert.deepEqual(state.workers, []);
    assert.ok(state.warnings.some(w => /no swarm manifest/.test(w)));
    d1();

    const byPin = makeFakeApi({ workspaces: [{ id: 'ws1', name: 'S' }], panes: [{ id: 'p', label: 'x', workspaceID: 'ws1' }] });
    const d2 = registerAll(byPin);
    await d2.ready;
    assert.equal((await byPin.command('get-state')).snapshot.orchestrator, null);
    const pinned = await byPin.command('pin-orchestrator', { paneID: 'p' });
    assert.deepEqual(pinned, { ok: true, orchestrator: { paneID: 'p', label: 'x', source: 'pin' } });
    d2();
    // the pin survives a reload
    const again = registerAll(makeFakeApi({ workspaces: [{ id: 'ws1', name: 'S' }], panes: [{ id: 'p', label: 'x', workspaceID: 'ws1' }], storage: byPin.storageMap }));
    await again.ready;
    assert.equal(again.store.orchestrator.source, 'pin');
    again();
});

test('an invalid manifest becomes a warning and the label fallback still works', async () => {
    const api = makeFakeApi({
        workspaces: [{ id: 'ws1', name: 'S' }],
        panes: [{ id: 'c', label: 'coordinator', workspaceID: 'ws1' }],
        files: { '/m/ws1.json': '{"version":1}' }
    });
    const d = registerAll(api);
    await d.ready;
    const { snapshot } = await api.command('get-state');
    assert.ok(snapshot.warnings.some(w => w.startsWith('manifest:')));
    assert.equal(snapshot.orchestrator.source, 'label');
    d();
});

test('the manifest is found in a later workspace when an earlier one also has a coordinator pane (integration S2)', async () => {
    const api = makeFakeApi({
        workspaces: [{ id: 'ws0', name: 'Old' }, { id: 'ws1', name: 'Swarm' }],
        panes: [
            { id: 'old-c', label: 'coordinator', workspaceID: 'ws0' },
            { id: 'orch', label: 'coordinator', workspaceID: 'ws1' },
            { id: 'w1', label: 'a', workspaceID: 'ws1', status: 'running' }
        ],
        files: {}
    });
    const d = registerAll(api);
    await d.ready;
    // no manifest yet: the label picks the first coordinator pane, so the swarm workspace is remembered as ws0
    assert.equal((await api.command('get-state')).snapshot.workspaceID, 'ws0');
    api.fileStore['/m/ws1.json'] = JSON.stringify({ version: 1, orchestrator: { paneID: 'orch', label: 'coordinator' }, workers: [{ paneID: 'w1', label: 'a', task: 't', resultPath: null, worktreePath: null, parent: null }] });
    await sleep(2100); // get-state re-reads the manifest at most every 2 seconds
    const { snapshot } = await api.command('get-state');
    assert.deepEqual(snapshot.orchestrator, { paneID: 'orch', label: 'coordinator', source: 'manifest' });
    assert.equal(snapshot.workspaceID, 'ws1');
    assert.deepEqual(snapshot.workers.map(w => w.paneID), ['w1']);
    d();
});

test('removing the manifest falls back to the coordinator label (integration S2)', async () => {
    const api = makeSwarmApi();
    const d = registerAll(api);
    await d.ready;
    assert.equal((await api.command('get-state')).snapshot.orchestrator.source, 'manifest');
    delete api.fileStore['/m/ws1.json'];
    await sleep(2100); // get-state re-reads the manifest at most every 2 seconds
    const { snapshot } = await api.command('get-state');
    assert.equal(snapshot.orchestrator.source, 'label');
    assert.deepEqual(snapshot.workers, []);
    d();
});

test('status bar counts update on every snapshot (acceptance 8)', async () => {
    const { api, dispose } = await start();
    const initial = api.statusUpdates.at(-1).items[COUNTS_ITEM];
    assert.equal(initial.text, 'Swarm 0/2/0');
    assert.equal(initial.tone, 'info');
    await api.upsert('w1', { status: 'waitingForInput' });
    const waiting = api.statusUpdates.at(-1).items[COUNTS_ITEM];
    assert.equal(waiting.text, 'Swarm 1/1/0');
    assert.equal(waiting.tone, 'warning');
    assert.equal(waiting.badge, '1');
    assert.equal(lastSnapshot(api).counts.waiting, 1, 'same snapshot is pushed to views');
    assert.equal(countsPatch({ waiting: 0, running: 0, finished: 2 }, true).tone, 'error');
    assert.equal(countsPatch({ waiting: 0, running: 0, finished: 2 }, false).tone, 'default');
    dispose();
});

test('snapshots pushed to views have strictly increasing sequences', async () => {
    const { api, dispose } = await start();
    await api.upsert('w1', { status: 'waitingForInput' });
    await api.upsert('w1', { status: 'running' });
    const seqs = api.emitted.filter(e => e.name === SNAPSHOT_EVENT).map(e => e.data.sequence);
    assert.ok(seqs.length >= 3);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    dispose();
});

test('a worker that writes its result becomes done and raises a Complete item that stays until handled (acceptance 2, 3)', async () => {
    const { api, dispose } = await start();
    api.fileStore['/wt/w1/result.md'] = '## Goal\nx\n';
    await api.upsert('w1', { status: 'waitingForInput' });
    let snap = lastSnapshot(api);
    assert.equal(snap.workers.find(w => w.paneID === 'w1').state, 'done');
    assert.equal(snap.counts.finished, 1);
    const item = snap.attention.find(i => i.type === 'Complete');
    assert.ok(item);
    await api.upsert('w2', { status: 'running' });
    assert.ok(lastSnapshot(api).attention.some(i => i.id === item.id), 'still there after unrelated events');
    assert.deepEqual(await api.command('clear-attention', { itemID: item.id }), { ok: true, itemID: item.id });
    assert.equal(lastSnapshot(api).attention.length, 0);
    dispose();
});

test('a closed worker with no result raises an Error item', async () => {
    const { api, dispose } = await start();
    // the workers were auto-hidden, so the removal is reported at the hidden workspace
    const hiddenID = api.paneList.find(p => p.id === 'w2').workspaceID;
    assert.notEqual(hiddenID, 'ws1');
    await api.fire('state.changed', { sequence: 500, data: [{ kind: 'pane-removed', workspaceID: hiddenID, paneID: 'w2' }] });
    const snap = lastSnapshot(api);
    assert.equal(snap.workers.find(w => w.paneID === 'w2').state, 'error');
    assert.ok(snap.attention.some(i => i.type === 'Error' && i.paneID === 'w2'));
    assert.equal(api.statusUpdates.at(-1).items[COUNTS_ITEM].tone, 'error', 'error outranks running when nothing is waiting');
    dispose();
});

test('duplicate or old state.changed sequences are ignored', async () => {
    const { api, dispose } = await start();
    const before = api.emitted.length;
    await api.fire('state.changed', { sequence: 1, data: [{ kind: 'pane-upserted', workspaceID: 'ws1', paneID: 'w1', pane: { id: 'w1', status: 'waitingForInput' } }] });
    assert.equal(api.emitted.length, before);
    dispose();
});

test('notification -> Request with command -> approve sends Enter to that pane (acceptance 7)', async () => {
    const { api, dispose } = await start({ captures: { w1: PROMPT_TEXT } });
    await api.upsert('w1', { status: 'waitingForInput' });
    await api.fire('daemon.notification', { name: 'daemon.notification', data: { kind: 'agent-notification', paneID: 'w1', workspaceID: 'ws1', title: 'Claude', body: 'needs permission' } });
    const request = lastSnapshot(api).attention.find(i => i.type === 'Request');
    assert.equal(request.command, 'rm -rf node_modules && npm ci\nReinstall dependencies');
    assert.match(request.promptHash, /^[0-9a-f]{64}$/);
    assert.equal((await api.command('approve', { itemID: request.id })).code, 'BAD_ARGS', 'hash missing from the call');
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    const result = await api.command('approve', { itemID: request.id, promptHash: request.promptHash });
    assert.deepEqual(result, { ok: true, itemID: request.id });
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['w1', 'enter']]);
    assert.equal(lastSnapshot(api).attention.some(i => i.type === 'Request'), false);
    dispose();
});

test('a Request is settled when the worker is answered in its own terminal', async () => {
    const { api, dispose } = await start({ captures: { w1: PROMPT_TEXT } });
    await api.upsert('w1', { status: 'waitingForInput' });
    await api.fire('daemon.notification', { data: { kind: 'agent-notification', paneID: 'w1', body: 'x' } });
    assert.equal(lastSnapshot(api).attention.length, 1);
    await api.upsert('w1', { status: 'running' });
    assert.equal(lastSnapshot(api).attention.length, 0);
    dispose();
});

test('snooze via command hides the item, and a reload re-arms it (acceptance 3, 4)', async () => {
    const storage = new Map();
    const first = await start({ storage, captures: { w1: PROMPT_TEXT } });
    await first.api.upsert('w1', { status: 'waitingForInput' });
    await first.api.fire('daemon.notification', { data: { kind: 'agent-notification', paneID: 'w1', body: 'x' } });
    const item = lastSnapshot(first.api).attention[0];
    const res = await first.api.command('snooze', { itemID: item.id, minutes: 15 });
    assert.equal(res.ok, true);
    assert.ok(Date.parse(res.snoozedUntil) > Date.now() + 14 * 60000);
    assert.equal(lastSnapshot(first.api).attention.length, 0);
    assert.equal(lastSnapshot(first.api).snoozed.length, 1);
    first.dispose();

    // reload with a snooze that is due very soon: rewrite the stored due time, then re-activate
    const stored = storage.get('attention');
    stored[0].snoozedUntil = new Date(Date.now() + 100).toISOString();
    storage.set('attention', stored);
    const second = await start({ storage, captures: { w1: PROMPT_TEXT }, w1Status: 'waitingForInput' });
    assert.equal(lastSnapshot(second.api).snoozed.length, 1, 'still snoozed straight after reload');
    await sleep(250);
    const snap = lastSnapshot(second.api);
    assert.equal(snap.attention.length, 1, 'item returned on time and a snapshot was pushed');
    assert.equal(snap.snoozed.length, 0);
    second.dispose();
});

test('snooze defaults to the snoozeMinutes setting and validates input', async () => {
    const { api, dispose } = await start({ settings: { snoozeMinutes: 5 }, captures: { w1: PROMPT_TEXT } });
    await api.upsert('w1', { status: 'waitingForInput' });
    await api.fire('daemon.notification', { data: { kind: 'agent-notification', paneID: 'w1', body: 'x' } });
    const id = lastSnapshot(api).attention[0].id;
    assert.equal((await api.command('snooze', { itemID: id, minutes: -1 })).code, 'BAD_ARGS');
    assert.equal((await api.command('snooze', {})).code, 'BAD_ARGS');
    assert.equal((await api.command('snooze', { itemID: 'nope' })).code, 'NOT_FOUND');
    const ok = await api.command('snooze', { itemID: id });
    const minutes = (Date.parse(ok.snoozedUntil) - Date.now()) / 60000;
    assert.ok(minutes > 4.9 && minutes <= 5.01);
    dispose();
});

test('collapse via index: only manifest workers move; orchestrator and unknown panes stay (acceptance 9)', async () => {
    const { api, dispose } = await start();
    const moves = api.callsTo('panes.moveToWorkspace').map(c => c.args[0]).sort();
    assert.deepEqual(moves, ['w1', 'w2']);
    assert.equal(api.paneList.find(p => p.id === 'orch').workspaceID, 'ws1');
    assert.equal(api.paneList.find(p => p.id === 'stranger').workspaceID, 'ws1');
    const hidden = api.workspaceList.find(w => w.name === 'Workers');
    assert.ok(hidden);
    assert.equal(api.paneList.find(p => p.id === 'w1').workspaceID, hidden.id);
    const snap = lastSnapshot(api);
    assert.ok(snap.workers.every(w => w.hidden), 'snapshot marks them hidden');
    // later events address the worker by pane id even though it lives in another workspace
    await api.upsert('w1', { status: 'waitingForInput' });
    assert.equal(lastSnapshot(api).workers.find(w => w.paneID === 'w1').state, 'waiting');
    const reads = api.callsTo('terminal.capture').filter(c => c.args[0] === 'w1');
    assert.ok(reads.length >= 1);
    // a brand-new unknown pane is never moved
    await api.upsert('late-stranger', { status: 'running', workspaceID: 'ws1' });
    assert.equal(api.callsTo('panes.moveToWorkspace').some(c => c.args[0] === 'late-stranger'), false);
    dispose();
});

test('collapse is skipped when the setting is off', async () => {
    const { api, dispose } = await start({ settings: { autoHide: false } });
    assert.equal(api.callsTo('panes.moveToWorkspace').length, 0);
    assert.equal(api.callsTo('workspaces.create').length, 0);
    dispose();
});

test('archive and accept via commands report refusals and never call destructive APIs', async () => {
    const { api, dispose } = await start({ gitStatus: { '/wt/w1': { kind: 'dirty', changedFiles: 1, additions: 1, deletions: 0 } } });
    api.fileStore['/wt/w1/result.md'] = '## Goal\nx';
    await api.upsert('w1', { status: 'waitingForInput' });
    const refused = await api.command('archive', { paneID: 'w1' });
    assert.deepEqual([refused.ok, refused.code], [false, 'DIRTY']);
    const accepted = await api.command('accept', { paneID: 'w1' });
    assert.equal(accepted.ok, true);
    assert.equal(lastSnapshot(api).workers.find(w => w.paneID === 'w1').accepted, true);
    assert.equal((await api.command('archive', {})).code, 'BAD_ARGS');
    assert.deepEqual(api.destructive, []);
    dispose();
});

test('read-result, capture-worker and open-thread', async () => {
    const { api, dispose } = await start({ files: { '/wt/w1/result.md': '## Goal\nG\n## Done\nD\n## Next\nN\n' } });
    const result = await api.command('read-result', { paneID: 'w1' });
    assert.deepEqual(result.summary, { goal: 'G', done: 'D', next: 'N' });
    assert.equal((await api.command('read-result', { paneID: 'w2' })).code, 'NO_RESULT');
    assert.deepEqual(await api.command('capture-worker', { paneID: 'w2' }), { ok: true, text: 'writing tests' });
    const opened = await api.command('open-thread', { paneID: 'w1' });
    assert.equal(opened.ok, true);
    assert.equal(opened.viewPaneID, 'view-pane');
    const call = api.callsTo('openView').at(-1);
    assert.equal(call.args[0], 'local.swarm-view.thread');
    assert.deepEqual(call.args[1].state, { paneID: 'w1' });
    assert.equal((await api.command('open-thread', { paneID: 'stranger' })).code, 'NOT_WORKER');
    assert.equal((await api.command('focus-rail')).ok, true);
    dispose();
});

test('open-thread keeps one thread pane: the previous one it opened is closed first', async () => {
    const { api, dispose } = await start({ allowClose: true, files: { '/wt/w1/result.md': '## Goal\nG\n' } });
    assert.equal((await api.command('open-thread', { paneID: 'w1' })).ok, true);
    assert.equal(api.callsTo('panes.close').length, 0, 'nothing to close the first time');
    assert.equal((await api.command('open-thread', { paneID: 'w2' })).ok, true);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['view-pane']]);
    assert.equal(api.callsTo('openView').length, 2);
    dispose();
});

test('close-worker command closes a worker pane and refuses a stranger', async () => {
    const { api, dispose } = await start({ allowClose: true });
    assert.equal((await api.command('close-worker', { paneID: 'stranger' })).code, 'NOT_WORKER');
    assert.equal((await api.command('close-worker', {})).code, 'BAD_ARGS');
    assert.equal((await api.command('close-worker', { paneID: 'w2' })).ok, true);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['w2']]);
    dispose();
});

const OTHER = { otherWorkspaces: [{ id: 'ws2', name: 'Elsewhere' }], otherPanes: [{ id: 'o-shell', label: 'my-other-shell', workspaceID: 'ws2', status: 'idle' }] };

test('the rail follows the workspace it is told about: a workspace with no swarm shows no swarm', async () => {
    const { api, dispose } = await start(OTHER);
    const home = await api.command('get-state', { workspaceID: 'ws1' });
    assert.deepEqual([home.snapshot.workspaceID, home.snapshot.workers.length], ['ws1', 2]);
    const elsewhere = await api.command('get-state', { workspaceID: 'ws2' });
    assert.equal(elsewhere.snapshot.workspaceID, 'ws2');
    assert.equal(elsewhere.snapshot.workers.length, 0);
    assert.equal(elsewhere.snapshot.orchestrator, null);
    const back = await api.command('get-state', { workspaceID: 'ws1' });
    assert.deepEqual([back.snapshot.workspaceID, back.snapshot.workers.length], ['ws1', 2]);
    dispose();
});

test('the hidden workers workspace counts as its swarm workspace, and an unknown id is ignored', async () => {
    const { api, dispose } = await start({ otherWorkspaces: [{ id: 'hw', name: 'Swarm · workers' }] });
    const viaWorkers = await api.command('get-state', { workspaceID: 'hw' });
    assert.equal(viaWorkers.snapshot.workspaceID, 'ws1');
    assert.equal(viaWorkers.snapshot.workers.length, 2);
    const unknown = await api.command('get-state', { workspaceID: 'nope' });
    assert.equal(unknown.snapshot.workspaceID, 'ws1');
    dispose();
});

test('attention from another swarm is not shown once the rail follows a workspace', async () => {
    const { api, dispose } = await start(OTHER);
    await api.command('get-state', { workspaceID: 'ws1' });
    const elsewhere = await api.command('get-state', { workspaceID: 'ws2' });
    assert.deepEqual(elsewhere.snapshot.attention, []);
    dispose();
});

const GROUPED = {
    swarmGroup: 'g1',
    otherWorkspaces: [{ id: 'ws3', name: 'Notes', groupID: 'g1' }, { id: 'ws2', name: 'Elsewhere', groupID: 'g2' }],
    otherPanes: [{ id: 'n-shell', workspaceID: 'ws3', status: 'idle' }, { id: 'o-shell', workspaceID: 'ws2', status: 'idle' }]
};

test('the shared Workers workspace is created in the Workers Group, not the swarm Group', async () => {
    const { api, dispose } = await start({ swarmGroup: 'g1' });
    const created = api.callsTo('workspaces.create').map(c => c.args[0]);
    assert.deepEqual(created, [{ name: 'Workers', groupID: 'g-created-1' }]);
    assert.equal(api.callsTo('workspaces.moveMany').length, 0);
    dispose();
});

test('workers in an old "<name> · workers" workspace move to the shared Workers workspace, and the rail still shows them', async () => {
    const api = makeSwarmApi({ swarmGroup: 'g1', otherWorkspaces: [{ id: 'hw', name: 'Swarm · workers', groupID: 'g1' }] });
    api.paneList.find(p => p.id === 'w1').workspaceID = 'hw';
    const dispose = registerAll(api);
    await dispose.ready;
    await api.idle();
    const shared = api.workspaceList.find(w => w.name === 'Workers');
    assert.equal(api.paneList.find(p => p.id === 'w1').workspaceID, shared.id);
    assert.equal(lastSnapshot(api).workers.length, 2);
    dispose();
});

test('any workspace in the swarm Group shows the swarm; another Group shows none', async () => {
    const { api, dispose } = await start(GROUPED);
    const sibling = await api.command('get-state', { workspaceID: 'ws3' });
    assert.deepEqual([sibling.snapshot.workspaceID, sibling.snapshot.workers.length], ['ws1', 2]);
    const other = await api.command('get-state', { workspaceID: 'ws2' });
    assert.deepEqual([other.snapshot.workspaceID, other.snapshot.workers.length], ['ws2', 0]);
    const back = await api.command('get-state', { workspaceID: 'ws3' });
    assert.equal(back.snapshot.workers.length, 2);
    dispose();
});

test('focus-rail emits the single focus-rail event', async () => {
    const { api, dispose } = await start();
    const before = api.emitted.length;
    assert.equal((await api.command('focus-rail')).ok, true);
    assert.deepEqual(api.emitted.slice(before).map(e => e.name), ['focus-rail']);
    dispose();
});

test('capture-worker, send-to-worker and open-result refuse panes that are not manifest workers', async () => {
    const { api, dispose } = await start();
    for (const paneID of ['stranger', 'orch', 'nope']) {
        assert.equal((await api.command('capture-worker', { paneID })).code, 'NOT_WORKER', paneID);
        assert.equal((await api.command('send-to-worker', { paneID, text: 'hi' })).code, 'NOT_WORKER', paneID);
        assert.equal((await api.command('open-result', { paneID })).code, 'NOT_WORKER', paneID);
        assert.equal((await api.command('read-result', { paneID })).code, 'NOT_WORKER', paneID);
    }
    assert.equal((await api.command('send-to-worker', { text: 'hi' })).code, 'BAD_ARGS');
    assert.equal(api.callsTo('terminal.send').length, 0);
    assert.equal(api.callsTo('files.open').length, 0);
    dispose();
});

test('send-to-worker sends to the worker and open-result opens only its manifest resultPath', async () => {
    const { api, dispose } = await start({ captures: { w1: ['─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n') } });
    assert.deepEqual(await api.command('send-to-worker', { paneID: 'w1', text: 'please fix' }), { ok: true, paneID: 'w1' });
    api.fileStore['/wt/w1/result.md'] = '## Goal\nx\n';
    assert.deepEqual(api.callsTo('terminal.send').map(c => c.args), [['w1', 'please fix']]);
    assert.deepEqual(await api.command('open-result', { paneID: 'w1', path: '/etc/passwd' }), { ok: true, path: '/wt/w1/result.md' });
    assert.deepEqual(api.callsTo('files.open').map(c => c.args[0]), ['/wt/w1/result.md']);
    dispose();
});

test('dispose stops event handling', async () => {
    const { api, dispose } = await start();
    dispose();
    const before = api.emitted.length;
    await api.upsert('w1', { status: 'waitingForInput' });
    assert.equal(api.emitted.length, before);
});


test('central Codex commands expose exact session-to-pane mappings and forward answers without terminal keys', async () => {
    const api = makeFakeApi({ workspaces: [{ id: 'ws1', name: 'S' }], panes: [
        { id: 'p', label: 'My Codex', workspaceID: 'ws1', agent: 'codex', agentSessionID: 'thread-a' }
    ] });
    let disposed = false, answered = null;
    const request = { requestID: 7, threadID: 'thread-a', questions: [{ id: 'q', question: 'Choose?' }] };
    const dispose = registerAll(api, { ...modules, createCodexQuestions: () => ({
        async refresh() {}, list: () => [request, { ...request, requestID: 8, threadID: 'unmapped' }],
        async answer(args) { answered = args; return { ok: true }; }, dispose() { disposed = true; }
    }) });
    try {
        await dispose.ready;
        assert.equal((await api.command('answer-codex-question', {})).ok, false);
        assert.equal((await api.command('load-codex-questions')).ok, true);
        const snapshot = (await api.command('get-state')).snapshot;
        assert.equal(snapshot.codexQuestions[0].paneID, 'p');
        assert.equal(snapshot.codexQuestions[1].paneID, undefined);
        const args = { requestID: 7, threadID: 'thread-a', answers: { q: { answers: ['Proceed'] } } };
        assert.equal((await api.command('answer-codex-question', args)).ok, true);
        assert.deepEqual(answered, args);
    } finally { dispose(); }
    assert.equal(disposed, true);
});
