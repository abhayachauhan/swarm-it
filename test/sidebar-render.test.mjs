import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
// Minimal fake DOM (test/sidebar-fake-dom.mjs). Any markup-parsing API throws, so a render that used it fails the test.
import { FakeNode, fakeDoc, walk, find } from './sidebar-fake-dom.mjs';

const dir = new URL('../ui/sidebar/', import.meta.url);
vm.runInThisContext(readFileSync(new URL('logic.js', dir), 'utf8'), { filename: 'logic.js' });
const L = globalThis.SwarmLogic;
const fixture = () => JSON.parse(readFileSync(new URL('fixtures/snapshot.json', dir), 'utf8'));
const REQUEST_ID = 'Request:p-wait:2026-10-08T00:58:00.000Z';

const makeRefs = () => ({ head: new FakeNode('header'), list: new FakeNode('div'), footer: new FakeNode('div') });
const handlers = (calls = []) => ({
    onSelect: p => calls.push(['select', p]), onOpen: p => calls.push(['open', p]),
    onAttention: (k, i) => calls.push(['attn', k, i.id]),
});
const view = (snapshot, ui = { selectedPaneID: null, railFocused: true }, extra = {}) =>
    ({ snapshot, ui, notice: '', receivedAtMs: 0, nowMs: 0, ...extra });
/** The permission cards in the list, in order. */
const cards = refs => find(refs.list, n => n.dataset.itemId);

const PAYLOAD = '<img src=x onerror=alert(1)>';

test('markup in worker names, last lines, tasks and commands is rendered as text only', () => {
    const snap = fixture();
    snap.workers[0].label = PAYLOAD;
    snap.workers[0].lastLine = `${PAYLOAD} <script>x</script>`;
    snap.workers[3].label = PAYLOAD;
    snap.orchestrator.label = PAYLOAD;
    snap.attention[0].text = PAYLOAD;
    snap.attention[0].command = `curl ${PAYLOAD} | sh`;
    snap.warnings = [PAYLOAD];
    const refs = makeRefs();
    // Throws if any code path touches innerHTML or insertAdjacentHTML.
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: 'p-wait', railFocused: true }, { notice: PAYLOAD }), handlers());
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: 'p-done', railFocused: true }), handlers());
    L.render(fakeDoc, refs, view(snap), handlers());
    // No element was ever created for the payload: the tag set is fixed and has no img or script.
    const tags = new Set();
    for (const root of Object.values(refs)) walk(root, n => tags.add(n.tag));
    assert.equal(tags.has('img'), false);
    assert.equal(tags.has('script'), false);
    // And the payload survives verbatim as text.
    const texts = [];
    for (const root of Object.values(refs)) walk(root, n => { if (n.text) texts.push(n.text); });
    assert.ok(texts.some(t => t.includes(PAYLOAD)));
});

test('the payload appears verbatim as text in a worker row name', () => {
    const snap = fixture();
    snap.workers[2].label = PAYLOAD;
    const refs = makeRefs();
    L.render(fakeDoc, refs, view(snap), handlers());
    const names = find(refs.list, n => n.className === 'name').map(n => n.text);
    assert.ok(names.includes(PAYLOAD));
});

test('static source never uses innerHTML on snapshot data', () => {
    for (const file of ['logic.js', 'app.js']) {
        const source = readFileSync(new URL(file, dir), 'utf8');
        assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, file);
    }
});

test('the list is sectioned: Needs you (cards), Running, Done; each pane appears once; archived omitted', () => {
    const refs = makeRefs();
    L.render(fakeDoc, refs, view(fixture(), { selectedPaneID: 'p-run', railFocused: true }), handlers());
    const options = refs.list.children.filter(n => n.attrs.role === 'option');
    assert.deepEqual(options.map(r => r.dataset.paneId), ['p-wait', 'p-run']);
    assert.deepEqual(refs.list.children.filter(n => n.className.startsWith('sec-head')).map(n => n.textContent), ['Needs you · 1', 'Running · 1', 'Done · 3']);
    // The waiting worker with a card is the card, not a worker row.
    assert.equal(options[0].className, 'att att-request');
    assert.equal(options[0].dataset.itemId, 'Request:p-wait:2026-10-08T00:58:00.000Z');
    assert.equal(find(options[1], n => n.className === 'time')[0].text, '42s');
    assert.equal(options[1].attrs['aria-current'], 'true');
    assert.equal(options[0].attrs['aria-current'], 'false');
    assert.equal(find(refs.list, n => n.text === 'orchestrator' || n.text === 'coordinator').length, 0, 'no coordinator row');
});

