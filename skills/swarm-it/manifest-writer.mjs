#!/usr/bin/env node
// Writes the swarm manifest read by the kelpi-swarm-view plugin.
// No dependencies, no daemon, no kelpi CLI. Schema: contracts/manifest.schema.json.
//
//   manifest-writer.mjs init <workspace-id> <orchestrator-pane-id> <orchestrator-label>
//   manifest-writer.mjs add-worker <workspace-id> <pane-id> <label> <task> <result-path> [worktree-path] [parent-pane-id]
//   manifest-writer.mjs remove-worker <workspace-id> <pane-id>
//   manifest-writer.mjs set-orchestrator <workspace-id> <orchestrator-pane-id>
//   manifest-writer.mjs show <workspace-id>
//
// Directory: $SWARM_MANIFEST_DIR, default ~/.kelpi-swarm. Use "-" for an absent optional value.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function fail(msg) {
  process.stderr.write(`manifest-writer: ${msg}\n`)
  process.exit(1)
}

function dir() {
  const d = process.env.SWARM_MANIFEST_DIR
  return d && d.length > 0 ? path.resolve(d) : path.join(os.homedir(), '.kelpi-swarm')
}

function checkWorkspaceId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) {
    fail(`malformed workspace id: ${JSON.stringify(id)}`)
  }
  return id
}

function checkNonEmpty(name, v) {
  if (typeof v !== 'string' || v.length === 0 || /[\u0000-\u001f]/.test(v)) {
    fail(`${name} must be a non-empty string without control characters`)
  }
  return v
}

// Optional path/id: undefined, "" or "-" means null.
function optional(v) {
  return v === undefined || v === '' || v === '-' ? null : v
}

function checkPath(name, v) {
  if (v === null) return null
  checkNonEmpty(name, v)
  if (v.split(/[\\/]/).includes('..')) fail(`${name} must not contain ".." segments`)
  return v
}

function fileFor(id) {
  checkWorkspaceId(id)
  const d = dir()
  const f = path.join(d, `${id}.json`)
  if (path.dirname(f) !== d) fail('manifest path escapes the manifest directory')
  return f
}

function load(f) {
  let raw
  try {
    raw = fs.readFileSync(f, 'utf8')
  } catch (e) {
    fail(`no manifest at ${f} (run init first)`)
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    fail(`manifest at ${f} is not valid JSON`)
  }
}

function save(f, m) {
  const d = path.dirname(f)
  fs.mkdirSync(d, { recursive: true })
  const tmp = path.join(d, `.${path.basename(f)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, f)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    fail(`write failed: ${e.message}`)
  }
}

const [cmd, ...a] = process.argv.slice(2)

switch (cmd) {
  case 'init': {
    if (a.length !== 3) fail('usage: init <workspace-id> <orchestrator-pane-id> <orchestrator-label>')
    const f = fileFor(a[0])
    save(f, {
      version: 1,
      orchestrator: { paneID: checkNonEmpty('orchestrator-pane-id', a[1]), label: checkNonEmpty('orchestrator-label', a[2]) },
      workers: [],
    })
    process.stdout.write(`${f}\n`)
    break
  }
  case 'set-orchestrator': {
    // The coordinator's pane id changes when its Claude restarts; keep the workers.
    if (a.length !== 2) fail('usage: set-orchestrator <workspace-id> <orchestrator-pane-id>')
    const f = fileFor(a[0])
    const m = load(f)
    m.orchestrator = { ...m.orchestrator, paneID: checkNonEmpty('orchestrator-pane-id', a[1]) }
    save(f, m)
    process.stdout.write(`${f}\n`)
    break
  }
  case 'add-worker': {
    if (a.length < 5 || a.length > 7) {
      fail('usage: add-worker <workspace-id> <pane-id> <label> <task> <result-path> [worktree-path] [parent-pane-id]')
    }
    const f = fileFor(a[0])
    const m = load(f)
    const paneID = checkNonEmpty('pane-id', a[1])
    const worker = {
      paneID,
      label: checkNonEmpty('label', a[2]),
      task: typeof a[3] === 'string' ? a[3] : fail('task required'),
      resultPath: checkPath('result-path', optional(a[4])),
      worktreePath: checkPath('worktree-path', optional(a[5])),
      parent: optional(a[6]) === null ? null : checkNonEmpty('parent-pane-id', a[6]),
    }
    if (m.orchestrator.paneID === paneID) fail('pane-id is the orchestrator')
    if (worker.parent !== null && !m.workers.some((w) => w.paneID === worker.parent)) {
      fail(`parent-pane-id ${worker.parent} is not a known worker`)
    }
    const i = m.workers.findIndex((w) => w.paneID === paneID)
    if (i >= 0) m.workers[i] = worker
    else m.workers.push(worker)
    save(f, m)
    process.stdout.write(`${f}\n`)
    break
  }
  case 'remove-worker': {
    if (a.length !== 2) fail('usage: remove-worker <workspace-id> <pane-id>')
    const f = fileFor(a[0])
    const m = load(f)
    const paneID = checkNonEmpty('pane-id', a[1])
    m.workers = m.workers.filter((w) => w.paneID !== paneID)
    for (const w of m.workers) if (w.parent === paneID) w.parent = null
    save(f, m)
    process.stdout.write(`${f}\n`)
    break
  }
  case 'show': {
    if (a.length !== 1) fail('usage: show <workspace-id>')
    process.stdout.write(JSON.stringify(load(fileFor(a[0])), null, 2) + '\n')
    break
  }
  default:
    fail('usage: manifest-writer.mjs init|add-worker|remove-worker|show ...')
}
