// The stylesheet as behaviour: every class the rail draws is styled and every rule is used, the 270 px layout cannot
// be widened by long text, the command clamps to two lines, and both theme palettes stay readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeNode, fakeDoc, walk } from './sidebar-fake-dom.mjs';

const dir = new URL('../ui/sidebar/', import.meta.url);
vm.runInThisContext(readFileSync(new URL('logic.js', dir), 'utf8'), { filename: 'logic.js' });
const L = globalThis.SwarmLogic;
const CSS = readFileSync(new URL('style.css', dir), 'utf8');
const HTML = readFileSync(new URL('index.html', dir), 'utf8');
const fixture = () => JSON.parse(readFileSync(new URL('fixtures/snapshot.json', dir), 'utf8'));

/** The stylesheet as data: [{ media, selector, decls }]. Comments dropped; @media blocks one level deep. */
function readRules(css) {
    const rules = [];
    const parse = (chunk, media) => {
        let i = 0;
        for (;;) {
            const open = chunk.indexOf('{', i);
            if (open < 0) break;
            const selector = chunk.slice(i, open).trim();
            let depth = 1, j = open + 1;
            for (; j < chunk.length && depth; j += 1) { if (chunk[j] === '{') depth += 1; else if (chunk[j] === '}') depth -= 1; }
            const body = chunk.slice(open + 1, j - 1);
            if (selector.startsWith('@media')) parse(body, selector.slice(6).trim());
            else {
                const decls = {};
                for (const d of body.split(';')) { const k = d.indexOf(':'); if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim(); }
                for (const sel of selector.split(',')) rules.push({ media, selector: sel.trim(), decls });
            }
            i = j;
        }
    };
    parse(css.replace(/\/\*[\s\S]*?\*\//g, ''), '');
    return rules;
}
const RULES = readRules(CSS);
const declsOf = (selector, media = '') => Object.assign({}, ...RULES.filter(r => r.media === media && r.selector === selector).map(r => r.decls));
const styledClasses = () => new Set(RULES.flatMap(r => [...r.selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => m[1])));

/** Every class name the renderers emit across the rail's states. */
function drawnClasses() {
    const classes = new Set();
    const refs = () => ({ head: new FakeNode('header'), panel: new FakeNode('section'), list: new FakeNode('div'), footer: new FakeNode('div') });
    const handlers = new Proxy({}, { get: () => () => {} });
    const draw = (snapshot, ui = { selectedPaneID: null, railFocused: true }, extra = {}) => {
        const r = refs();
        L.render(fakeDoc, r, { snapshot, ui, notice: '', receivedAtMs: 0, nowMs: 0, guard: L.createButtonGuard(), ...extra }, handlers);
        for (const root of Object.values(r)) walk(root, n => n.classes().forEach(c => classes.add(c)));
    };
    const snap = fixture();
    const id = snap.attention[0].id;
    const auto = { on: true, until: null, since: '2026-10-10T20:30:00.000Z', approved: 3, skipped: 1, failed: 1, logCount: 2, paused: [{ paneID: 'p-run', label: 'api-docs', reason: 'rate', at: '2026-10-10T21:00:00.000Z' }], ended: null };
    const entries = [{ at: '2026-10-11T02:10:00.000Z', swarmName: 'BB', swarmWorkspaceID: 'ws2', paneID: 'x1', label: 'w', command: 'npm test', ok: true },
        { at: '2026-10-11T01:00:00.000Z', swarmName: 'S', swarmWorkspaceID: 'ws1', paneID: 'p-run', label: 'a', command: 'git push', ok: false, reason: 'STALE' }];
    draw({ ...snap, warnings: ['w'], autoApprove: auto }, { selectedPaneID: 'p-run', railFocused: true, warningsOpen: true, autoLogOpen: true, closeAsk: { paneID: 'p-run', until: 9e12 } }, { autoLog: { entries, count: 2 }, notice: 'n' });
    draw(snap, { selectedPaneID: 'p-wait', railFocused: true, expanded: [id], armed: { action: 'approve', itemID: id, paneID: 'p-wait', promptHash: snap.attention[0].promptHash, until: 9e12 } });
    const closed = fixture();
    closed.workers.find(w => w.paneID === 'p-err').paneClosed = true;
    closed.attention[0] = { ...closed.attention[0], approvable: false, command: '', promptBlock: 'x\n' + '─'.repeat(10) + '\ncmd\n' + '─'.repeat(10) + '\nDo you?\n1. Yes' };
    draw(closed, { selectedPaneID: null, railFocused: false }, { autoLog: null });
    draw({ ...snap, attention: [], autoApprove: { ...auto, on: false, ended: { reason: 'expired', at: '2026-10-11T08:30:00.000Z' } } });
    // Another swarm: a card with its "from" tag, a waiting row, the other-swarms lines, and the Auto duration menu.
    const other = { ...snap.attention[0], id: 'Request:x1:1', paneID: 'x1', swarmName: 'Kelpi UI', swarmWorkspaceID: 'ws2' };
    const stopped = { ...snap, workers: snap.workers.map(w => (w.paneID === 'p-run' ? { ...w, state: 'waiting', stopped: { reason: 'usage limit reached' } } : w)) };
    draw(stopped);
    draw({ ...snap, attention: [other], autoApprove: { ...auto, on: false },
        waitingPanes: [{ paneID: 'x2', label: 'narrow', swarmName: 'Kelpi UI', swarmWorkspaceID: 'ws2' }],
        otherSwarms: [{ workspaceID: 'ws2', name: 'Kelpi UI', orchestratorPaneID: 'o2', color: 'purple', running: 1, needYou: 2, done: 0 }] },
    { selectedPaneID: null, railFocused: true, autoMenuOpen: true });
    draw({ ...snap, workers: [], attention: [], orchestrator: null });
    draw({ ...snap, codexQuestions: [{ requestID: 1, threadID: 'test', questions: [{ id: 'q', question: 'Choose?' }] }] });
    draw(null);
    return classes;
}

// Selector hooks that logic.js emits for tests and scenarios, deliberately unstyled; and classes other files add.
const HOOKS = new Set(['att-request', 'sec-running', 'sec-done', 'sec-other', 'sec-title']);
const FROM_HTML = new Set([...HTML.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
const FROM_APP_JS = new Set(['att-overflow']);

test('every class the rail draws has a style rule, and every styled class is drawn: no missing and no dead CSS', () => {
    const drawn = drawnClasses(), styled = styledClasses();
    const missing = [...drawn].filter(c => !styled.has(c) && !HOOKS.has(c));
    assert.deepEqual(missing, [], 'drawn but unstyled');
    const dead = [...styled].filter(c => !drawn.has(c) && !FROM_HTML.has(c) && !FROM_APP_JS.has(c));
    assert.deepEqual(dead, [], 'styled but never drawn');
});

test('the 270 px layout: long names ellipsise, commands wrap and clamp to two lines, the header wraps, nothing widens the rail', () => {
    const clamp = declsOf('.att-clamp');
    assert.equal(clamp['-webkit-line-clamp'], '2');
    assert.equal(clamp['line-clamp'], '2');
    assert.equal(clamp.overflow, 'hidden');
    assert.equal(clamp.display, '-webkit-box');
    const command = declsOf('.att-command');
    assert.equal(command['overflow-wrap'], 'anywhere');
    assert.equal(command['white-space'], 'pre-wrap');
    for (const sel of ['.att-pane', '.name', '.last', '.btn-auto']) {
        const d = declsOf(sel);
        assert.equal(d.overflow, 'hidden', sel);
        assert.equal(d['text-overflow'], 'ellipsis', sel);
        assert.equal(d['white-space'], 'nowrap', sel);
    }
    for (const sel of ['.att-pane', '.name', '.head-auto']) assert.equal(declsOf(sel)['min-width'], '0', sel);
    assert.equal(declsOf('.btn-auto')['max-width'], '100%');
    assert.equal(declsOf('.head')['flex-wrap'], 'wrap');
    assert.equal(declsOf('.att-actions')['flex-wrap'], 'wrap');
    for (const sel of ['.att-text', '.notice', '.warn', '.aa-note', '.aa-who']) assert.equal(declsOf(sel)['overflow-wrap'], 'anywhere', sel);
    // The "Long command" line is hidden until app.js measures a real overflow.
    assert.equal(declsOf('.att-more-maybe').display, 'none');
    assert.equal(declsOf('.att-more-maybe.att-overflow').display, 'block');
    // Stop lives only on the hovered or selected row, at the row's right edge, so Keep lands where Stop was.
    assert.equal(declsOf('.row-hover').display, 'none');
    assert.equal(declsOf('.row:hover .row-hover').display, 'flex');
    assert.equal(declsOf('.row[aria-current="true"] .row-hover').display, 'flex');
    assert.equal(declsOf('.row-actions')['justify-content'], 'flex-end');
    assert.equal(declsOf('.name').flex, '1');
    // The panel and footer take no room while empty.
    assert.equal(declsOf('.panel:empty').display, 'none');
    assert.equal(declsOf('.foot:empty').display, 'none');
});

// ---- themes ---------------------------------------------------------------------------------------------------
const hex = value => { const m = String(value).match(/#([0-9a-f]{6})\b/i); return m ? m[1] : null; };
const luminance = h => {
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** The palette one theme resolves to when the host provides no tokens: the fallback of each var(). */
function palette(media) {
    const root = declsOf(':root', media);
    const out = {};
    for (const [name, value] of Object.entries(root)) if (name.startsWith('--')) { const h = hex(value); if (h) out[name.slice(2)] = h; }
    return out;
}

test('theme tokens: a dark and a light palette, each readable (WCAG AA for text, AAA for body text)', () => {
    assert.match(declsOf(':root')['color-scheme'], /dark/);
    assert.match(declsOf(':root')['color-scheme'], /light/);
    const dark = palette(''), light = palette('(prefers-color-scheme: light)');
    for (const [name, theme] of [['dark', dark], ['light', light]]) {
        for (const token of ['bg', 'fg', 'dim', 'line', 'accent', 'surface', 'ok', 'warn', 'bad']) assert.ok(theme[token], `${name} theme defines --${token}`);
        const ratio = (a, b) => contrast(theme[a], theme[b]);
        assert.ok(ratio('fg', 'bg') >= 7, `${name}: body text ${ratio('fg', 'bg').toFixed(1)}`);
        assert.ok(ratio('dim', 'bg') >= 4.5, `${name}: dim text ${ratio('dim', 'bg').toFixed(1)}`);
        assert.ok(ratio('warn', 'bg') >= 4.5, `${name}: command text (warn on bg) ${ratio('warn', 'bg').toFixed(1)}`);
        assert.ok(ratio('bad', 'bg') >= 4.5, `${name}: error text ${ratio('bad', 'bg').toFixed(1)}`);
        assert.ok(ratio('accent', 'bg') >= 4.5, `${name}: button text and hover fill ${ratio('accent', 'bg').toFixed(1)}`);
        assert.ok(ratio('ok', 'bg') >= 3, `${name}: running dot ${ratio('ok', 'bg').toFixed(1)}`);
        assert.ok(ratio('fg', 'surface') >= 7, `${name}: card text ${ratio('fg', 'surface').toFixed(1)}`);
        assert.ok(ratio('line', 'bg') >= 1.2, `${name}: borders are visible`);
    }
    assert.ok(luminance(dark.bg) < 0.1 && luminance(light.bg) > 0.9, 'the two palettes really are dark and light');
    // The host's own tokens win in both themes.
    for (const media of ['', '(prefers-color-scheme: light)']) for (const token of ['bg', 'fg', 'accent', 'warn']) assert.match(declsOf(':root', media)[`--${token}`], /^var\(--kelpi-/, `${media || 'dark'} --${token}`);
});
