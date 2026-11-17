/**
 * Host half of dsh-session-cleaner: scans session artifacts for header-only
 * sessions, moves them into a quarantine batch, and restores or purges batches.
 * The browser half only talks to these routes; it never sees filesystem paths.
 */
import {
  batchName,
  defaultQuarantineRoot,
  defaultSessionsRoot,
  scanSessions,
} from './lib/sessions.mjs'
import {
  listBatches,
  purgeBatch,
  quarantineSessions,
  restoreBatch,
} from './lib/quarantine.mjs'

/** Cordis plugin name. */
export const name = 'dsh-session-cleaner'

/** Services required to mount the routes. */
export const inject = ['webServer']

/** Route prefix; unique to this plugin. */
const PREFIX = '/plugins/dsh-session-cleaner'

/** A filesystem-name segment that cannot escape its parent directory. */
function safeSegment(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length < 200 &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/:*?"<>|]/.test(value)
  )
}

/** Read and parse a JSON request body with a hard size cap. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.length === 0 ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Send one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Wrap one route handler with uniform error reporting. */
function route(handler) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      await handler(req, res, url)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
}

/** Create the route table for one activation. */
function mountRoutes(ctx) {
  const disposers = []
  const sessionsRoot = defaultSessionsRoot()
  const quarantineRoot = defaultQuarantineRoot()

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/scan',
      handler: route(async (req, res, url) => {
        const includeSystem = url.searchParams.get('includeSystem') === '1'
        const result = await scanSessions({ root: sessionsRoot, includeSystem })
        const empty = result.sessions.filter((session) => session.blank)
        sendJson(res, 200, {
          ok: true,
          root: result.root,
          workspaces: result.workspaces,
          sessions: result.sessions.filter((session) => session.blank),
          blankCount: empty.length,
          totalSessions: result.sessions.length,
          includeSystem,
        })
      }),
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/quarantine',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST required' })
          return
        }
        const body = await readJson(req)
        const targets = Array.isArray(body.targets) ? body.targets : []
        const includeRecent = body.includeRecent === true
        // Re-verify every target against the artifacts: the browser is not trusted.
        const scan = await scanSessions({ root: sessionsRoot, includeSystem: true })
        const byKey = new Map(scan.sessions.map((session) => [session.workspace + '/' + session.dir, session]))
        const accepted = []
        const rejected = []
        for (const target of targets) {
          const workspace = target && target.workspace
          const dir = target && target.dir
          if (!safeSegment(workspace) || !safeSegment(dir)) {
            rejected.push({ target, reason: 'invalid-path' })
            continue
          }
          const found = byKey.get(workspace + '/' + dir)
          if (!found) {
            rejected.push({ target, reason: 'not-found' })
            continue
          }
          if (!found.blank) {
            rejected.push({ target, reason: 'not-blank' })
            continue
          }
          if (found.recent && !includeRecent) {
            rejected.push({ target, reason: 'recent' })
            continue
          }
          accepted.push({ workspace, dir, id: found.id })
        }
        if (accepted.length === 0) {
          sendJson(res, 409, { ok: false, error: 'no acceptable targets', rejected })
          return
        }
        const batch = batchName()
        const result = await quarantineSessions({
          sessionsRoot,
          quarantineRoot,
          targets: accepted,
          batch,
        })
        sendJson(res, 200, { ok: true, batch, moved: result.manifest.entries.length, rejected, conflicts: result.manifest.conflicts })
      }),
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/batches',
      handler: route(async (req, res) => {
        const batches = await listBatches({ quarantineRoot })
        sendJson(res, 200, { ok: true, batches })
      }),
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/restore',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST required' })
          return
        }
        const body = await readJson(req)
        if (!safeSegment(body.batch)) {
          sendJson(res, 400, { ok: false, error: 'invalid batch' })
          return
        }
        const result = await restoreBatch({ quarantineRoot, batch: body.batch })
        sendJson(res, 200, { ok: true, ...result })
      }),
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/purge',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST required' })
          return
        }
        const body = await readJson(req)
        if (!safeSegment(body.batch)) {
          sendJson(res, 400, { ok: false, error: 'invalid batch' })
          return
        }
        const result = await purgeBatch({ quarantineRoot, batch: body.batch })
        sendJson(res, 200, { ok: true, ...result })
      }),
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Idempotent teardown.
      }
    }
  }
}

/** Mount the routes for the lifetime of the plugin fiber. */
export function apply(ctx) {
  const dispose = mountRoutes(ctx)
  ctx.on('dispose', dispose)
}
