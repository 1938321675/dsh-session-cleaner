import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { apply } from '../index.mjs'

function mockContext() {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    on() {},
  }
  return { ctx, routes }
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    port: server.address().port,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

let cachedScan = null
async function scanOnce() {
  if (cachedScan !== null) return cachedScan
  const { ctx, routes } = mockContext()
  apply(ctx)
  const { port, close } = await serve(routes)
  const response = await fetch('http://127.0.0.1:' + port + '/plugins/dsh-session-cleaner/scan?includeSystem=1')
  cachedScan = { status: response.status, data: await response.json() }
  await close()
  return cachedScan
}

test('mounts every route', () => {
  const { ctx, routes } = mockContext()
  apply(ctx)
  assert.ok(routes.has('/plugins/dsh-session-cleaner/scan'))
  assert.ok(routes.has('/plugins/dsh-session-cleaner/quarantine'))
  assert.ok(routes.has('/plugins/dsh-session-cleaner/batches'))
  assert.ok(routes.has('/plugins/dsh-session-cleaner/restore'))
  assert.ok(routes.has('/plugins/dsh-session-cleaner/purge'))
})

test('scan route answers with blank sessions', async () => {
  const { status, data } = await scanOnce()
  assert.equal(status, 200)
  assert.equal(data.ok, true)
  assert.ok(Array.isArray(data.sessions))
  assert.ok(data.sessions.every((session) => session.blank === true))
  assert.ok(Array.isArray(data.workspaces))
})

test('quarantine refuses unknown and invalid targets', async () => {
  const { ctx, routes } = mockContext()
  apply(ctx)
  const { port, close } = await serve(routes)
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/plugins/dsh-session-cleaner/quarantine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [{ workspace: '--does-not-exist--', dir: 'session-x' }] }),
    })
    const data = await response.json()
    assert.equal(response.status, 409)
    assert.equal(data.ok, false)
    assert.ok(Array.isArray(data.rejected))
  } finally {
    await close()
  }
})

test('restore rejects an invalid batch name', async () => {
  const { ctx, routes } = mockContext()
  apply(ctx)
  const { port, close } = await serve(routes)
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/plugins/dsh-session-cleaner/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: '../escape' }),
    })
    assert.equal(response.status, 400)
  } finally {
    await close()
  }
})
