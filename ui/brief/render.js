import { ageLabel, briefSummary, pullLink, text } from './logic.js';

// Keep form nodes mounted: polling must not replace a focused field or a user's draft.
export function createBriefRenderer(document, { details, onLink }) {
    const $ = id => document.getElementById(id);
    $('app').className = details ? 'details' : 'compact';
    $('details').hidden = details;
    $('refresh').hidden = !details;
    $('full').hidden = !details;
    let renderedWorkspace = null;
    return model => {
        const summary = briefSummary(model.brief);
        $('goal').textContent = model.workspaceID ? summary.goal : 'Select a local workspace';
        $('now-label').textContent = summary.nowLabel;
        $('now').textContent = summary.now;
        $('next').textContent = summary.next;
        const messages = [ageLabel(model.brief?.updatedAt)];
        if (model.pending) messages.push('Preparing update…');
        if (model.error) messages.push(model.error);
        $('status').textContent = messages.filter(Boolean).join(' · ');
        $('details').disabled = !model.workspaceID;
        $('refresh').disabled = !model.workspaceID || model.loading || model.saving;
        $('save').disabled = !model.workspaceID || model.saving;
        $('pin').disabled = !model.workspaceID || !model.brief || model.saving;
        $('cancel').disabled = !model.workspaceID || model.saving;
        $('pin').textContent = model.brief?.goalPinned ? 'Unpin goal' : 'Pin goal';
        $('goal-input').disabled = !model.workspaceID;
        $('goal-pinned').disabled = !model.workspaceID;
        const input = $('goal-input'), checkbox = $('goal-pinned');
        const changedWorkspace = renderedWorkspace !== model.workspaceID;
        if (changedWorkspace || (document.activeElement !== input && !model.draft?.dirty)) {
            if (input.value !== (model.draft?.goal ?? '')) input.value = model.draft?.goal ?? '';
        }
        if (changedWorkspace || (document.activeElement !== checkbox && !model.draft?.dirty)) checkbox.checked = !!model.draft?.goalPinned;
        renderedWorkspace = model.workspaceID;
        const links = [];
        const prs = Array.isArray(model.brief?.pullRequests) ? model.brief.pullRequests : [];
        const assessmentMode = !details && prs.some(pr => pullLink(pr.url));
        if (assessmentMode && !model.brief?.goalPinned && text(prs[0]?.problem)) $('goal').textContent = prs[0].problem;
        $('now-row').hidden = assessmentMode;
        $('next-row').hidden = assessmentMode;
        $('details').textContent = assessmentMode && model.brief?.needsYou ? 'Decision needed · Details' : 'Details';
        for (const pr of details ? prs : prs.slice(0, 1)) {
            const link = pullLink(pr.url);
            if (!link) continue;
            const row = document.createElement('div');
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'pr-link';
            button.textContent = `${text(pr.title) || 'Pull request'} · #${link.number}${pr.status ? ` · ${text(pr.status)}` : ''}`;
            button.title = link.url;
            const id = model.workspaceID;
            button.addEventListener('click', () => onLink(link.url, id));
            row.className = 'pr-assessment';
            row.append(button);
            const fields = details ? [
                ['Problem', pr.problem || 'Not yet explained. Refresh this brief.'],
                ['Change', pr.change || 'Not yet assessed.'],
                ['Risk', pr.risk || 'Unknown. No risk assessment recorded.'],
                ['Validation', [pr.checks || 'GitHub checks not verified', pr.validation || 'Runtime validation not verified.'].join('. ')]
            ] : [
                ['Change', pr.change || 'Open Details for an assessment.'],
                ['Risk', pr.risk || 'Unknown. No risk assessment recorded.'],
                ['Validation', [pr.checks || 'GitHub checks not verified', pr.validation || 'Runtime validation not verified.'].join('. ')]
            ];
            const assessment = document.createElement('dl');
            for (const [label, value] of fields) {
                const field = document.createElement('div');
                const name = document.createElement('dt'); name.textContent = label;
                const body = document.createElement('dd'); body.textContent = value;
                field.append(name, body); assessment.append(field);
            }
            row.append(assessment);
            if (details && pr.evidenceAt) {
                const checked = document.createElement('p'); checked.className = 'assessment-note';
                checked.textContent = 'Risk is a preliminary assessment from the available evidence. ' + ageLabel(pr.evidenceAt);
                row.append(checked);
            }
            links.push(row);
        }
        if (!details && prs.length > 1) {
            const more = document.createElement('div'); more.className = 'assessment-note';
            more.textContent = (prs.length - 1) + ' more pull requests in Details'; links.push(more);
        }
        $('pull-requests').replaceChildren(...links);
        if (!details) return;
        const steps = Array.isArray(model.brief?.steps) ? model.brief.steps : [];
        const unique = new Set(), nodes = [];
        for (const step of steps) {
            const value = text(step?.text).trim();
            if (!value || unique.has(value)) continue;
            unique.add(value);
            const row = document.createElement('li');
            row.textContent = `${({ done: 'Done', active: 'In progress', todo: 'To do' })[step.state] || 'Planned'}: ${value}`; nodes.push(row);
        }
        $('steps').replaceChildren(...nodes);
        $('empty-steps').textContent = nodes.length ? '' : 'No plan recorded yet.';
    };
}
