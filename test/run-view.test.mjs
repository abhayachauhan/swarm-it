// The "Run suggested command" view as the user drives it: ui/run/app.js booted in a fake window with the real logic.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeNode } from './sidebar-fake-dom.mjs';

const dir = new URL('../ui/run/', import.meta.url);
const APP = readFileSync(new URL('app.js', dir), 'utf8');
const HTML = readFileSync(new URL('index.html', dir), 'utf8');
const logic = await import('../ui/run/logic.js');
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };

const STATE = {
    mode: 'run', sourcePaneID: 'c1', command: 'npm test',
    targets: [{ paneID: 'c1', name: 'claude', agent: true, source: true }, { paneID: 's1', name: 'shell', agent: false, source: false }]
};

async function boot(state = STATE, execute = () => ({ ok: true })) {
    const byId = {};
    for (const [, tag, id] of HTML.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) { const node = new FakeNode(tag); node.attrs.id = id; node.value = ''; byId[id] = node; }
    const document = { getElementById: id => byId[id] ?? null, createElement: tag => new FakeNode(tag) };
    const calls = [];
    const api = {
        ready: Promise.resolve(), state,
        commands: { execute: async (command, args) => { const name = command.replace('local.swarm-view.', ''); calls.push({ name, args: JSON.parse(JSON.stringify(args)) }); return execute(name, args); } }
    };
    const source = APP.replace(/^import \{([^}]*)\} from '\.\/logic\.js';/m, (_, names) => `const {${names}} = __logic;`);
    assert.notEqual(source, APP, 'the logic import was rebound');
    const context = vm.createContext({ window: { kelpi: api }, document, __logic: logic, console });
    await vm.runInContext(`(async () => {${source}\n})()`, context, { filename: 'run/app.js' });
    await flush();
    return { $: id => byId[id], calls, click: async id => { await byId[id].onclick(); await flush(); } };
}

test('the view shows the command, defaults to a new shell pane and runs nothing until Run', async () => {
    const view = await boot();
    assert.equal(view.$('command').value, 'npm test');
    assert.equal(view.$('target').value, 'new');
    assert.deepEqual(view.$('target').children.map(o => o.value), ['new', 'c1', 's1']);
    assert.match(view.$('target').children[1].textContent, /Claude session, runs as a ! command/);
    assert.equal(view.$('target-note').textContent, '', 'no note for a new shell pane');
    assert.equal(view.calls.length, 0);
    view.$('command').value = 'npm test -- --watch=false';
    await view.click('run');
    assert.deepEqual(view.calls, [{ name: 'run-suggested-confirm', args: { sourcePaneID: 'c1', text: 'npm test -- --watch=false', target: 'new', confirmed: true } }]);
});

test('a ! command opens with Claude\'s own session picked and says what Run will type', async () => {
    const view = await boot({ ...STATE, defaultTarget: 'c1' });
    assert.equal(view.$('target').value, 'c1');
    assert.match(view.$('target-note').textContent, /Types "! <command>" into Claude's prompt/);
    assert.match(view.$('target-note').textContent, /unsent text/);
    view.$('target').value = 'new';
    view.$('target').onchange();
    assert.equal(view.$('target-note').textContent, '');
    view.$('target').value = 'c1';
    await view.click('run');
    assert.deepEqual(view.calls[0].args, { sourcePaneID: 'c1', text: 'npm test', target: 'c1', confirmed: true, allowAgent: true });
    assert.equal(logic.readState({ ...STATE, defaultTarget: 'gone' }).defaultTarget, 'new', 'an unknown default falls back to a new pane');
});

test('picking the agent pane is the only way to allow typing into it', async () => {
    const view = await boot();
    view.$('target').value = 'c1';
    await view.click('run');
    assert.equal(view.calls[0].args.allowAgent, true);
    assert.equal(logic.confirmArgs(logic.readState(STATE), 'ls', 's1').allowAgent, undefined);
    assert.equal(logic.confirmArgs(logic.readState(STATE), 'ls', 'gone').target, 'new');
});

test('control characters and empty text are refused in the view; Copy and Cancel send their commands', async () => {
    const view = await boot();
    view.$('command').value = 'echo \u001b[2J';
    await view.click('run');
    assert.match(view.$('error').textContent, /control character/);
    view.$('command').value = '';
    await view.click('copy');
    assert.equal(view.calls.length, 0);
    view.$('command').value = 'echo ok\n';
    await view.click('copy');
    await view.click('cancel');
    assert.deepEqual(view.calls, [{ name: 'copy-suggested', args: { text: 'echo ok' } }, { name: 'close-run-view', args: {} }]);
});

test('a multi-line command says how many lines run, and invisible characters are refused', async () => {
    const view = await boot({ ...STATE, command: 'cd app\nnpm ci\nnpm test' });
    assert.equal(view.$('lines').textContent, '3 lines: each runs as its own command.');
    view.$('command').value = 'npm test';
    view.$('command').oninput();
    assert.equal(view.$('lines').textContent, '');
    view.$('command').value = 'echo ‮evil';
    await view.click('run');
    assert.match(view.$('error').textContent, /invisible/);
    assert.equal(view.calls.length, 0);
});

test('a backend refusal is shown, and a view without state disables Run', async () => {
    const view = await boot(STATE, name => (name === 'run-suggested-confirm' ? { ok: false, error: 'pane c1 is running an agent', code: 'AGENT_PANE' } : { ok: true }));
    await view.click('run');
    assert.match(view.$('error').textContent, /running an agent/);
    const empty = await boot({});
    assert.equal(empty.$('run').disabled, true);
});
