// swarm-spawn records how each worker started, archives a reused label's result and prunes dead swarms;
// swarm-retry starts a dead worker again from that record. Runs the real scripts against a stub `kelpi`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const spawnScript = path.join(here, 'swarm-spawn')
const retryScript = path.join(here, 'swarm-retry')

const ME = { id: 'ORCH', label: 'coordinator', workspace_id: 'WS', workspace_name: 'Warm pool', group_id: 'G', status: 'idle' }

function stub() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-retry-'))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(home, 'panes.json'), JSON.stringify([ME]))
  fs.writeFileSync(path.join(home, 'next-pane'), 'P1')
  fs.writeFileSync(path.join(bin, 'kelpi'), `#!/bin/sh
echo "$*" >> "${home}/calls.log"
case "$1 $2" in
  "pane id") echo ORCH ;;
  "pane list") cat "${home}/panes.json" ;;
  "workspace list") echo '[{"id":"WS","name":"Warm pool"}]' ;;
  "pane create") echo "{\\"pane_id\\":\\"$(cat "${home}/next-pane")\\"}" ;;
  "pane split") echo "{\\"pane_id\\":\\"$(cat "${home}/next-pane")\\"}" ;;
esac
`, { mode: 0o755 })
  const task = path.join(home, 'task.md')
  fs.writeFileSync(task, 'Do the thing\n')
  return { home, bin, task, manifestDir: path.join(home, '.kelpi-swarm'), results: path.join(home, '.kelpi-swarm', 'results') }
}

function run(script, s, args) {
  const env = { ...process.env, HOME: s.home, PATH: `${s.bin}:${process.env.PATH}` }
  delete env.SWARM_MANIFEST_DIR
  const out = spawnSync(script, args, { env, encoding: 'utf8' })
  const log = path.join(s.home, 'calls.log')
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
  fs.rmSync(log, { force: true })
  return { ...out, calls }
}
const spawn = (s, args = ['w1', s.task, '--path', s.home]) => run(spawnScript, s, args)
const retry = (s, args) => run(retryScript, s, args)
const setPanes = (s, panes) => fs.writeFileSync(path.join(s.home, 'panes.json'), JSON.stringify(panes))
const manifest = (s, ws = 'WS') => JSON.parse(fs.readFileSync(path.join(s.manifestDir, `${ws}.json`), 'utf8'))
const noWork = (calls) => !calls.some((c) => c.startsWith('pane create') || c.startsWith('pane split') || c.startsWith('pane send'))

test('swarm-retry stops with a local-access diagnostic for failed or empty pane metadata', () => {
  for (const data of [null, '', JSON.stringify([{ ...ME, workspace_id: null }])]) {
    const s = stub()
    if (data === null) fs.rmSync(path.join(s.home, 'panes.json'))
    else fs.writeFileSync(path.join(s.home, 'panes.json'), data)
    try {
      const out = retry(s, ['P1:w1'])
      assert.notEqual(out.status, 0)
      assert.match(out.stderr, /cannot read Kelpi panes|no workspace ID/)
      assert.match(out.stderr, /sandbox escalation/)
      assert.ok(noWork(out.calls))
      assert.equal(fs.existsSync(s.manifestDir), false)
    } finally { fs.rmSync(s.home, { recursive: true, force: true }) }
  }
})

test('swarm-spawn records the task path, model, mode, directory and start time', () => {
  const s = stub()
  const { status, stdout, stderr } = spawn(s, ['w1', s.task, '--path', s.home, '--model', 'haiku'])
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'P1:w1')
  const w = manifest(s).workers[0]
  assert.equal(w.taskPath, s.task)
  assert.equal(w.model, 'haiku')
  assert.equal(w.mode, 'auto')
  assert.equal(w.dir, s.home)
  assert.match(w.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
})

test('swarm-spawn archives the old result of a reused label as results/archive/<label>.<UTC time>.md', () => {
  const s = stub()
  assert.equal(spawn(s).status, 0)
  assert.deepEqual(fs.existsSync(path.join(s.results, 'archive')) && fs.readdirSync(path.join(s.results, 'archive')), [], 'nothing to archive on first use')
  fs.writeFileSync(path.join(s.results, 'w1.md'), 'first result')
  assert.equal(spawn(s).status, 0)
  assert.equal(fs.existsSync(path.join(s.results, 'w1.md')), false, 'the label starts clean')
  const [name, ...rest] = fs.readdirSync(path.join(s.results, 'archive'))
  assert.deepEqual(rest, [])
  assert.match(name, /^w1\.\d{8}T\d{6}Z\.md$/)
  assert.equal(fs.readFileSync(path.join(s.results, 'archive', name), 'utf8'), 'first result')
})

