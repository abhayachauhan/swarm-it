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
            row.append(button); links.push(row);
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
