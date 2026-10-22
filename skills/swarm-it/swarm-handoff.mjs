#!/usr/bin/env node
// Read a source-authored JSON summary and ask the Kelpi plugin to open the other agent.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateHandoff } from '../../backend/handoff.mjs';

const usage = 'usage: node swarm-handoff.mjs --from claude|codex --to claude|codex [--summary-file path]';
const flags = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
    if (!['--from', '--to', '--summary-file'].includes(args[i]) || i + 1 >= args.length || flags[args[i]]) {
        process.stderr.write(`${usage}\n`);
        process.exit(1);
    }
    flags[args[i]] = args[i + 1];
}
let summary;
try {
    const raw = readFileSync(flags['--summary-file'] ?? 0, 'utf8');
    if (raw.length > 16384) throw new Error('summary is too long');
    summary = JSON.parse(raw);
} catch (error) {
    process.stderr.write(`could not read summary: ${error.message}\n`);
    process.exit(1);
}
const payload = {
    sourcePaneID: process.env.KELPI_PANE_ID,
    fromAgent: flags['--from'],
    toAgent: flags['--to'],
    goal: summary?.goal,
    keyPoints: summary?.keyPoints,
    next: summary?.next
};
const problem = validateHandoff(payload);
if (problem) {
    process.stderr.write(`${problem.error}\n`);
    process.exit(1);
}
try {
    const raw = execFileSync('kelpi', ['plugin', 'run', 'local.swarm-view.handoff', '--args', JSON.stringify(payload)],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    const result = JSON.parse(raw);
    if (!result.ok) {
        process.stderr.write(`${result.error ?? 'handoff failed'}\n`);
        process.exit(1);
    }
    process.stdout.write(`${result.toAgent} opened in pane ${result.paneID}; handoff saved at ${result.handoffPath}\n`);
} catch (error) {
    process.stderr.write(`handoff failed: ${error.message}\n`);
    process.exit(1);
}