test('the header has ⌂ Coordinator: one click runs open-thread on the coordinator; never disabled, with none known it closes the worker view', () => {
    const refs = makeRefs();
    const calls = [];
    L.render(fakeDoc, refs, view(fixture()), { ...handlers(calls), onHome: () => calls.push(['home']) });
    const home = find(refs.head, n => n.tag === 'button' && n.text === '⌂ Coordinator')[0];
    assert.ok(home);
    assert.equal(!!home.disabled, false);
    assert.match(home.attrs.title, /coordinator/);
    home.click();
    assert.deepEqual(calls, [['home']]);
    L.render(fakeDoc, refs, view({ ...fixture(), orchestrator: null }), { ...handlers(calls), onHome: () => calls.push(['home']) });
    const none = find(refs.head, n => n.tag === 'button' && n.text === '⌂ Coordinator')[0];
    assert.equal(!!none.disabled, false, 'never disabled');
    assert.equal(none.attrs.title, 'No coordinator pane known yet: closes the worker view');
    none.click();
    assert.deepEqual(calls, [['home'], ['home']]);
    assert.deepEqual(L.homeEffect({ ...fixture(), orchestrator: null }), { command: 'local.swarm-view.close-thread', args: {} });
});

test('empty sections are not drawn', () => {
    const refs = makeRefs();
    const snap = { ...fixture(), attention: [], workers: fixture().workers.filter(w => w.state === 'running') };
    L.render(fakeDoc, refs, view(snap), handlers());
    assert.deepEqual(refs.list.children.filter(n => n.className.startsWith('sec-head')).map(n => n.textContent), ['Running · 1']);
});

test('Done is a count only: no rows and no buttons; with only finished workers the rail shows just that count', () => {
    const refs = makeRefs();
    L.render(fakeDoc, refs, view(fixture()), handlers());
    const heads = refs.list.children.filter(n => n.className.startsWith('sec-head'));
    assert.deepEqual(heads.map(head => find(head, n => n.tag === 'button' || n.tagName === 'BUTTON').length), [0, 0, 0]);
    assert.equal(L.clearDoneEffect, undefined);
    const finished = { ...fixture(), attention: [], workers: fixture().workers.filter(w => w.state === 'done' || w.state === 'error') };
    L.render(fakeDoc, refs, view(finished), handlers());
    assert.deepEqual(refs.list.children.map(n => n.textContent), ['Done · 3']);
});

test('clicking a card selects it, so Y/N land on that request', () => {
    const refs = makeRefs();
    const calls = [];
    L.render(fakeDoc, refs, view(fixture()), handlers(calls));
    cards(refs)[0].click();
    assert.deepEqual(calls, [['select', 'p-wait']]);
});

test('Request cards only: no Complete or Error cards and no summary bar', () => {
    const refs = makeRefs();
    L.render(fakeDoc, refs, view(fixture()), handlers());
    const items = cards(refs);
    assert.deepEqual(items.map(i => i.dataset.itemId), ['Request:p-wait:2026-10-08T00:58:00.000Z']);
    const labels = item => find(item, n => n.tag === 'button').map(b => b.text);
    assert.deepEqual(labels(items[0]), ['Approve', 'Deny']);
    assert.equal(find(items[0], n => n.tag === 'code')[0].text, 'npm test');
    assert.equal(find(items[0], n => n.text === 'repo-lag wants to run a command').length, 0, 'the long item text is not shown');
    assert.equal(find(refs.list, n => n.className === 'strip-summary').length, 0, 'no summary bar');
    assert.equal(find(refs.list, n => /ui-polish finished|db-migrate failed/.test(n.text)).length, 0, 'finished workers are not cards');
    // The finished workers are not rows either: the Done head counts them.
    const rows = find(refs.list, n => n.className === 'row').map(r => r.dataset.paneId);
    assert.deepEqual(rows, ['p-run']);
    const quiet = { ...fixture(), attention: fixture().attention.filter(i => i.type !== 'Request') };
    L.render(fakeDoc, refs, view(quiet), handlers());
    assert.equal(cards(refs).length, 0);
});

test('attention cards name the worker (and the swarm when it is another swarm), with the pane id as a tooltip', () => {
    const snap = fixture();
    const item = snap.attention[0];
    const worker = snap.workers.find(w => w.paneID === item.paneID);
    const refs = makeRefs();
    L.render(fakeDoc, refs, view(snap), handlers());
    const pane = find(refs.list, n => n.className === 'att-pane')[0];
    assert.equal(pane.text, worker.label);
    assert.equal(pane.attrs.title, item.paneID);
    snap.attention[0] = { ...item, paneID: '0E661D85-B366-4515-9284-33A5939AAD23' };
    L.render(fakeDoc, refs, view(snap), handlers());
    assert.equal(find(refs.list, n => n.className === 'att-pane')[0].text, '0E661D85', 'unknown pane: short id');
    snap.attention[0] = { ...snap.attention[0], paneLabel: 'worker-2', swarmName: 'Other', swarmWorkspaceID: 'ws2' };
    L.render(fakeDoc, refs, view(snap), handlers());
    assert.equal(find(refs.list, n => n.className === 'att-pane')[0].text, 'worker-2 · Other', "another swarm's card names the swarm");
    assert.equal(find(refs.list, n => /^Other: /.test(n.text)).length, 0, 'the swarm is not repeated in a text line');
});

