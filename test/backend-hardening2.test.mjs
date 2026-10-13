// Hardening pass 2: result file sink policy and manifest worker workspace scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, applyStateChange } from '../backend/store.mjs';
import { createAttention } from '../backend/attention.mjs';
import { openResult, readResult } from '../backend/actions.mjs';
import { checkResultPath, worktreeTrustRoots } from '../backend/safepath.mjs';
import { resultContext } from '../backend/store.mjs';
import { registerAll } from '../backend/index.mjs';
import { makeFakeApi, makeSwarmApi, MANIFEST } from './backend-fake-api.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-sink-')));
const ws = join(root, 'ws');
const work = join(ws, 'wt');
const outside = join(root, 'outside');
mkdirSync(ws);
mkdirSync(work);
mkdirSync(outside);
writeFileSync(join(work, 'result.md'), '# Goal\nok');
writeFileSync(join(work, 'result.pem'), 'key');
writeFileSync(join(outside, 'secret.md'), 'secret');
writeFileSync(join(outside, 'secret.pem'), 'secret');
symlinkSync(outside, join(work, 'linkdir'));
symlinkSync(join(outside, 'secret.md'), join(work, 'link.md'));
symlinkSync(join(work, 'result.pem'), join(work, 'disguised.md'));

function setup(resultPath, extra = {}) {
    const api = makeFakeApi({ files: { [resultPath]: '# Goal\nx' } });
    const store = createStore(api);
    createAttention(api, store);
    store.settings = { manifestDir: join(ws, 'm'), worktreeRoots: [ws], ...(extra.settings ?? {}) };
    store.manifestWorkers = [{ ...MANIFEST.workers[0], resultPath, worktreePath: 'worktreePath' in extra ? extra.worktreePath : work }];
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: 'w1', pane: { id: 'w1', status: 'idle', workingDirectory: 'cwd' in extra ? extra.cwd : (extra.worktreePath ?? work) } });
    return { api, store };
}
const refused = async (resultPath, extra) => {
    const { api, store } = setup(resultPath, extra);
    for (const run of [openResult, readResult]) {
        const result = await run(api, store, 'w1');
        assert.deepEqual([result.ok, result.code], [false, 'BAD_RESULT_PATH'], `${run.name} ${resultPath}`);
    }
    assert.equal(api.callsTo('files.open').length + api.callsTo('files.read').length, 0, 'nothing reached the files service');
};

test('a result inside the worktree is opened by its real path in Kelpi (files.open), and read', async () => {
    const { api, store } = setup(join(work, 'result.md'));
    assert.deepEqual(await openResult(api, store, 'w1'), { ok: true, path: join(work, 'result.md') });
    assert.equal((await readResult(api, store, 'w1')).ok, true);
    assert.deepEqual(api.callsTo('files.open').map(c => c.args[0]), [join(work, 'result.md')]);
    assert.equal(api.destructive.length, 0);
});

test('symlinked directory pointing outside the worktree is refused', () => refused(join(work, 'linkdir', 'secret.md')));
test('symlinked file pointing outside the worktree is refused', () => refused(join(work, 'link.md')));
test('a .md symlink to a disallowed file type inside the worktree is refused', () => refused(join(work, 'disguised.md')));
test('a path outside the worktree is refused even with a good extension', () => refused(join(outside, 'secret.md')));
test('wrong extensions are refused', async () => {
    for (const name of ['result.pem', 'result.sh', 'result', 'result.md.exe', '.env']) await refused(join(work, name));
});
test('../ traversal is refused (a manifest that slipped past validation)', async () => {
    await refused(`${work}/../outside/secret.md`);
    await refused(`${work}/sub/../../outside/secret.md`);
});
test('a relative result path is refused', () => refused('result.md'));

