import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCandidates, createAgentMaintenance, recheckCompleted } from '../backend/maintenance.mjs';
import { createStore, applyStateChange } from '../backend/store.mjs';
import { createAttention } from '../backend/attention.mjs';
import { autoClean } from '../backend/workers.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';

const session = '09db8710-7474-428d-89c5-715b196bfc97';
const shell = { type: 'shell', workingDirectory: '/wt/w1', workspaceID: 'ws1', status: 'idle', agent: null };
const rule = '─'.repeat(60);
const empty = [rule, '❯ ', rule, '[Opus] | /wt/w1'].join('\n');

function setup(panes, opts = {}) {
    const api = makeFakeApi({ panes, allowClose: true, ...opts });
    const store = createStore(api);
    createAttention(api, store);
    store.workspaceID = 'ws1';
    store.settings = { ...store.settings, worktreeRoots: ['/wt'], autoCleanMinutes: 0 };
    for (const pane of panes) applyStateChange(store, { kind: 'pane-upserted', paneID: pane.id, pane });
    return { api, store };
}

test('Clean closes only the result-backed worker that is still idle and leaves result and other panes intact', async () => {
    const panes = ['good', 'draft', 'dirty', 'started', 'coordinator', 'shell-draft', 'foreground'].map(id => ({ id, ...shell, workingDirectory: `/wt/${id}` }));
    const files = Object.fromEntries(panes.map(pane => [`${pane.workingDirectory}/result.md`, '# Goal\nFinished']));
    const { api, store } = setup(panes, { files,
        gitStatus: { '/wt/good': { kind: 'clean' }, '/wt/draft': { kind: 'clean' }, '/wt/dirty': { kind: 'dirty' }, '/wt/started': { kind: 'clean' }, '/wt/shell-draft': { kind: 'clean' }, '/wt/foreground': { kind: 'clean' } }
    });
    store.orchestrator = { paneID: 'coordinator' };
    store.manifestWorkers = panes.map(pane => ({ paneID: pane.id, label: pane.id,
        resultPath: `${pane.workingDirectory}/result.md`, worktreePath: pane.workingDirectory }));
    for (const pane of panes) store.resultExists.set(pane.id, true);
    api.terminal.read = async id => ({ text: id === 'draft' ? empty.replace('❯ ', '❯ unsent text') : id === 'shell-draft' ? 'sh-3.2$ git status' : id === 'foreground' ? 'server listening on :3000' : 'sh-3.2$ ', altScreen: id === 'draft' });
    api.paneList.find(pane => pane.id === 'draft').agent = 'claude';
    api.paneList.find(pane => pane.id === 'started').status = 'running';
    const result = await autoClean(api, store, cleanCandidates(store), Date.now(), worker => recheckCompleted(api, store, worker));
    assert.deepEqual(result.cleaned, ['good']);
    assert.deepEqual(result.kept.map(pane => pane.paneID), ['draft', 'dirty', 'started', 'shell-draft', 'foreground']);
    assert.match(result.kept.find(pane => pane.paneID === 'dirty').error, /uncommitted changes/);
    assert.equal(result.kept.find(pane => pane.paneID === 'shell-draft').error, 'Completion or idle terminal could not be verified.');
    assert.deepEqual(api.callsTo('panes.close').map(call => call.args), [['good']]);
    assert.deepEqual(api.fileStore, files);
});

test('Update installs each tool once and rechecks the original idle session before resuming', async () => {
    const base = { ...shell, agent: 'claude', agentSessionID: session, agentStartedAt: 10 };
    const { api, store } = setup([{ id: 'idle', ...base }, { id: 'focused-after-update', ...base }, { id: 'active', ...base, status: 'running' }]);
    api.terminal.read = async () => ({ text: empty, altScreen: true });
    delete api.paneList[0].agent;
    api.paneList[0].agentKind = 'claude';
    const installed = [];
    const restarts = [];
    const service = createAgentMaintenance(api, store, async (_api, _store, id, args) => {
        restarts.push({ id, sessionID: args.maintenance.agentSessionID, executable: args.executable });
        return { finished: Promise.resolve({ ok: true, session }) };
    }, {
        installed: async agent => agent === 'claude' ? { file: '/tools/claude', time: 5, version: installed.length ? '2.1.10' : '2.1.9' } : null,
        latest: async () => '2.1.10',
        install: async file => {
            installed.push(file);
            Object.assign(api.paneList[1], { isFocused: true, isActiveWorkspace: true });
        }
    });
    await service.tick(async () => {});
    assert.equal(service.status().text, 'Update 2');
    service.request();
    await service.tick(async () => {});
    assert.deepEqual(installed, ['/tools/claude']);
    assert.deepEqual(restarts, [{ id: 'idle', sessionID: session, executable: '/tools/claude' }]);
    assert.match(service.status().tooltip, /Resumed 1 session.*session changed/);
    assert.equal(api.paneList[2].status, 'running');
});

test('Update leaves the terminal and installed version alone when the composer contains a draft', async () => {
    const { api, store } = setup([{ id: 'draft', ...shell, agent: 'claude', agentSessionID: session, agentStartedAt: 10 }]);
    api.terminal.read = async () => ({ text: empty.replace('❯ ', '❯ my draft'), altScreen: true });
    const effects = [];
    const service = createAgentMaintenance(api, store, async () => { effects.push('restart'); }, {
        installed: async agent => agent === 'claude' ? { file: '/tools/claude', time: 5, version: '2.1.9' } : null,
        latest: async () => '2.1.10',
        install: async () => { effects.push('install'); }
    });
    service.request();
    await service.tick(async () => {});
    assert.deepEqual(effects, []);
    assert.match(service.status().tooltip, /terminal is in use/);
});


test('Update drops an unavailable native release and never quits a session for it', async () => {
    const { api, store } = setup([{ id: 'idle', ...shell, agent: 'claude', agentSessionID: session, agentStartedAt: 10 }]);
    api.terminal.read = async () => ({ text: empty, altScreen: true });
    const effects = [];
    const service = createAgentMaintenance(api, store, async () => effects.push('restart'), {
        installed: async agent => agent === 'claude' ? { file: '/tools/claude', time: 5, version: '2.1.9' } : null,
        latest: async () => '2.1.10',
        install: async () => { effects.push('install'); }
    });
    service.request();
    await service.tick(async () => {});
    assert.deepEqual(effects, ['install']);
    assert.match(service.status().tooltip, /no newer native build/);
    assert.equal(service.status().text, 'Update');
    service.request();
    await service.tick(async () => {});
    assert.deepEqual(effects, ['install']);
});
