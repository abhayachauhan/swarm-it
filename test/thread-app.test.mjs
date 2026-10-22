// The thread view as the user drives it: ui/thread/app.js booted in a fake window with the real logic.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeNode } from './sidebar-fake-dom.mjs';

const dir = new URL('../ui/thread/', import.meta.url);
const APP = readFileSync(new URL('app.js', dir), 'utf8');
const HTML = readFileSync(new URL('index.html', dir), 'utf8');
const logic = await import('../ui/thread/logic.js');
const fixture = () => JSON.parse(readFileSync(new URL('../ui/sidebar/fixtures/snapshot.json', import.meta.url), 'utf8'));
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };

/** Boot the view for one pane. `execute(command, args)` may return a result to override the default ok. */
async function bootThread({ snapshot = fixture(), paneID = 'p-wait', execute } = {}) {
    const clock = { now: 1_760_000_000_000 };
    class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
    const timers = [];
    let timerID = 0;
    const schedule = (fn, ms, every) => { const id = ++timerID; timers.push({ id, fn, due: clock.now + Math.max(0, Number(ms) || 0), every }); return id; };
    const cancel = id => { const at = timers.findIndex(t => t.id === id); if (at >= 0) timers.splice(at, 1); };
    const advance = async ms => {
        const end = clock.now + ms;
        for (;;) {
            const next = timers.filter(t => t.due <= end).sort((a, b) => a.due - b.due)[0];
            if (!next) break;
            clock.now = Math.max(clock.now, next.due);
            if (next.every) next.due += next.every; else cancel(next.id);
            next.fn();
            await flush();
        }
        clock.now = end;
    };
    const byId = {};
    for (const [, tag, id] of HTML.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) { const node = new FakeNode(tag); node.attrs.id = id; node.hidden = false; node.value = ''; byId[id] = node; }
    const document = { getElementById: id => byId[id] ?? null, createElement: tag => new FakeNode(tag) };
    const calls = [], listeners = [];
    const api = {
        ready: Promise.resolve(), state: { paneID },
        events: { on: (name, fn) => { listeners.push(fn); return () => {}; } },
        commands: {
            execute: async (command, args) => {
                calls.push({ command: command.replace('local.swarm-view.', ''), args: JSON.parse(JSON.stringify(args ?? null)) });
                const custom = execute ? execute(command.replace('local.swarm-view.', ''), args) : null;
                if (custom) return custom;
                if (command.endsWith('get-state')) return { ok: true, snapshot };
                if (command.endsWith('read-result')) return { ok: false, error: 'none yet', code: 'NO_RESULT' };
                return { ok: true };
            },
        },
        ui: { reveal: async id => { calls.push({ command: 'reveal', args: { paneID: id } }); } },
    };
    const window = { kelpi: api };
    // app.js is an ES module whose only import is ./logic.js: bind that import to the real module and run the rest as
    // an async function (it uses top-level await).
    const source = APP.replace(/^import \{([^}]*)\} from '\.\/logic\.js';/m, (_, names) => `const {${names}} = __logic;`);
    assert.notEqual(source, APP, 'the logic import was rebound');
    const context = vm.createContext({ window, document, __logic: logic, console, Date: FakeDate,
        setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: cancel, setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1)), clearInterval: cancel });
    await vm.runInContext(`(async () => {${source}\n})()`, context, { filename: 'thread/app.js' });
    await flush();
    return {
        $: id => byId[id], calls, advance, flush,
        sent: name => calls.filter(c => c.command === name),
        emit: snap => { for (const fn of listeners) fn({ name: 'local.swarm-view.snapshot' }, snap); },
        click: async id => { await byId[id].onclick(); await flush(); },
    };
}

