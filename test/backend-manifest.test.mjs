import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifestPath, validateManifest, readManifest, resolveOrchestrator } from '../backend/manifest.mjs';
import { makeFakeApi, MANIFEST } from './backend-fake-api.mjs';

const example = JSON.parse(readFileSync(new URL('../contracts/examples/manifest.example.json', import.meta.url), 'utf8'));

test('manifestPath: default dir, manifestDir override, unsafe ids rejected', () => {
    assert.equal(manifestPath('ws1', '/home/u'), '/home/u/.kelpi-swarm/ws1.json');
    assert.equal(manifestPath('ws1', '/home/u', '/custom'), '/custom/ws1.json');
    assert.equal(manifestPath('../etc', '/home/u'), null);
    assert.equal(manifestPath('a/b', '/home/u'), null);
    assert.equal(manifestPath('', '/home/u'), null);
});

test('validateManifest accepts the contract example', () => {
    assert.equal(validateManifest(example).ok, true);
});

test('validateManifest rejects schema violations', () => {
    const bad = (mutate) => {
        const copy = structuredClone(MANIFEST);
        mutate(copy);
        return validateManifest(copy);
    };
    assert.equal(bad(m => { m.version = 2; }).ok, false);
    assert.equal(bad(m => { m.extra = 1; }).ok, false);
    assert.equal(bad(m => { delete m.workers; }).ok, false);
    assert.equal(bad(m => { m.orchestrator.label = ''; }).ok, false);
    assert.equal(bad(m => { delete m.workers[0].parent; }).ok, false);
    assert.equal(bad(m => { m.workers[0].resultPath = 5; }).ok, false);
    assert.equal(bad(m => { m.workers[0].unknown = 'x'; }).ok, false);
    assert.equal(bad(m => { m.workers[1].paneID = 'w1'; }).ok, false, 'duplicate worker pane');
    assert.equal(bad(m => { m.workers[0].paneID = 'orch'; }).ok, false, 'orchestrator listed as worker');
    assert.equal(validateManifest(null).ok, false);
    assert.equal(validateManifest([]).ok, false);
});

test('validateManifest rejects traversal, relative and NUL paths and hostile labels', () => {
    const bad = mutate => { const copy = structuredClone(MANIFEST); mutate(copy); return validateManifest(copy); };
    assert.equal(bad(m => { m.workers[0].resultPath = '../../etc/passwd'; }).ok, false);
    assert.equal(bad(m => { m.workers[0].resultPath = '/r/../../etc/passwd'; }).ok, false);
    assert.equal(bad(m => { m.workers[0].resultPath = 'relative/result.md'; }).ok, false);
    assert.equal(bad(m => { m.workers[0].resultPath = '/r/a\u0000.md'; }).ok, false);
    assert.equal(bad(m => { m.workers[0].worktreePath = '/wt/../../x'; }).ok, false);
    assert.equal(bad(m => { m.workers[0].resultPath = '/r/ok.md'; }).ok, true);
    for (const label of ['a\nb', 'a`id`', 'a$(id)', 'a\u001b[0m', 'x'.repeat(41)]) {
        assert.equal(bad(m => { m.workers[0].label = label; }).ok, false, JSON.stringify(label));
        assert.equal(bad(m => { m.orchestrator.label = label; }).ok, false, JSON.stringify(label));
    }
    assert.equal(bad(m => { m.workers[0].label = 'repo lag_1.x-y'; }).ok, true);
});

test('readManifest: ok, missing, invalid json, invalid schema', async () => {
    const api = makeFakeApi({ files: { '/m/ok.json': JSON.stringify(MANIFEST), '/m/junk.json': '{nope', '/m/bad.json': '{"version":1}' } });
    const ok = await readManifest(api, '/m/ok.json');
    assert.equal(ok.ok, true);
    assert.equal(ok.manifest.workers.length, 2);
    const missing = await readManifest(api, '/m/none.json');
    assert.deepEqual([missing.ok, missing.missing, missing.code], [false, true, 'MISSING']);
    const junk = await readManifest(api, '/m/junk.json');
    assert.deepEqual([junk.ok, junk.missing, junk.code], [false, false, 'INVALID']);
    const bad = await readManifest(api, '/m/bad.json');
    assert.deepEqual([bad.ok, bad.code], [false, 'INVALID']);
});

const panes = [
    { id: 'm-orch', label: 'coordinator', workspaceID: 'ws1' },
    { id: 'lab', label: 'coordinator', workspaceID: 'ws2' },
    { id: 'pinned', label: 'whatever', workspaceID: 'ws1' }
];

test('resolveOrchestrator: manifest first, then label, then pin (acceptance 1)', () => {
    const manifest = { orchestrator: { paneID: 'm-orch', label: 'boss' } };
    const model = { panes, workspaceID: 'ws2' };
    assert.deepEqual(resolveOrchestrator(model, manifest, {}, 'pinned'), { paneID: 'm-orch', label: 'boss', source: 'manifest' });
    // manifest names a pane that no longer exists: fall back to the label, preferring the swarm workspace
    const stale = { orchestrator: { paneID: 'gone', label: 'x' } };
    assert.deepEqual(resolveOrchestrator(model, stale, {}, 'pinned'), { paneID: 'lab', label: 'coordinator', source: 'label' });
    assert.deepEqual(resolveOrchestrator(model, null, { coordinatorLabel: 'coordinator' }, 'pinned').source, 'label');
    // no manifest and no labelled pane: the pin
    const noLabel = { panes: [panes[2]], workspaceID: 'ws1' };
    assert.deepEqual(resolveOrchestrator(noLabel, null, {}, 'pinned'), { paneID: 'pinned', label: 'whatever', source: 'pin' });
    assert.equal(resolveOrchestrator(noLabel, null, {}, 'missing-pane'), null);
    assert.equal(resolveOrchestrator(noLabel, null, {}, null), null);
});

test('resolveOrchestrator honours a custom coordinatorLabel and accepts a Map', () => {
    const map = new Map([['a', { id: 'a', label: 'boss', workspaceID: 'w' }], ['b', { id: 'b', label: 'coordinator', workspaceID: 'w' }]]);
    assert.equal(resolveOrchestrator({ panes: map }, null, { coordinatorLabel: 'boss' }, null).paneID, 'a');
});
