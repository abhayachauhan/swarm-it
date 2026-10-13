// A minimal fake DOM for the rail's text-only renderers. Any markup-parsing API throws, so a render that used it
// fails the test. Shared by the render tests (logic.js builders) and the app harness (app.js in a fake window).
export class FakeNode {
    constructor(tag) {
        this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.className = ''; this.text = '';
        this.listeners = {}; this.parent = null; this.ownerDocument = null; this.disabled = false;
        // Layout, for the overflow measure: tests set these on the nodes they care about.
        this.scrollHeight = 0; this.clientHeight = 0;
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
    set innerHTML(_) { throw new Error('innerHTML used'); }
    get innerHTML() { throw new Error('innerHTML used'); }
    insertAdjacentHTML() { throw new Error('insertAdjacentHTML used'); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    classes() { return this.className.split(/\s+/).filter(Boolean); }
    get classList() {
        const self = this;
        const set = list => { self.className = list.join(' '); };
        return {
            contains: name => self.classes().includes(name),
            add: name => { if (!self.classes().includes(name)) set([...self.classes(), name]); },
            remove: name => set(self.classes().filter(c => c !== name)),
            toggle(name, force) {
                const has = self.classes().includes(name);
                const want = force === undefined ? !has : Boolean(force);
                if (want && !has) this.add(name);
                if (!want && has) this.remove(name);
                return want;
            },
        };
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
    get nextElementSibling() {
        if (!this.parent) return null;
        const at = this.parent.children.indexOf(this);
        return this.parent.children[at + 1] ?? null;
    }
    contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
    focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    /** Like a browser: a disabled button receives no click. */
    click() { if (this.disabled) return; for (const fn of this.listeners.click ?? []) fn({ stopPropagation() {} }); }
    querySelectorAll(selector) { const test = matches(selector); return find(this, n => n !== this && test(n)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

export const fakeDoc = { createElement: tag => new FakeNode(tag) };
export const walk = (node, visit) => { visit(node); node.children.forEach(child => walk(child, visit)); };
export const find = (node, predicate) => { const out = []; walk(node, n => { if (predicate(n)) out.push(n); }); return out; };

const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
/** Compound selectors only (tag, .class, #id, [attr], [data-x="v"]), comma-separated. No combinators. */
export function matches(selector) {
    const tests = selector.split(',').map(compound => {
        const parts = compound.trim().match(/[.#]?[\w-]+|\[[^\]]+\]/g) ?? [];
        return node => parts.every(part => {
            if (part.startsWith('.')) return node.classes().includes(part.slice(1));
            if (part.startsWith('#')) return node.attrs.id === part.slice(1);
            if (part.startsWith('[')) {
                const m = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
                if (!m) return false;
                const actual = m[1].startsWith('data-') ? node.dataset[camel(m[1].slice(5))] : node.attrs[m[1]];
                return m[2] === undefined ? actual !== undefined : String(actual) === m[2];
            }
            return node.tag === part;
        });
    });
    return node => tests.some(test => test(node));
}
