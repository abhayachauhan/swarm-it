// S10: which event name does the host really deliver for the backend's snapshot emit? Read it from `plugin watch` while a
// command forces the backend to publish. Informational: PASS when a snapshot event is observed, evidence names it.
import { spawn } from 'node:child_process';
import { K, SOCKET, cmd, k, ensureManifest, record, sleep } from './lib.mjs';

export const name = 'S10-events';

export async function run(ctx) {
    await ensureManifest(ctx);
    const lines = [];
    const child = spawn(K, ['plugin', 'watch'], { env: { ...process.env, SWARM_VIEW_SOCKET: SOCKET } });
    let buf = '';
    child.stdout.on('data', d => { buf += d; const parts = buf.split('\n'); buf = parts.pop(); lines.push(...parts); });
    await sleep(1500);
    await cmd('pin-orchestrator', { paneID: ctx.coordinator });
    await cmd('focus-rail');
    await sleep(2500);
    child.kill();
    const parsed = lines.map(l => { try { const j = JSON.parse(l); return j.event ?? j; } catch { return null; } }).filter(Boolean);
    const names = [...new Set(parsed.map(e => e.name))];
    const snapshotEvents = parsed.filter(e => e.pluginID === 'local.swarm-view' && /snapshot$/.test(e.name ?? ''));
    const logs = await k(['plugin', 'logs', 'local.swarm-view']);
    // clean up the rail pane that focus-rail opened
    const extra = (await (await import('./lib.mjs')).panes(ctx.ws.id)).filter(p => p.type === 'plugin');
    for (const p of extra) await k(['pane', 'close', '--target', p.id, '--workspace', ctx.ws.id]);
    return record(name, snapshotEvents.length > 0, {
        watchLines: lines.length, eventNamesSeen: names,
        snapshotEventName: snapshotEvents[0]?.name ?? null,
        note: 'host-delivered name is the emit name prefixed with the plugin id; the sidebar subscribes to both forms',
        pluginLogs: logs.stdout.trim().slice(0, 200)
    });
}
