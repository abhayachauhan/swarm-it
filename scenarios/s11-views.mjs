#!/usr/bin/env node
// S11: verify the sidebar rail view and the thread view LIVE, through the private instance's Chromium debug port (CDP over
// Node's global WebSocket, no deps). Re-runnable: node scenarios/s11-views.mjs   (needs SWARM_VIEW_SOCKET=tcp:127.0.0.1:...)
// CDP port: SWARM_VIEW_CDP (default http://127.0.0.1:56354, the debug port Kelpi's scripts/dev-instance.mjs prints).
//
// The rail under test is the simplified one: header (⌂ Coordinator, Auto toggle), sections Needs you / Running / Done,
// permission cards (command clamped to two lines, Approve/Deny, or "Answer in the pane" + "Go to pane"), worker rows
// with a two-step Stop, and a footer that carries only notices.
import fs from 'node:fs';
import path from 'node:path';
import { cmd, k, send, setup, teardown, setSetting, reinstall, ensureManifest, manifestWriter, activateSwarm, waitFor, sleep, tmpDir, fakeScript, record, OUT, SOCKET } from './lib.mjs';

export const name = 'S11-views';
const CDP = process.env.SWARM_VIEW_CDP || 'http://127.0.0.1:56354';
const HOSTILE_IMG = '<img src=x onerror=window.__pwn=1>';
const HOSTILE_TASK = '<script>window.__pwn=1</script><b>bold task</b>';
const HOSTILE_LABEL = '<img src=x onerror=window.__pwn=2>';

/** Minimal CDP session over one target's websocket. */
async function attach(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`ws open failed ${target.id}`)); });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async expression => {
        const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
    };
    return { target, call, evaluate, close: () => ws.close() };
}
const targets = async () => (await (await fetch(`${CDP}/json/list`)).json());
async function findView(predicateExpr, label) {
    return waitFor(async () => {
        for (const t of (await targets()).filter(x => x.type === 'iframe')) {
            const s = await attach(t).catch(() => null);
            if (!s) continue;
            try { if (await s.evaluate(predicateExpr)) return s; } catch { /* not ready */ }
            s.close();
        }
        return null;
    }, { timeout: 25000, every: 1000, label });
}
const key = async (session, keyName, code, vk) => {
    const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await session.call('Input.dispatchKeyEvent', { type: 'keyDown', text: keyName.length === 1 ? keyName.toLowerCase() : undefined, ...base });
    await session.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};
const KEYS = { j: ['j', 'KeyJ', 74], k: ['k', 'KeyK', 75], x: ['x', 'KeyX', 88], Enter: ['Enter', 'Enter', 13] };
async function shot(session, file) {
    fs.mkdirSync(OUT, { recursive: true });
    const r = await session.call('Page.captureScreenshot', { format: 'png' });
    const full = path.join(OUT, file);
    fs.writeFileSync(full, Buffer.from(r.data, 'base64'));
    return full;
}

// What the rail shows, read from its DOM: header buttons, sections, every selectable option in J/K order, worker rows,
// permission cards, the footer, and whether anything widened the 270 px rail.
const RAIL_PROBE = `(() => {
  const list = document.getElementById('list');
  const btn = b => ({ label: b.textContent, disabled: b.disabled });
  const visible = el => el && getComputedStyle(el).display !== 'none';
  return {
    focused: list.dataset.railFocused === 'true',
    home: (b => b ? btn(b) : null)(document.querySelector('#head .btn-home')),
    auto: document.querySelector('#head .btn-auto')?.textContent ?? '',
    sections: [...list.querySelectorAll('.sec-head .sec-title')].map(h => h.textContent),
    options: [...list.querySelectorAll('[role="option"]')].map(o => ({ pane: o.dataset.paneId, kind: o.classList.contains('att') ? 'card' : 'row', selected: o.getAttribute('aria-current') === 'true' })),
    rows: [...list.querySelectorAll('.row')].map(r => ({ pane: r.dataset.paneId, state: r.dataset.state, name: r.querySelector('.name')?.textContent, last: r.querySelector('.last')?.textContent, selected: r.getAttribute('aria-current') === 'true', buttons: [...r.querySelectorAll('button')].map(btn) })),
    cards: [...list.querySelectorAll('.att')].map(a => ({ id: a.dataset.itemId, pane: a.dataset.paneId, title: a.querySelector('.att-pane')?.textContent, paneTip: a.querySelector('.att-pane')?.title, command: a.querySelector('.att-command')?.textContent ?? '', clamped: !!a.querySelector('.att-clamp'), more: [...a.querySelectorAll('.att-more')].filter(visible).map(m => m.textContent), answerInPane: [...a.querySelectorAll('.att-text')].some(t => t.textContent === 'Answer in the pane'), selected: a.getAttribute('aria-current') === 'true', buttons: [...a.querySelectorAll('button')].map(btn) })),
    footer: document.getElementById('footer').textContent,
    width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    imgs: document.querySelectorAll('img, #app script').length, pwn: window.__pwn ?? null
  };
})()`;

