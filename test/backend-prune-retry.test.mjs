// Manifest retry fields (taskPath, model, mode, effort, dir, startedAt), auto-clean of a closed coordinator's workers,
// and the result-path policy around the results/archive folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../backend/manifest.mjs';
import { checkResultPath } from '../backend/safepath.mjs';
import { makeSwarmApi, MANIFEST } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
const { registerAll } = await import('../backend/index.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async cond => { for (let n = 0; n < 200 && !cond(); n += 1) await sleep(10); };
const MIN = 60000;

const RETRY = { taskPath: '/plans/t.md', model: 'sonnet', mode: 'auto', effort: 'high', dir: '/repos/x', startedAt: '2026-10-17T01:02:03.000Z' };
const withFields = fields => ({ ...MANIFEST, workers: [{ ...MANIFEST.workers[0], ...fields }, MANIFEST.workers[1]] });

test('validateManifest accepts the retry fields, null or absent, and an old manifest without them', () => {
    assert.deepEqual(validateManifest(withFields(RETRY)).errors, []);
    assert.deepEqual(validateManifest(withFields({ taskPath: null, model: null, mode: null, effort: null, dir: null, startedAt: null })).errors, []);
    assert.deepEqual(validateManifest(MANIFEST).errors, []);
});

test('validateManifest caps and checks the retry fields', () => {
    const errors = fields => validateManifest(withFields(fields)).errors;
    assert.deepEqual(errors({ taskPath: 'rel/t.md' }), ['manifest.workers[0].taskPath: must be an absolute path without ".." segments']);
    assert.deepEqual(errors({ dir: '/a/../b' }), ['manifest.workers[0].dir: must be an absolute path without ".." segments']);
    assert.deepEqual(errors({ taskPath: `/${'a'.repeat(1000)}` }), ['manifest.workers[0].taskPath: must be at most 1000 characters']);
    assert.deepEqual(errors({ model: 'm'.repeat(41) }), ['manifest.workers[0].model: must be at most 40 characters']);
    assert.deepEqual(errors({ mode: 5 }), ['manifest.workers[0].mode: must be a string or null']);
    assert.deepEqual(errors({ startedAt: 'yesterday' }), ['manifest.workers[0].startedAt: must be an ISO time']);
    assert.deepEqual(errors({ effort: 'ultra' }), ['manifest.workers[0].effort: must be one of low, medium, high, xhigh, max']);
    assert.deepEqual(errors({ effort: 3 }), ['manifest.workers[0].effort: must be a string or null']);
    assert.deepEqual(errors({ finishedAt: '2026-10-17T01:02:03Z' }), ['manifest.workers[0]: unexpected property "finishedAt"']);
});

const DEAD = {
    version: 1,
    orchestrator: { paneID: 'orchD', label: 'coordinator' },
    workers: [
        { paneID: 'd1', label: 'closed-one', task: 'a', resultPath: null, worktreePath: null, parent: null },
        { paneID: 'd2', label: 'still-open', task: 'b', resultPath: null, worktreePath: null, parent: null }
    ]
};

/** ws1 is followed; ws2 ("Dead") has a manifest whose coordinator pane is gone. d1's pane is closed, d2's is still open. */
function makeApi(extra = {}) {
    return makeSwarmApi({
        otherWorkspaces: [{ id: 'ws2', name: 'Dead' }],
        otherPanes: [{ id: 'd2', label: 'still-open', workspaceID: 'ws2', status: 'running' }],
        files: { '/m/ws2.json': JSON.stringify(DEAD) },
        captures: { d2: 'working' },
        allowClose: true,
        ...extra
    });
}

test('auto-clean tidies the closed workers of a closed coordinator after the delay, and leaves an open pane alone', async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    const st = dispose.store;
    await until(() => st.doneSince.has('d1'));
    assert.ok(st.doneSince.has('d1'), 'the closed worker is timed');
    assert.equal(st.doneSince.has('d2'), false, 'an open pane is not finished');
    assert.equal(st.archived.has('d1'), false, 'not before the delay');
    st.doneSince.set('d1', Date.now() - 11 * MIN);
    await until(() => st.archived.has('d1'));
    assert.ok(st.archived.has('d1'));
    assert.equal(st.archived.has('d2'), false);
    assert.deepEqual(api.callsTo('panes.close'), [], 'no pane is closed');
    assert.deepEqual(st.swarms.map(s => s.workspaceID), ['ws1'], 'the closed coordinator\'s swarm is still not shown');
    const snapshot = await api.command('get-state', { workspaceID: 'ws1' });
    assert.deepEqual(snapshot.otherSwarms ?? [], [], 'and not counted anywhere');
    dispose();
});

test('autoCleanMinutes 0 leaves a closed coordinator\'s workers alone', async () => {
    const api = makeApi({ settings: { autoCleanMinutes: 0 } });
    const dispose = registerAll(api);
    await dispose.ready;
    await sleep(150);
    assert.equal(dispose.store.doneSince.size, 0);
    assert.equal(dispose.store.archived.has('d1'), false);
    dispose();
});

test('a live coordinator\'s swarm is not treated as dead', async () => {
    const api = makeApi({ otherPanes: [{ id: 'orchD', label: 'coordinator', workspaceID: 'ws2' }, { id: 'd2', label: 'still-open', workspaceID: 'ws2', status: 'running' }] });
    const dispose = registerAll(api);
    await dispose.ready;
    await until(() => dispose.store.swarms.length > 1);
    assert.deepEqual(dispose.store.swarms.map(s => s.workspaceID), ['ws1', 'ws2']);
    assert.deepEqual(dispose.store.deadSwarms, []);
    dispose();
});

test('results/<label>.md and results/archive/ follow the same result-path policy, and a path outside the manifest folder is refused', async () => {
    const settings = { manifestDir: '/h/.kelpi-swarm' };
    const ok = await checkResultPath({ resultPath: '/h/.kelpi-swarm/results/w1.md' }, settings, '/h');
    assert.equal(ok.ok, true);
    const archived = await checkResultPath({ resultPath: '/h/.kelpi-swarm/results/archive/w1.20261017T010203Z.md' }, settings, '/h');
    assert.equal(archived.ok, true, 'an explicit path into the archive still passes the same policy');
    const outside = await checkResultPath({ resultPath: '/h/other/results/archive/w1.md' }, settings, '/h');
    assert.equal(outside.code, 'BAD_RESULT_PATH');
});
