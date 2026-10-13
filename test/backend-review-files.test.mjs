// Review fixes: result file handling is race-resistant, size capped and refuses non-regular files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, applyStateChange, refreshWorker } from '../backend/store.mjs';
import { createAttention } from '../backend/attention.mjs';
import { readResult, openResult } from '../backend/actions.mjs';
import { checkResultPath, readResultSafely, MAX_RESULT_BYTES } from '../backend/safepath.mjs';
import { makeFakeApi, MANIFEST } from './backend-fake-api.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-files-')));
const home = join(root, 'home');
const tree = join(root, 'ws', 'wt');
const manifests = join(root, 'ws', 'm');
for (const d of [home, tree, manifests, join(tree, '.git')]) mkdirSync(d, { recursive: true });
const result = join(tree, 'result.md');
writeFileSync(result, '# Goal\nok');

test('readResultSafely reads a regular file through one handle', async () => {
    assert.deepEqual(await readResultSafely(result), { ok: true, text: '# Goal\nok' });
});

test('a FIFO is refused without blocking', async () => {
    const fifo = join(tree, 'pipe.md');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    const r = await readResultSafely(fifo);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_RESULT_PATH');
    assert.ok(Date.now() - started < 2000, 'returned promptly');
});

test('a final symlink is refused by O_NOFOLLOW even if it points at a fine file', async () => {
    const link = join(tree, 'swapped.md');
    symlinkSync(result, link);
    const r = await readResultSafely(link);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_RESULT_PATH');
});

test('a path whose real path changed since the check (non canonical) is refused as moved', async () => {
    const viaDir = join(root, 'alias');
    symlinkSync(tree, viaDir);
    const r = await readResultSafely(join(viaDir, 'result.md'));
    assert.equal(r.ok, false);
    assert.match(r.error, /moved/);
});

test('a file with a second hard link is refused', async () => {
    const twin = join(tree, 'twin.md');
    writeFileSync(twin, 'x');
    linkSync(twin, join(root, 'ws', 'elsewhere.md'));
    const r = await readResultSafely(twin);
    assert.equal(r.ok, false);
    assert.match(r.error, /hard link/);
});

test('a file over the size cap is refused, one at the cap is read', async () => {
    const big = join(tree, 'big.md');
    writeFileSync(big, Buffer.alloc(MAX_RESULT_BYTES + 1, 97));
    assert.equal((await readResultSafely(big)).ok, false);
    const edge = join(tree, 'edge.md');
    writeFileSync(edge, Buffer.alloc(MAX_RESULT_BYTES, 97));
    assert.equal((await readResultSafely(edge)).ok, true);
});

test('a missing file is NO_RESULT, not a policy error', async () => {
    assert.equal((await readResultSafely(join(tree, 'nope.md'))).code, 'NO_RESULT');
});

function realSetup(resultPath, workingDirectory = tree) {
    const api = makeFakeApi({});
    const store = createStore(api);
    createAttention(api, store);
    store.readFile = null; // use the real filesystem reader, not the in-memory fake
    store.isWorktree = null;
    store.settings = { ...store.settings, manifestDir: manifests, worktreeRoots: [join(root, 'ws')] };
    store.manifestWorkers = [{ ...MANIFEST.workers[0], resultPath, worktreePath: tree }];
    store.orchestrator = { paneID: 'orch', label: 'coordinator', source: 'manifest' };
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: 'w1', pane: { id: 'w1', status: 'idle', workingDirectory } });
    return { api, store };
}

test('refreshWorker applies the result path policy and never stalls on a FIFO', async () => {
    const fifo = join(tree, 'stall.md');
    execFileSync('mkfifo', [fifo]);
    const { api, store } = realSetup(fifo);
    const started = Date.now();
    await refreshWorker(store, 'w1');
    assert.equal(store.resultExists.get('w1'), false);
    assert.ok(Date.now() - started < 2000);
    assert.equal(api.callsTo('files.read').length, 0, 'the unchecked files.read is no longer used for existence');
    const ok = realSetup(result);
    await refreshWorker(ok.store, 'w1');
    assert.equal(ok.store.resultExists.get('w1'), true);
    const outside = realSetup('/dev/zero');
    await refreshWorker(outside.store, 'w1');
    assert.equal(outside.store.resultExists.get('w1'), false, 'a path outside every root is not even opened');
});

