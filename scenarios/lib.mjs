// Shared helpers for the integration scenarios. Every Kelpi call goes through bin/k (private socket only).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const K = path.join(REPO, 'bin', 'k');
export const FAKE = path.join(REPO, 'scenarios', 'fake');
export const OUT = path.join(REPO, 'scenarios', 'out');
export const SOCKET = process.env.SWARM_VIEW_SOCKET || 'tcp:127.0.0.1:56353';
export const PLUGIN = 'local.swarm-view';
export const WORKSPACE_NAME = 'swarm-it';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Run bin/k with args. Resolves { code, stdout, stderr } and never rejects. */
export async function k(args, { timeout = 30000 } = {}) {
    try {
        const { stdout, stderr } = await run(K, args, { env: { ...process.env, SWARM_VIEW_SOCKET: SOCKET }, timeout, maxBuffer: 16 * 1024 * 1024 });
        return { code: 0, stdout, stderr };
    } catch (error) {
        return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) };
    }
}

export async function kjson(args) {
    const r = await k(args);
    if (r.code !== 0) throw new Error(`k ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return JSON.parse(r.stdout);
}

/** Run a plugin command. Resolves the parsed JSON result (CommandResult). */
export async function cmd(name, args = {}) {
    const r = await k(['plugin', 'run', `${PLUGIN}.${name}`, '--args', JSON.stringify(args)]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || r.stdout.trim(), code: 'CLI' };
    try { return JSON.parse(r.stdout); } catch { return { ok: false, error: `unparseable: ${r.stdout}`, code: 'CLI' }; }
}

export const state = async () => (await cmd('get-state')).snapshot;

export async function waitFor(fn, { timeout = 15000, every = 500, label = 'condition' } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { last = await fn(); if (last) return last; } catch (error) { last = error; }
        await sleep(every);
    }
    throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

export const panes = (workspace) => kjson(['pane', 'list', '--json', ...(workspace ? ['--workspace', workspace] : [])]);
export const workspaces = () => kjson(['workspace', 'list', '--json']);
export const capture = async (paneID, lines = 60) => (await k(['pane', 'capture', '--target', paneID, '--lines', String(lines)])).stdout;
/** Type a command line into a pane (appends Enter). Addressed by pane id. */
export const send = (paneID, text) => k(['pane', 'send', '--target', paneID, text]);
export const sendKey = (paneID, key) => k(['pane', 'send-key', '--target', paneID, key]);

export function tmpDir(prefix = 'swarm-it-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Open pty masters on this machine (macOS allows 511 in total; running out stops every app creating terminals). */
export async function ptyCount() {
    try {
        const { stdout } = await run('sh', ['-c', 'lsof /dev/ptmx 2>/dev/null | wc -l']);
        return Math.max(0, Number(stdout.trim()) - 1);
    } catch { return 0; }
}
export const PTY_LIMIT = 300;
/** Refuse to continue past PTY_LIMIT: a leaking test instance once took all 511 and broke the live Kelpi. */
export async function assertPtyBudget(where) {
    const n = await ptyCount();
    console.log(`ptys ${n} (${where})`);
    if (n > PTY_LIMIT) throw new Error(`pty count ${n} is over ${PTY_LIMIT} at ${where}; stopping before the machine runs out`);
    return n;
}

/** Create (or reuse) the swarm-it workspace with a coordinator and three workers w1..w3. Returns { ws, coordinator, workers }. */
export async function setup() {
    let ws = (await workspaces()).find(w => w.name === WORKSPACE_NAME);
    let split;
    if (!ws) {
        const created = await kjson(['workspace', 'create', '--name', WORKSPACE_NAME, '--path', os.homedir(), '--json']);
        ws = { id: created.workspace_id, name: created.workspace_name };
        const first = (await panes(ws.id))[0];
        const named = await k(['pane', 'name', '--target', first.id, 'coordinator']);
        if (named.code !== 0) throw new Error(`pane name failed: ${named.stderr}`);
        split = {};
        for (const name of ['w1', 'w2', 'w3']) {
            const r = await kjson(['pane', 'split', '--target', first.id, '--name', name, '--json']);
            split[name] = r;
        }
    }
    const list = await panes(ws.id);
    const byLabel = Object.fromEntries(list.filter(p => p.label).map(p => [p.label, p.id]));
    return {
        ws, split,
        coordinator: byLabel.coordinator,
        workers: { w1: byLabel.w1, w2: byLabel.w2, w3: byLabel.w3 }
    };
}

/** Delete the swarm-it workspace (and its hidden sibling) and any ~/.kelpi-swarm entry for them. */
export async function teardown() {
    const out = [];
    for (const w of await workspaces()) {
        if (w.name === WORKSPACE_NAME || w.name === `${WORKSPACE_NAME} · workers`) {
            const r = await k(['workspace', 'delete', w.id, '--force']);
            out.push(`${w.name}: ${r.code === 0 ? 'deleted' : r.stderr.trim()}`);
            fs.rmSync(path.join(os.homedir(), '.kelpi-swarm', `${w.id}.json`), { force: true });
        }
    }
    return out;
}

const MANIFEST_WRITER = path.join(REPO, 'launcher-patch', 'manifest-writer.mjs');
/** Run the launcher's manifest-writer with SWARM_MANIFEST_DIR unset (writes ~/.kelpi-swarm). */
export async function manifestWriter(args) {
    const env = { ...process.env };
    delete env.SWARM_MANIFEST_DIR;
    try {
        const { stdout } = await run('node', [MANIFEST_WRITER, ...args], { env });
        return stdout.trim();
    } catch (error) {
        throw new Error(`manifest-writer ${args[0]}: ${error.stderr || error.message}`);
    }
}
export const manifestFile = wsID => path.join(os.homedir(), '.kelpi-swarm', `${wsID}.json`);

/** Write the swarm manifest (coordinator + w1..w3, optional per-worker worktree) for the swarm-it workspace. Returns the result dir. */
export async function ensureManifest(ctx, { worktrees = {} } = {}) {
    ctx.resultDir ??= tmpDir();
    await manifestWriter(['init', ctx.ws.id, ctx.coordinator, 'coordinator']);
    for (const w of ['w1', 'w2', 'w3']) {
        await manifestWriter(['add-worker', ctx.ws.id, ctx.workers[w], w, `task ${w}`, `${ctx.resultDir}/${w}-result.md`, worktrees[w] ?? '-']);
    }
    return ctx.resultDir;
}

/** Read the size of a pane's terminal: runs `stty size` in its shell and reads the result. Returns "rows cols". */
export async function ttySize(paneID, dir) {
    const file = path.join(dir, `size-${paneID}.txt`);
    fs.rmSync(file, { force: true });
    await send(paneID, `stty size > '${file}'`);
    return waitFor(() => { const t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''; return t || null; }, { timeout: 8000, label: `stty size of ${paneID}` });
}

/**
 * Make swarm-it the active workspace. The CLI has no "activate" verb, so run focus-rail (which opens the rail view as a
 * pane in swarm-it and activates it), then close that extra pane again so the layout is unchanged.
 */
export async function activateSwarm(ctx) {
    const active = () => workspaces().then(l => l.find(w => w.is_active)?.name);
    if ((await active()) === WORKSPACE_NAME) return { changed: false };
    const before = new Set((await panes(ctx.ws.id)).map(p => p.id));
    const r = await cmd('focus-rail');
    const extra = (await panes(ctx.ws.id)).filter(p => !before.has(p.id));
    for (const p of extra) await k(['pane', 'close', '--target', p.id, '--workspace', ctx.ws.id]);
    await sleep(800);
    return { changed: true, focusRailOk: r.ok, closedExtra: extra.map(p => p.type), active: await active() };
}

export const setSetting = (key, value) => k(['plugin', 'settings', PLUGIN, '--key', key, '--value', JSON.stringify(value)]);
export const reinstall = async () => (await k(['plugin', 'install', REPO, '--trust'])).code;

export function record(name, pass, evidence) {
    fs.mkdirSync(OUT, { recursive: true });
    const result = { scenario: name, pass: !!pass, evidence };
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(result, null, 2));
    return result;
}

export const fakeScript = name => path.join(FAKE, name);
