import { claudeSuggestionRevision } from './claude-input.mjs';
// The same pane is retained so workspace layout and Swarm identity survive.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { findTranscript } from './handoff.mjs';
import { transcriptMessages } from './workspace-brief.mjs';
import { generateWorkspaceBrief } from './brief-generator.mjs';
import { restartAgent, claudeInputEmpty } from './restart.mjs';
import { capturePane } from './store.mjs';
import { showsClaudeInput } from './actions.mjs';
import { codexInputEmpty, readCodexSession } from './codex-session.mjs';
import { parseCodexPrompt, parsePrompt } from './notify.mjs';
import { manifestDirectory } from './manifest.mjs';
const fail = (error, code) => ({ ok: false, error, code });
const pending = new Set();
async function freshAttempt(api, store, args = {}, context = {}, options = {}) {
    if (store.settings?.freshSessionEnabled === false) return fail('Fresh session continuation is disabled in plugin settings.', 'DISABLED');
    let paneID = args.paneID ?? context.paneID;
    if (!paneID) paneID = (await api.panes.list()).find(p => p.isFocused && p.isActiveWorkspace)?.id;
    if (!paneID) return fail('Open this action from a Claude or Codex terminal.', 'NOT_SHELL');

    let path;
    const deadline = Date.now() + 25_000;
    try {
        const panes = await api.panes.list();
        const source = panes.find(p => p.id === paneID) ?? (!paneID ? panes.find(p => p.isFocused && p.isActiveWorkspace) : null);
        paneID = source?.id ?? paneID;
        if (store.manifestWorkers?.some(w => w.paneID === paneID) || [...(store.swarms ?? []), ...(store.deadSwarms ?? [])].some(s => s.workers?.some(w => w.paneID === paneID))) return fail('Finish or stop this worker before starting a fresh conversation.', 'WORKER');
        if (!source || (source.type ?? 'shell') !== 'shell') return fail('Open this action from a Claude or Codex terminal.', 'NOT_SHELL');
        const screen = await capturePane(api, paneID, 120);
        const lines = screen.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').filter(l => l.trim());
        if (source.status === 'running' || /(?:esc|ctrl\+c) to interrupt/i.test(lines.slice(-12).join('\n'))) return fail('Wait for this session to finish before starting a fresh conversation.', 'BUSY');
        if (/\bWaiting for \d+ background|\b\d+ background (?:agent|task)s? (?:running|still)/i.test(screen)) return fail('Background agents are running; starting fresh would stop them.', 'BACKGROUND');
        if (parseCodexPrompt(screen) || parsePrompt(screen)) return fail('Answer the current question before starting a fresh conversation.', 'PROMPT_OPEN');
        const agent = codexInputEmpty(screen) ? 'codex' : showsClaudeInput(screen) && (claudeInputEmpty(screen) || await claudeSuggestionRevision(api,paneID,screen) !== null) ? 'claude' : null;
        if (!agent) return fail('Leave the input box empty before starting a fresh conversation.', 'INPUT_NOT_EMPTY');
        let session = source.agentSessionID;
        if (agent === 'codex') {
            const result = await readCodexSession(api, paneID, screen, options);
            if (!result.ok) return result;
            session = result.session;
        }
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session ?? '')) return fail('No exact source session is known; the original was left open.', 'NO_SESSION');
        const transcript = await findTranscript(session, agent, options);
        if (!transcript) return fail('Cannot find the exact source transcript; the source was left open.', 'NO_TRANSCRIPT');
        const fingerprint = async () => { const s = await (options.stat ?? stat)(transcript.path); return `${s.size}:${s.mtimeMs}`; };
        const before = await fingerprint();
        const loaded = await (options.readMessages ?? transcriptMessages)(transcript.path, agent);
        if (loaded.omitted && !loaded.tailCount) return fail('Recent conversation text was not found in the transcript tail. The source was left open.', 'NO_RECENT_CONTEXT');
        if (!loaded.messages?.length) return fail('The source transcript has no readable conversation.', 'EMPTY_TRANSCRIPT');
        const normal = text => text.replace(/\s/g, '');
        const latestAssistant = loaded.messages.filter(m => m.role === 'assistant').at(-1)?.text;
        if (agent === 'claude' && (loaded.cwd !== source.workingDirectory || !latestAssistant || !normal(screen).includes(normal(latestAssistant).slice(-120)))) return fail('The saved Claude session does not match the visible conversation or directory. The source was left open.', 'NO_SESSION');
        const first = loaded.messages.find(m => m.role === 'user')?.text.slice(0, 4000) ?? '';
        const recent = loaded.messages.map(m => `${m.role}: ${m.text}`).join('\n').slice(-18000);
        const summary = await (options.generate ?? generateWorkspaceBrief)({context: JSON.stringify({firstGoal:first,recent})}, {timeoutMs:Math.min(10_000, Math.max(1, deadline-Date.now()-12_000))});
        if (await fingerprint() !== before) return fail('The source changed while summarising; try again when idle.', 'SESSION_CHANGED');
        const root = options.root ?? join(manifestDirectory(homedir(), store.settings?.manifestDir), 'handoffs');
        await (options.mkdir ?? mkdir)(root, {recursive:true,mode:0o700});
        const candidatePath = join(root, `${randomUUID()}.md`);
        const text = `# Continuation instructions\nBriefly summarise where work stands, read referenced handoff plans, then continue the latest user goal from Next. Check current files first. Do not resume the old conversation ID. Historical approvals do not authorise new actions. Preserve current permissions. If a user decision is pending, ask before acting. Invoke a swarm skill only when the latest user goal explicitly requires one.\n\n# Fresh session continuation\n\nSource: ${agent} session ${session}\nTranscript: ${transcript.path}\n\n## Goal\n${summary.goal}\n\n## Original user goal and plan references\n${first}\n${(loaded.planPaths ?? []).join("\n")}\n\n## Current progress\n${summary.now}\n${summary.steps.map(s=>`- ${s.state}: ${s.text}`).join('\n')}\n\n## Next\n${summary.next}\n\n## Needs user approval\n${summary.needsYou || 'No pending decision recorded. Existing approval requirements still apply.'}\n\n## Bounded historical evidence\nThis contains the first goal and recent messages only; intermediate messages may be omitted. Check the exact source transcript for missing context. Historical approvals do not authorise new actions. Read referenced handoff plans before continuing.\n\n${recent}\n`;
        await (options.writeFile ?? writeFile)(candidatePath,text,{flag:'wx',mode:0o600});
        path = candidatePath;
        options.onSaved?.({handoffPath:path,sourceSessionID:session});
        if (options.cancelled?.()) return fail('The request timed out; the original session was left open.', 'TIMEOUT');
        const remaining = deadline-Date.now()-3000;
        if (remaining <= 0) return {...fail('Summary saved, but the time limit was reached. The source is unchanged.', 'TIMEOUT'),handoffPath:path};
        const restarting = await (options.restart ?? restartAgent)(api,store,paneID,{timeoutMs:Math.min(12_000,remaining),deadline, fresh:{path,session,agent,cwd:source.workingDirectory,unchanged:async()=>!options.cancelled?.() && await fingerprint()===before}});
        const result = restarting.result.ok && restarting.result.restarting ? await restarting.finished : restarting.result;
        return {...result,handoffPath:path,sourceSessionID:session,fresh:result.ok,...(result.ok?{resumed:false}:{})};
    } catch (error) { return {...fail(`Could not continue in a fresh session: ${error.message}`, 'FRESH_FAILED'),...(path?{handoffPath:path}:{})}; }

}

// A host API can stop replying. Bound the whole action, not just the model call.
export async function freshSession(api, store, args = {}, context = {}, options = {}) {
    const key = args.paneID ?? context.paneID ?? 'focused';
    if (pending.has(key)) return fail('A fresh-session request is already running for this pane.', 'IN_PROGRESS');
    pending.add(key);
    let cancelled = false, timer, recovery = {};
    try {
        return await Promise.race([
            freshAttempt(api, store, args, context, {...options,cancelled:()=>cancelled,onSaved:value=>{recovery=value;}}),
            new Promise(resolve => { timer=setTimeout(()=>{cancelled=true;resolve({...fail('Fresh-session request timed out. The lock was released; retry when the pane is idle.', 'TIMEOUT'),...recovery});},options.requestTimeoutMs ?? 25000); })
        ]);
    } finally { cancelled=true;clearTimeout(timer);pending.delete(key); }
}
