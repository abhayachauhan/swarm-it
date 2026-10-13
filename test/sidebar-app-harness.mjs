// Boots ui/sidebar/app.js (with logic.js) in a fake window: fake DOM, fake Kelpi API, fake timers and clock. Tests
// click the rendered buttons, press keys, emit snapshots, advance time, and read what the rail did.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { FakeNode, find } from './sidebar-fake-dom.mjs';

const dir = new URL('../ui/sidebar/', import.meta.url);
const LOGIC = readFileSync(new URL('logic.js', dir), 'utf8');
const APP = readFileSync(new URL('app.js', dir), 'utf8');
const INDEX = readFileSync(new URL('index.html', dir), 'utf8');
export const fixture = () => JSON.parse(readFileSync(new URL('fixtures/snapshot.json', dir), 'utf8'));

/** Let every pending promise settle (the app's handlers are async). */
export const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve)); };

/**
 * options: snapshot (get-state result), execute(command, args) returning a result to override the default ok,
 * revealFails (message: api.ui.reveal rejects), onCreate(node) to size nodes for the overflow measure,
 * resizeObserver: false to boot without one.
 */
export async function bootApp(options = {}) {
    const clock = { now: 1_760_000_000_000 };
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
    }
    // ---- timers: nothing runs until the test advances the clock ----
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

    // ---- document: the containers index.html declares, nested under #app ----
    const document = { activeElement: null, hasFocus: () => true };
    const byId = {};
    const make = (tag, id) => { const node = new FakeNode(tag); node.ownerDocument = document; if (id) { node.attrs.id = id; byId[id] = node; } return node; };
    for (const [, tag, id] of INDEX.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) make(tag, id);
    const app = byId.app;
    for (const id of Object.keys(byId)) if (id !== 'app') app.append(byId[id]);
    document.createElement = tag => { const node = make(tag); if (options.onCreate) options.onCreate(node); return node; };
    document.getElementById = id => byId[id] ?? null;
    document.querySelectorAll = selector => app.querySelectorAll(selector);
    document.querySelector = selector => app.querySelector(selector);

    // ---- window and the Kelpi API ----
    const calls = [], reveals = [], warned = [], listeners = {}, events = {};
    // Errors the fake API throws come from the app's own realm, as in a browser (instanceof Error holds there).
    let AppError = Error;
    const api = {
        ready: Promise.resolve(),
        events: { on(name, fn) { (events[name] ??= []).push(fn); return () => { events[name] = (events[name] ?? []).filter(f => f !== fn); }; } },
        commands: {
            execute: async (command, args) => {
                // Copied out of the vm context so assert.deepEqual compares plain host objects.
                calls.push({ command, args: JSON.parse(JSON.stringify(args ?? null)) });
                const custom = options.execute ? options.execute(command, args) : null;
                if (custom) return custom;
                if (command.endsWith('get-state')) return { ok: true, snapshot: options.snapshot ?? fixture() };
                return { ok: true };
            },
        },
        ui: { reveal: async paneID => { reveals.push(paneID); if (options.revealFails) throw new AppError(options.revealFails); } },
    };
    const window = { kelpi: api, addEventListener(name, fn) { (listeners[name] ??= []).push(fn); }, focus() {} };
    const dispatch = (name, event = {}) => {
        const payload = { target: window, preventDefault() { payload.prevented = true; }, ...event };
        for (const fn of listeners[name] ?? []) fn(payload);
        return payload;
    };
    const observers = [];
    class ResizeObserver {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(target) { this.targets.push(target); }
        disconnect() { this.targets = []; }
    }

    const context = vm.createContext({
        window, document, CSS: { escape: s => s },
        console: { ...console, warn: (...args) => warned.push(args.join(' ')) },
        setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: cancel, setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1)), clearInterval: cancel,
        Date: FakeDate, ResizeObserver: options.resizeObserver === false ? undefined : ResizeObserver,
    });
    AppError = vm.runInContext('Error', context);
    vm.runInContext(LOGIC, context, { filename: 'logic.js' });
    vm.runInContext(APP, context, { filename: 'app.js' });
    await flush();

    const list = byId.list, footer = byId.footer, head = byId.head;
    return {
        refs: { app, head, panel: byId.panel, list, footer },
        L: context.SwarmLogic, calls, reveals, warned, clock, advance, flush, dispatch, observers,
        /** Deliver a backend event (a snapshot, focus-rail, gap). */
        emit: (name, data) => { for (const fn of events[name] ?? []) fn({ data }); },
        /** Fire every ResizeObserver callback, as the browser does when #list changes size. */
        resize: () => { for (const o of observers) if (o.targets.length) o.callback([]); },
        button: (root, text) => find(root, n => n.tag === 'button' && n.text === text)[0] ?? null,
        card: index => find(list, n => n.dataset.itemId)[index] ?? null,
        row: paneID => find(list, n => n.className === 'row' && n.dataset.paneId === paneID)[0] ?? null,
        footerText: () => footer.textContent,
        /**
         * A pointer click as the browser delivers it: pointerdown (the rail defers redraws), click, pointerup (the
         * deferred redraw runs on the next timer tick). Returns once that redraw has happened.
         */
        pointerClick: async node => { dispatch('pointerdown'); node.click(); dispatch('pointerup'); await advance(0); },
        press: async key => { const out = dispatch('keydown', { key, ctrlKey: false, altKey: false, metaKey: false, isComposing: false }); await flush(); return out; },
    };
}