test('attention buttons call the handler with the item', () => {
    const refs = makeRefs();
    const calls = [];
    L.render(fakeDoc, refs, view(fixture(), undefined, { nowMs: 5000 }), handlers(calls));
    const first = cards(refs)[0];
    find(first, n => n.tag === 'button' && n.text === 'Approve')[0].click();
    find(first, n => n.tag === 'button' && n.text === 'Deny')[0].click();
    assert.deepEqual(calls, [['attn', 'approve', first.dataset.itemId], ['attn', 'deny', first.dataset.itemId]]);
});

test('the command is clamped to two lines; clicking it asks to expand, and an expanded card shows it whole', () => {
    const refs = makeRefs();
    const calls = [];
    const snap = fixture();
    snap.attention[0].command = 'mv /private/tmp/claude-501/swarm-prompt-probe /private/tmp/claude-501/swarm-prompt-probe2 && ls -la /private/tmp/claude-501';
    const h = { ...handlers(calls), onExpand: id => calls.push(['expand', id]) };
    L.render(fakeDoc, refs, view(snap), h);
    const code = find(cards(refs)[0], n => n.tag === 'code')[0];
    assert.equal(code.className, 'att-command att-clamp');
    assert.equal(code.attrs.title, 'Click to show the whole command');
    code.click();
    assert.deepEqual(calls, [['expand', snap.attention[0].id]]);
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: null, railFocused: true, expanded: [snap.attention[0].id] }), h);
    const open = find(cards(refs)[0], n => n.tag === 'code')[0];
    assert.equal(open.className, 'att-command');
    assert.equal(open.text, snap.attention[0].command);
    assert.equal(open.attrs.title, 'Click to shorten');
});

test('a clamped card with more than two lines says how many are hidden; an expanded one does not', () => {
    const refs = makeRefs();
    const calls = [];
    const snap = fixture();
    snap.attention[0].command = 'echo ok\n#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nrm -rf ~/repos\necho done';
    const h = { ...handlers(calls), onExpand: id => calls.push(['expand', id]) };
    L.render(fakeDoc, refs, view(snap), h);
    const more = find(cards(refs)[0], n => n.className === 'att-more dim');
    assert.equal(more.length, 1);
    assert.equal(more[0].text, '2 more lines hidden, click to show');
    more[0].click();
    assert.deepEqual(calls, [['expand', snap.attention[0].id]]);
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: null, railFocused: true, expanded: [snap.attention[0].id] }), h);
    assert.equal(find(cards(refs)[0], n => n.className.startsWith('att-more')).length, 0, 'expanded: nothing is hidden');
    // Two lines fit by count, but a long line may still wrap: the hint exists and app.js reveals it after measuring.
    snap.attention[0].command = 'one\ntwo';
    L.render(fakeDoc, refs, view(snap), h);
    const maybe = find(cards(refs)[0], n => n.className.startsWith('att-more'));
    assert.deepEqual(maybe.map(n => [n.className, n.text]), [['att-more att-more-maybe dim', 'Long command, click to show it all']]);
    // The measure itself, and its re-run on resize, are exercised in sidebar-app.test.mjs.
});

test('Approve and Deny are disabled for 400 ms after a card expands or collapses (the second click of a double-click must find nothing)', () => {
    const guard = L.createButtonGuard();
    const snap = fixture();
    const plain = { selectedPaneID: null, railFocused: true };
    const buttons = (ui, nowMs) => {
        const refs = makeRefs();
        L.render(fakeDoc, refs, view(snap, ui, { nowMs, guard }), handlers());
        return find(cards(refs)[0], n => n.tag === 'button').map(b => [b.text, !!b.disabled]);
    };
    buttons(plain, 0); // the item is known to the guard from t=0
    assert.deepEqual(buttons(plain, 1000), [['Approve', false], ['Deny', false]]);
    const expanded = L.toggleExpanded(plain, REQUEST_ID, 1000);
    assert.deepEqual(expanded.expanded, [REQUEST_ID]);
    assert.deepEqual(buttons(expanded, 1000), [['Approve', true], ['Deny', true]]);
    assert.deepEqual(buttons(expanded, 1399), [['Approve', true], ['Deny', true]]);
    assert.deepEqual(buttons(expanded, 1400), [['Approve', false], ['Deny', false]]);
    const collapsed = L.toggleExpanded(expanded, REQUEST_ID, 2000);
    assert.deepEqual(collapsed.expanded, []);
    assert.deepEqual(buttons(collapsed, 2300), [['Approve', true], ['Deny', true]]);
    assert.equal(L.LAYOUT_LOCK_MS, 400);
    assert.equal(L.layoutLockRemaining(collapsed, 2100), 300);
    assert.equal(L.layoutLockRemaining(collapsed, 2400), 0);
    assert.equal(L.layoutLockRemaining(plain, 2100), 0, 'no layout change: no lock');
});

