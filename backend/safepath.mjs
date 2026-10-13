// Result file sink policy. A manifest is untrusted input (any process can write it), so a worker's resultPath is only
// read or opened when it passes all of these:
//   1. its extension (and the extension of the file it resolves to) is in RESULT_EXTENSIONS;
//   2. its real path, after resolving symlinks, sits under the worker's worktreePath when one is set AND that
//      worktree (also resolved) sits strictly inside the `worktreeRoots` setting (default <home>/repos), the `resultRoot` or the manifest
//      directory AND is a real git worktree AND the pane's actual working directory (from the snapshot) is the worktree or
//      inside it; otherwise under the manifest directory and `resultRoot` alone (never the home directory). The
//      manifest is untrusted, so worktreePath is never a root by itself; "/", home and its ancestors are rejected,
//      for every root including `resultRoot`.
//   3. when the file is read, it is opened with O_NOFOLLOW, the open handle must be a regular file with a single link and
//      at most MAX_RESULT_BYTES, must still be what the checked real path points at, and the bytes are read from that
//      same handle (see readResultSafely). A FIFO, device or hard link is refused.
// Failures return code BAD_RESULT_PATH. A path that does not exist yet is checked through its nearest existing
// ancestor, so a missing file is still NO_RESULT downstream rather than a policy error.
import { constants as fsc } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const RESULT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.log']);
const bad = error => ({ ok: false, error, code: 'BAD_RESULT_PATH' });

/** realpath that tolerates a missing tail: resolves the nearest existing ancestor and re-appends the rest. */
export async function realpathLoose(path) {
    const tail = [];
    let current = resolve(path);
    for (;;) {
        try {
            return join(await realpath(current), ...tail);
        } catch (error) {
            const parent = dirname(current);
            if (!['ENOENT', 'ENOTDIR'].includes(error?.code) || parent === current) throw error;
            tail.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
            current = parent;
        }
    }
}

