#!/usr/bin/env node
// Read a source-authored JSON summary and ask the Kelpi plugin to open the other agent.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateHandoff } from '../../backend/handoff.mjs';

const usage = 'usage: node swarm-handoff.mjs --from claude|codex --to claude|codex [--session-id uuid] [--quit-source] [--summary-file path]';
const flags = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--quit-source' && !flags['--quit-source']) { flags['--quit-source'] = true; continue; }
    if (!['--from', '--to', '--session-id', '--summary-file'].includes(args[i]) || i + 1 >= args.length || flags[args[i]]) {
        process.stderr.write(`${usage}\n`);
        process.exit(1);
    }
    flags[args[i]] = args[++i];
}
let summary = {};
try {
    if (!flags['--session-id'] || flags['--summary-file']) {
        const raw = readFileSync(flags['--summary-file'] ?? 0, 'utf8');
        if (raw.length > 16384) throw new Error('summary is too long');
        summary = JSON.parse(raw);
    }
} catch (error) {
    process.stderr.write(`could not read summary: ${error.message}\n`);
    process.exit(1);
}
const payload = {
    sourcePaneID: process.env.KELPI_PANE_ID,
    fromAgent: flags['--from'],
    toAgent: flags['--to'],
    sourceSessionID: flags['--session-id'],
    quitSource: flags['--quit-source'] === true,
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
    process.stdout.write(`${result.toAgent} opened in pane ${result.paneID}; ${result.handoffPath ? `context saved at ${result.handoffPath}` : `source session ${result.sourceSessionID}`}${result.sourceClosed ? '; source pane closed' : result.sourceCloseScheduled ? '; source pane will close' : ''}\n`);
} catch (error) {
    process.stderr.write(`handoff failed: ${error.message}\n`);
    process.exit(1);
}