test('"Really stop?" is disabled for 400 ms after Stop is armed; Keep is the last button, where Stop was', () => {
    const snap = fixture();
    const h = { ...handlers(), onCloseAsk() {}, onCloseConfirm() {}, onCloseCancel() {} };
    const row = (ui, nowMs) => {
        const refs = makeRefs();
        L.render(fakeDoc, refs, view(snap, ui, { nowMs, guard: L.createButtonGuard() }), h);
        return find(find(refs.list, n => n.dataset.paneId === 'p-run')[0], n => n.tag === 'button').map(b => [b.text, !!b.disabled]);
    };
    assert.deepEqual(row({ selectedPaneID: 'p-run', railFocused: true }, 1000), [['Stop', false]]);
    const asked = L.askClose({ selectedPaneID: 'p-run', railFocused: true }, 'p-run', 1000);
    assert.deepEqual(asked.closeAsk, { paneID: 'p-run', until: 1000 + L.ARM_MS });
    assert.deepEqual(row(asked, 1000), [['Really stop?', true], ['Keep', false]]);
    assert.deepEqual(row(asked, 1399), [['Really stop?', true], ['Keep', false]]);
    assert.deepEqual(row(asked, 1400), [['Really stop?', false], ['Keep', false]]);
    // Keep brings Stop back under the pointer; arming it again starts the lock again.
    const kept = L.cancelClose(asked, 2000);
    assert.equal(kept.closeAsk, null);
    assert.deepEqual(row(kept, 2000), [['Stop', false]]);
    assert.deepEqual(row(L.askClose(kept, 'p-run', 2100), 2300), [['Really stop?', true], ['Keep', false]]);
    // The X key arms through the same path.
    const byKey = L.reduceKey({ selectedPaneID: 'p-run', railFocused: true }, snap, { key: 'x', nowMs: 5000 });
    assert.deepEqual(row(byKey.ui, 5100), [['Really stop?', true], ['Keep', false]]);
});

test('empty states: one line when there is nothing at all, Connecting before the first snapshot', () => {
    const refs = makeRefs();
    const empty = { ...fixture(), orchestrator: null, workers: [], attention: [], snoozed: [] };
    L.render(fakeDoc, refs, view(empty), handlers());
    assert.deepEqual(refs.list.children.map(n => n.text), ['No workers yet.']);
    L.render(fakeDoc, refs, view(null), handlers());
    assert.match(refs.list.textContent, /Connecting/);
    assert.equal(refs.list.children.length, 1);
});

test('notice (for example an archive refusal) is shown in the footer', () => {
    const refs = makeRefs();
    const message = L.describeResult('Archive', { ok: false, code: 'DIRTY', error: 'Worktree has uncommitted changes' }).message;
    L.render(fakeDoc, refs, view(fixture(), undefined, { notice: message }), handlers());
    const notice = find(refs.footer, n => n.className === 'notice')[0];
    assert.equal(notice.text, 'Archive: Worktree has uncommitted changes');
    assert.equal(notice.attrs.role, 'alert');
});

test('the footer is quiet: no counts line, no key hint, no warnings; empty without a notice', () => {
    const refs = makeRefs();
    const snap = fixture();
    snap.warnings = ['manifest invalid'];
    L.render(fakeDoc, refs, view(snap), handlers());
    assert.equal(refs.footer.children.length, 0);
    L.render(fakeDoc, refs, view(snap, undefined, { notice: 'Stop: refused' }), handlers());
    assert.deepEqual(refs.footer.children.map(n => [n.className, n.text]), [['notice', 'Stop: refused']]);
    assert.equal(refs.head.attrs.title, L.KEY_HINT, 'the key hint is the header tooltip');
    assert.match(L.KEY_HINT, /Ctrl\+Alt\+J/);
});

test('warnings: a small ⚠ N in the header with the list as tooltip; a click expands them under the header', () => {
    const refs = { ...makeRefs(), panel: new FakeNode('section') };
    const snap = fixture();
    snap.warnings = ['manifest: invalid json', 'autohide: 2 workers waiting for a retry'];
    const calls = [];
    const h = { ...handlers(calls), onHome() {}, onWarnings: () => calls.push(['warnings']) };
    L.render(fakeDoc, refs, view(snap), h);
    const warn = find(refs.head, n => n.tag === 'button' && n.text === '⚠ 2')[0];
    assert.ok(warn, 'the badge');
    assert.equal(warn.attrs.title, 'manifest: invalid json\nautohide: 2 workers waiting for a retry');
    assert.equal(warn.attrs['aria-expanded'], 'false');
    assert.equal(refs.panel.children.length, 0, 'closed by default');
    warn.click();
    assert.deepEqual(calls, [['warnings']]);
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: null, railFocused: true, warningsOpen: true }), h);
    assert.equal(find(refs.head, n => n.text === '⚠ 2')[0].attrs['aria-expanded'], 'true');
    assert.deepEqual(find(refs.panel, n => n.className === 'warn').map(n => n.text), snap.warnings);
    // No warnings: no badge, no panel even when "open".
    L.render(fakeDoc, refs, view(fixture(), { selectedPaneID: null, railFocused: true, warningsOpen: true }), h);
    assert.equal(find(refs.head, n => n.className === 'btn btn-warn').length, 0);
    assert.equal(refs.panel.children.length, 0);
    assert.deepEqual(L.warningsOf({ warnings: ['a', '', 3, 'b'] }), ['a', 'b']);
    assert.deepEqual(L.warningsOf(null), []);
    // app.js sends each new set of warnings to console.warn once: sidebar-app.test.mjs.
});

