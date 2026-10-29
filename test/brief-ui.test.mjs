import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeNode, find } from './sidebar-fake-dom.mjs';
import * as logic from '../ui/brief/logic.js';
import * as rendering from '../ui/brief/render.js';

const brief = (goal = 'Build workspace brief') => ({ goal, now: 'Adding the card', next: 'Check workspace switching', needsYou: '',
    steps: [{ text: 'Build card', state: 'done' }, { text: 'Build card', state: 'done' }, { text: 'Check switching', state: 'running' }],
    pullRequests: [{ url: 'https://github.com/owner/repo/pull/42', title: 'Show automatic workspace progress above terminals', status: 'draft' }],
    updatedAt: new Date().toISOString(), goalPinned: false });
const response = (id, goal) => ({ ok: true, workspaceID: id, brief: brief(goal) });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
function doc() {
    const nodes = {};
    const document = { activeElement: null, createElement: tag => { const node = new FakeNode(tag); node.ownerDocument = document; return node; }, getElementById: id => nodes[id] };
    const html = readFileSync(new URL('../ui/brief/index.html', import.meta.url), 'utf8');
    for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
        nodes[id] = document.createElement(tag); nodes[id].value = ''; nodes[id].checked = false;
    }
    return { document, $: id => nodes[id] };
}
function harness(execute) {
    let model;
    const calls = [];
    const controller = logic.createBriefController({ execute: async (command, args) => { calls.push({ command, args }); return execute(command, args); }, render: value => { model = value; } });
    return { controller, calls, get model() { return model; } };
}

test('switch and replay discard stale successful and failed responses without changing the current workspace or issuing edits', async () => {
    const pending = [];
    const h = harness(() => { const item = deferred(); pending.push(item); return item.promise; });
    h.controller.select('a'); h.controller.select('b'); h.controller.select('a');
    pending[2].resolve(response('a', 'Current goal')); await flush();
    const before = h.model;
    pending[0].resolve(response('a', 'Old goal')); pending[1].reject(new Error('Old failure')); await flush();
    assert.equal(h.model, before);
    h.controller.resetDraft();
    assert.equal(h.model.draft.goal, 'Current goal');
    assert.equal(h.model.brief.goal, 'Current goal'); assert.equal(h.model.error, '');
    assert.deepEqual(h.calls.map(x => x.command), Array(3).fill('get-workspace-brief'));
});

test('mismatched workspace reply shows exact error and leaves the brief empty', async () => {
    const h = harness(() => response('wrong', 'Other workspace'));
    h.controller.select('a'); await flush();
    assert.equal(h.model.error, 'Brief response belongs to another workspace');
    assert.equal(h.model.brief, null); assert.equal(h.calls.length, 1);
});

test('poll, refresh, save, pin and unpin preserve unsaved drafts; failures leave data unchanged', async () => {
    let fail = false;
    const h = harness((command, args) => command === 'get-workspace-brief' ? response(args.workspaceID, 'Server goal') : fail ? { ok: false, error: 'Goal is read only' } : { ok: true });
    h.controller.select('a'); await flush();
    h.controller.changeDraft('My draft', true); await h.controller.refresh(true);
    assert.deepEqual(h.model.draft, { goal: 'My draft', goalPinned: true, dirty: true });
    assert.deepEqual(h.calls.at(-1).args, { workspaceID: 'a', force: true });
    fail = true; await h.controller.edit();
    assert.equal(h.model.error, 'Goal is read only'); assert.equal(h.model.brief.goal, 'Server goal');
    assert.equal(h.model.draft.goal, 'My draft'); assert.equal(h.model.draft.dirty, true);
    fail = false; await h.controller.edit();
    assert.equal(h.model.brief.goal, 'My draft'); assert.equal(h.model.brief.goalPinned, true);
    assert.deepEqual(h.calls.at(-1), { command: 'edit-workspace-brief', args: { workspaceID: 'a', goal: 'My draft', goalPinned: true } });
    await h.controller.edit(true); assert.equal(h.model.brief.goalPinned, false);
    await h.controller.edit(true); assert.equal(h.model.brief.goalPinned, true);
    h.controller.changeDraft('Keep across switching', false);
    h.controller.select('b'); await flush(); h.controller.select('a'); await flush();
    assert.equal(h.model.draft.goal, 'Keep across switching');
    h.controller.resetDraft(); assert.equal(h.model.draft.goal, 'Server goal');
    await h.controller.openDetails();
    assert.deepEqual(h.calls.at(-1), { command: 'open-workspace-brief', args: { workspaceID: 'a' } });
});

test('poll started before save and edit completed after switching cannot overwrite the current brief or draft', async () => {
    let poll, edit;
    const h = harness((command, args) => command === 'get-workspace-brief' ? (poll?.promise ?? response(args.workspaceID, 'Server')) : edit.promise);
    h.controller.select('a'); await flush();
    poll = deferred(); const refreshing = h.controller.refresh();
    edit = deferred(); h.controller.changeDraft('Saved', true); const saving = h.controller.edit();
    edit.resolve({ ok: true }); await saving;
    poll.resolve(response('a', 'Old poll')); await refreshing;
    assert.equal(h.model.brief.goal, 'Saved');
    edit = deferred(); const lateEdit = h.controller.edit(true);
    poll = null; h.controller.select('b'); await flush(); const before = h.model;
    edit.resolve({ ok: true }); await lateEdit;
    assert.equal(h.model, before); assert.equal(h.model.brief.goal, 'Server');
});

