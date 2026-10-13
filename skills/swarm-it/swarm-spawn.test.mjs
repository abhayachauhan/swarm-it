// swarm-spawn places a worker without moving it between workspaces when it can: Kelpi switches the
// user's view on every move, never on a background create. Runs the real script against a stub `kelpi`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'swarm-spawn')

const ME = { id: 'ORCH', label: 'coordinator', workspace_id: 'WS', workspace_name: 'Warm pool', group_id: 'G' }

function stub(workspaces) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-spawn-'))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(home, 'panes.json'), JSON.stringify([ME]))
  fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify(workspaces))
  fs.writeFileSync(path.join(bin, 'kelpi'), `#!/bin/sh
echo "$*" >> "${home}/calls.log"
case "$1 $2" in
  "pane id") echo ORCH ;;
  "pane list") cat "${home}/panes.json" ;;
  "workspace list") cat "${home}/workspaces.json" ;;
  "pane create") echo '{"pane_id":"CREATED"}' ;;
  "pane split") echo '{"pane_id":"SPLIT"}' ;;
esac
`, { mode: 0o755 })
  const task = path.join(home, 'task.md')
  fs.writeFileSync(task, 'Do the thing\n')
  return { home, bin, task }
}

function spawn({ home, bin, task }) {
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }
  delete env.SWARM_MANIFEST_DIR
  const out = spawnSync(script, ['w1', task, '--path', home], { env, encoding: 'utf8' })
  return { ...out, calls: fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n') }
}

test('a worker opens straight in the existing workers workspace, with no split and no move', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }, { id: 'HID', name: 'Warm pool · workers' }, { id: 'X', name: 'Other · workers' }])
  const { status, stdout, stderr, calls } = spawn(s)
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'CREATED:w1')
  assert.ok(calls.includes(`pane create --workspace HID --name w1 --path ${s.home} --json`), calls.join('\n'))
  assert.ok(!calls.some(c => c.startsWith('pane split') || c.includes('move') || c.includes('--focus')), calls.join('\n'))
  const manifest = JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'), 'utf8'))
  assert.deepEqual(manifest.workers.map(w => w.paneID), ['CREATED'])
})

test('the first worker of a new swarm splits beside the coordinator, for the plugin to move once', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }, { id: 'X', name: 'Other · workers' }])
  const { status, stdout, stderr, calls } = spawn(s)
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'SPLIT:w1')
  assert.ok(calls.some(c => c.startsWith('pane split --name w1')), calls.join('\n'))
  assert.ok(!calls.some(c => c.startsWith('pane create')), calls.join('\n'))
})