test('swarm-spawn prunes dead swarms first and keeps its own, the live ones and every result', () => {
  const s = stub()
  fs.mkdirSync(s.results, { recursive: true })
  fs.writeFileSync(path.join(s.results, 'gone.md'), 'kept')
  fs.writeFileSync(path.join(s.manifestDir, 'DEAD.json'), JSON.stringify({ version: 1, orchestrator: { paneID: 'nope', label: 'coordinator' },
    workers: [{ paneID: 'x', label: 'gone', task: 't', resultPath: path.join(s.results, 'gone.md'), worktreePath: null, parent: null }] }))
  // Written an hour ago: prune leaves a manifest written in the last minute alone.
  const old = new Date(Date.now() - 3600000)
  fs.utimesSync(path.join(s.manifestDir, 'DEAD.json'), old, old)
  assert.equal(spawn(s).status, 0)
  assert.deepEqual(fs.readdirSync(s.manifestDir).filter((n) => n.endsWith('.json')), ['WS.json'])
  assert.equal(fs.readFileSync(path.join(s.results, 'gone.md'), 'utf8'), 'kept')
})

test('a restarted coordinator keeps its manifest through the prune', () => {
  const s = stub()
  assert.equal(spawn(s).status, 0)
  const m = manifest(s)
  m.orchestrator.paneID = 'OLD-ORCH'
  fs.writeFileSync(path.join(s.manifestDir, 'WS.json'), JSON.stringify(m))
  fs.writeFileSync(path.join(s.home, 'next-pane'), 'P2')
  assert.equal(spawn(s, ['w2', s.task, '--path', s.home]).status, 0)
  assert.deepEqual(manifest(s).workers.map((w) => w.label), ['w1', 'w2'])
  assert.equal(manifest(s).orchestrator.paneID, 'ORCH')
})

function started(s, extra = []) {
  assert.equal(spawn(s, ['w1', s.task, '--path', s.home, '--model', 'haiku', ...extra]).status, 0)
  setPanes(s, [ME]) // the worker pane P1 is gone
  fs.writeFileSync(path.join(s.home, 'next-pane'), 'P2')
}

test('swarm-retry starts a dead worker again with the same label, task, mode, model and directory', () => {
  const s = stub()
  started(s)
  fs.writeFileSync(path.join(s.results, 'w1.md'), 'half done')
  const { status, stdout, stderr, calls } = retry(s, ['P1:w1'])
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'P2:w1')
  const send = calls.find((c) => c.startsWith('pane send'))
  assert.ok(send.includes(`cd ${s.home} && claude -p --permission-mode auto --model haiku "Do the task in ${s.task}.`), send)
  assert.ok(send.includes(`Write the result to ${s.results}/w1.md.`), send)
  assert.deepEqual(manifest(s).workers.map((w) => [w.paneID, w.label, w.taskPath, w.model, w.mode, w.dir]), [['P2', 'w1', s.task, 'haiku', 'auto', s.home]])
  assert.equal(fs.existsSync(path.join(s.results, 'w1.md')), false)
  assert.equal(fs.readdirSync(path.join(s.results, 'archive')).length, 1, 'the earlier result is archived')
})

test('swarm-retry --model overrides the recorded model', () => {
  const s = stub()
  started(s)
  const { status, stderr, calls } = retry(s, ['P1:w1', '--model', 'opus'])
  assert.equal(status, 0, stderr)
  assert.ok(calls.find((c) => c.startsWith('pane send')).includes('--model opus "Do the task'))
  assert.equal(manifest(s).workers[0].model, 'opus')
})

