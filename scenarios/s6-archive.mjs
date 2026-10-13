// S6: archive uses the git service on the worker's worktree. dirty (untracked file) refuses, unknown (non-git dir)
// refuses, clean marks archived. Nothing is deleted and no pane is closed. Archives w3 (permanent for this run).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cmd, ensureManifest, panes, waitFor, tmpDir, record } from './lib.mjs';

const git = promisify(execFile);
export const name = 'S6-archive';

export async function run(ctx) {
    const root = tmpDir('swarm-it-git-');
    const dirty = path.join(root, 'dirty');
    const clean = path.join(root, 'clean');
    const plain = path.join(root, 'not-a-repo');
    for (const d of [dirty, clean, plain]) fs.mkdirSync(d);
    for (const d of [dirty, clean]) {
        await git('git', ['-C', d, 'init', '-q', '-b', 'main']);
        fs.writeFileSync(path.join(d, 'a.txt'), 'hello\n');
        await git('git', ['-C', d, 'add', 'a.txt']);
        await git('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
    }
    fs.writeFileSync(path.join(dirty, 'untracked.txt'), 'x\n');
    await ensureManifest(ctx, { worktrees: { w1: dirty, w2: plain, w3: clean } });
    await waitFor(async () => (await cmd('get-state')).snapshot.workers.some(w => w.worktreePath === clean), { label: 'manifest with worktrees' });
    const ev = {};
    const before = (await panes()).length;
    const rDirty = await cmd('archive', { paneID: ctx.workers.w1 });
    const rUnknown = await cmd('archive', { paneID: ctx.workers.w2 });
    ev.dirty = { ok: rDirty.ok, code: rDirty.code, error: rDirty.error };
    ev.unknown = { ok: rUnknown.ok, code: rUnknown.code, error: rUnknown.error };
    const mid = (await cmd('get-state')).snapshot;
    ev.afterRefusals = mid.workers.filter(w => w.archived).map(w => w.label);
    const rClean = await cmd('archive', { paneID: ctx.workers.w3 });
    ev.clean = { ok: rClean.ok, code: rClean.code };
    const after = (await cmd('get-state')).snapshot;
    ev.archivedAfter = after.workers.filter(w => w.archived).map(w => w.label);
    ev.nothingDeleted = fs.existsSync(path.join(clean, 'a.txt')) && fs.existsSync(path.join(clean, '.git')) && fs.existsSync(path.join(dirty, 'untracked.txt'));
    ev.panesBefore = before;
    ev.panesAfter = (await panes()).length;
    const pass = rDirty.code === 'DIRTY' && rUnknown.code === 'UNKNOWN_GIT' && rClean.ok === true
        && ev.afterRefusals.length === 0 && ev.archivedAfter.join() === 'w3' && ev.nothingDeleted && ev.panesBefore === ev.panesAfter;
    fs.rmSync(root, { recursive: true, force: true });
    return record(name, pass, ev);
}