test('sidebar listens only to the focus-rail event, with no window focus or pointer fallbacks', () => {
    const src = readFileSync(new URL('app.js', dir), 'utf8');
    assert.match(src, /'local\.swarm-view\.focus-rail'/);
    assert.equal(src.includes('local.swarm-view.focus\''), false);
    // document.hasFocus() may only confirm a blur (resolveBlur); it never grants focus.
    assert.deepEqual(src.match(/hasFocus/g), ['hasFocus']);
    assert.match(src, /L\.resolveBlur\(ui, Date\.now\(\), document\.hasFocus\(\)\)/);
    assert.equal(src.includes("addEventListener('focus'"), false);
    assert.equal(/pointerdown[^\n]*setFocused/.test(src), false);
});

test('an unrecognised prompt (approvable=false): label, the guessed command, "Answer in the pane" and a "Go to pane" button; no Approve or Deny', () => {
    const snap = fixture();
    snap.attention[0].approvable = false;
    snap.attention[0].command = '';
    snap.attention[0].promptBlock = 'Weird thing\nDo you want to?\n1. Yes';
    const refs = makeRefs();
    const calls = [];
    const h = { ...handlers(calls), onAnswer: item => calls.push(['answer', item.id]) };
    L.render(fakeDoc, refs, view(snap), h);
    const item = cards(refs)[0];
    assert.equal(find(item, n => n.className === 'att-pane')[0].text, 'repo-lag');
    assert.equal(find(item, n => n.tag === 'code')[0].text, 'repo-lag wants to run a command', 'no rule-delimited command: the item text stands in');
    assert.ok(find(item, n => n.text === 'Answer in the pane').length === 1);
    const buttons = find(item, n => n.tag === 'button');
    assert.deepEqual(buttons.map(b => b.text), ['Go to pane']);
    assert.match(buttons[0].attrs.title, /pane/);
    buttons[0].click();
    assert.deepEqual(calls, [['answer', snap.attention[0].id]]);
    assert.equal(find(item, n => n.tag === 'pre' || n.tag === 'details').length, 0, 'no full-prompt fold');
});

test('an unrecognised newer-layout prompt shows just the command between the rules', () => {
    const snap = fixture();
    snap.attention[0].approvable = false;
    snap.attention[0].command = '';
    snap.attention[0].promptBlock = ['Still waiting on the agent', 'Bash command · from the general-purpose agent', 'Run shell command',
        '╌'.repeat(40), 'gh pr ready 490 --repo acme/widgets', '╌'.repeat(40),
        'Ask rule Bash(gh pr ready *) overrides auto mode', 'Do you want to proceed?', '❯ 1. Yes', '2. No'].join('\n');
    const refs = makeRefs();
    L.render(fakeDoc, refs, view(snap), { ...handlers([]), onAnswer() {} });
    const item = cards(refs)[0];
    assert.equal(find(item, n => n.tag === 'code')[0].text, 'gh pr ready 490 --repo acme/widgets');
    assert.equal(find(item, n => n.tag === 'details').length, 0);
    assert.equal(find(item, n => /Still waiting|Ask rule/.test(n.text)).length, 0, 'the rest of the prompt is not shown');
});

test('Y/N on an unrecognised prompt gives a notice, not an approve effect, and never arms', () => {
    const snap = fixture();
    const item = snap.attention.find(i => i.type === 'Request');
    item.approvable = false;
    const ui = { selectedPaneID: item.paneID, railFocused: true };
    for (const k of ['y', 'n']) {
        const first = L.reduceKey(ui, snap, { key: k, nowMs: 1000 });
        assert.equal(first.handled, true);
        assert.equal(first.effect, null);
        assert.equal(first.notice, 'Unrecognised prompt: answer it in the pane.');
        assert.equal(first.ui.armed ?? null, null, 'nothing to confirm with a second press');
        const second = L.reduceKey(first.ui, snap, { key: k, nowMs: 1500 });
        assert.equal(second.effect, null, 'the second press sends nothing either');
    }
});

test('Approve and Deny render disabled while the guard says the item just changed, enabled afterwards', () => {
    const snap = fixture();
    const guard = L.createButtonGuard();
    const buttons = nowMs => {
        const refs = makeRefs();
        L.render(fakeDoc, refs, view(snap, undefined, { nowMs, guard }), handlers());
        const item = cards(refs).find(n => n.className.includes('att-request'));
        return find(item, n => n.tag === 'button').slice(0, 2).map(b => [b.text, !!b.disabled]);
    };
    assert.deepEqual(buttons(1000), [['Approve', true], ['Deny', true]]);
    assert.deepEqual(buttons(1499), [['Approve', true], ['Deny', true]]);
    assert.deepEqual(buttons(1500), [['Approve', false], ['Deny', false]]);
});

test('an armed item shows "Press Y again to approve" and expires with the arm', () => {
    const snap = fixture();
    const item = snap.attention.find(i => i.type === 'Request');
    const armed = { action: 'approve', itemID: item.id, paneID: item.paneID, promptHash: item.promptHash, until: 4000 };
    const texts = nowMs => {
        const refs = makeRefs();
        L.render(fakeDoc, refs, view(snap, { selectedPaneID: item.paneID, railFocused: true, armed }, { nowMs, guard: L.createButtonGuard() }), handlers());
        return find(cards(refs)[0], n => n.text).map(n => n.text);
    };
    assert.ok(texts(3999).includes('Press Y again to approve'));
    assert.ok(!texts(4000).some(t => /again/.test(t)));
});