test('without a worktree the manifest directory is the root; outside it is refused', async () => {
    const manifests = join(ws, 'm');
    mkdirSync(manifests, { recursive: true });
    writeFileSync(join(manifests, 'note.txt'), 'n');
    const { api, store } = setup(join(manifests, 'note.txt'), { worktreePath: null });
    assert.equal((await openResult(api, store, 'w1')).ok, true);
    await refused(join(outside, 'secret.md'), { worktreePath: null });
    await refused('/etc/passwd', { worktreePath: null });
    const configured = setup(join(outside, 'secret.md'), { worktreePath: null, settings: { resultRoot: outside } });
    assert.equal((await readResult(configured.api, configured.store, 'w1')).ok, true, 'a configured root is allowed');
});

test('a missing file inside the worktree is still NO_RESULT, not a policy error', async () => {
    const { api, store } = setup(join(work, 'missing.md'));
    delete api.fileStore[join(work, 'missing.md')];
    assert.equal((await checkResultPath(store.manifestWorkers[0], store.settings, undefined, resultContext(store, 'w1'))).ok, true);
    assert.equal((await readResult(api, store, 'w1')).code, 'NO_RESULT');
});

test('a worker pane in a foreign workspace is ignored and surfaced as a warning', async () => {
    const api = makeSwarmApi();
    api.paneList.find(p => p.id === 'w2').workspaceID = 'wsX';
    const dispose = registerAll(api);
    await dispose.ready;
    const { snapshot } = await api.command('get-state');
    assert.deepEqual(snapshot.workers.map(w => w.paneID), ['w1']);
    assert.ok(snapshot.warnings.some(w => /ignored 1 manifest worker.*tests/.test(w)), snapshot.warnings.join('|'));
    for (const name of ['send-to-worker', 'capture-worker', 'open-result']) {
        assert.equal((await api.command(name, { paneID: 'w2', text: 'hi' })).code, 'NOT_WORKER', name);
    }
    assert.equal(api.callsTo('terminal.send').length, 0);
    assert.ok(!api.callsTo('panes.moveToWorkspace').some(c => c.args[0] === 'w2'), 'a foreign pane is never moved');
    dispose();
});

test('a worker moved into the plugin hidden workspace stays in the swarm', async () => {
    const api = makeSwarmApi();
    const dispose = registerAll(api);
    await dispose.ready;
    const { snapshot } = await api.command('get-state');
    assert.deepEqual(snapshot.workers.map(w => w.paneID).sort(), ['w1', 'w2']);
    assert.ok(snapshot.workers.every(w => w.hidden), 'both were hidden by the plugin');
    assert.ok(!snapshot.warnings.some(w => /ignored/.test(w)));
    dispose();
});

test('worktreePath is not trusted by itself: "/", home, outside the allowed roots and escaping symlinks', async () => {
    const home = realpathSync(process.env.HOME ?? '/');
    const target = join(outside, 'secret.md');
    for (const tree of ['/', home, outside, join(ws, '..')]) {
        const { api, store } = setup(target, { worktreePath: tree });
        for (const run of [openResult, readResult]) assert.equal((await run(api, store, 'w1')).code, 'BAD_RESULT_PATH', `${run.name} ${tree}`);
        assert.equal(api.callsTo('files.open').length + api.callsTo('files.read').length, 0);
    }
    const escape = join(ws, 'escape');
    symlinkSync(outside, escape);
    const { api, store } = setup(join(escape, 'secret.md'), { worktreePath: escape });
    assert.equal((await readResult(api, store, 'w1')).code, 'BAD_RESULT_PATH', 'symlinked worktree escaping the root');
});

test('a worktree outside the allowed roots falls back to the trusted roots alone', async () => {
    mkdirSync(join(ws, 'm'), { recursive: true });
    writeFileSync(join(ws, 'm', 'note.md'), 'n');
    const { api, store } = setup(join(ws, 'm', 'note.md'), { worktreePath: outside });
    assert.equal((await readResult(api, store, 'w1')).ok, true, 'file is inside the manifest directory');
    const other = setup(join(outside, 'secret.md'), { worktreePath: outside });
    assert.equal((await readResult(other.api, other.store, 'w1')).code, 'BAD_RESULT_PATH');
});