const inside = (root, path) => {
    const rel = relative(root, path);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** True for a root that must never be trusted: "/", the home directory, or any ancestor of home. */
const dangerousRoot = (r, realHome) => r === parse(r).root || r === realHome || inside(r, realHome);

/** Default "is this a real git worktree": a `.git` entry (directory, or file for a linked worktree) at the tree itself. */
export async function fsIsWorktree(tree) {
    try { return !!(await stat(join(tree, '.git'))); } catch { return false; }
}

/**
 * Roots a result may live under when the worker has no worktree: the manifest directory itself (never its parent,
 * which by default is the home directory and would expose ~/.aws, ~/.ssh and friends) plus the optional `resultRoot`.
 */
export function allowedRoots(settings = {}, home = homedir()) {
    const dir = typeof settings.manifestDir === 'string' && settings.manifestDir.trim() ? settings.manifestDir.trim() : join(home, '.kelpi-swarm');
    const roots = [resolve(dir)];
    if (typeof settings.resultRoot === 'string' && isAbsolute(settings.resultRoot.trim())) roots.push(resolve(settings.resultRoot.trim()));
    return roots;
}

/** Roots a worker worktree may live strictly inside: `worktreeRoots` (default <home>/repos), plus the result roots. */
export function worktreeTrustRoots(settings = {}, home = homedir()) {
    // Kelpi settings are string/number/boolean only, so the host stores this as ':' or newline separated paths; arrays are accepted too.
    const raw = Array.isArray(settings.worktreeRoots) ? settings.worktreeRoots : typeof settings.worktreeRoots === 'string' ? settings.worktreeRoots.split(/[:\n]/) : [];
    const configured = raw.filter(r => typeof r === 'string' && isAbsolute(r.trim())).map(r => resolve(r.trim()));
    return [...(configured.length ? configured : [join(home, 'repos')]), ...allowedRoots(settings, home)];
}

/**
 * @param {object} worker manifest worker
 * @param {object} settings
 * @param {string} [home]
 * @param {{ pane?: { workingDirectory?: string | null }, isWorktree?: (tree: string) => Promise<boolean> | boolean }} [ctx]
 *   pane is the live pane record (its workingDirectory proves where the worker really runs); isWorktree defaults to a `.git` check
 * @returns {Promise<{ ok: true, path: string } | { ok: false, error: string, code: 'BAD_RESULT_PATH' }>} path is the resolved real path
 */
export async function checkResultPath(worker, settings, home = homedir(), ctx = {}) {
    const given = worker?.resultPath;
    if (typeof given !== 'string' || !isAbsolute(given)) return bad('result path must be absolute');
    if (!RESULT_EXTENSIONS.has(extname(given).toLowerCase())) return bad(`result files must be one of ${[...RESULT_EXTENSIONS].join(' ')}`);
    let real;
    try {
        real = await realpathLoose(given);
    } catch (error) {
        return bad(`cannot resolve the result path: ${String(error?.code ?? error?.message ?? error)}`);
    }
    if (!RESULT_EXTENSIONS.has(extname(real).toLowerCase())) return bad('result path resolves to a file type that is not allowed');
    let realHome;
    try { realHome = await realpathLoose(home); } catch { realHome = resolve(home); }
    const trusted = [];
    for (const candidate of allowedRoots(settings, home)) {
        try {
            const r = await realpathLoose(candidate);
            if (!dangerousRoot(r, realHome)) trusted.push(r); // never trust "/", home or an ancestor as a root, resultRoot included
        } catch { /* unresolvable root is not trusted */ }
    }
    let roots = trusted;
    let scoped = false;
    if (worker.worktreePath) {
        let tree;
        try {
            tree = await realpathLoose(worker.worktreePath);
        } catch { return bad('cannot resolve the worker worktree'); }
        if (dangerousRoot(tree, realHome) || worker.worktreePath === '/') return bad('worker worktree must not be the filesystem root, the home directory or one of its ancestors');
        const treeRoots = [];
        for (const candidate of worktreeTrustRoots(settings, home)) {
            try {
                const r = await realpathLoose(candidate);
                if (!dangerousRoot(r, realHome)) treeRoots.push(r);
            } catch { /* unresolvable root is not trusted */ }
        }
        if (treeRoots.some(root => inside(root, tree))) {
            // worktreePath is worker-declared: it only scopes results when it is a real git worktree that the pane really runs in.
            const isWorktree = ctx.isWorktree ?? fsIsWorktree;
            let cwd = null;
            const declared = ctx.pane?.workingDirectory;
            if (typeof declared === 'string' && isAbsolute(declared)) { try { cwd = await realpathLoose(declared); } catch { cwd = null; } }
            const running = cwd !== null && (cwd === tree || inside(tree, cwd));
            if (running && await isWorktree(tree)) { roots = [tree]; scoped = true; }
        }
    }
    if (roots.some(root => inside(root, real))) return { ok: true, path: real };
    return bad(scoped ? 'result path is outside the worker worktree' : 'result path is outside the workspace root');
}

export const MAX_RESULT_BYTES = 1024 * 1024;
export const READ_TIMEOUT_MS = 5000;
const badRead = (error, code = 'BAD_RESULT_PATH') => ({ ok: false, error, code });

/** Race a promise against a timer; the timer is always cleared. Rejects with code TIMEOUT. */
export function withTimeout(promise, ms, what = 'operation') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms`), { code: 'TIMEOUT' })), ms);
        timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Open `real` (an already policy-checked real path) without following a final symlink or blocking on a FIFO, and prove the
 * HANDLE is a regular, single-link, size-capped file that is still what the path points at. Caller must close the handle.
 * @returns {Promise<{ ok: true, handle: import('node:fs/promises').FileHandle, size: number } | { ok: false, error: string, code: string, missing?: boolean }>}
 */
export async function openResultHandle(real, maxBytes = MAX_RESULT_BYTES) {
    let handle;
    try {
        handle = await open(real, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ...badRead('result file does not exist', 'NO_RESULT'), missing: true };
        return badRead(`cannot open the result file: ${String(error?.code ?? error?.message ?? error)}`);
    }
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw badRead('result path is not a regular file');
        if (info.nlink !== 1) throw badRead('result file has more than one hard link');
        if (info.size > maxBytes) throw badRead(`result file is larger than ${maxBytes} bytes`);
        // Re-resolve after the open: the path must still lead to the very file we hold (same device and inode).
        let again;
        let current;
        try { again = await realpath(real); current = await stat(real); } catch { throw badRead('result file moved while it was being opened'); }
        if (again !== real || current.ino !== info.ino || current.dev !== info.dev) throw badRead('result file moved while it was being opened');
        return { ok: true, handle, size: info.size };
    } catch (failure) {
        await handle.close().catch(() => {});
        if (failure && failure.ok === false) return failure;
        return badRead(`cannot inspect the result file: ${String(failure?.code ?? failure?.message ?? failure)}`);
    }
}

/**
 * Read a policy-checked result file through ONE open handle. Never throws.
 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string, code: string }>}
 */
export async function readResultSafely(real, { maxBytes = MAX_RESULT_BYTES, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const opened = await openResultHandle(real, maxBytes);
    if (!opened.ok) return opened;
    const { handle } = opened;
    try {
        const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(opened.size, 1)) + 1);
        const read = await withTimeout(handle.read(buffer, 0, buffer.length, 0), timeoutMs, 'reading the result file');
        if (read.bytesRead > maxBytes) return badRead(`result file is larger than ${maxBytes} bytes`);
        return { ok: true, text: buffer.toString('utf8', 0, read.bytesRead) };
    } catch (error) {
        return badRead(`cannot read the result file: ${String(error?.code ?? error?.message ?? error)}`, 'NO_RESULT');
    } finally {
        await handle.close().catch(() => {});
    }
}
