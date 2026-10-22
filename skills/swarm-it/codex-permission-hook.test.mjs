import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(dir, 'codex-permission-hook.mjs');
const installer = path.join(dir, 'install-codex-hook.mjs');

test('the Codex hook forwards a Bash request and translates allow, while abstain leaves native approval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-codex-hook-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'kelpi'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${root}/call'\ncat '${root}/reply'\n`, { mode: 0o755 });
  const env = { ...process.env, KELPI_PANE_ID: 'pane-123', PATH: `${bin}:${process.env.PATH}` };
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  fs.writeFileSync(path.join(root, 'reply'), '{"behavior":"allow"}');
  const yes = spawnSync(process.execPath, [hook], { env, input, encoding: 'utf8' });
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(JSON.parse(yes.stdout).hookSpecificOutput.decision.behavior, 'allow');
  const call = fs.readFileSync(path.join(root, 'call'), 'utf8');
  assert.ok(call.includes('plugin service-call kelpi.agent.permissions decide --version 1 --args'), call);
  assert.ok(call.includes('"agent":"codex"') && call.includes('"command":"npm test"'), call);
  fs.writeFileSync(path.join(root, 'reply'), '{"behavior":"abstain"}');
  assert.equal(spawnSync(process.execPath, [hook], { env, input, encoding: 'utf8' }).stdout, '');
  assert.equal(spawnSync(process.execPath, [hook], { env, input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: 'x' } }), encoding: 'utf8' }).stdout, '');
});

test('the installer preserves Kelpi hooks and is idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-codex-home-'));
  const file = path.join(home, 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'kelpi event notification --agent codex' }] }] } }));
  const env = { ...process.env, CODEX_HOME: home };
  const first = spawnSync(process.execPath, [installer], { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const installed = fs.readFileSync(file, 'utf8');
  assert.ok(installed.includes('kelpi event notification --agent codex'));
  assert.ok(installed.includes('codex-permission-hook.mjs'));
  const second = spawnSync(process.execPath, [installer], { env, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /unchanged/);
  assert.equal(fs.readFileSync(file, 'utf8'), installed);
});