test('row verbs: Stop (two steps, hover or selected only) while running; Open and ✕ for done, error and closed panes', () => {
    const snap = fixture();
    snap.workers.find(w => w.paneID === 'p-err').paneClosed = true;
    const refs = makeRefs();
    const calls = [];
    const h = { ...handlers(calls), onCloseAsk: p => calls.push(['ask', p]), onCloseConfirm: p => calls.push(['confirm', p]), onCloseCancel: () => calls.push(['keep']), onClose: p => calls.push(['close', p]), onDismiss: p => calls.push(['dismiss', p]) };
    L.render(fakeDoc, refs, view(snap), h);
    const row = id => find(refs.list, n => n.dataset.paneId === id)[0];
    const buttons = id => find(row(id), n => n.tag === 'button').map(b => b.text);
    const actions = id => find(row(id), n => n.className.startsWith('row-actions'))[0];
    assert.deepEqual(buttons('p-run'), ['Stop']);
    assert.equal(actions('p-run').className, 'row-actions row-hover', 'Stop is only shown on the hovered or selected row');
    // A waiting worker without a card is a Running row with Stop.
    const noCard = { ...snap, attention: snap.attention.filter(i => i.type !== 'Request') };
    L.render(fakeDoc, refs, view(noCard), h);
    assert.deepEqual(buttons('p-wait'), ['Stop']);
    L.render(fakeDoc, refs, view(snap), h);
    for (const id of ['p-done', 'p-err', 'p-acc']) assert.equal(row(id), undefined, `${id}: finished, no row`);
    for (const gone of ['pane closed', 'Close', 'Accept', 'accepted', 'Dismiss', 'Open', '✕']) assert.equal(find(refs.list, n => n.text === gone).length, 0, `no "${gone}"`);
    find(row('p-run'), n => n.tag === 'button')[0].click();
    assert.deepEqual(calls, [['ask', 'p-run']]);
    // The second step, on the asked row: Really stop? / Keep.
    calls.length = 0;
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: 'p-run', railFocused: true, closeAsk: { paneID: 'p-run', until: 9e12 } }), h);
    assert.deepEqual(buttons('p-run'), ['Really stop?', 'Keep']);
    find(row('p-run'), n => n.text === 'Really stop?')[0].click();
    find(row('p-run'), n => n.text === 'Keep')[0].click();
    assert.deepEqual(calls, [['confirm', 'p-run'], ['keep']]);
});

test('the status line is clean: no box drawing, no git status, a prompt line becomes the state', () => {
    const refs = makeRefs();
    const snap = fixture();
    const set = (id, lastLine) => { snap.workers.find(w => w.paneID === id).lastLine = lastLine; };
    set('p-run', '│ Reading files ─── main ↑16 !10 ?3');
    L.render(fakeDoc, refs, view(snap), handlers());
    const last = id => find(find(refs.list, n => n.dataset.paneId === id)[0], n => n.className === 'last')[0].text;
    assert.equal(last('p-run'), 'Reading files main');
    set('p-run', '╭──────────────────────╮');
    L.render(fakeDoc, refs, view(snap), handlers());
    assert.equal(last('p-run'), 'running');
});

// ---- auto-approve ---------------------------------------------------------------------------------------------
const autoRefs = () => ({ ...makeRefs(), panel: new FakeNode('section') });
const autoHandlers = (calls = []) => ({
    ...handlers(calls), onHome() {}, onWarnings() {},
    onAutoOn: h => calls.push(['auto-on', h]), onAutoOff: () => calls.push(['auto-off']),
    onAutoLogToggle: () => calls.push(['auto-log']), onAutoLogClear: () => calls.push(['auto-clear']),
});
const AUTO_ON = { on: true, until: '2026-10-11T08:30:00.000Z', since: '2026-10-10T20:30:00.000Z', approved: 14, skipped: 0, failed: 0, logCount: 14, paused: [], ended: null };
const autoToggle = refs => find(refs.head, n => n.className.startsWith('btn btn-auto'))[0];

