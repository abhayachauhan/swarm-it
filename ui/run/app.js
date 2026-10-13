// "Run suggested command" view: shows the rejoined command for checking and editing, and the pane it will run in.
// Nothing is typed until Run is pressed. All text is set with textContent or value only.
import { textError, readState, targetOptions, targetNote, confirmArgs, lineNote } from './logic.js';

const api = window.kelpi;
await api.ready;
const $ = id => document.getElementById(id);
const PREFIX = 'local.swarm-view.';
const model = readState(api.state);
const showError = message => { $('error').textContent = message || ''; };

async function run(command, args) {
    const result = await api.commands.execute(PREFIX + command, args);
    if (!result || result.ok !== true) throw new Error(result?.error || 'Command failed');
    return result;
}
let busy = false;
const guarded = fn => async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (error) { showError(error instanceof Error ? error.message : String(error)); } finally { busy = false; }
};

if (!model) {
    showError('This view was opened without a command. Use "Run last suggested command" on a pane.');
    $('run').disabled = true;
    $('copy').disabled = true;
} else {
    $('command').value = model.command;
    const showLines = () => {
        $('lines').textContent = lineNote($('command').value);
        $('command').rows = Math.min(20, Math.max(3, $('command').value.split('\n').length + 1));
    };
    showLines();
    $('command').oninput = showLines;
    for (const option of targetOptions(model.targets)) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        $('target').append(node);
    }
    $('target').value = model.defaultTarget;
    const showNote = () => { $('target-note').textContent = targetNote(model, $('target').value); };
    showNote();
    $('target').onchange = showNote;
    if (model.mode === 'copy') {
        $('title').textContent = 'Copy fixed command';
        $('hint').textContent = 'The clipboard was not available. Select the command and copy it, or run it.';
        $('command').focus?.();
        $('command').select?.();
    }
}

$('run').onclick = guarded(async () => {
    const problem = textError($('command').value);
    if (problem) { showError(problem); return; }
    showError('');
    await run('run-suggested-confirm', confirmArgs(model, $('command').value, $('target').value));
});
$('copy').onclick = guarded(async () => {
    const problem = textError($('command').value);
    if (problem) { showError(problem); return; }
    await run('copy-suggested', { text: $('command').value.replace(/\n+$/, '') });
    showError('');
    $('hint').textContent = 'Copied.';
});
$('cancel').onclick = guarded(async () => { await run('close-run-view', {}); });
