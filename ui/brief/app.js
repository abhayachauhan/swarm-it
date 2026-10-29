import { createBriefController, pullLink, text } from './logic.js';
import { createBriefRenderer } from './render.js';

const api = window.kelpi;
await api.ready;
const $ = id => document.getElementById(id);
const details = api.state?.details === true;
let layoutError = '';
if (details && api.state?.enableLayout === true) {
    try { await api.ui.selectView('workspace', 'local.swarm-view.brief-layout'); }
    catch (cause) { layoutError = `Could not enable brief: ${cause.message || String(cause)}`; }
}
let disposed = false, selected = null;
const render = createBriefRenderer(document, { details, onLink: async (url, workspaceID) => {
    if (disposed || selected !== workspaceID || !pullLink(url)) return;
    try {
        // SDK command uses the host's native browser opening and policy, after a user click.
        const panes = await api.panes.list({ workspaceID });
        if (disposed || selected !== workspaceID) return;
        const local = panes.filter(pane => pane.workspaceID === workspaceID);
        const source = local.find(pane => pane.isFocused) ?? local[0];
        if (!source) throw new Error('No pane available in this workspace');
        const result = await api.command({ command: 'web-open', url, pane_id: source.id, focus: true });
        if (result?.ok === false) throw new Error(text(result.error) || 'Could not open pull request');
    } catch (cause) { if (!disposed && selected === workspaceID) $('status').textContent = cause.message || String(cause); }
} });
const controller = createBriefController({
    execute: (command, args) => api.commands.execute(`local.swarm-view.${command}`, args),
    render: model => { if (!disposed) render({ ...model, error: [layoutError, model.error].filter(Boolean).join(' · ') }); },
});
const draftChanged = () => controller.changeDraft($('goal-input').value, $('goal-pinned').checked);
$('goal-input').addEventListener('input', draftChanged);
$('goal-pinned').addEventListener('change', draftChanged);
$('editor').addEventListener('submit', event => { event.preventDefault(); draftChanged(); void controller.edit(); });
$('pin').addEventListener('click', () => { void controller.edit(true); });
$('cancel').addEventListener('click', () => {
    // Explicit reset may replace a draft even when its field has focus.
    $('cancel').focus(); controller.resetDraft();
});
$('hide').addEventListener('click', async () => {
    if (!details) return;
    $('hide').disabled = true;
    try { await api.ui.selectView('workspace', 'kelpi.workspace'); layoutError = ''; $('status').textContent = 'Brief hidden'; }
    catch (cause) { layoutError = `Could not hide brief: ${cause.message || String(cause)}`; $('status').textContent = layoutError; }
    finally { $('hide').disabled = false; }
});
$('refresh').addEventListener('click', () => { void controller.refresh(true); });
$('details').addEventListener('click', () => { void controller.openDetails(); });
const select = id => { selected = text(id) || null; controller.select(selected); };
let stop = () => {};
if (details) {
    select(api.state.workspaceID);
} else {
    let receivedChrome = false;
    stop = api.ui.onChrome(snapshot => {
        if (disposed) return;
        receivedChrome = true;
        select(snapshot?.remoteWorkspaceSelected ? null : snapshot?.workspace?.id);
    }, cause => { if (!disposed) { select(null); $('status').textContent = cause.message || String(cause); } });
    try {
        const initial = await api.ui.getChrome();
        if (!disposed && !receivedChrome) select(initial?.remoteWorkspaceSelected ? null : initial?.workspace?.id);
    } catch (cause) { if (!disposed && !receivedChrome) $('status').textContent = cause.message || String(cause); }
}
const poll = setInterval(() => { if (!disposed && api.visible !== false && !document.hidden) void controller.refresh(); }, 5000);
window.addEventListener('pagehide', () => { disposed = true; clearInterval(poll); stop(); controller.select(null); }, { once: true });
