#!/usr/bin/env node
// Codex PermissionRequest hook: ask the selected Swarm-it provider for a Bash decision.
// Any missing daemon, slow reply, malformed input or abstention leaves Codex's own prompt in place.
import { execFile } from 'node:child_process';

const PANE = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const MAX_INPUT = 16384;
const paneID = process.env.KELPI_PANE_ID;
if (!PANE.test(paneID ?? '')) process.exit(0);

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > MAX_INPUT) process.exit(0);
}
let request;
try { request = JSON.parse(raw); } catch { process.exit(0); }
if (request?.tool_name !== 'Bash' || typeof request?.tool_input?.command !== 'string') process.exit(0);

const args = JSON.stringify({ paneID, agent: 'codex', toolName: 'Bash', toolInput: request.tool_input });
const response = await new Promise(resolve => {
  execFile('kelpi', ['plugin', 'service-call', 'kelpi.agent.permissions', 'decide', '--version', '1', '--args', args],
    { timeout: 2500, maxBuffer: 65536 }, (error, stdout) => resolve(error ? null : stdout));
});
let decision;
try { decision = JSON.parse(response); } catch { process.exit(0); }
if (decision?.behavior === 'allow') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
} else if (decision?.behavior === 'deny') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Swarm-it policy denied this request' } } }));
}
