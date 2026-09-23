import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'

const testRoot = mkdtempSync(join(tmpdir(), 'chatgpt-next-cdp-related-'))
app.setPath('userData', join(testRoot, 'user-data'))

const workBody = JSON.stringify({
  action: 'next',
  conversation_origin: 'work',
  model: 'gpt-5.6-sol-wm',
  messages: [{ id: 'isolated-related-target-smoke' }]
})
const handoffBody =
  'data: {"type":"stream_handoff","options":[{"type":"resume_sse_endpoint"}]}\n\n'

const server = http.createServer((request, response) => {
  if (request.url === '/sw.js') {
    response.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'service-worker-allowed': '/',
      'cache-control': 'no-store'
    })
    response.end(`
      self.addEventListener('install', () => self.skipWaiting())
      self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
      self.addEventListener('message', (event) => {
        if (event.data !== 'send-background-request') return
        event.waitUntil(fetch('/retry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: ${JSON.stringify(workBody)}
        }).then((response) => response.text()))
      })
    `)
    return
  }

  if (request.url === '/retry') {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end(handoffBody)
    })
    return
  }

  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(`
    <!doctype html>
    <meta charset="utf-8">
    <title>Related target smoke</title>
    <script>
      navigator.serviceWorker.register('/sw.js')
        .then(() => navigator.serviceWorker.ready)
        .then(() => {
          if (!navigator.serviceWorker.controller) {
            location.reload()
            return
          }
          navigator.serviceWorker.controller.postMessage('send-background-request')
        })
    </script>
  `)
})

let exitCode = 1
app.on('will-quit', () => {
  rmSync(testRoot, { recursive: true, force: true })
})

app.whenReady().then(async () => {
  const address = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
  assert.equal(typeof address, 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const partition = `cdp-related-smoke-${Date.now()}`
  const testSession = session.fromPartition(partition, { cache: false })
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  try {
    await window.loadURL('about:blank')
    const debuggerApi = window.webContents.debugger
    debuggerApi.attach()

    const targetTypes = new Map()
    let serviceWorkerAttached = false
    let backgroundRequestSeen = false
    let acceptanceBodySeen = false
    let rootBrowserContextId
    const attachingTargets = new Set()
    let resolveEvidence
    const evidence = new Promise((resolve) => {
      resolveEvidence = resolve
    })
    let queue = Promise.resolve()

    debuggerApi.on('message', (_event, method, params, sessionId) => {
      queue = queue.then(async () => {
        if (method === 'Target.attachedToTarget') {
          targetTypes.set(params.sessionId, params.targetInfo.type)
          if (
            params.targetInfo.type === 'service_worker' &&
            params.targetInfo.url.startsWith(origin)
          ) {
            serviceWorkerAttached = true
            await debuggerApi
              .sendCommand(
                'Network.enable',
                { maxPostDataSize: 1024 * 1024 },
                params.sessionId
              )
              .catch(() => undefined)
          }
          if (params.waitingForDebugger) {
            await debuggerApi
              .sendCommand('Runtime.runIfWaitingForDebugger', {}, params.sessionId)
              .catch(() => undefined)
          }
          return
        }

        if (
          (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') &&
          params.targetInfo.type === 'service_worker' &&
          params.targetInfo.url.startsWith(origin) &&
          rootBrowserContextId &&
          params.targetInfo.browserContextId === rootBrowserContextId &&
          !attachingTargets.has(params.targetInfo.targetId)
        ) {
          attachingTargets.add(params.targetInfo.targetId)
          await debuggerApi
            .sendCommand('Target.attachToTarget', {
              targetId: params.targetInfo.targetId,
              flatten: true
            })
            .catch(() => undefined)
          return
        }

        if (
          method === 'Network.requestWillBeSent' &&
          params.request.url === `${origin}/retry` &&
          targetTypes.get(sessionId) === 'service_worker'
        ) {
          const postData =
            params.request.postData ??
            (
              await debuggerApi.sendCommand(
                'Network.getRequestPostData',
                { requestId: params.requestId },
                sessionId
              )
            ).postData
          assert.equal(postData, workBody)
          backgroundRequestSeen = true
        }

        if (
          method === 'Network.loadingFinished' &&
          backgroundRequestSeen &&
          targetTypes.get(sessionId) === 'service_worker'
        ) {
          const response = await debuggerApi
            .sendCommand('Network.getResponseBody', { requestId: params.requestId }, sessionId)
            .catch(() => ({}))
          if (response.body === handoffBody) acceptanceBodySeen = true
        }

        if (serviceWorkerAttached && backgroundRequestSeen && acceptanceBodySeen) {
          resolveEvidence()
        }
      }).catch((error) => {
        process.stderr.write(`CDP event handler failed: ${String(error)}\n`)
      })
    })

    await debuggerApi.sendCommand('Network.enable', { maxPostDataSize: 1024 * 1024 })
    const { targetInfo } = await debuggerApi.sendCommand('Target.getTargetInfo')
    assert.equal(typeof targetInfo.browserContextId, 'string')
    rootBrowserContextId = targetInfo.browserContextId
    await debuggerApi.sendCommand('Target.setDiscoverTargets', {
      discover: true,
      filter: [
        { type: 'service_worker', exclude: false },
        { type: 'shared_worker', exclude: false },
        { type: 'worker', exclude: false },
        { exclude: true }
      ]
    })

    await window.loadURL(origin)
    await Promise.race([
      evidence,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for related service-worker evidence')), 20_000)
      )
    ])
    await queue

    assert.equal(serviceWorkerAttached, true)
    assert.equal(backgroundRequestSeen, true)
    assert.equal(acceptanceBodySeen, true)
    await new Promise((resolve) =>
      process.stdout.write(
        'CDP related-target smoke passed: service-worker request and acceptance body were observed.\n',
        resolve
      )
    )
    exitCode = 0
  } finally {
    if (!window.isDestroyed()) window.destroy()
    await testSession.clearStorageData().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    process.exitCode = exitCode
    app.quit()
  }
}).catch((error) => {
  console.error(error)
  server.close(() => undefined)
  process.exitCode = 1
  app.quit()
})
