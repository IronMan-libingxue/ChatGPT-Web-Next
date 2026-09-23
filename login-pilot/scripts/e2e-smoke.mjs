import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeBrowser = resolve(projectRoot, 'login-pilot/test-fixtures/fake-browser.mjs')
const testRoot = await mkdtemp(join(tmpdir(), 'chatgpt-login-pilot-e2e-'))
const profilePath = join(testRoot, 'control-data', 'BrowserProfiles', 'chrome')
const normalProfile = join(testRoot, 'normal-browser-profile')
const visualOutput = resolve(projectRoot, 'output', 'login-pilot')
const packagedExecutable = process.env.CHATGPT_LOGIN_PILOT_EXECUTABLE
await chmod(fakeBrowser, 0o755)
await mkdir(visualOutput, { recursive: true })

const normalBrowser = spawn(fakeBrowser, [`--user-data-dir=${normalProfile}`, '--app=https://example.com/'], {
  detached: true,
  stdio: 'ignore'
})
await onceSpawned(normalBrowser)

const electronApp = await electron.launch({
  args: packagedExecutable ? [] : ['out-login-pilot/main/index.js'],
  cwd: projectRoot,
  executablePath: packagedExecutable ? resolve(projectRoot, packagedExecutable) : undefined,
  env: {
    ...process.env,
    CHATGPT_LOGIN_PILOT_TEST_ROOT: testRoot,
    CHATGPT_LOGIN_PILOT_TEST_BROWSER_EXECUTABLE: fakeBrowser,
    CHATGPT_LOGIN_PILOT_TEST_CLEAR_RESPONSE: 'accept',
    CHATGPT_WORK_PILOT_EXTENSION_DIR: resolve(projectRoot, 'out-chrome-work-pilot')
  }
})

let latestPilotPid

try {
  const page = await electronApp.firstWindow()
  await page.locator('h1').waitFor({ state: 'visible' })
  assert.equal(await page.locator('h1').textContent(), 'Chrome Work 检测验证')

  const bridgeKeys = await page.evaluate(() => Object.keys(window.chatgptLoginPilot).sort())
  assert.deepEqual(bridgeKeys, [
    'clearAndRelaunch',
    'getState',
    'launch',
    'onState',
    'prepareWorkExtension',
    'selectBrowser'
  ])

  const initial = await page.evaluate(() => window.chatgptLoginPilot.getState())
  assert.equal(initial.selectedBrowser, 'chrome')
  assert.equal(initial.profileExists, false)
  assert.equal(initial.runningProcessCount, 0)
  assert.ok(initial.browsers.find((browser) => browser.id === 'chrome')?.available)
  assert.equal(initial.workExtensionSourceReady, true)
  assert.equal(initial.workExtensionPath, resolve(projectRoot, 'out-chrome-work-pilot'))
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: join(visualOutput, 'control-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(visualOutput, 'control-dark.png'), fullPage: true })

  await page.getByTestId('prepare-work-extension').click()
  await waitFor(async () => {
    try {
      const launch = JSON.parse(await readFile(join(profilePath, 'fake-browser-started.json'), 'utf8'))
      return launch.arguments.includes('chrome://extensions/')
    } catch {
      return false
    }
  }, 'Chrome extension setup page')
  const extensionLaunch = JSON.parse(
    await readFile(join(profilePath, 'fake-browser-started.json'), 'utf8')
  )
  assert.equal(extensionLaunch.arguments.some((value) => value.includes('remote-debugging')), false)
  assert.equal(extensionLaunch.arguments.some((value) => value.includes('load-extension')), false)

  await page.getByTestId('launch').click()
  await waitFor(async () => {
    try {
      const launch = JSON.parse(await readFile(join(profilePath, 'fake-browser-started.json'), 'utf8'))
      return launch.pid !== extensionLaunch.pid && launch.arguments.includes('--app=https://chatgpt.com/')
    } catch {
      return false
    }
  }, 'dedicated browser launch')

  const firstLaunch = JSON.parse(await readFile(join(profilePath, 'fake-browser-started.json'), 'utf8'))
  assert.ok(Number.isInteger(firstLaunch.pid))
  assert.ok(firstLaunch.arguments.includes(`--user-data-dir=${profilePath}`))
  assert.ok(firstLaunch.arguments.includes('--app=https://chatgpt.com/'))
  assert.equal(firstLaunch.arguments.some((value) => value.includes('remote-debugging')), false)
  await writeFile(join(profilePath, 'old-login-sentinel.txt'), 'must disappear after clear')

  await page.getByTestId('clear-and-relaunch').click()
  await waitFor(async () => {
    try {
      const launch = JSON.parse(await readFile(join(profilePath, 'fake-browser-started.json'), 'utf8'))
      latestPilotPid = launch.pid
      return launch.pid !== firstLaunch.pid
    } catch {
      return false
    }
  }, 'clear and fresh relaunch')

  await assertFileMissing(join(profilePath, 'old-login-sentinel.txt'))
  assert.equal(isProcessAlive(firstLaunch.pid), false)
  assert.equal(isProcessAlive(normalBrowser.pid), true)

  const trashEntries = await readdir(join(testRoot, 'recoverable-trash'))
  assert.equal(trashEntries.length, 1)
  const trashedSentinel = join(
    testRoot,
    'recoverable-trash',
    trashEntries[0],
    'old-login-sentinel.txt'
  )
  assert.equal(await readFile(trashedSentinel, 'utf8'), 'must disappear after clear')

  const finalState = await page.evaluate(() => window.chatgptLoginPilot.getState())
  assert.equal(finalState.profileExists, true)
  assert.ok(finalState.runningProcessCount > 0)
  assert.match(finalState.message, /已清除/u)

  console.log('Login pilot UI, isolated launch, recoverable clear and fresh relaunch passed.')
  console.log('A different browser profile remained running, so normal browser data/processes were untouched.')
} finally {
  await electronApp.close().catch(() => undefined)
  if (latestPilotPid) safeKill(latestPilotPid)
  safeKill(normalBrowser.pid)
  await rm(testRoot, { recursive: true, force: true })
}

function onceSpawned(child) {
  if (child.pid) return Promise.resolve()
  return new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn)
    child.once('error', rejectSpawn)
  })
}

async function waitFor(predicate, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function assertFileMissing(path) {
  try {
    await readFile(path)
    assert.fail(`Expected file to be absent: ${path}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function isProcessAlive(processId) {
  if (!processId) return false
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function safeKill(processId) {
  if (!processId) return
  try {
    process.kill(processId, 'SIGTERM')
  } catch {
    // The process already stopped.
  }
}