const THREAD_PROBE = `(() => ({
  name: document.getElementById('name').textContent, state: document.getElementById('state').textContent,
  task: document.getElementById('task').textContent, taskHtml: document.getElementById('task').innerHTML,
  back: { label: document.getElementById('back').textContent, disabled: document.getElementById('back').disabled },
  requestHidden: document.getElementById('request').hidden, origin: document.getElementById('requestOrigin').textContent,
  command: document.getElementById('requestCommand').textContent,
  approveDisabled: document.getElementById('approve').disabled, denyDisabled: document.getElementById('deny').disabled,
  imgs: document.querySelectorAll('img, #app script').length, bold: document.querySelectorAll('#task b').length, pwn: window.__pwn ?? null
}))()`;

export async function run(ctx) {
    const ev = {};
    const dir = tmpDir();
    const sessions = [];
    try {
        ev.reinstallExit = await reinstall();
        await setSetting('autoHide', true); // workers stay unattended (hidden workspace), so daemon.notification fires
        const resultDir = await ensureManifest(ctx);
        await manifestWriter(['add-worker', ctx.ws.id, ctx.workers.w3, 'w3', HOSTILE_TASK, `${resultDir}/w3-result.md`, '-']);
        let poke = 0; // each pane rename is a state change that makes the plugin re-read the manifest and settle (auto-hide)
        const renamePane = async () => (await k(['pane', 'name', '--target', ctx.workers.w3, poke++ % 2 ? `${HOSTILE_LABEL} ` : HOSTILE_LABEL])).code;
        ev.hostilePaneRename = await renamePane();
        // let the plugin load the manifest and move the workers to the hidden workspace before anything notifies
        await waitFor(async () => { const s = (await cmd('get-state')).snapshot; if (s.workers.length === 3 && s.workers.every(w => w.hidden)) return true; await renamePane(); return false; }, { timeout: 60000, label: 'workers hidden' }).catch(async error => {
            const s = (await cmd('get-state')).snapshot;
            ev.stateOnTimeout = { workers: s.workers.map(w => `${w.label}:${w.state}:hidden=${w.hidden}`), warnings: s.warnings, orchestrator: s.orchestrator };
            throw error;
        });
        await sleep(2000);
        const { w1, w2, w3 } = ctx.workers;
        await send(w1, `bash ${fakeScript('perm-worker.sh')} ${dir}/w1.key ${dir}/w1.swap real 'rm -rf node_modules' 'echo ${HOSTILE_IMG}'`);
        await send(w2, `bash ${fakeScript('unknown-worker.sh')}`);
        await waitFor(async () => { const s = (await cmd('get-state')).snapshot; return s.attention.filter(i => i.type === 'Request').length >= 2; }, { timeout: 30000, label: 'two Request items' }).catch(async error => {
            const s = (await cmd('get-state')).snapshot;
            ev.stateOnTimeout = { attention: s.attention.map(i => `${i.type}:${i.paneID}`), workers: s.workers.map(w => `${w.label}:${w.state}`), warnings: s.warnings, orchestrator: s.orchestrator?.source };
            ev.screens = { w1: (await k(['pane', 'capture', '--target', w1, '--lines', '15'])).stdout, w2: (await k(['pane', 'capture', '--target', w2, '--lines', '15'])).stdout };
            throw error;
        });
        ev.activate = await activateSwarm(ctx);
        ev.focusRail = (await cmd('focus-rail')).ok;

        // ---- (a) rail: snapshot event received; header, sections, one option per pane, no coordinator row, nothing widens it
        const rail = await findView(`!!document.getElementById('list') && [...document.querySelectorAll('#list .att')].some(a => a.dataset.paneId === ${JSON.stringify(w1)})`, 'rail view iframe showing the w1 card');
        sessions.push(rail);
        await rail.evaluate(`(() => { window.__ev = []; window.kelpi.events.on('*', (...a) => { window.__ev.push(a.map(x => typeof x === 'string' ? x : x && typeof x === 'object' ? { name: x.name ?? x.type, keys: Object.keys(x).slice(0, 8), seq: x.data?.sequence ?? x.sequence } : typeof x)); }); return true; })()`);
        await send(w3, 'kelpi event start --agent claude'); // forces a publish
        const events = await waitFor(async () => { const e = await rail.evaluate('window.__ev'); return e.length ? e : null; }, { timeout: 15000, label: 'snapshot event in the rail view' });
        ev.eventsSeenByRail = events.slice(0, 3);
        ev.eventNames = [...new Set(events.map(a => a.find(x => x && x.name)?.name ?? (typeof a[0] === 'string' ? a[0] : '?')))];
        const probe = async () => rail.evaluate(RAIL_PROBE);
        // Approve/Deny stay disabled for 500 ms after a card appears: wait until the w1 card is live and unlocked.
        const p = await waitFor(async () => { const x = await probe(); const c = x.cards.find(i => i.pane === w1); return x.cards.length >= 2 && c && c.buttons.some(b => b.label === 'Approve' && !b.disabled) ? x : null; }, { timeout: 15000, label: 'rail cards and rows' });
        const snap = (await cmd('get-state')).snapshot;
        ev.rail = { sections: p.sections, options: p.options.map(o => `${o.kind}:${o.pane === w1 ? 'w1' : o.pane === w2 ? 'w2' : o.pane === w3 ? 'w3' : o.pane}`), rows: p.rows.map(r => `${r.name}:${r.state}`), home: p.home, auto: p.auto, width: p.width, scrollWidth: p.scrollWidth };
        const carded = new Set(p.cards.map(c => c.pane));
        const aPass = ev.eventNames.length > 0
            && p.home && p.home.label === '⌂ Coordinator' && !p.home.disabled
            && /^Auto: off$/.test(p.auto)
            && p.sections[0] === `Needs you · ${p.cards.length}` && p.sections.every(s => /^(Needs you|Running|Done) · \d+$/.test(s))
            && p.options.length === snap.workers.length && snap.workers.every(w => p.options.some(o => o.pane === w.paneID))
            && p.rows.every(r => !carded.has(r.pane)) && !p.options.some(o => o.pane === ctx.coordinator)
            && p.scrollWidth <= p.width;
        ev.a = { pass: aPass, cards: p.cards.length, rowsNotCarded: p.rows.every(r => !carded.has(r.pane)), coordinatorRow: p.options.some(o => o.pane === ctx.coordinator), noHorizontalOverflow: p.scrollWidth <= p.width };

        // ---- (b) the w1 card: worker label, pane id tooltip, the raw command clamped to two lines, Approve and Deny
        const req1 = p.cards.find(c => c.pane === w1);
        const bPass = !!req1 && req1.title === 'w1' && req1.paneTip === w1 && req1.command === `rm -rf node_modules\necho ${HOSTILE_IMG}` && req1.clamped
            && req1.buttons.some(b => b.label === 'Approve' && !b.disabled) && req1.buttons.some(b => b.label === 'Deny' && !b.disabled) && !req1.answerInPane;
        ev.b = { pass: bPass, card: req1 };

        // ---- (d) the w2 card (unrecognised prompt): the guessed command, "Answer in the pane", only "Go to pane"
        const req2 = p.cards.find(c => c.pane === w2);
        const dPass = !!req2 && req2.answerInPane && /Something new from Claude/.test(req2.command)
            && req2.buttons.map(b => b.label).join(',') === 'Go to pane' && !req2.buttons[0].disabled;
        ev.d = { pass: dPass, card: req2 };

        // ---- (e) hostile text renders as text (command, manifest task, pane label); no element injected, no script ran
        const ePre = p.imgs === 0 && p.pwn === null && !!req1 && req1.command.includes(HOSTILE_IMG);
        ev.railLabels = p.rows.map(r => r.name);

        // screenshots of the rail (host window shows the sidebar/pane iframes)
        const hostPage = await attach((await targets()).find(t => t.type === 'page'));
        sessions.push(hostPage);
        await hostPage.call('Page.bringToFront').catch(() => {});
        ev.shotSidebar = await shot(hostPage, 's11-sidebar-populated.png');
        ev.shotRail = await shot(rail, 's11-rail-cards.png').catch(async () => shot(hostPage, 's11-rail-cards.png'));

        // ---- (c) keys: the rail takes the keyboard on focus-rail (data-rail-focused), J/K walk cards then rows, Enter expands
        // a card in place, X arms a two-step Stop on a row (Really stop? / Keep) and any other key cancels it.
        // The private window is not frontmost, so emulate focus on the rail target, send focus-rail, and wait for the DOM flag.
        const focusAttempts = [];
        let focused = false;
        for (let attempt = 1; attempt <= 3 && !focused; attempt += 1) {
            const a = { attempt };
            await rail.call('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(e => { a.emulationError = e.message; });
            await hostPage.call('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(e => { a.hostEmulationError = e.message; });
            await rail.call('Page.bringToFront').catch(() => {});
            await rail.evaluate(`window.__keys = []; if (!window.__keysHooked) { window.__keysHooked = true; for (const t of ['keydown', 'blur', 'focus']) window.addEventListener(t, e => { if (t === 'keydown' || e.target === window) window.__keys.push(t + ':' + (e.key ?? '') + '@' + Math.round(performance.now())); }, true); window.__handled = 0; window.addEventListener('keydown', e => { if (e.defaultPrevented) window.__handled += 1; }); } window.focus(); true`);
            a.focusRail = (await cmd('focus-rail')).ok;
            const t0 = Date.now();
            for (; Date.now() - t0 < 5000; await sleep(200)) { if ((await probe()).focused) { focused = true; break; } }
            a.focused = focused; a.ms = Date.now() - t0;
            a.pageEvents = await rail.evaluate('window.__keys');
            focusAttempts.push(a);
        }
        ev.focusAttempts = focusAttempts;
        if (!focused) ev.focusFailure = 'rail never reported focused after 3 attempts (see focusAttempts.pageEvents)';
        // The page's blur fires repeatedly after keys (window not frontmost): re-arm before a key when the flag dropped, send the
        // key once, and re-send only if the app's keydown handler did not claim it (defaultPrevented, seen by a later listener).
        let rearms = 0, keyResends = 0;
        const fkey = async name => {
            const [keyName, code, vk] = KEYS[name];
            for (let i = 0; i < 5; i += 1) {
                const before = await rail.evaluate('window.__handled');
                if (!(await probe()).focused) {
                    rearms += 1; await cmd('focus-rail');
                    await rail.evaluate(`new Promise(res => { const t0 = performance.now(); const iv = setInterval(() => { if (document.getElementById('list').dataset.railFocused === 'true' || performance.now() - t0 > 1500) { clearInterval(iv); res(true); } }, 10); })`);
                    await sleep(40); // inside the 250 ms blur grace period
                }
                await key(rail, keyName, code, vk);
                await sleep(150);
                if (await rail.evaluate('window.__handled') > before) break;
                keyResends += 1;
            }
        };
        const sel = async () => (await probe()).options.findIndex(o => o.selected);
        const s0 = await sel();
        await fkey('j'); await sleep(300);
        const s1 = await sel();
        await fkey('j'); await sleep(300);
        const s2 = await sel();
        await fkey('k'); await sleep(300);
        const s3 = await sel();
        const last = p.options.length - 1;
        ev.selection = { start: s0, afterJ: s1, afterJJ: s2, afterK: s3 };
        const movePass = s1 === Math.min(s0 + 1, last) && s2 === Math.min(s1 + 1, last) && s3 === s2 - 1 && s1 !== s0;
        // Move onto the w1 card and press Enter: the command expands in place (no longer clamped); Enter again clamps it.
        const optionIndex = async pane => (await probe()).options.findIndex(o => o.pane === pane);
        const moveTo = async pane => { const target = await optionIndex(pane); let cur = await sel(); for (let guard = 0; cur !== target && guard < 8; guard += 1) { await fkey(cur < target ? 'j' : 'k'); await sleep(250); cur = await sel(); } return cur === target; };
        ev.onW1 = await moveTo(w1);
        await fkey('Enter'); await sleep(300);
        const expanded = (await probe()).cards.find(c => c.pane === w1);
        await fkey('Enter'); await sleep(300);
        const clampedAgain = (await probe()).cards.find(c => c.pane === w1);
        ev.expand = { clampedBefore: req1.clamped, afterEnter: expanded?.clamped, afterEnterAgain: clampedAgain?.clamped, moreAfterEnter: expanded?.more };
        const expandPass = req1.clamped && expanded && !expanded.clamped && expanded.more.length === 0 && clampedAgain && clampedAgain.clamped;
        ev.shotExpanded = await shot(rail, 's11-rail-expanded.png').catch(e => `shot failed: ${e.message}`);
        // Move onto the w3 row and press X: the footer asks to confirm and the row shows Really stop? and Keep; K cancels.
        ev.onW3 = await moveTo(w3);
        await fkey('x'); await sleep(300);
        const asked = await probe();
        const askedRow = asked.rows.find(r => r.pane === w3);
        await fkey('k'); await sleep(300);
        const cancelledRow = (await probe()).rows.find(r => r.pane === w3);
        ev.stop = { footer: asked.footer, buttonsAsked: askedRow?.buttons.map(b => b.label), buttonsAfterK: cancelledRow?.buttons.map(b => b.label) };
        const stopPass = /Press X again/.test(asked.footer) && askedRow && askedRow.buttons.map(b => b.label).join(',') === 'Really stop?,Keep'
            && cancelledRow && cancelledRow.buttons.map(b => b.label).join(',') === 'Stop';
        const stillOne = (await cmd('get-state')).snapshot.workers.filter(w => w.paneID === w3 && !w.archived).length === 1;
        ev.rearms = rearms; ev.keyResends = keyResends; ev.keysSeenByPage = await rail.evaluate('window.__keys');
        ev.c = { pass: focused && movePass && expandPass && stopPass && stillOne, move: movePass, expand: expandPass, stop: stopPass, w3StillListed: stillOne };

        // ---- thread views: open w1 and w2; the request card names its origin, the unrecognised one keeps Approve/Deny off,
        // the hostile task is text, and Back (never disabled) closes the thread view.
        const threads = {};
        for (const [label, pane] of [['w1', w1], ['w2', w2]]) {
            await cmd('open-thread', { paneID: pane });
            const t = await findView(`!!document.getElementById('approve') && window.kelpi && window.kelpi.state && window.kelpi.state.paneID === ${JSON.stringify(pane)} && document.getElementById('name').textContent !== 'Worker'`, `thread view for ${label}`);
            sessions.push(t);
            threads[label] = t;
        }
        await sleep(1000);
        const t1 = await threads.w1.evaluate(THREAD_PROBE), t2 = await threads.w2.evaluate(THREAD_PROBE);
        ev.thread = { w1: t1, w2: t2 };
        ev.shotThread = await shot(hostPage, 's11-thread-view.png');
        const threadOk = t1.requestHidden === false && t1.origin === `w1 (${w1})` && t1.command === `rm -rf node_modules\necho ${HOSTILE_IMG}` && t1.imgs === 0
            && t2.requestHidden === false && t2.approveDisabled && t2.denyDisabled && t2.origin === `w2 (${w2})` && /Something new from Claude/.test(t2.command)
            && t1.back.label === '← Back to coordinator' && !t1.back.disabled && !t2.back.disabled;
        // Back on the w2 thread: the thread pane goes away (the coordinator gets its space back) and nothing else closes.
        const threadTargetID = threads.w2.target.id;
        await threads.w2.evaluate(`(() => { document.getElementById('back').click(); return true; })()`);
        const closed = await waitFor(async () => (!(await targets()).some(t => t.id === threadTargetID)) || null, { timeout: 10000, label: 'w2 thread view closed by Back' }).catch(() => false);
        ev.backClosedThread = closed === true;
        const after = (await cmd('get-state')).snapshot;
        const workersIntact = after.workers.filter(w => !w.archived).length === 3 && after.orchestrator?.paneID === ctx.coordinator;
        ev.d.threadUnrecognisedDisabled = t2.approveDisabled && t2.denyDisabled;
        ev.d.pass = ev.d.pass && threadOk && ev.backClosedThread && workersIntact;

        // w3's task is hostile: open its thread last and read it as text.
        await cmd('open-thread', { paneID: w3 });
        const t3view = await findView(`!!document.getElementById('approve') && window.kelpi && window.kelpi.state && window.kelpi.state.paneID === ${JSON.stringify(w3)} && document.getElementById('name').textContent !== 'Worker'`, 'thread view for w3');
        sessions.push(t3view);
        await sleep(500);
        const t3 = await t3view.evaluate(THREAD_PROBE);
        ev.thread.w3 = t3;
        const ePass = ePre && t3.imgs === 0 && t3.pwn === null && t3.bold === 0 && t3.task === HOSTILE_TASK;
        ev.e = { pass: ePass, railImgs: p.imgs, threadTaskText: t3.task, threadBoldElements: t3.bold, threadImgs: t3.imgs, pwn: [p.pwn, t3.pwn], paneLabelAsText: p.rows.map(r => r.name) };
        const pass = [ev.a, ev.b, ev.c, ev.d, ev.e].every(x => x.pass);
        return record(name, pass, ev);
    } catch (error) {
        ev.exception = String(error.stack ?? error);
        return record(name, false, ev);
    } finally {
        for (const s of sessions) { try { s.close(); } catch { /* ignore */ } }
    }
}

// Standalone entry: own workspace, torn down afterwards.
if (import.meta.url === `file://${process.argv[1]}`) {
    if (!/^tcp:127\.0\.0\.1:/.test(SOCKET)) { console.error('set SWARM_VIEW_SOCKET to the private tcp:127.0.0.1 socket'); process.exit(2); }
    console.log('cleanup before:', (await teardown()).join('; ') || 'none');
    const ctx = await setup();
    let result;
    try { result = await run(ctx); } finally {
        const snap = (await cmd('get-state')).snapshot;
        for (const item of [...(snap?.attention ?? []), ...(snap?.snoozed ?? [])]) await cmd('clear-attention', { itemID: item.id });
        await setSetting('autoHide', true);
        console.log('teardown:', (await teardown()).join('; '));
    }
    console.log(JSON.stringify({ pass: result.pass, a: result.evidence.a?.pass, b: result.evidence.b?.pass, c: result.evidence.c?.pass, d: result.evidence.d?.pass, e: result.evidence.e?.pass }));
    console.log(JSON.stringify(result.evidence, null, 1).slice(0, 6000));
    process.exit(result.pass ? 0 : 1);
}
