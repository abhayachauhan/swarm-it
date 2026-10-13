// Pure helpers for the "Run suggested command" view. No DOM here.

/** The value of the target menu's default entry: a new shell pane split next to the source pane. */
export const NEW_PANE = 'new';

// Same policy as the backend: newlines between commands only, no other control character.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Why the edited text cannot run, or ''. */
export function textError(text) {
    if (typeof text !== 'string' || !text.trim()) return 'The command is empty.';
    if (CONTROL.test(text.replace(/\n+$/, ''))) return 'The command contains a control character; remove it to run.';
    if (/\p{Cf}/u.test(text)) return 'The command contains an invisible formatting character; remove it to run.';
    return '';
}

/** How many commands Run will type, said plainly when it is more than one. */
export function lineNote(text) {
    const count = String(text).replace(/\n+$/, '').split('\n').filter(line => line.trim()).length;
    return count > 1 ? `${count} lines: each runs as its own command.` : '';
}

/** Read the view state the backend opened this view with, or null when it is unusable. */
export function readState(state) {
    if (!state || typeof state.sourcePaneID !== 'string' || !state.sourcePaneID || typeof state.command !== 'string') return null;
    const targets = Array.isArray(state.targets) ? state.targets.filter(t => t && typeof t.paneID === 'string' && t.paneID) : [];
    // The backend's pick (Claude's own session for a `!` command); anything it does not offer falls back to a new pane.
    const defaultTarget = targets.some(t => t.paneID === state.defaultTarget) ? state.defaultTarget : NEW_PANE;
    return { mode: state.mode === 'copy' ? 'copy' : 'run', sourcePaneID: state.sourcePaneID, command: state.command, targets, defaultTarget };
}

/** Target menu entries: the new shell pane first, then existing panes, agents labelled. */
export function targetOptions(targets) {
    return [
        { value: NEW_PANE, label: 'A new shell pane next to this one' },
        ...targets.map(t => ({ value: t.paneID, label: `${t.name || t.paneID}${t.source ? ' (this pane)' : ''}${t.agent ? ' — Claude session, runs as a ! command' : ''}` }))
    ];
}

/** What typing into the picked pane will do, said plainly, or ''. */
export function targetNote(model, target) {
    const picked = model.targets.find(t => t.paneID === target);
    if (!picked?.agent) return '';
    return 'Types "! <command>" into Claude\'s prompt, so Claude runs it and sees the output. Any unsent text in that prompt gets the command added to its end.';
}

/** Arguments for run-suggested-confirm. An agent pane is only typed into because the user picked it in the menu. */
export function confirmArgs(model, text, target) {
    const picked = model.targets.find(t => t.paneID === target);
    return {
        sourcePaneID: model.sourcePaneID,
        text: text.replace(/\n+$/, ''),
        target: picked ? picked.paneID : NEW_PANE,
        confirmed: true,
        ...(picked?.agent ? { allowAgent: true } : {})
    };
}
