#!/usr/bin/env node
// Writes the swarm manifest read by the kelpi-swarm-view plugin.
// No dependencies, no daemon, no kelpi CLI. Schema: contracts/manifest.schema.json.
//
//   manifest-writer.mjs init <workspace-id> <orchestrator-pane-id> <orchestrator-label>
//   manifest-writer.mjs add-worker <workspace-id> <pane-id> <label> <task> <result-path> [worktree-path] [parent-pane-id]
//      optional flags: --agent claude|codex --task-path <abs> --model <m> --mode <x> --effort <level> --dir <abs> --started-at <iso>
//   manifest-writer.mjs remove-worker <workspace-id> <pane-id>
//   kelpi pane list --json | manifest-writer.mjs prune [--keep <workspace-id>] [--older-than-minutes 10]
//   manifest-writer.mjs set-orchestrator <workspace-id> <orchestrator-pane-id>
//   manifest-writer.mjs show <workspace-id>
//
// Directory: $SWARM_MANIFEST_DIR, default ~/.kelpi-swarm. Use "-" for an absent optional value.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// prune leaves another swarm's manifest alone this long after its last write.
const FRESH_MS = Number(process.env.SWARM_PRUNE_FRESH_MS ?? 60000)

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

const FLAGS = { '--agent': 'agent', '--task-path': 'taskPath', '--model': 'model', '--mode': 'mode', '--effort': 'effort', '--dir': 'dir', '--started-at': 'startedAt' }
// The reasoning levels Claude and Codex both accept. Codex's ultra is left out: it starts its own agents.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// Separates `--flag value` pairs from positional arguments.
function splitFlags(args) {
  const positional = []
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue }
    if (!(args[i] in FLAGS) && args[i] !== '--keep' && args[i] !== '--older-than-minutes') fail(`unknown option ${args[i]}`)
    if (i + 1 >= args.length) fail(`${args[i]} needs a value`)
    flags[args[i]] = args[++i]
  }
  return { positional, flags }
}

