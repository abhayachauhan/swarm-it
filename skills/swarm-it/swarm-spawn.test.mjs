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

function spawn({ home, bin, task }, args = ['w1', task, '--path', home]) {
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }
  delete env.SWARM_MANIFEST_DIR
  const out = spawnSync(script, args, { env, encoding: 'utf8' })
  const log = path.join(home, 'calls.log')
  return { ...out, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] }
}

test('shell metacharacters in the label, task, dir, mode or model are refused before anything runs', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  const victim = path.join(s.home, 'x.md')
  fs.writeFileSync(victim, 'keep')
  for (const args of [
    ['../../x', s.task],
    ['w$(id)', s.task],
    ['w1', s.task, '--path', 'a;rm${IFS}-rf${IFS}b'],
    ['w1', s.task, '--model', 'sonnet;id'],
    ['w1', s.task, '--mode', 'auto --dangerously-skip-permissions'],
    ['w1', `${s.task}$(id)`]
  ]) {
    const { status, calls } = spawn(s, args)
    assert.notEqual(status, 0, args.join(' '))
    assert.deepEqual(calls, [], `nothing ran for ${args.join(' ')}`)
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep', 'a ../ label deletes nothing')
})

test('a worker opens straight in the shared Workers workspace, with no split and no move', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }, { id: 'OLD', name: 'Warm pool · workers' }, { id: 'LOOSE', name: 'Workers' }, { id: 'HID', name: 'Workers', group_name: 'Workers' }])
  const { status, stdout, stderr, calls } = spawn(s)
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'CREATED:w1')
  assert.ok(calls.includes(`pane create --workspace HID --name w1 --path ${s.home} --json`), calls.join('\n'))
  assert.ok(!calls.some(c => c.startsWith('pane split') || c.includes('move') || c.includes('--focus')), calls.join('\n'))
  const manifest = JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'), 'utf8'))
  assert.deepEqual(manifest.workers.map(w => w.paneID), ['CREATED'])
})

test('before the Workers workspace exists a worker splits beside the coordinator, for the plugin to move once', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }, { id: 'X', name: 'Warm pool · workers' }])
  const { status, stdout, stderr, calls } = spawn(s)
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'SPLIT:w1')
  assert.ok(calls.some(c => c.startsWith('pane split --name w1')), calls.join('\n'))
  assert.ok(!calls.some(c => c.startsWith('pane create')), calls.join('\n'))
})

test('a Codex worker uses its sandbox and records its agent without a Claude model default', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  const { status, stderr, calls } = spawn(s, ['review', s.task, '--agent', 'codex', '--path', s.home])
  assert.equal(status, 0, stderr)
  const send = calls.find(c => c.startsWith('pane send'))
  assert.ok(send.includes(`codex --sandbox workspace-write --add-dir ${s.home}/.kelpi-swarm/results --ask-for-approval on-request`), send)
  assert.ok(!send.includes('claude -p') && !send.includes('--model sonnet'), send)
  const worker = JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'), 'utf8')).workers[0]
  assert.deepEqual([worker.agent, worker.model, worker.mode], ['codex', null, 'on-request'])
  assert.equal(worker.effort, null)
  assert.ok(!send.includes('model_reasoning_effort'), send)
})