test('readResult and openResult refuse a FIFO and a hard link', async () => {
    const fifo = join(tree, 'q.md');
    execFileSync('mkfifo', [fifo]);
    const f = realSetup(fifo);
    for (const run of [readResult, openResult]) assert.equal((await run(f.api, f.store, 'w1')).code, 'BAD_RESULT_PATH', run.name);
    assert.equal(f.api.callsTo('files.open').length, 0);
});

test('a reader that never returns cannot stall a read: the guard times out', async () => {
    const { api, store } = realSetup(result);
    store.readFile = () => new Promise(() => {});
    store.readTimeoutMs = 40;
    const r = await readResult(api, store, 'w1');
    assert.equal(r.ok, false);
    await refreshWorker(store, 'w1');
    assert.equal(store.resultExists.get('w1'), false);
});

// ---- worktreePath is worker-declared: it must be a real worktree the pane runs in ----
const ctx = (cwd, isWorktree = true) => ({ pane: cwd === undefined ? undefined : { workingDirectory: cwd }, isWorktree: async () => isWorktree });
const settings = { manifestDir: manifests, worktreeRoots: [join(root, 'ws')] };
const inTree = { resultPath: result, worktreePath: tree };

test('worktree scoping needs a real git worktree and a pane working directory inside it', async () => {
    assert.equal((await checkResultPath(inTree, settings, home, ctx(tree))).ok, true);
    assert.equal((await checkResultPath(inTree, settings, home, ctx(join(tree, 'sub')))).ok, true, 'cwd inside the worktree');
    assert.equal((await checkResultPath(inTree, settings, home, ctx(tree, false))).code, 'BAD_RESULT_PATH', 'not a git worktree: trusted roots only');
    assert.equal((await checkResultPath(inTree, settings, home, ctx(join(root, 'ws')))).code, 'BAD_RESULT_PATH', 'cwd above the worktree');
    assert.equal((await checkResultPath(inTree, settings, home, ctx(join(root, 'elsewhere')))).code, 'BAD_RESULT_PATH', 'cwd elsewhere');
    assert.equal((await checkResultPath(inTree, settings, home, ctx(undefined))).code, 'BAD_RESULT_PATH', 'cwd unknown');
    // falling back to trusted roots still allows a result under the manifest directory
    writeFileSync(join(manifests, 'r.md'), 'x');
    assert.equal((await checkResultPath({ resultPath: join(manifests, 'r.md'), worktreePath: tree }, settings, home, ctx(undefined))).ok, true);
});

test('the default worktree check looks for a .git entry', async () => {
    const plain = join(root, 'ws', 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'r.md'), 'x');
    const w = { resultPath: join(plain, 'r.md'), worktreePath: plain };
    assert.equal((await checkResultPath(w, settings, home, { pane: { workingDirectory: plain } })).code, 'BAD_RESULT_PATH');
    writeFileSync(join(plain, '.git'), 'gitdir: /elsewhere');
    assert.equal((await checkResultPath(w, settings, home, { pane: { workingDirectory: plain } })).ok, true);
});

test('resultRoot gets the same "/" and home rejection as worktreeRoots', async () => {
    mkdirSync(join(home, 'secrets'), { recursive: true });
    writeFileSync(join(home, 'secrets', 'x.json'), 'x');
    for (const resultRoot of ['/', home, root]) {
        const r = await checkResultPath({ resultPath: join(home, 'secrets', 'x.json'), worktreePath: null }, { manifestDir: manifests, resultRoot }, home);
        assert.equal(r.code, 'BAD_RESULT_PATH', `resultRoot ${resultRoot}`);
    }
    const fine = join(root, 'ws', 'results');
    mkdirSync(fine);
    writeFileSync(join(fine, 'a.md'), 'x');
    assert.equal((await checkResultPath({ resultPath: join(fine, 'a.md') }, { manifestDir: manifests, resultRoot: fine }, home)).ok, true);
});
