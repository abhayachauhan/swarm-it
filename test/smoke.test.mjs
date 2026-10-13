import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, COUNTS_ITEM, RAIL_VIEW, THREAD_VIEW, modules } from '../backend/index.mjs';

const manifest = JSON.parse(readFileSync(new URL('../kelpi.plugin.json', import.meta.url), 'utf8'));

test('manifest declares every command the backend registers', () => {
    const declared = manifest.contributes.commands.map(c => c.id).sort();
    assert.deepEqual([...COMMANDS].sort(), declared);
});

test('manifest declares views and the status bar item', () => {
    const views = manifest.contributes.views.map(v => v.id);
    assert.ok(views.includes(RAIL_VIEW) && views.includes(THREAD_VIEW));
    assert.ok(manifest.contributes.items.some(i => i.id === COUNTS_ITEM && i.placement === 'statusbar'));
    assert.ok(!manifest.contributes.views.some(v => v.placements.includes('statusbar')));
});

test('all backend modules import and are stubs or implementations', () => {
    for (const name of ['store', 'manifest', 'attention', 'actions', 'collapse', 'notify']) {
        assert.ok(Object.keys(modules[name]).length > 0, name);
    }
});