test('a valid worktree inside an allowed root scopes results to itself', async () => {
    const sibling = join(ws, 'sibling');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'x.md'), 'x');
    const { api, store } = setup(join(sibling, 'x.md'));
    assert.equal((await readResult(api, store, 'w1')).code, 'BAD_RESULT_PATH', 'inside the root but outside this worktree');
    const ok = setup(join(work, 'result.md'));
    assert.equal((await readResult(ok.api, ok.store, 'w1')).ok, true);
});

// ---- fail-closed actions: unknown pane or missing workspaceID --------------------------------
import { sendToWorker, captureWorker, approve, deny, archive, accept } from '../backend/actions.mjs';
import { hideWorker } from '../backend/collapse.mjs';
import { addItem } from '../backend/attention.mjs';
import { PROMPT_TEXT } from './backend-fake-api.mjs';
import { parsePrompt, promptHash } from '../backend/notify.mjs';

for (const [name, panePatch] of [['unknown pane', null], ['pane without workspaceID', { id: 'w1', status: 'waitingForInput' }]]) {
    test(`every action refuses a manifest worker: ${name}`, async () => {
        const api = makeFakeApi({ captures: { w1: PROMPT_TEXT }, files: { '/wt/w1/result.md': '# Goal\nx' } });
        const store = createStore(api);
        createAttention(api, store);
        store.settings = { ...store.settings, manifestDir: '/m', worktreeRoots: ['/wt'] };
        store.manifestWorkers = [MANIFEST.workers[0]];
        store.orchestrator = { paneID: 'orch', label: 'coordinator', source: 'manifest' };
        store.allowedWorkspace = id => id === 'ws1';
        if (panePatch) store.panes.set('w1', panePatch);
        const p = parsePrompt(PROMPT_TEXT);
        const { item } = await addItem(store.att, { type: 'Request', paneID: 'w1', text: 'asks', command: p.command, promptHash: promptHash(p.block) });
        const results = {
            send: await sendToWorker(api, store, 'w1', 'hi'),
            capture: await captureWorker(api, store, 'w1'),
            open: await openResult(api, store, 'w1'),
            read: await readResult(api, store, 'w1'),
            approve: await approve(api, store, item.id, item.promptHash),
            deny: await deny(api, store, item.id),
            archive: await archive(api, store, 'w1'),
            accept: await accept(api, store, 'w1'),
            hide: await hideWorker(api, store, 'w1')
        };
        for (const [action, r] of Object.entries(results)) assert.equal(r.ok, false, action);
        assert.equal(api.callsTo('terminal.send').length + api.callsTo('terminal.sendKey').length + api.callsTo('panes.moveToWorkspace').length
            + api.callsTo('files.open').length + api.callsTo('files.read').length, 0);
    });
}

test('a pane in a workspace that is not allowed is refused by every action', async () => {
    const api = makeFakeApi({ captures: { w1: 'x' } });
    const store = createStore(api);
    createAttention(api, store);
    store.manifestWorkers = [MANIFEST.workers[0]];
    store.allowedWorkspace = id => id === 'ws1';
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'other', paneID: 'w1', pane: { id: 'w1', status: 'idle' } });
    assert.equal((await sendToWorker(api, store, 'w1', 'hi')).code, 'NOT_WORKER');
    assert.equal((await captureWorker(api, store, 'w1')).code, 'NOT_WORKER');
});

