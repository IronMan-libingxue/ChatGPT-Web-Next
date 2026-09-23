import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const extensionPath = resolve(projectRoot, 'out-chrome-work-pilot')
const profilePath = await mkdtemp(join(tmpdir(), 'chatgpt-work-pilot-runtime-'))
const outputPath = resolve(projectRoot, 'output', 'chrome-work-pilot', 'runtime-smoke.png')
await mkdir(dirname(outputPath), { recursive: true })

const context = await chromium.launchPersistentContext(profilePath, {
  channel: 'chromium',
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ]
})

try {
  let workers = context.serviceWorkers()
  if (workers.length === 0) {
    await context.waitForEvent('serviceworker', { timeout: 15_000 })
    workers = context.serviceWorkers()
  }
  const worker = workers.find((candidate) => candidate.url().endsWith('/service-worker.js'))
  assert.ok(worker, 'Work pilot extension service worker did not start')

  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto('https://chatgpt.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000
  })
  await page.locator('#chatgpt-web-next-work-pilot').waitFor({
    state: 'attached',
    timeout: 20_000
  })
  assert.equal(
    await page.locator('#chatgpt-web-next-work-pilot').evaluate((host) => host.shadowRoot),
    null,
    'The validation panel must use a closed shadow root'
  )

  const storedState = await worker.evaluate(async () => {
    const result = await globalThis.chrome.storage.local.get('chatgptWorkPilotStateV1')
    return result.chatgptWorkPilotStateV1
  })
  assert.equal(storedState.schemaVersion, 1)
  assert.equal(storedState.phase, 'idle')
  assert.equal(storedState.statistics.confirmedWork, 0)

  await page.evaluate(async () => {
    const submit = async (body) => {
      try {
        await fetch('/backend-api/f/conversation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      } catch {
        // Logged-out test requests may be rejected at either HTTP or network level.
      }
    }
    const common = {
      action: 'next',
      client_prepare_state: 'sent',
      conversation_mode: { kind: 'primary_assistant' },
      messages: [{ id: 'runtime-operation', author: { role: 'user' } }]
    }
    await submit({
      ...common,
      conversation_origin: 'chat',
      model: 'gpt-5.6-sol'
    })
    await submit({
      ...common,
      messages: [{ id: 'runtime-work-operation', author: { role: 'user' } }],
      conversation_origin: 'tpp',
      model: 'gpt-5.6-sol-wm'
    })
  })

  await assertEventually(async () => {
    const state = await worker.evaluate(async () => {
      const result = await globalThis.chrome.storage.local.get('chatgptWorkPilotStateV1')
      return result.chatgptWorkPilotStateV1
    })
    return state.statistics.conversationPosts >= 2 && state.pending.length === 0
  }, 'logged-out request observation')

  const observedState = await worker.evaluate(async () => {
    const result = await globalThis.chrome.storage.local.get('chatgptWorkPilotStateV1')
    return result.chatgptWorkPilotStateV1
  })
  assert.equal(observedState.statistics.ignoredNonWork, 1)
  assert.equal(observedState.statistics.matchedWork, 1)
  assert.equal(observedState.statistics.confirmedWork, 0)
  assert.equal(
    observedState.statistics.rejectedWork + observedState.statistics.transportErrors,
    1
  )

  await page.screenshot({ path: outputPath })
  console.log('Chrome extension service worker, isolated storage and ChatGPT status panel passed.')
  console.log(`Runtime screenshot: ${outputPath}`)
} finally {
  await context.close().catch(() => undefined)
  await rm(profilePath, { recursive: true, force: true })
}

async function assertEventually(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