test('swarm-retry keeps a Codex worker on Codex with its configured model', () => {
  const s = stub()
  assert.equal(spawn(s, ['w1', s.task, '--agent', 'codex', '--path', s.home, '--model', 'gpt-6.1-sol']).status, 0)
  setPanes(s, [ME])
  fs.writeFileSync(path.join(s.home, 'next-pane'), 'P2')
  const { status, stderr, calls } = retry(s, ['P1:w1'])
  assert.equal(status, 0, stderr)
  assert.ok(calls.find(c => c.startsWith('pane send')).includes('codex --sandbox workspace-write'), calls.join('\n'))
  assert.deepEqual(manifest(s).workers.map(w => [w.paneID, w.agent, w.model]), [['P2', 'codex', 'gpt-6.1-sol']])
})

test('swarm-retry refuses a worker whose pane still runs Claude, and starts nothing', () => {
  for (const pane of [{ id: 'P1', workspace_id: 'WS', status: 'running' }, { id: 'P1', workspace_id: 'WS', status: 'waitingForInput' },
    { id: 'P1', workspace_id: 'WS', status: 'idle', agent_session_id: '0f0f0f0f-0000-4000-8000-00000000c0de' }]) {
    const s = stub()
    started(s)
    setPanes(s, [ME, pane])
    const { status, stderr, calls } = retry(s, ['P1:w1'])
    assert.equal(status, 1)
    assert.equal(stderr.trim(), 'worker w1 still runs Claude in pane P1; close it first or wait for it')
    assert.ok(noWork(calls), calls.join('\n'))
    assert.equal(manifest(s).workers[0].paneID, 'P1', 'manifest unchanged')
  }
})

test('swarm-retry retries an idle pane that no longer runs Claude', () => {
  const s = stub()
  started(s)
  setPanes(s, [ME, { id: 'P1', workspace_id: 'WS', status: 'idle' }])
  const { status, stdout, stderr } = retry(s, ['P1:w1'])
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'P2:w1')
})

test('swarm-retry refuses an old worker with no recorded task path', () => {
  const s = stub()
  started(s)
  const m = manifest(s)
  delete m.workers[0].taskPath
  fs.writeFileSync(path.join(s.manifestDir, 'WS.json'), JSON.stringify(m))
  const { status, stderr, calls } = retry(s, ['P1:w1'])
  assert.equal(status, 1)
  assert.equal(stderr.trim(), 'worker w1 has no recorded task path (started before swarm-retry existed); run swarm-spawn again by hand')
  assert.ok(noWork(calls), calls.join('\n'))
})

test('swarm-retry refuses an unknown worker, a wrong label, a missing task file and hostile values', () => {
  const s = stub()
  started(s)
  const refused = (args, message) => {
    const { status, stderr, calls } = retry(s, args)
    assert.equal(status, 1, args.join(' '))
    assert.equal(stderr.trim(), message, args.join(' '))
    assert.ok(noWork(calls), `${args.join(' ')}\n${calls.join('\n')}`)
  }
  refused(['NOPE:w1'], 'no worker NOPE:w1 in this swarm\'s manifest')
  refused(['P1:other'], 'no worker P1:other in this swarm\'s manifest')
  refused(['P1:../x'], 'label must be letters, digits, dot, dash or underscore')
  refused(['P1:w$(id)'], 'label must be letters, digits, dot, dash or underscore')
  refused(['P1;id:w1'], 'pane id must be letters, digits, dot, dash or underscore')
  refused(['P1:w1', '--model', 'sonnet;id'], 'mode and model must be plain words')
  refused(['P1'], 'usage: swarm-retry <pane-id>:<label> [--model sonnet]')
  refused([], 'usage: swarm-retry <pane-id>:<label> [--model sonnet]')
  // The manifest is untrusted: a recorded value with shell characters is refused too.
  const m = manifest(s)
  m.workers[0].model = 'haiku;id'
  fs.writeFileSync(path.join(s.manifestDir, 'WS.json'), JSON.stringify(m))
  refused(['P1:w1'], 'recorded model must be a plain word')
  m.workers[0].model = 'haiku'
  m.workers[0].dir = '/tmp/a b'
  fs.writeFileSync(path.join(s.manifestDir, 'WS.json'), JSON.stringify(m))
  refused(['P1:w1'], 'recorded task path and dir must be letters, digits, dot, dash, underscore or slash')
  m.workers[0].dir = s.home
  fs.rmSync(s.task)
  fs.writeFileSync(path.join(s.manifestDir, 'WS.json'), JSON.stringify(m))
  refused(['P1:w1'], `no task file: ${s.task}`)
})
