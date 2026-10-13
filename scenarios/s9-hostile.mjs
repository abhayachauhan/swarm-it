// S9: hostile labels. Part A: the PANE is renamed `$(touch /tmp/pwned)` (and a label with a newline if the CLI allows) while
// the manifest label stays safe. Part B: the MANIFEST itself carries the hostile label. In both, nothing hostile may be
// typed into the orchestrator and /tmp/pwned must never appear.
import fs from 'node:fs';
import { cmd, k, ensureManifest, manifestWriter, waitFor, capture, record, sleep } from './lib.mjs';

export const name = 'S9-hostile';
const HOSTILE = '$(touch /tmp/pwned)';

export async function run(ctx) {
    fs.rmSync('/tmp/pwned', { force: true });
    const resultDir = await ensureManifest(ctx);
    const ev = {};
    fs.writeFileSync(`${resultDir}/w2-result.md`, '# Goal\ng\n# Done\nd\n# Next\nn\n');
    const w2 = ctx.workers.w2;

    // Part A
    const rename = await k(['pane', 'name', '--target', w2, HOSTILE]);
    ev.renameHostile = { exit: rename.code, out: (rename.stdout + rename.stderr).trim().slice(0, 120) };
    const nl = await k(['pane', 'name', '--target', ctx.workers.w3, 'a\nb']);
    ev.renameNewline = { exit: nl.code, out: (nl.stdout + nl.stderr).trim().slice(0, 120) };
    await sleep(2500);
    const snapA = (await cmd('get-state')).snapshot;
    ev.partA = { workerLabels: snapA.workers.map(w => w.label), warnings: snapA.warnings };
    const before = await capture(ctx.coordinator, 40);
    const acceptA = await cmd('accept', { paneID: w2 });
    await sleep(2000);
    const after = await capture(ctx.coordinator, 40);
    ev.partA.accept = { ok: acceptA.ok, code: acceptA.code, notified: acceptA.notified };
    ev.partA.typedIntoOrchestrator = after.slice(before.length > after.length ? 0 : 0).split('\n').filter(l => /Reviewed and accepted/.test(l)).slice(-1);
    ev.partA.hostileTextTyped = /pwned/.test(after);

    // Part B: hostile label in the manifest (the writer only forbids control characters, the plugin must still refuse)
    await manifestWriter(['add-worker', ctx.ws.id, w2, HOSTILE, 'task', `${resultDir}/w2-result.md`]);
    await sleep(2500);
    const snapB = (await cmd('get-state')).snapshot;
    ev.partB = { workerLabels: snapB.workers.map(w => w.label), warnings: snapB.warnings, orchestrator: snapB.orchestrator?.source };
    const mark = (await capture(ctx.coordinator, 60)).length;
    const acceptB = await cmd('accept', { paneID: w2 });
    await sleep(1500);
    const afterB = await capture(ctx.coordinator, 60);
    ev.partB.accept = { ok: acceptB.ok, code: acceptB.code, error: acceptB.error };
    ev.partB.hostileTextTyped = /pwned/.test(afterB.replace(after, ''));
    ev.pwnedExists = fs.existsSync('/tmp/pwned');

    // restore a safe manifest and label
    await k(['pane', 'name', '--target', w2, 'w2']);
    await k(['pane', 'name', '--target', ctx.workers.w3, 'w3']);
    await ensureManifest(ctx);
    fs.rmSync('/tmp/pwned', { force: true });
    // The hostile manifest never reaches accept: validateManifest rejects the whole file with BAD_LABEL (a warning), and the
    // last good manifest stays in force, so accept still uses the safe label from it.
    const refused = snapB.warnings.some(w => /BAD_LABEL/.test(w));
    const pass = !ev.pwnedExists && !ev.partA.hostileTextTyped && !ev.partB.hostileTextTyped && refused;
    ev.note = `hostile manifest label rejected with BAD_LABEL warning: ${refused}; accept afterwards returned ok=${acceptB.ok} using the previous good manifest`;
    return record(name, pass, ev);
}
