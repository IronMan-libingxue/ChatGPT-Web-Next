import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { _electron as electron } from 'playwright'

const runFile = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')
const currentVersion = JSON.parse(
  await readFile(resolve(projectRoot, 'package.json'), 'utf8')
).version
const previousArchive = resolve(
  projectRoot,
  process.env.CHATGPT_WEB_NEXT_PREVIOUS_ARCHIVE ??
    'dist/ChatGPT Web Next-0.1.0-mac-universal.zip'
)
const currentExecutable = resolve(
  projectRoot,
  process.env.CHATGPT_WEB_NEXT_CURRENT_EXECUTABLE ??
    'dist/mac-universal/ChatGPT Web Next.app/Contents/MacOS/ChatGPT Web Next'
)
const temporaryRoot = await mkdtemp(join(tmpdir(), 'chatgpt-web-next-upgrade-'))
const extractedRoot = join(temporaryRoot, 'previous')
const dataRoot = join(temporaryRoot, 'data')
const testSecret = 'isolated-upgrade-smoke-secret'

await mkdir(extractedRoot, { recursive: true })
await mkdir(join(dataRoot, 'app-data'), { recursive: true })
await mkdir(join(dataRoot, 'browser-data'), { recursive: true })

try {
  await runFile('ditto', ['-x', '-k', previousArchive, extractedRoot])
  const previousExecutable = join(
    extractedRoot,
    'ChatGPT Web Next.app',
    'Contents',
    'MacOS',
    'ChatGPT Web Next'
  )

  let app = await launch(previousExecutable)
  const previousToolbar = await waitForToolbar(app)
  const previousState = await waitForStorage(previousToolbar)
  await setUpgradeCookie(app)
  assert.equal(await hasUpgradeCookie(app), true)
  await quit(app)

  app = await launch(currentExecutable)
  try {
    const currentToolbar = await waitForToolbar(app)
    const currentState = await waitForStorage(currentToolbar)
    assert.equal(currentState.maskedDeviceId, previousState.maskedDeviceId)
    assert.equal(currentState.storageStatus, 'ready')
    assert.equal(await hasUpgradeCookie(app), true)
  } finally {
    await quit(app)
  }

  console.log(
    `Upgrade smoke passed: ${currentVersion} retained the isolated 0.1.0 device record and browser session.`
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function launch(executablePath) {
  return electron.launch({
    executablePath,
    env: {
      ...process.env,
      CHATGPT_WEB_NEXT_TEST_ROOT: dataRoot,
      CHATGPT_WEB_NEXT_TEST_STORAGE_SECRET: testSecret
    }
  })
}

async function waitForToolbar(electronApplication) {
  await electronApplication.firstWindow()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const page = electronApplication
      .windows()
      .find((candidate) => candidate.url().includes('view=toolbar'))
    if (page) {
      await page.locator('.toolbar').waitFor({ state: 'visible' })
      return page
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the toolbar during upgrade test')
}

async function waitForStorage(toolbar) {
  const deadline = Date.now() + 30_000
  let state
  while (Date.now() < deadline) {
    state = await toolbar.evaluate(() => window.chatgptWebNext.getState())
    if (state.storageStatus !== 'initializing') return state
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for device state: ${JSON.stringify(state)}`)
}

async function setUpgradeCookie(electronApplication) {
  await electronApplication.evaluate(async ({ session }) => {
    const remoteSession = session.fromPartition('persist:chatgpt-main')
    await remoteSession.cookies.set({
      url: 'https://chatgpt.com/',
      name: 'chatgpt_web_next_upgrade_test',
      value: 'present',
      secure: true,
      expirationDate: Date.now() / 1000 + 86_400
    })
    await remoteSession.cookies.flushStore()
  })
}

async function hasUpgradeCookie(electronApplication) {
  return electronApplication.evaluate(async ({ session }) => {
    const cookies = await session
      .fromPartition('persist:chatgpt-main')
      .cookies.get({ name: 'chatgpt_web_next_upgrade_test' })
    return cookies.some((cookie) => cookie.value === 'present')
  })
}

async function quit(electronApplication) {
  const childProcess = electronApplication.process()
  if (childProcess.exitCode !== null) return
  const exited = once(childProcess, 'exit')
  void electronApplication.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out quitting upgrade test app')), 8_000)
    )
  ])
}
