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

const COLLAPSE_WARNING = 'Warning: the daemon does not support --collapse-parent. Workspace w1 (CHILD) was created.'

const ME = { id: 'ORCH', label: 'coordinator', workspace_id: 'WS', workspace_name: 'Warm pool', group_id: 'G' }

function stub(workspaces, { collapseParent = false, olderDaemon = false, createError = '', errorParent = '' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-spawn-'))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(home, 'panes.json'), JSON.stringify([ME]))
  fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify(workspaces))
  fs.writeFileSync(path.join(bin, 'kelpi'), `#!/bin/sh
echo "$*" >> "${home}/calls.log"
case "$1 $2" in
  "pane id") echo ORCH ;;
  "pane list") if [ "$3" = "--workspace" ]; then echo '[{"id":"CREATED","workspace_id":"CHILD"}]'; else cat "${home}/panes.json"; fi ;;
  "workspace list") cat "${home}/workspaces.json" ;;
  "workspace create")
    if [ "$3" = "--help" ]; then
      echo 'Usage: kelpi workspace create --parent <id>${collapseParent ? ' [--collapse-parent]' : ''}'
    elif ${createError ? 'true' : 'false'}; then
      ${errorParent ? `echo '{"ok":true,"workspace_id":"CHILD","parent_id":"${errorParent}"}'` : ':'}
      echo '${createError}' >&2
      exit 1
    else
      echo '{"ok":true,"workspace_id":"CHILD","parent_id":"WS"${collapseParent && !olderDaemon ? ',"parent_collapsed":true' : ''}}'
      ${olderDaemon ? `echo '${COLLAPSE_WARNING}' >&2` : ':'}
    fi ;;
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
  const typed = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
  return { ...out, typed, calls: typed.map(expandPrompt) }
}

/** The typed command reads its prompt from a file; put the file's text back so assertions see the whole prompt. */
function expandPrompt(call) {
  return call.replace(/"\$\(cat '([^']+)'\)"/, (_, file) => `"${fs.readFileSync(file, 'utf8').trimEnd()}"`)
}
const promptFileOf = typed => typed.match(/"\$\(cat '([^']+)'\)"$/)?.[1]

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

test('each worker uses the initial shell in a child workspace, without a shared workspace, split, move or focus', () => {
  for (const workspaces of [[{ id: 'WS', name: 'Warm pool' }], [{ id: 'WS', name: 'Warm pool' }, { id: 'HID', name: 'Workers' }]]) {
    const s = stub(workspaces)
    const { status, stdout, stderr, calls } = spawn(s)
    assert.equal(status, 0, stderr)
    assert.equal(stdout.trim(), 'CREATED:w1')
    assert.deepEqual(calls.filter(c => c.startsWith('workspace create ')), [
      'workspace create --help',
      `workspace create --parent WS --name w1 --path ${s.home} --no-repo --json`
    ])
    assert.ok(calls.includes('pane list --workspace CHILD --json'))
    assert.ok(!calls.some(c => /^pane (split|create)/.test(c) || c.includes('move') || c.includes('--focus')), calls.join('\n'))
    const manifest = JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'), 'utf8'))
    assert.deepEqual(manifest.workers.map(w => w.paneID), ['CREATED'])
  }
})

test('a supported Kelpi collapses the parent during the single background create', t => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }], { collapseParent: true })
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }))
  const { status, stdout, stderr, calls } = spawn(s)
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'CREATED:w1')
  assert.deepEqual(calls.filter(c => c.startsWith('workspace create ')), [
    'workspace create --help',
    `workspace create --parent WS --name w1 --path ${s.home} --no-repo --json --collapse-parent`
  ])
})

test('a newer CLI keeps the nested child already confirmed by an older daemon', t => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }], {
    collapseParent: true, olderDaemon: true
  })
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }))
  const { status, stdout, stderr, calls } = spawn(s)
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'CREATED:w1')
  assert.equal(stderr.trim(), COLLAPSE_WARNING)
  assert.deepEqual(calls.filter(c => c.startsWith('workspace create ')), [
    'workspace create --help',
    `workspace create --parent WS --name w1 --path ${s.home} --no-repo --json --collapse-parent`
  ])
  assert.equal(calls.some(c => c.startsWith('workspace delete')), false)
  const manifest = JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'), 'utf8'))
  assert.deepEqual(manifest.workers.map(w => w.paneID), ['CREATED'])
})

test('a create failure leaves the previous result and manifest alone without retrying', t => {
  for (const [createError, errorParent] of [
    ['create reply was lost', ''],
    ['terminal startup failed', 'WS']
  ]) {
    const s = stub([{ id: 'WS', name: 'Warm pool' }], { collapseParent: true, createError, errorParent })
    t.after(() => fs.rmSync(s.home, { recursive: true, force: true }))
    const results = path.join(s.home, '.kelpi-swarm', 'results')
    fs.mkdirSync(results, { recursive: true })
    fs.writeFileSync(path.join(results, 'w1.md'), 'previous result')
    const { status, stderr, calls } = spawn(s)
    assert.equal(status, 1)
    assert.equal(stderr.trim(), `${createError}\nKelpi did not create the child workspace; no worker was registered`)
    assert.deepEqual(calls.filter(c => c.startsWith('workspace create ')), [
      'workspace create --help',
      `workspace create --parent WS --name w1 --path ${s.home} --no-repo --json --collapse-parent`
    ])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'))).workers, [])
    assert.equal(fs.readFileSync(path.join(results, 'w1.md'), 'utf8'), 'previous result')
    assert.equal(calls.some(c => c.startsWith('pane send')), false)
  }
})

test('a sub-swarm nests new workers under the root parent', () => {
  const s = stub([{ id: 'WS', name: 'Worker', parent_id: 'ROOT' }])
  const cli = path.join(s.bin, 'kelpi')
  fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace('"parent_id":"WS"', '"parent_id":"ROOT"'))
  const out = spawn(s)
  assert.equal(out.status, 0, out.stderr)
  assert.ok(out.calls.some(c => c.startsWith('workspace create --parent ROOT ')))
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

test('--parent-session tells a Claude worker to message that session, and is left out otherwise', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  const lastSend = out => out.calls.filter(c => c.startsWith('pane send')).at(-1)
  const plain = spawn(s, ['w1', s.task, '--path', s.home])
  assert.equal(plain.status, 0, plain.stderr)
  assert.ok(!lastSend(plain).includes('SendMessage'), lastSend(plain))
  const told = spawn(s, ['w1', s.task, '--path', s.home, '--parent-session', 'repos-a9'])
  assert.equal(told.status, 0, told.stderr)
  const send = lastSend(told)
  assert.ok(send.includes('Your coordinator is the Claude Code session repos-a9. Load SendMessage'), send)
  assert.ok(send.includes('start with w1:'), send)
  assert.ok(send.indexOf('/.kelpi-swarm/results/w1.md.') < send.indexOf('Your coordinator'), 'the result file instruction comes first')
  assert.ok(send.endsWith('Always write the result file even if a send fails. Reply done."'), send)
})

test('the typed command stays under the 1024-byte terminal line limit and reads the full prompt from a file', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  const deep = path.join(s.home, 'a-fairly-long-scratchpad-folder-name-e66692be-8c93-46b2-9455-cc37d93631aa', 'another-nested-folder-for-the-worker')
  fs.mkdirSync(deep, { recursive: true })
  const label = 'a-long-worker-label-for-the-line-limit-check'
  for (const agent of ['claude', 'codex']) {
    const out = spawn(s, [label, s.task, '--agent', agent, '--path', deep, '--effort', 'high', '--parent-session', 'repos-a9'])
    assert.equal(out.status, 0, out.stderr)
    const typed = out.typed.filter(c => c.startsWith('pane send')).at(-1).replace(/^pane send --target \S+ /, '')
    assert.ok(Buffer.byteLength(typed) < 700, `${agent}: ${Buffer.byteLength(typed)} bytes typed: ${typed}`)
    const file = promptFileOf(typed)
    assert.ok(file?.startsWith(`${s.home}/.kelpi-swarm/prompts/${label}.`) && file.endsWith('.txt'), typed)
    const prompt = fs.readFileSync(file, 'utf8')
    assert.ok(prompt.startsWith(`Do the task in ${s.task}. Write the result as markdown`), prompt)
    assert.ok(prompt.trimEnd().endsWith('Reply done.'), prompt)
    assert.equal(prompt.includes('Your coordinator is the Claude Code session repos-a9.'), agent === 'claude', prompt)
  }
})

test('two spawns with the same label keep separate prompt files, and a real shell reads one with spaces in its path', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  const other = path.join(s.home, 'other-task.md')
  fs.writeFileSync(other, 'Other task\n')
  const first = spawn(s, ['same', s.task, '--path', s.home])
  const second = spawn(s, ['same', other, '--path', s.home])
  assert.equal(first.status + second.status, 0, first.stderr + second.stderr)
  const fileA = promptFileOf(first.typed.filter(c => c.startsWith('pane send')).at(-1))
  const fileB = promptFileOf(second.typed.filter(c => c.startsWith('pane send')).at(-1))
  assert.notEqual(fileA, fileB)
  assert.ok(fs.readFileSync(fileA, 'utf8').startsWith(`Do the task in ${s.task}.`), 'the first worker keeps its own task')
  assert.ok(fs.readFileSync(fileB, 'utf8').startsWith(`Do the task in ${other}.`))
  // The typed form must survive a real shell even when the path has a space in it.
  const spaced = path.join(s.home, 'a b', 'prompt.txt')
  fs.mkdirSync(path.dirname(spaced), { recursive: true })
  fs.writeFileSync(spaced, 'Do the task in x. Reply done.\n')
  const echoed = spawnSync('zsh', ['-fc', `printf '%s' "$(cat '${spaced}')"`], { encoding: 'utf8' })
  assert.equal(echoed.stdout, 'Do the task in x. Reply done.')
})

test('a Codex worker is not told to message the parent session and the coordinator is warned', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  const out = spawn(s, ['review', s.task, '--agent', 'codex', '--path', s.home, '--parent-session', 'repos-a9'])
  assert.equal(out.status, 0, out.stderr)
  assert.ok(!out.calls.find(c => c.startsWith('pane send')).includes('SendMessage'))
  assert.match(out.stderr, /Codex workers cannot message repos-a9/)
})

test('a parent session name with shell characters is refused before anything runs', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  for (const name of ['repos a9', 'x;id', '$(id)', 'a"b', '../x', '-x']) {
    const { status, stderr, calls } = spawn(s, ['w1', s.task, '--path', s.home, '--parent-session', name])
    assert.notEqual(status, 0, name)
    assert.match(stderr, /parent session must be letters/)
    assert.deepEqual(calls, [], `nothing ran for --parent-session ${name}`)
  }
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
  fs.writeFileSync(path.join(s.bin, 'kelpi'), fs.readFileSync(path.join(s.bin, 'kelpi'), 'utf8').replace('[{"id":"CREATED","workspace_id":"CHILD"}]', '[]'))
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


test('a daemon that ignores nesting fails before registration, result archiving or sending a command', () => {
  const s = stub([{ id: 'WS', name: 'Warm pool' }])
  const cli = path.join(s.bin, 'kelpi')
  fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace(',"parent_id":"WS"', ''))
  const results = path.join(s.home, '.kelpi-swarm', 'results')
  fs.mkdirSync(results, { recursive: true })
  fs.writeFileSync(path.join(results, 'w1.md'), 'previous result')
  const out = spawn(s)
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /did not nest the child workspace; update Kelpi/)
  assert.ok(out.calls.includes('workspace delete CHILD'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'))).workers, [])
  assert.equal(fs.readFileSync(path.join(results, 'w1.md'), 'utf8'), 'previous result')
  assert.ok(!out.calls.some(c => c.startsWith('pane send')))
})
