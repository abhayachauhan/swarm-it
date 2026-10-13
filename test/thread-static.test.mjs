import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = name => readFileSync(fileURLToPath(new URL(`../ui/thread/${name}`, import.meta.url)), 'utf8');

test('thread view never uses HTML-injecting sinks', () => {
    for (const file of ['app.js', 'logic.js']) {
        const src = read(file);
        for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
            assert.equal(src.includes(sink), false, `${file} uses ${sink}`);
        }
    }
});

test('thread view only calls declared commands', () => {
    const declared = JSON.parse(readFileSync(fileURLToPath(new URL('../kelpi.plugin.json', import.meta.url)), 'utf8'))
        .contributes.commands.map(command => command.id);
    const used = [...read('app.js').matchAll(/run\('([a-z-]+)'/g)].map(match => `local.swarm-view.${match[1]}`);
    assert.ok(used.length > 0);
    for (const id of used) assert.ok(declared.includes(id), `${id} not declared`);
});

test('thread view uses send-to-worker and open-result, never terminal.send or a path', () => {
    const src = read('app.js');
    assert.equal(src.includes('terminal.send'), false);
    assert.equal(src.includes('api.command('), false);
    assert.match(src, /run\('send-to-worker', \{ paneID, text \}\)/);
    assert.match(src, /run\('open-result', \{ paneID \}\)/);
    assert.doesNotMatch(src, /path:/);
});

test('thread view passes the displayed promptHash on approve and deny', () => {
    const src = read('app.js');
    assert.match(src, /run\('approve', \{ itemID: [^}]*promptHash/);
    assert.match(src, /run\('deny', \{ itemID: [^}]*promptHash/);
});

test('thread view shows a multi-line command with line breaks preserved', () => {
    assert.match(read('style.css'), /#requestCommand\s*\{[^}]*white-space:\s*pre-wrap/);
});

test('index.html references local assets only', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /https?:\/\//);
    assert.match(html, /app\.js/);
    assert.match(html, /style\.css/);
});

test('thread view disables Approve and Deny when approvable is false', () => {
    const src = read('app.js');
    assert.match(src, /item\.approvable === false/);
    assert.match(src, /\$\('approve'\)\.disabled = unrecognised/);
    assert.match(src, /\$\('deny'\)\.disabled = unrecognised/);
});
