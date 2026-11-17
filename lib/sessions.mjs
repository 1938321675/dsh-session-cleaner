/**
 * Session log analysis and quarantine helpers for dsh-session-cleaner.
 *
 * DSH session logs are multi-frame zstd files. Blank-session detection reads
 * frames one at a time and stops at the first event that proves real content,
 * so scanning hundreds of large logs stays fast.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** zstd frame magic (little endian 0xFD2FB528). */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Events a header-only session may carry without being a real conversation. */
const INITIAL_EVENTS = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent-preset/selected',
  'session/end-seed',
])

/** Session categories that belong to the harness rather than to the user. */
const SYSTEM_CATEGORIES = new Set(['subagent', 'automation', 'mnemon'])

/** Sessions younger than this are treated as possibly in use. */
export const RECENT_MS = 10 * 60 * 1000

/** Root directory holding every workspace's session artifacts. */
export function defaultSessionsRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

/** Root directory receiving quarantined sessions. */
export function defaultQuarantineRoot() {
  return join(homedir(), '.dsh', 'sessions-quarantine', 'session-cleaner')
}

/** Offsets of every zstd frame start in one artifact. */
function frameStarts(buf) {
  const starts = []
  let at = buf.indexOf(MAGIC, 0)
  while (at !== -1) {
    starts.push(at)
    at = buf.indexOf(MAGIC, at + 1)
  }
  return starts
}

/**
 * Join every zstd frame of one session artifact into one UTF-8 JSONL string.
 * Frames whose boundary scan misfires are skipped; a real log still parses.
 */
export function decodeSessionLog(buf) {
  const starts = frameStarts(buf)
  if (starts.length === 0) return ''
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(from, to)).toString('utf8'))
    } catch {
      // Boundary misfire: drop this slice, the other frames still count.
    }
  }
  return parts.join('')
}

/** Decode a workspace directory name such as --E-A0-~516C~5171~533A~57DF--. */
export function decodeWorkspaceDir(name) {
  return name
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/** Classify one session from its header. */
export function classifySession(header) {
  const id = header.id ?? ''
  if (id.startsWith('dsh-automation-session-')) return 'automation'
  if (id.startsWith('mnemon-run-v1-') || id.startsWith('mnemon-task-v1-')) return 'mnemon'
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return 'subagent'
  return 'main'
}

/** Whether one event type is still part of a freshly opened session. */
function isInitialEvent(type) {
  return type === 'session' || INITIAL_EVENTS.has(type)
}

/**
 * Decide whether a session is blank: no event beyond the header and the
 * initialization records a freshly opened session writes.
 */
export function isBlankSession(eventTypes) {
  return eventTypes.every((type) => isInitialEvent(type))
}

/** Extract the event type from one JSONL record without parsing its payload. */
function eventTypeOf(line) {
  if (line.startsWith('{"type":"')) {
    const end = line.indexOf('"', 10)
    if (end > 0) return line.slice(9, end)
  }
  try {
    const record = JSON.parse(line)
    return typeof record.type === 'string' ? record.type : ''
  } catch {
    return ''
  }
}

/**
 * Analyze one artifact, stopping at the first event that proves content.
 * Returns the header fields needed by the UI plus the blank verdict.
 */
export function analyzeArtifact(buf) {
  const starts = frameStarts(buf)
  if (starts.length === 0) return { header: {}, blank: true, events: 1 }
  let header = {}
  let events = 0
  let sawHeader = false
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    let text
    try {
      text = zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (const line of lines) {
      if (line.length === 0) continue
      const type = eventTypeOf(line)
      if (type === '') continue
      events += 1
      if (!sawHeader && type === 'session' && line.startsWith('{"type":"session"')) {
        try {
          header = JSON.parse(line)
        } catch {
          header = {}
        }
        sawHeader = true
        continue
      }
      if (!isInitialEvent(type)) {
        return { header, blank: false, events }
      }
    }
  }
  return { header, blank: true, events }
}

/** Analyze one decoded log (kept for JSONL fixtures and tests). */
export function analyzeLog(text) {
  const lines = text.split('\n').filter(Boolean)
  let header = {}
  const eventTypes = []
  for (let i = 0; i < lines.length; i += 1) {
    let record
    try {
      record = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (typeof record.type === 'string') eventTypes.push(record.type)
    if (i === 0 && record.type === 'session') header = record
  }
  return {
    header,
    eventTypes,
    blank: isBlankSession(eventTypes),
    events: eventTypes.length,
  }
}

/** Read and analyze every session under one workspace directory. */
async function scanWorkspace(root, workspaceDir) {
  const workspacePath = join(root, workspaceDir)
  const entries = await readdir(workspacePath, { withFileTypes: true }).catch(() => [])
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionDir = entry.name
    const artifact = join(workspacePath, sessionDir, 'session.v4.jsonl.zstd')
    const info = await stat(artifact).catch(() => null)
    if (info === null || !info.isFile()) continue
    const { header, blank, events } = analyzeArtifact(await readFile(artifact))
    rows.push({
      workspace: workspaceDir,
      workspacePath: decodeWorkspaceDir(workspaceDir),
      dir: sessionDir,
      id: header.id ?? sessionDir,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      bytes: info.size,
      category: classifySession(header),
      blank,
      events,
    })
  }
  return rows
}

/**
 * Scan one or every workspace. includeSystem keeps subagent / automation /
 * mnemon sessions in the result; the blank list is what the UI deletes.
 */
export async function scanSessions(options = {}) {
  const root = options.root ?? defaultSessionsRoot()
  const includeSystem = options.includeSystem === true
  const entries = await readdir(root, { withFileTypes: true })
  const workspaces = []
  const sessions = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const workspaceDir = entry.name
    const workspaceSessions = await scanWorkspace(root, workspaceDir)
    if (workspaceSessions.length === 0) continue
    workspaces.push({
      dir: workspaceDir,
      path: decodeWorkspaceDir(workspaceDir),
      sessions: workspaceSessions.length,
    })
    for (const session of workspaceSessions) {
      if (!includeSystem && SYSTEM_CATEGORIES.has(session.category)) continue
      sessions.push(session)
    }
  }
  const now = Date.now()
  for (const session of sessions) {
    session.recent = typeof session.createdAt === 'number' && now - session.createdAt < RECENT_MS
  }
  sessions.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  return { root, workspaces, sessions, now }
}

/** Pack a batch directory name from a timestamp. */
export function batchName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}