test('--effort reaches Codex as model_reasoning_effort and Claude as --effort, and is recorded for swarm-retry', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  const codex = spawn(s, ['impl', s.task, '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'xhigh', '--path', s.home])
  assert.equal(codex.status, 0, codex.stderr)
  const codexSend = codex.calls.find(c => c.startsWith('pane send'))
  assert.ok(codexSend.includes('--model gpt-6.1-sol -c model_reasoning_effort=xhigh "Do the task'), codexSend)
  const worker = () => JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'), 'utf8')).workers[0]
  assert.deepEqual([worker().label, worker().effort], ['impl', 'xhigh'])
  // The stub hands out one pane id, so this worker replaces the first in the manifest.
  const claude = spawn(s, ['fix', s.task, '--effort', 'low', '--path', s.home])
  assert.equal(claude.status, 0, claude.stderr)
  const claudeSend = claude.calls.filter(c => c.startsWith('pane send')).at(-1)
  assert.ok(claudeSend.includes('claude -p --permission-mode auto --model sonnet --effort low "Do the task'), claudeSend)
  assert.deepEqual([worker().label, worker().effort], ['fix', 'low'])
})

test('an unknown effort, Codex ultra included, is refused before anything runs', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  for (const effort of ['ultra', 'none', 'high;id', 'HIGH']) {
    const { status, stderr, calls } = spawn(s, ['w1', s.task, '--agent', 'codex', '--effort', effort, '--path', s.home])
    assert.notEqual(status, 0, effort)
    assert.match(stderr, /effort must be low, medium, high, xhigh or max/)
    assert.deepEqual(calls, [], `nothing ran for --effort ${effort}`)
  }
})

test('failed, empty and invalid pane lists stop before changing manifests or archiving results', () => {
  for (const panes of [null, '', '{', '[]', JSON.stringify([{ ...ME, workspace_id: '' }]), JSON.stringify([{ ...ME, workspace_id: null }])]) {
    const s = stub([{ id: 'WS', name: 'Warm pool' }])
    const results = path.join(s.home, '.kelpi-swarm', 'results')
    fs.mkdirSync(results, { recursive: true })
    fs.writeFileSync(path.join(results, 'w1.md'), 'previous result')
    if (panes === null) fs.rmSync(path.join(s.home, 'panes.json'))
    else fs.writeFileSync(path.join(s.home, 'panes.json'), panes)
    try {
      const out = spawn(s)
      assert.notEqual(out.status, 0)
      assert.match(out.stderr, /cannot read Kelpi panes|no coordinator pane|no workspace ID/)
      assert.doesNotMatch(out.stderr, /not in a Group|malformed workspace id/)
      assert.equal(out.calls.some(c => /^pane (?:create|split|send|name)/.test(c)), false)
      assert.equal(fs.existsSync(path.join(s.home, '.kelpi-swarm', 'WS.json')), false)
      assert.equal(fs.readFileSync(path.join(results, 'w1.md'), 'utf8'), 'previous result')
      assert.equal(fs.existsSync(path.join(results, 'archive')), false)
    } finally { fs.rmSync(s.home, { recursive: true, force: true }) }
  }
})

test('an empty workspace list fails before creating a manifest or a worker', () => {
  const s = stub([])
  fs.writeFileSync(path.join(s.home, 'workspaces.json'), '')
  try {
    const out = spawn(s)
    assert.notEqual(out.status, 0)
    assert.match(out.stderr, /no workspace list/)
    assert.equal(out.calls.some(c => /^pane (?:create|split|send)/.test(c)), false)
    assert.equal(fs.existsSync(path.join(s.home, '.kelpi-swarm')), false)
  } finally { fs.rmSync(s.home, { recursive: true, force: true }) }
})

test('a failed pane creation does not register a worker or archive the previous result', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  fs.writeFileSync(path.join(s.bin, 'kelpi'), fs.readFileSync(path.join(s.bin, 'kelpi'), 'utf8').replace('"pane_id":"SPLIT"', '"error":"socket failed"'))
  const results = path.join(s.home, '.kelpi-swarm', 'results')
  fs.mkdirSync(results, { recursive: true })
  fs.writeFileSync(path.join(results, 'w1.md'), 'previous result')
  try {
    const out = spawn(s)
    assert.notEqual(out.status, 0)
    assert.match(out.stderr, /did not create the worker pane/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'))).workers.length, 0)
    assert.equal(fs.readFileSync(path.join(results, 'w1.md'), 'utf8'), 'previous result')
    assert.equal(out.calls.some(c => c.startsWith('pane send')), false)
  } finally { fs.rmSync(s.home, { recursive: true, force: true }) }
})
