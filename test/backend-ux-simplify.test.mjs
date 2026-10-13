// Rail simplification: the backend additions the simpler rail needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

const { registerAll } = await import('../backend/index.mjs');

test('close-thread closes only the thread pane this plugin opened, and is ok with nothing open', async () => {
    const api = makeSwarmApi({ allowClose: true, files: { '/wt/w1/result.md': '## Goal\nG\n' } });
    const dispose = registerAll(api);
    await dispose.ready;
    assert.deepEqual(await api.command('close-thread', {}), { ok: true, closedViewPaneID: null }, 'nothing open: still ok');
    assert.equal(api.callsTo('panes.close').length, 0);
    assert.equal((await api.command('open-thread', { paneID: 'w1' })).ok, true);
    assert.deepEqual(await api.command('close-thread', {}), { ok: true, closedViewPaneID: 'view-pane' });
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['view-pane']], 'only the thread pane it opened');
    assert.deepEqual(await api.command('close-thread', {}), { ok: true, closedViewPaneID: null }, 'the closed pane is forgotten');
    assert.equal(api.callsTo('panes.close').length, 1);
    // Arguments are ignored: it can never be pointed at another pane.
    assert.deepEqual(await api.command('close-thread', { paneID: 'orch' }), { ok: true, closedViewPaneID: null });
    assert.equal(api.callsTo('panes.close').length, 1);
    dispose();
});