test('auto-approve off: the header says "Auto: off"; a click opens a menu of 4 hours, 12 hours and until 9am, with no "no limit"', () => {
    const snap = { ...fixture(), autoApprove: { ...AUTO_ON, on: false, until: null, approved: 0, logCount: 0 } };
    const refs = autoRefs();
    const calls = [];
    const handlersWithMenu = { ...autoHandlers(calls), onAutoMenu: () => calls.push(['auto-menu']) };
    L.render(fakeDoc, refs, view(snap), handlersWithMenu);
    const toggle = autoToggle(refs);
    assert.equal(toggle.text, 'Auto: off');
    assert.equal(toggle.attrs.role, 'switch');
    assert.equal(toggle.attrs['aria-checked'], 'false', 'a switch carries aria-checked');
    assert.equal(toggle.attrs['aria-pressed'], undefined, 'not aria-pressed (that is for toggle buttons)');
    assert.equal(toggle.attrs['aria-expanded'], 'false');
    toggle.click();
    assert.deepEqual(calls, [['auto-menu']], 'the click opens the menu; nothing is turned on yet');
    const texts = find(refs.head, n => n.tag === 'button').map(b => b.text);
    assert.deepEqual(texts, ['⌂ Coordinator', 'Auto: off'], 'no log link while the log is empty');
    assert.equal(find(refs.panel, n => n.tag === 'button').length, 0, 'the menu is closed until opened');
    // Open (ui.autoMenuOpen): four choices, each sending its key.
    const morning = new Date(2026, 9, 11, 7, 30).getTime();
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: null, railFocused: true, autoMenuOpen: true }, { nowMs: morning }), handlersWithMenu);
    const choices = find(refs.panel, n => n.tag === 'button');
    assert.deepEqual(choices.map(b => b.text), ['10 minutes', '4 hours', '12 hours', 'Until 9am today']);
    choices.forEach(b => b.click());
    assert.deepEqual(calls.slice(1), [['auto-on', '10m'], ['auto-on', '4h'], ['auto-on', '12h'], ['auto-on', '9am']]);
    // The menu is not drawn while auto-approve is on.
    L.render(fakeDoc, refs, view({ ...snap, autoApprove: AUTO_ON }, { selectedPaneID: null, railFocused: true, autoMenuOpen: true }), handlersWithMenu);
    assert.equal(find(refs.panel, n => n.tag === 'button' && /hours|9am/.test(n.text)).length, 0);
    assert.equal(L.AUTO_HOURS, undefined);
    assert.equal(L.AUTO_DEFAULT_HOURS, 12);
    assert.deepEqual(L.autoOnEffect(), { command: 'local.swarm-view.auto-approve', args: { on: true, hours: 12 } });
    assert.deepEqual(L.autoOnEffect(4).args, { on: true, hours: 4 });
    assert.deepEqual(L.autoOffEffect(), { command: 'local.swarm-view.auto-approve', args: { on: false } });
    assert.deepEqual(L.autoLogClearEffect().args, { clear: true });
    // Without autoApprove in the snapshot (older backend) the toggle still reads off.
    L.render(fakeDoc, refs, view({ ...fixture(), autoApprove: null }), autoHandlers());
    assert.equal(autoToggle(refs).text, 'Auto: off');
    const app = readFileSync(new URL('app.js', dir), 'utf8');
    assert.doesNotMatch(app, /autoAsk|onAutoAsk|onAutoCancel/, 'the old picker is gone from app.js too');
});

test('the Auto menu choices: 10 minutes, 4 and 12 hours, and until 9am today before 9, else tomorrow (local time)', () => {
    const at = (h, m = 0) => new Date(2026, 9, 11, h, m).getTime();
    assert.deepEqual(L.autoChoiceEffect('10m', at(10)).args, { on: true, hours: 10 / 60 });
    assert.deepEqual(L.autoChoiceEffect('4h', at(10)).args, { on: true, hours: 4 });
    assert.deepEqual(L.autoChoiceEffect('12h', at(10)).args, { on: true, hours: 12 });
    assert.equal(L.autoChoiceEffect('9am', at(8, 59)).args.until, new Date(2026, 9, 11, 9).toISOString());
    assert.equal(L.autoChoiceEffect('9am', at(9)).args.until, new Date(2026, 9, 12, 9).toISOString());
    assert.equal(L.autoChoiceEffect('9am', at(23, 30)).args.until, new Date(2026, 9, 12, 9).toISOString());
    assert.equal(L.autoChoiceEffect('none', at(10)), null);
    assert.deepEqual(L.autoChoices(at(8)).map(c => c.label), ['10 minutes', '4 hours', '12 hours', 'Until 9am today']);
    assert.deepEqual(L.autoChoices(at(21)).map(c => c.label), ['10 minutes', '4 hours', '12 hours', 'Until 9am tomorrow']);
});

test('auto-approve on: "Auto: on · 14 ✓ · until 08:30", notes in the tooltip, one click turns it off', () => {
    const snap = { ...fixture(), autoApprove: { ...AUTO_ON, skipped: 2, paused: [{ paneID: 'p-run', label: 'api-docs', reason: 'more than 30 auto-approvals in 10 minutes; its cards are left for you', at: AUTO_ON.since }] } };
    const refs = autoRefs();
    const calls = [];
    L.render(fakeDoc, refs, view(snap), autoHandlers(calls));
    const toggle = autoToggle(refs);
    assert.match(toggle.text, /^Auto: on · 14 ✓ · until \d{2}:\d{2}$/);
    assert.equal(toggle.text, L.autoLabel(snap.autoApprove));
    assert.equal(toggle.className, 'btn btn-auto btn-auto-on');
    assert.equal(toggle.attrs['aria-checked'], 'true');
    const tip = toggle.attrs.title.split('\n');
    assert.match(tip[0], /Click to turn off/);
    assert.ok(tip.includes('2 unrecognised prompts left for you'));
    assert.ok(tip.some(t => /^Stopped for api-docs: more than 30 auto-approvals/.test(t)));
    toggle.click();
    assert.deepEqual(calls, [['auto-off']]);
    assert.equal(L.autoLabel({ ...AUTO_ON, until: null }), 'Auto: on · 14 ✓ · until turned off');
    assert.equal(find(refs.head, n => n.className === 'aa-banner').length, 0, 'no banner');
});