test('Back to coordinator: open-thread for the coordinator, close-thread when none is known, never disabled', async () => {
    const view = await bootThread();
    assert.equal(view.$('back').disabled, false);
    await view.click('back');
    assert.deepEqual(view.sent('open-thread').map(c => c.args), [{ paneID: 'p-orch' }]);
    assert.equal(view.sent('close-thread').length, 0);
    assert.equal(view.$('back').disabled, false, 'still usable after a click');
    const alone = await bootThread({ snapshot: { ...fixture(), orchestrator: null } });
    await alone.click('back');
    assert.deepEqual(alone.sent('close-thread').map(c => c.args), [{}]);
    assert.equal(alone.sent('open-thread').length, 0);
    assert.equal(alone.$('back').disabled, false);
    // Even a refused close leaves the button usable and shows the reason.
    const refused = await bootThread({ snapshot: { ...fixture(), orchestrator: null }, execute: c => (c === 'close-thread' ? { ok: false, error: 'host gone', code: 'INTERNAL' } : null) });
    await refused.click('back');
    assert.equal(refused.$('error').textContent, 'INTERNAL: host gone');
    assert.equal(refused.$('back').disabled, false);
    // Top left: the button comes before the worker name in the markup.
    assert.ok(HTML.indexOf('id="back"') < HTML.indexOf('id="name"'));
    assert.match(HTML, /<button id="back"[^>]*>← Back to coordinator<\/button>/);
});

test('the request card names its origin, locks Approve and Deny for 500 ms after a change, and for good on an unrecognised prompt', async () => {
    const view = await bootThread();
    assert.equal(view.$('request').hidden, false);
    assert.equal(view.$('requestOrigin').textContent, 'repo-lag (p-wait)');
    assert.equal(view.$('requestCommand').textContent, 'npm test');
    assert.equal(view.$('approve').disabled, true, 'just appeared: locked');
    assert.equal(view.$('deny').disabled, true);
    assert.equal(view.$('answerInPane').hidden, true);
    await view.advance(600);
    assert.equal(view.$('approve').disabled, false, 'the lock lifted and the view redrew by itself');
    assert.equal(view.$('deny').disabled, false);
    await view.click('approve');
    assert.deepEqual(view.sent('approve').map(c => c.args), [{ itemID: 'Request:p-wait:2026-10-08T00:58:00.000Z', promptHash: fixture().attention[0].promptHash }]);
    // An unrecognised prompt: the raw block, and both buttons stay disabled however long it sits there.
    const snap = fixture();
    snap.sequence = 13;
    snap.attention[0] = { ...snap.attention[0], approvable: false, command: '', promptBlock: 'Weird thing\nDo you want to?\n1. Yes' };
    view.emit(snap);
    await view.advance(600);
    assert.equal(view.$('approve').disabled, true);
    assert.equal(view.$('deny').disabled, true);
    assert.equal(view.$('answerInPane').hidden, false);
    assert.match(view.$('requestCommand').textContent, /^Unrecognised prompt\. Answer it in the pane\.\n\nWeird thing/);
    // No worker for the pane: the origin is the pane id alone.
    const other = await bootThread({ paneID: 'p-orch' });
    assert.equal(other.$('request').hidden, true);
});

test('Codex requests lead to their pane and never offer Claude approval keys', async () => {
    const snap = fixture();
    snap.workers[0].agent = 'codex';
    const view = await bootThread({ snapshot: snap });
    assert.equal(view.$('approve').hidden, true);
    assert.equal(view.$('deny').hidden, true);
    assert.equal(view.$('answerInPane').hidden, false);
    assert.equal(view.$('requestHelp').textContent, 'Answer this request in Codex.');
    await view.click('answerInPane');
    assert.deepEqual(view.sent('reveal').map(c => c.args), [{ paneID: 'p-wait' }]);
    assert.equal(view.sent('approve').length, 0);
});

test('worker result links open in Kelpi and hostile markup remains plain text', async () => {
    const view = await bootThread({ execute: command => command === 'read-result' ? {
        ok: true, path: '/tmp/result.md', text: '**Goal**\nRead [docs](https://example.com/a).\n**Done**\n<script>x</script>\n**Next**\nVisit https://example.org/b.'
    } : null });
    const goalLink = view.$('goal').children.find(node => node.className === 'result-link');
    assert.equal(goalLink.textContent, 'docs');
    assert.equal(goalLink.title, 'https://example.com/a');
    goalLink.click();
    await view.flush();
    assert.deepEqual(view.sent('open-web-link').map(c => c.args), [{ paneID: 'p-wait', url: 'https://example.com/a' }]);
    assert.match(view.$('done').textContent, /<script>x<\/script>/);
    assert.equal(view.$('done').children.some(node => node.tag === 'script'), false);
});