// ---- worktreeRoots trust model (home injected so nothing touches the real home directory) ------
const fakeHome = join(root, 'home');
mkdirSync(join(fakeHome, 'repos', 'foo-w', 'backend'), { recursive: true });
mkdirSync(join(fakeHome, '.aws', 'sso', 'cache'), { recursive: true });
mkdirSync(join(fakeHome, '.kelpi-swarm'), { recursive: true });
mkdirSync(join(root, 'home-sibling', '.aws'), { recursive: true });
mkdirSync(join(root, 'custom', 'tree'), { recursive: true });
for (const f of [join(fakeHome, 'repos', 'foo-w', 'backend', 'r.md'), join(fakeHome, '.aws', 'sso', 'cache', 'x.json'),
    join(root, 'home-sibling', '.aws', 'x.json'), join(root, 'custom', 'tree', 'r.md')]) writeFileSync(f, 'x');
const check = (resultPath, worktreePath, settings = {}) => checkResultPath({ resultPath, worktreePath }, settings, fakeHome,
    { pane: { workingDirectory: worktreePath }, isWorktree: () => true });

test('worktree under the default <home>/repos root is trusted and scopes results to itself', async () => {
    const tree = join(fakeHome, 'repos', 'foo-w', 'backend');
    assert.equal((await check(join(tree, 'r.md'), tree)).ok, true);
    assert.equal((await check(join(fakeHome, '.aws', 'sso', 'cache', 'x.json'), tree)).code, 'BAD_RESULT_PATH');
    assert.deepEqual(worktreeTrustRoots({}, fakeHome)[0], join(fakeHome, 'repos'));
});

test('worktree in a dot-directory of home, or a sibling of home, is not trusted', async () => {
    for (const tree of [join(fakeHome, '.aws'), join(fakeHome, '.aws', 'sso'), join(root, 'home-sibling', '.aws'), fakeHome, root, '/']) {
        const target = tree === join(root, 'home-sibling', '.aws') ? join(tree, 'x.json') : join(fakeHome, '.aws', 'sso', 'cache', 'x.json');
        assert.equal((await check(target, tree)).code, 'BAD_RESULT_PATH', tree);
    }
});

test('a custom worktreeRoots value replaces the ~/repos default', async () => {
    const tree = join(root, 'custom', 'tree');
    const settings = { worktreeRoots: [join(root, 'custom')] };
    assert.equal((await check(join(tree, 'r.md'), tree, settings)).ok, true);
    assert.equal((await check(join(tree, 'r.md'), tree)).code, 'BAD_RESULT_PATH', 'not trusted without the setting');
    const repoTree = join(fakeHome, 'repos', 'foo-w', 'backend');
    assert.equal((await check(join(repoTree, 'r.md'), repoTree, settings)).code, 'BAD_RESULT_PATH', 'default no longer applies');
});

test('worktreeRoots accepts the string form the host stores (colon or newline separated)', async () => {
    const tree = join(root, 'custom', 'tree');
    assert.equal((await check(join(tree, 'r.md'), tree, { worktreeRoots: `/nonexistent-a:${join(root, 'custom')}` })).ok, true);
    assert.equal((await check(join(tree, 'r.md'), tree, { worktreeRoots: `/nonexistent-a\n${join(root, 'custom')}` })).ok, true);
});

test('worktreeRoots set to home or an ancestor of home is ignored', async () => {
    const target = join(fakeHome, '.aws', 'sso', 'cache', 'x.json');
    for (const bad of [fakeHome, root, '/']) assert.equal((await check(target, join(fakeHome, '.aws'), { worktreeRoots: [bad] })).code, 'BAD_RESULT_PATH', bad);
});

test('a result directly under home (e.g. ~/.aws/sso/cache/x.json) is refused with and without a worktree', async () => {
    const target = join(fakeHome, '.aws', 'sso', 'cache', 'x.json');
    assert.equal((await check(target, null)).code, 'BAD_RESULT_PATH');
    assert.equal((await check(target, null, { manifestDir: join(fakeHome, '.kelpi-swarm') })).code, 'BAD_RESULT_PATH');
    assert.equal((await check(join(fakeHome, '.kelpi-swarm', 'n.txt'), null)).ok, true, 'the manifest directory itself stays allowed');
});