test('after the timer switched it off the toggle reads off and its tooltip says why', () => {
    const auto = { ...AUTO_ON, on: false, until: null, ended: { reason: 'expired', at: '2026-10-11T08:30:00.000Z' } };
    const refs = autoRefs();
    L.render(fakeDoc, refs, view({ ...fixture(), autoApprove: auto }), autoHandlers());
    const toggle = autoToggle(refs);
    assert.equal(toggle.text, 'Auto: off');
    assert.match(toggle.attrs.title, /Auto-approve switched itself off at \d{2}:\d{2}: the time ran out\. 14 approved\./);
    assert.match(L.autoEndedText({ ...auto, ended: { reason: 'user', at: auto.ended.at } }), /^Auto-approve turned off at \d{2}:\d{2}\. 14 approved\.$/);
    assert.equal(L.autoEndedText(AUTO_ON), '');
    assert.equal(L.autoEndedText(null), '');
    assert.deepEqual(L.autoNotes(null), []);
    assert.deepEqual(L.autoNotes({ ...AUTO_ON, on: false, skipped: 3, failed: 1, ended: null }), [], 'skipped and failed only matter while on');
});

test('the "log" link appears only when the log has entries and expands it under the header: newest first, refusals marked, Clear', () => {
    const entries = [
        { at: '2026-10-11T02:10:00.000Z', swarmName: 'BB', swarmWorkspaceID: 'ws2', paneID: 'x1', label: 'worker-2', command: 'npm test', ok: true },
        { at: '2026-10-11T01:00:00.000Z', swarmName: 'Swarm', swarmWorkspaceID: 'ws1', paneID: 'p-run', label: 'api-docs', command: 'git push', ok: false, reason: 'the permission prompt changed since it was displayed; review it again', code: 'STALE' }
    ];
    const snap = { ...fixture(), autoApprove: { ...AUTO_ON, logCount: 2, failed: 1 } };
    const refs = autoRefs();
    const calls = [];
    L.render(fakeDoc, refs, view(snap), autoHandlers(calls));
    const link = find(refs.head, n => n.tag === 'button' && n.text === 'log')[0];
    assert.ok(link, 'the log link');
    assert.equal(link.attrs.title, 'Auto-approved (2): click to show the log');
    assert.equal(link.attrs['aria-expanded'], 'false');
    assert.equal(refs.panel.children.length, 0, 'closed by default');
    link.click();
    assert.deepEqual(calls, [['auto-log']]);
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: null, railFocused: true, autoLogOpen: true }, { autoLog: { entries, count: 2 } }), autoHandlers(calls));
    assert.equal(find(refs.head, n => n.text === 'log')[0].attrs['aria-expanded'], 'true');
    const log = find(refs.panel, n => n.className === 'panel-log')[0];
    assert.ok(log);
    assert.equal(log.children[0].text, 'Auto-approved (2)');
    assert.ok(find(log, n => n.text === '1 refused by the live check (see the log)').length, 'notes sit above the entries');
    const rows = find(log, n => n.className.startsWith('aa-entry'));
    assert.equal(rows.length, 2);
    assert.equal(find(rows[0], n => n.className === 'aa-who')[0].text, 'BB: worker-2');
    assert.equal(find(rows[0], n => n.tag === 'code')[0].text, 'npm test');
    assert.equal(rows[1].className, 'aa-entry aa-failed');
    assert.match(find(rows[1], n => n.className === 'aa-reason')[0].text, /^Not approved: the permission prompt changed/);
    find(log, n => n.tag === 'button' && n.text === 'Clear')[0].click();
    assert.deepEqual(calls.slice(1), [['auto-clear']]);
    // Not fetched yet: a loading line. Empty log: no link and no panel even when "open".
    L.render(fakeDoc, refs, view(snap, { selectedPaneID: null, railFocused: true, autoLogOpen: true }), autoHandlers());
    assert.ok(find(refs.panel, n => n.text === 'Loading...').length);
    L.render(fakeDoc, refs, view({ ...fixture(), autoApprove: { ...AUTO_ON, logCount: 0 } }, { selectedPaneID: null, railFocused: true, autoLogOpen: true }), autoHandlers());
    assert.equal(find(refs.head, n => n.text === 'log').length, 0);
    assert.equal(refs.panel.children.length, 0);
});

test('a rail without the head and panel containers (older refs) still renders the list', () => {
    const refs = { list: new FakeNode('div'), footer: new FakeNode('div') };
    L.render(fakeDoc, refs, view({ ...fixture(), autoApprove: AUTO_ON }), autoHandlers());
    assert.ok(find(refs.list, n => n.className === 'row').length);
});
