// S1: install with --trust, plugin running, every command from kelpi.plugin.json registered.
// `plugin contributions` only holds dynamic item state, so each command is invoked with {}: a registered
// command answers (usually BAD_ARGS), an unregistered one fails with "unknown plugin command".
import fs from 'node:fs';
import path from 'node:path';
import { k, kjson, cmd, record, REPO, PLUGIN } from './lib.mjs';

export const name = 'S1-install';
export async function run() {
    const install = await k(['plugin', 'install', REPO, '--trust']);
    const list = await kjson(['plugin', 'list', '--json']);
    const me = list.find(p => p.manifest.id === PLUGIN);
    const declared = JSON.parse(fs.readFileSync(path.join(REPO, 'kelpi.plugin.json'), 'utf8')).contributes.commands.map(c => c.id);
    const inHost = me?.manifest.contributes.commands.map(c => c.id) ?? [];
    const answers = {};
    const missing = [];
    for (const id of declared) {
        const r = await cmd(id.slice(PLUGIN.length + 1));
        answers[id.slice(PLUGIN.length + 1)] = r.ok ? 'ok' : r.code;
        if (r.code === 'CLI') missing.push(id);
    }
    const state = await cmd('get-state');
    const pass = install.code === 0 && me?.status === 'running' && me?.enabled === true && missing.length === 0 && declared.every(id => inHost.includes(id)) && state.ok === true;
    return record(name, pass, { installExit: install.code, status: me?.status, enabled: me?.enabled, declared: declared.length, registeredInHost: inHost.length, unregistered: missing, answers });
}