test('render uses plain text, descriptive pull request links, unique steps, needs-you status and preserves focus and drafts', () => {
    const d = doc(), links = [];
    const render = rendering.createBriefRenderer(d.document, { details: true, onLink: (...args) => links.push(args) });
    const model = { workspaceID: 'a', brief: brief('<img onerror=bad>'), draft: { goal: 'Draft', goalPinned: true, dirty: true }, pending: true, error: 'Provider unavailable' };
    render(model);
    assert.equal(d.$('goal').textContent, '<img onerror=bad>'); assert.equal(d.$('goal').children.length, 0);
    assert.equal(d.$('steps').children.length, 2);
    const link = find(d.$('pull-requests'), n => n.tag === 'button')[0];
    assert.equal(link.textContent, 'Show automatic workspace progress above terminals · #42 · draft');
    link.click(); assert.deepEqual(links, [['https://github.com/owner/repo/pull/42', 'a']]);
    d.$('goal-input').value = 'Typing more'; d.$('goal-input').focus();
    render({ ...model, brief: { ...model.brief, needsYou: 'Choose the migration date', now: 'Preparing migration' } });
    assert.equal(d.document.activeElement, d.$('goal-input')); assert.equal(d.$('goal-input').value, 'Typing more');
    assert.equal(d.$('now-label').textContent, 'Needs you'); assert.equal(d.$('now').textContent, 'Choose the migration date');
    assert.match(d.$('status').textContent, /Preparing update… · Provider unavailable$/);
    render({ ...model, brief: null }); assert.equal(d.$('goal').textContent, 'Preparing brief…');
    assert.equal(d.$('pull-requests').children.length, 0); assert.equal(d.$('empty-steps').textContent, 'No plan recorded yet.');
});

test('only ordinary GitHub pull URLs are clickable, never scripts or lookalike hosts', () => {
    for (const value of ['javascript:alert(1)', 'https://github.com.evil.test/o/r/pull/1', 'https://user@github.com/o/r/pull/1', 'http://github.com/o/r/pull/1', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/1?evil=1', 'https://github.com/o/r/pull/0', 'https://github.com/o/r/pull/1\n']) assert.equal(logic.pullLink(value), null, value);
    assert.deepEqual(logic.pullLink('https://github.com/o/r/pull/123'), { url: 'https://github.com/o/r/pull/123', number: '123' });
});

async function boot({ state = {}, chrome = { workspace: { id: 'a' } }, execute, selectView, ready = Promise.resolve(), getChrome } = {}) {
    const d = doc(), calls = [], intervals = [], listeners = {};
    let chromeListener;
    const api = { ready, state, visible: true, panes: { list: async ({ workspaceID }) => [{ id: `pane-${workspaceID}`, workspaceID, isFocused: true }] }, commands: { execute: async (command, args) => {
        command = command.replace('local.swarm-view.', ''); calls.push({ command, args });
        return execute ? execute(command, args) : response(args.workspaceID);
    } }, command: async args => { calls.push({ command: 'native', args }); return { ok: true }; },
    ui: { selectView: async (...args) => { calls.push({ command: 'selectView', args }); if (selectView) return selectView(...args); },
        onChrome: fn => { chromeListener = fn; return () => calls.push({ command: 'stop' }); }, getChrome: getChrome || (async () => chrome) } };
    const source = readFileSync(new URL('../ui/brief/app.js', import.meta.url), 'utf8')
        .replace(/^import \{([^}]*)\} from '\.\/logic.js';/m, 'const {$1} = logic;')
        .replace(/^import \{([^}]*)\} from '\.\/render.js';/m, 'const {$1} = rendering;');
    const context = vm.createContext({ document: d.document, window: { kelpi: api, addEventListener: (event, fn) => { listeners[event] = fn; } }, logic, rendering,
        setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1; }, clearInterval: () => {} });
    const started = vm.runInContext(`(async () => {${source}\n})()`, context);
    return { ...d, api, calls, started, intervals, emit: value => chromeListener(value), close: () => listeners.pagehide(), fire: async (id, event = 'click') => {
        for (const fn of d.$(id).listeners[event] ?? []) await fn({ preventDefault() {} }); await flush();
    } };
}

