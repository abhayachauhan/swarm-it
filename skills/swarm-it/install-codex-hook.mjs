#!/usr/bin/env node
// Install Swarm-it's Codex Bash approval hook alongside Kelpi's lifecycle hooks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const file = path.join(home, 'hooks.json');
const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-permission-hook.mjs');
const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const command = `node ${shellQuote(hookPath)}`;
const dryRun = process.argv.slice(2).includes('--dry-run');
if (process.argv.slice(2).some(arg => arg !== '--dry-run')) {
  process.stderr.write('usage: install-codex-hook.mjs [--dry-run]\n');
  process.exit(1);
}
fs.mkdirSync(home, { recursive: true });
let config = {};
if (fs.existsSync(file)) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing to replace a symlinked hooks.json');
  config = JSON.parse(fs.readFileSync(file, 'utf8'));
}
if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('hooks.json must be an object');
config.hooks ??= {};
if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('hooks must be an object');
const groups = config.hooks.PermissionRequest ?? [];
if (!Array.isArray(groups)) throw new Error('PermissionRequest must be an array');
for (const group of groups) {
  if (!Array.isArray(group.hooks)) throw new Error('PermissionRequest group must contain hooks');
  group.hooks = group.hooks.filter(hook => !String(hook?.command ?? '').includes('codex-permission-hook.mjs'));
}
config.hooks.PermissionRequest = groups.filter(group => group.hooks.length);
config.hooks.PermissionRequest.push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 4 }] });
const updated = JSON.stringify(config, null, 2) + '\n';
const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
if (before === updated) {
  process.stdout.write(`unchanged ${file}\n`);
} else if (dryRun) {
  process.stdout.write(`would update ${file}\n`);
} else {
  if (before !== null) fs.copyFileSync(file, `${file}.swarm-backup`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, updated, { mode: 0o600 });
  fs.renameSync(temp, file);
  process.stdout.write(`updated ${file}; run /hooks inside Codex to trust the new hook\n`);
}
