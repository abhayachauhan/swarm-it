import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeApi } from './backend-fake-api.mjs';
import { locateCodexPane } from '../backend/codex-navigation.mjs';
const session = '22222222-3333-4444-8555-666666666666';
const other = '11111111-2222-4333-8444-555555555555';
const composer = '› Ask Codex to do anything\nGPT-6.1-Sol medium · ~/repos · Different footer\n← for agents · ? for shortcuts';
function setup(screen = composer) {
    const api = makeFakeApi({ panes: [{ id: 'p', title: 'Find Claude session | repos', type: 'shell', workspaceID: 'ws2' }], captures: { p: screen } });
    const send = api.terminal.send;
    api.terminal.send = async (...args) => { await send(...args); api.captureStore.p = `Session: ${session}\n${composer}`; };
    return { api, store: { sessions: new Map() } };
}
test('workspace lookup uses the exact native session when Kelpi metadata is missing', async () => {
    const { api, store } = setup();
    assert.deepEqual(await locateCodexPane(api, store, session, 'Find Claude session', { sleep: async () => {} }), { ok: true, paneID: 'p' });
    assert.equal(store.sessions.get('p'), session);
    assert.deepEqual(api.callsTo('terminal.send').map(c => c.args[1]), ['/status']);
    assert.equal(api.callsTo('panes.close').length, 0);
});
test('matching titles never navigate to a different session', async () => {
    const { api, store } = setup();
    assert.deepEqual(await locateCodexPane(api, store, other, 'Find Claude session', { sleep: async () => {} }),
        { ok: false, error: 'No open pane could be verified for this Codex session. Leave its prompt empty and try again when Codex is idle.', code: 'NO_PANE' });
    assert.equal(store.sessions.get('p'), session);
});
test('workspace lookup preserves unlinked drafts and working sessions without typing status', async () => {
    for (const screen of [composer.replace('Ask Codex to do anything', 'unsent text'), `• Working (2m • esc to interrupt)\n${composer}`]) {
        const { api, store } = setup(screen);
        assert.equal((await locateCodexPane(api, store, session, 'Find Claude session')).code, 'NO_PANE');
        assert.deepEqual(api.callsTo('terminal.send'), []);
        assert.equal(api.captureStore.p, screen);
    }
});
test('known exact session mappings navigate without typing or reading the terminal', async () => {
    const { api, store } = setup(); store.sessions.set('p', session);
    assert.deepEqual(await locateCodexPane(api, store, session), { ok: true, paneID: 'p' });
    assert.deepEqual(api.callsTo('terminal.send'), []); assert.deepEqual(api.callsTo('terminal.capture'), []);
});

test('a unique matching Codex title and footer navigates during active work without typing', async () => {
    for (const prefix of ['', '• Working (2m • esc to interrupt)\n']) {
        const screen = prefix + composer.replace('Different footer', 'Find Claude session');
        const { api, store } = setup(screen);
        assert.deepEqual(await locateCodexPane(api, store, session, 'Find Claude session'), { ok: true, paneID: 'p' });
        assert.deepEqual(api.callsTo('terminal.send'), []);
        assert.equal(api.captureStore.p, screen);
        assert.equal(store.sessions.size, 0, 'a title match is never saved as a verified session ID');
    }
});

test('duplicate names do not select an arbitrary working pane', async () => {
    const screen = `• Working (2m • esc to interrupt)\n${composer.replace('Different footer', 'Find Claude session')}`;
    const { api, store } = setup(screen);
    api.paneList.push({ id: 'p2', title: 'Find Claude session | repos', type: 'shell', workspaceID: 'ws3' });
    api.captureStore.p2 = screen;
    assert.equal((await locateCodexPane(api, store, session, 'Find Claude session')).code, 'NO_PANE');
    assert.deepEqual(api.callsTo('terminal.send'), []);
    assert.equal(store.sessions.size, 0);
});
