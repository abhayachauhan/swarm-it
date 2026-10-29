import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeComposer, claudeSuggestionRevision } from '../backend/claude-input.mjs';
const rule = '─'.repeat(60);
const plain = `${rule}\n❯ Check again\n${rule}\n[Opus 5.5] | ~/repos`;
const styled = `${rule}\r\n\x1b[0m❯ \x1b[2mCheck\x1b[1Cagain\r\n\x1b[38;2;136;136;136;22m${rule}\r\n[Opus 5.5] | ~/repos`;
function setup({ ansi = styled, col = 2, changed = false } = {}) {
    const calls = []; let reads = 0;
    return { calls, api: { terminal: {
        async read() { calls.push('read'); return { text: plain, cursor: { col }, revision: changed ? ++reads : 42 }; },
        async watch() { calls.push('watch'); return { subscription: 'sub', base64: Buffer.from(ansi).toString('base64') }; },
        async unwatch(id) { calls.push(['unwatch', id]); }
    } } };
}
test('serialized Claude dim suggestions retain style across cursor spacing and color resets', () => {
    assert.deepEqual(claudeComposer(styled, true), { content: 'Check again', suggestion: true });
    assert.deepEqual(claudeComposer(plain), { content: 'Check again', suggestion: false });
    assert.equal(claudeComposer(styled.replace('[2m', '[38;2;153;153;153m'), true).suggestion, false, 'RGB parameters cannot enable dim');
    assert.equal(claudeComposer(styled.replace('Check', 'Check\x1b[22m'), true).suggestion, false, 'mixed real text and suggestion is a draft');
});
test('only an unchanged dim suggestion at the input start permits guarded restart', async () => {
    const { api, calls } = setup();
    assert.equal(await claudeSuggestionRevision(api, 'p', plain), 42);
    assert.deepEqual(calls, ['read', 'watch', 'read', ['unwatch', 'sub']]);
});
test('real drafts, moved cursors, changed screens and unavailable styles stay protected', async () => {
    for (const opts of [{ ansi: plain }, { col: 5 }, { changed: true }, { ansi: styled.replace('Check', 'Different') }]) {
        const { api, calls } = setup(opts);
        assert.equal(await claudeSuggestionRevision(api, 'p', plain), null);
        if (calls.includes('watch')) assert.deepEqual(calls.at(-1), ['unwatch', 'sub']);
    }
    assert.equal(await claudeSuggestionRevision({ terminal: {} }, 'p', plain), null);
});