test('SDK waits for ready, polls selected local workspace, skips remotes, opens details and never sends session answers', async () => {
    const ready = deferred(); const h = await boot({ ready: ready.promise });
    assert.deepEqual(h.calls, []); ready.resolve(); await h.started; await flush();
    assert.equal(h.intervals[0].ms, 5000); assert.equal(h.calls[0].args.workspaceID, 'a');
    h.emit({ remoteWorkspaceSelected: true, workspace: { id: 'a' } }); await h.intervals[0].fn(); await flush();
    assert.equal(h.calls.length, 1); assert.equal(h.$('details').disabled, true);
    h.emit({ workspace: { id: 'b' } }); await flush(); await h.fire('details');
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), { command: 'open-workspace-brief', args: { workspaceID: 'b' } });
    assert.deepEqual(h.calls.map(x => x.command), ['get-workspace-brief', 'get-workspace-brief', 'open-workspace-brief']);
    const link = find(h.$('pull-requests'), n => n.tag === 'button')[0]; link.click(); await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), { command: 'native', args: { command: 'web-open', url: 'https://github.com/owner/repo/pull/42', pane_id: 'pane-b', focus: true } });
    h.close(); await flush(); const count = h.calls.length; await h.intervals[0].fn(); await flush(); assert.equal(h.calls.length, count);
});

test('late initial chrome cannot undo a newer selection and details stays bound to its explicit workspace', async () => {
    const initial = deferred(); const h = await boot({ getChrome: () => initial.promise });
    await flush(); h.emit({ workspace: { id: 'new' } }); initial.resolve({ workspace: { id: 'old' } }); await h.started; await flush();
    assert.deepEqual(h.calls.map(x => x.args.workspaceID), ['new']);
    const details = await boot({ state: { details: true, workspaceID: 'fixed' } }); await details.started; await flush();
    assert.equal(details.$('full').hidden, false); assert.equal(details.$('details').hidden, true);
    assert.deepEqual(details.calls.map(x => x.args.workspaceID), ['fixed']);
    details.$('goal-input').value = 'Edited goal'; details.$('goal-pinned').checked = true;
    await details.fire('goal-input', 'input'); await details.fire('editor', 'submit');
    assert.deepEqual(JSON.parse(JSON.stringify(details.calls.at(-1))), { command: 'edit-workspace-brief', args: { workspaceID: 'fixed', goal: 'Edited goal', goalPinned: true } });
});

test('bootstrap enables the workspace layout only in Details, reports failure and Hide restores native Workspaces', async () => {
    const h = await boot({ state: { workspaceID: 'fixed', details: true, enableLayout: true }, selectView: () => { throw new Error('Layout unavailable'); } });
    await h.started; await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { command: 'selectView', args: ['workspace', 'local.swarm-view.brief-layout'] });
    assert.equal(h.$('status').textContent.includes('Could not enable brief: Layout unavailable'), true);
    await h.fire('hide'); assert.equal(h.$('status').textContent, 'Could not hide brief: Layout unavailable');
    const ok = await boot({ state: { workspaceID: 'fixed', details: true, enableLayout: true } }); await ok.started; await flush(); await ok.fire('hide');
    assert.deepEqual(JSON.parse(JSON.stringify(ok.calls.at(-1))), { command: 'selectView', args: ['workspace', 'kelpi.workspace'] });
    const header = await boot({ state: { enableLayout: true } }); await header.started; await flush();
    assert.equal(header.calls.filter(x => x.command === 'selectView').length, 0);
});


test('cached brief survives provider errors and preserves draft while showing the exact reason', async () => {
    const h = harness(() => ({ ...response('a', 'Cached goal'), pending: true, error: 'Generator unavailable' }));
    h.controller.select('a'); await flush();
    assert.equal(h.model.brief.goal, 'Cached goal'); assert.equal(h.model.error, 'Generator unavailable');
    assert.equal(h.model.pending, true);
    h.controller.changeDraft('Local draft', true); await h.controller.refresh();
    assert.equal(h.model.draft.goal, 'Local draft'); assert.equal(h.model.error, 'Generator unavailable');
});


test('ordinary empty or whitespace needs-you keeps Now, and a real request replaces Now', () => {
    assert.deepEqual(logic.briefSummary({ goal: 'Goal', now: 'Making the card', next: 'Verify', needsYou: '' }), {
        goal: 'Goal', now: 'Making the card', next: 'Verify', nowLabel: 'Now',
    });
    assert.equal(logic.briefSummary({ now: 'Still working', needsYou: '   ' }).now, 'Still working');
    assert.equal(logic.briefSummary({ now: 'Still working', needsYou: '   ' }).nowLabel, 'Now');
    assert.equal(logic.briefSummary({ now: 'Still working', needsYou: ' Choose a date ' }).now, 'Choose a date');
    assert.equal(logic.briefSummary({ needsYou: 'Choose a date' }).nowLabel, 'Needs you');
});

test('polling pauses while either Kelpi view or document is hidden and resumes when visible', async () => {
    const h = await boot({ state: { details: true, workspaceID: 'fixed' } }); await h.started; await flush();
    const count = h.calls.length;
    h.api.visible = false; h.intervals[0].fn(); await flush(); assert.equal(h.calls.length, count);
    h.api.visible = true; h.document.hidden = true; h.intervals[0].fn(); await flush(); assert.equal(h.calls.length, count);
    h.document.hidden = false; h.intervals[0].fn(); await flush(); assert.equal(h.calls.length, count + 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), { command: 'get-workspace-brief', args: { workspaceID: 'fixed' } });
});