// What swarm-retry needs to start a worker again. Only the flags given are written, so old callers keep the old shape.
function retryFields(flags) {
  const out = {}
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (!(flag in flags)) continue
    const v = optional(flags[flag])
    if (v === null) { out[key] = null; continue }
    checkNonEmpty(flag, v)
    if (key === 'taskPath' || key === 'dir') {
      if (!v.startsWith('/')) fail(`${flag} must be an absolute path`)
      checkPath(flag, v)
    } else if (key === 'agent') {
      if (!['claude', 'codex'].includes(v)) fail('--agent must be claude or codex')
    } else if (key === 'effort') {
      if (!EFFORTS.includes(v)) fail(`--effort must be one of ${EFFORTS.join(', ')}`)
    } else if (key === 'startedAt') {
      if (Number.isNaN(Date.parse(v))) fail('--started-at must be an ISO time')
    } else if (!/^[A-Za-z0-9.-]+$/.test(v)) fail(`${flag} must be a plain word`)
    if (v.length > (key === 'taskPath' || key === 'dir' ? 1000 : 40)) fail(`${flag} is too long`)
    out[key] = v
  }
  return out
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
    const { positional, flags } = splitFlags(a)
    if (positional.length < 5 || positional.length > 7) {
      fail('usage: add-worker <workspace-id> <pane-id> <label> <task> <result-path> [worktree-path] [parent-pane-id] [--task-path p] [--model m] [--mode x] [--effort level] [--dir d] [--started-at iso]')
    }
    const f = fileFor(positional[0])
    const m = load(f)
    const paneID = checkNonEmpty('pane-id', positional[1])
    const worker = {
      paneID,
      label: checkNonEmpty('label', positional[2]),
      task: typeof positional[3] === 'string' ? positional[3] : fail('task required'),
      resultPath: checkPath('result-path', optional(positional[4])),
      worktreePath: checkPath('worktree-path', optional(positional[5])),
      parent: optional(positional[6]) === null ? null : checkNonEmpty('parent-pane-id', positional[6]),
      ...retryFields(flags),
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
  case 'prune': {
    // Reads `kelpi pane list --json` on stdin. Result files are never touched.
    const { positional, flags } = splitFlags(a)
    if (positional.length) fail('usage: prune [--keep <workspace-id>] [--older-than-minutes N]  (pane list JSON on stdin)')
    const keep = '--keep' in flags ? checkWorkspaceId(flags['--keep']) : null
    const minutes = '--older-than-minutes' in flags ? Number(flags['--older-than-minutes']) : 10
    if (!Number.isFinite(minutes) || minutes < 0) fail('--older-than-minutes must be a number of minutes, 0 or more')
    let panes
    try { panes = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { fail('stdin must be the JSON from `kelpi pane list`') }
    // An empty or malformed list would make every pane look closed, so it never prunes.
    if (!Array.isArray(panes) || panes.length === 0 || !panes.every((p) => p && typeof p.id === 'string')) {
      fail('stdin must be a non-empty JSON array of panes with ids')
    }
    const live = new Map(panes.map((p) => [p.id, p.workspace_id]))
    const out = { droppedWorkers: [], deletedManifests: [] }
    const d = dir()
    let names = []
    try { names = fs.readdirSync(d) } catch {}
    for (const name of names.sort()) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : null
      if (id === null || !ID_RE.test(id) || id.includes('..')) continue
      const f = path.join(d, name)
      // Another coordinator may be writing its manifest right now; a save here would drop its new worker.
      try { if (id !== keep && Date.now() - fs.statSync(f).mtimeMs < FRESH_MS) continue } catch { continue }
      let m
      try { m = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
      if (!m || !m.orchestrator || !Array.isArray(m.workers)) continue
      // Same rule as the plugin: the coordinator pane exists and sits in the workspace the file is named after.
      const orchWs = live.get(m.orchestrator.paneID)
      const coordinatorGone = id !== keep && !(live.has(m.orchestrator.paneID) && (orchWs === undefined || orchWs === id))
      const finishedBefore = Date.now() - minutes * 60000
      const dropped = new Set()
      for (const w of m.workers) {
        if (live.has(w.paneID)) continue
        let hasOldResult = false
        try {
          const s = w.resultPath ? fs.statSync(w.resultPath) : null
          hasOldResult = !!s && s.isFile() && s.mtimeMs <= finishedBefore
        } catch {}
        if (coordinatorGone || hasOldResult) dropped.add(w.paneID)
      }
      const kept = m.workers.filter((w) => !dropped.has(w.paneID))
      if (coordinatorGone && !kept.some((w) => live.has(w.paneID))) {
        fs.unlinkSync(f)
        out.deletedManifests.push(id)
        out.droppedWorkers.push(...dropped)
        continue
      }
      if (dropped.size === 0) continue
      for (const w of kept) if (dropped.has(w.parent)) w.parent = null
      m.workers = kept
      save(f, m)
      out.droppedWorkers.push(...dropped)
    }
    // The plugin's exits/<pane-id>.json files for swarm-wait: a closed pane's is never read again.
    out.removedExits = []
    let exits = []
    try { exits = fs.readdirSync(path.join(d, 'exits')) } catch {}
    for (const name of exits) {
      const pane = name.endsWith('.json') ? name.slice(0, -5) : null
      if (pane === null || !ID_RE.test(pane) || live.has(pane)) continue
      try { fs.unlinkSync(path.join(d, 'exits', name)); out.removedExits.push(pane) } catch {}
    }
    process.stdout.write(JSON.stringify(out) + '\n')
    break
  }
  case 'show': {
    if (a.length !== 1) fail('usage: show <workspace-id>')
    process.stdout.write(JSON.stringify(load(fileFor(a[0])), null, 2) + '\n')
    break
  }
  default:
    fail('usage: manifest-writer.mjs init|add-worker|remove-worker|prune|show ...')
}
