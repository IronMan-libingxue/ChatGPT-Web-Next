import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const testRoot = await mkdtemp(join(tmpdir(), 'chatgpt-native-login-pilot-'))
const visualOutput = resolve(projectRoot, 'output', 'native-login-pilot')
const packagedExecutable = process.env.CHATGPT_NATIVE_LOGIN_PILOT_EXECUTABLE
await mkdir(visualOutput, { recursive: true })

let mainOrigin = ''
let authOrigin = ''
const mainServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', mainOrigin)
  if (url.pathname === '/callback') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(callbackPage(mainOrigin))
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(mainPage(mainOrigin, authOrigin))
})
const authServer = createServer((_request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': 'native_login_auth=present; Max-Age=86400; Path=/; SameSite=Lax'
  })
  response.end(authPage(mainOrigin))
})

await listen(mainServer)
mainOrigin = serverOrigin(mainServer)
await listen(authServer)
authOrigin = serverOrigin(authServer)

const launchApp = () =>
  electron.launch({
    args: packagedExecutable ? [] : ['out-native-login-pilot/main/index.js'],
    cwd: projectRoot,
    executablePath: packagedExecutable ? resolve(projectRoot, packagedExecutable) : undefined,
    env: {
      ...process.env,
      CHATGPT_NATIVE_LOGIN_PILOT_TEST_ROOT: testRoot,
      CHATGPT_NATIVE_LOGIN_PILOT_TEST_URL: `${mainOrigin}/`,
      CHATGPT_NATIVE_LOGIN_PILOT_TEST_ALLOWED_ORIGINS: `${mainOrigin},${authOrigin}`,
      CHATGPT_NATIVE_LOGIN_PILOT_TEST_CLEAR_RESPONSE: 'accept'
    }
  })

let electronApp = await launchApp()

try {
  let toolbar = await waitForToolbar(electronApp)
  await toolbar.locator('.toolbar').waitFor({ state: 'visible' })

  assert.deepEqual(
    await toolbar.evaluate(() => Object.keys(window.chatgptNativeLoginPilot).sort()),
    ['clearWebData', 'getState', 'hardRefresh', 'onState', 'refresh']
  )
  const initialState = await toolbar.evaluate(() => window.chatgptNativeLoginPilot.getState())
  assert.equal(initialState.popupStrategy, 'native')
  assert.equal(initialState.persistentSession, true)
  assert.equal(initialState.popupCount, 0)

  await waitFor(
    async () =>
      (await remoteEvaluate(electronApp, "document.querySelector('#fixture-ready')?.textContent")) ===
      'ready',
    'fixture page'
  )

  const runtime = await inspectRuntime(electronApp)
  assert.equal(runtime.remotePreferences.nodeIntegration, false)
  assert.equal(runtime.remotePreferences.contextIsolation, true)
  assert.equal(runtime.remotePreferences.sandbox, true)
  assert.equal(runtime.remotePreferences.webSecurity, true)
  assert.equal(runtime.remoteHasPreload, false)
  assert.equal(runtime.debuggerAttached, false)
  assert.match(runtime.userAgent, /Electron\//u)

  await remoteEvaluate(
    electronApp,
    "document.querySelector('#open-login')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); true"
  )
  const popup = await waitForPage(electronApp, authOrigin)
  await popup.locator('#continue-login').waitFor({ state: 'visible' })
  assert.equal(await popup.evaluate(() => window.opener !== null), true)

  const popupRuntime = await inspectPopupRuntime(electronApp, authOrigin)
  assert.equal(popupRuntime.parentMatches, true)
  assert.equal(popupRuntime.sessionMatches, true)
  assert.equal(popupRuntime.preferences.nodeIntegration, false)
  assert.equal(popupRuntime.preferences.contextIsolation, true)
  assert.equal(popupRuntime.preferences.sandbox, true)
  assert.equal(popupRuntime.preferences.webSecurity, true)

  const popupState = await toolbar.evaluate(() => window.chatgptNativeLoginPilot.getState())
  assert.equal(popupState.popupCount, 1)
  assert.equal(popupState.activePopupCount, 1)
  assert.equal(popupState.popupStatus, 'created')

  const popupClosed = popup.waitForEvent('close')
  await popup.locator('#continue-login').click()
  await popupClosed
  await waitFor(
    async () =>
      (await remoteEvaluate(electronApp, "document.querySelector('#login-result')?.textContent")) ===
      'native-popup-login-complete',
    'opener callback'
  )

  const completedState = await toolbar.evaluate(() => window.chatgptNativeLoginPilot.getState())
  assert.equal(completedState.popupCount, 1)
  assert.equal(completedState.activePopupCount, 0)
  assert.equal(completedState.popupStatus, 'closed')
  assert.equal(await hasAuthCookie(electronApp), true)

  const screenshot = await captureMainWindow(electronApp)
  await writeFile(join(visualOutput, 'native-popup-flow.png'), screenshot)

  await remoteEvaluate(
    electronApp,
    "document.querySelector('#open-blocked')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); true"
  )
  await waitFor(
    async () =>
      (await toolbar.evaluate(() => window.chatgptNativeLoginPilot.getState())).lastBlockedHost ===
      'example.com',
    'blocked external popup'
  )
  assert.equal(
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1
  )

  await quitApplication(electronApp)
  electronApp = await launchApp()
  toolbar = await waitForToolbar(electronApp)
  assert.equal(await hasAuthCookie(electronApp), true)

  await toolbar.getByTestId('clear-web-data').click()
  await waitFor(
    async () => {
      const state = await toolbar.evaluate(() => window.chatgptNativeLoginPilot.getState())
      return state.activity === 'idle' && /已清除/u.test(state.message)
    },
    'web data clear'
  )
  assert.equal(await hasAuthCookie(electronApp), false)
  await waitFor(
    async () =>
      (await remoteEvaluate(electronApp, "document.querySelector('#fixture-ready')?.textContent")) ===
      'ready',
    'fixture reload after clear'
  )

  console.log('Native Electron popup was created by window.open and retained window.opener.')
  console.log('Popup and ChatGPT view used the same isolated persistent session.')
  console.log('Session survived restart; one-click clear removed it and reloaded the page.')
  console.log('Security isolation stayed enabled; no user-agent rewrite or debugger attachment was used.')
} finally {
  await quitApplication(electronApp).catch(() => electronApp.process().kill('SIGKILL'))
  mainServer.close()
  authServer.close()
  await Promise.allSettled([once(mainServer, 'close'), once(authServer, 'close')])
  await rm(testRoot, { recursive: true, force: true })
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

function serverOrigin(server) {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function mainPage(openerOrigin, identityOrigin) {
  const popupUrl = `${identityOrigin}/auth`
  return `<!doctype html>
  <html><body>
    <h1>Native popup fixture</h1>
    <p id="fixture-ready">ready</p>
    <p id="login-result">waiting</p>
    <button id="open-login">Open login</button>
    <button id="open-blocked">Open blocked</button>
    <script>
      window.addEventListener('message', (event) => {
        if (event.origin !== ${JSON.stringify(openerOrigin)}) return
        if (event.data?.type === 'native-login-complete') {
          document.querySelector('#login-result').textContent = 'native-popup-login-complete'
        }
      })
      document.querySelector('#open-login').addEventListener('click', () => {
        window.open(${JSON.stringify(popupUrl)}, 'chatgpt-native-auth', 'width=620,height=780')
      })
      document.querySelector('#open-blocked').addEventListener('click', () => {
        window.open('https://example.com/not-login', 'blocked-popup')
      })
    </script>
  </body></html>`
}

function authPage(callbackOrigin) {
  return `<!doctype html>
  <html><body>
    <h1>Identity provider fixture</h1>
    <button id="continue-login">Continue</button>
    <script>
      document.querySelector('#continue-login').addEventListener('click', () => {
        location.href = ${JSON.stringify(`${callbackOrigin}/callback`)}
      })
    </script>
  </body></html>`
}

function callbackPage(openerOrigin) {
  return `<!doctype html>
  <html><body><p id="opener-state"></p>
    <script>
      document.querySelector('#opener-state').textContent = window.opener ? 'linked' : 'missing'
      if (window.opener) {
        window.opener.postMessage({ type: 'native-login-complete' }, ${JSON.stringify(openerOrigin)})
      }
      setTimeout(() => window.close(), 80)
    </script>
  </body></html>`
}

async function waitForToolbar(electronApplication) {
  const page = await electronApplication.firstWindow()
  if (await page.locator('.toolbar').count()) return page
  return waitForPage(electronApplication, 'index.html')
}

async function waitForPage(electronApplication, urlFragment) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const match = electronApplication.windows().find((page) => page.url().includes(urlFragment))
    if (match) return match
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(
    `Timed out waiting for ${urlFragment}; windows: ${electronApplication.windows().map((page) => page.url()).join(', ')}`
  )
}

async function remoteEvaluate(electronApplication, expression) {
  return electronApplication.evaluate(
    async ({ BrowserWindow }, source) => {
      const toolbar = BrowserWindow.getAllWindows().find((window) =>
        window.getTitle().includes('Electron 原生登录验证')
      )
      const remote = toolbar?.contentView.children[0]
      if (!remote) throw new Error('Remote ChatGPT view not found')
      return remote.webContents.executeJavaScript(source, true)
    },
    expression
  )
}

async function inspectRuntime(electronApplication) {
  return electronApplication.evaluate(async ({ BrowserWindow }) => {
    const toolbar = BrowserWindow.getAllWindows().find((window) =>
      window.getTitle().includes('Electron 原生登录验证')
    )
    const remote = toolbar?.contentView.children[0]
    if (!remote) throw new Error('Remote ChatGPT view not found')
    return {
      remotePreferences: remote.webContents.getLastWebPreferences(),
      remoteHasPreload: Boolean(remote.webContents.getLastWebPreferences().preload),
      debuggerAttached: remote.webContents.debugger.isAttached(),
      userAgent: await remote.webContents.executeJavaScript('navigator.userAgent', true)
    }
  })
}

async function inspectPopupRuntime(electronApplication, popupOrigin) {
  return electronApplication.evaluate(
    ({ BrowserWindow }, origin) => {
      const toolbar = BrowserWindow.getAllWindows().find((window) =>
        window.getTitle().includes('Electron 原生登录验证')
      )
      const remote = toolbar?.contentView.children[0]
      const popup = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith(origin)
      )
      if (!toolbar || !remote || !popup) throw new Error('Native popup runtime not found')
      return {
        parentMatches: popup.getParentWindow() === toolbar,
        sessionMatches: popup.webContents.session === remote.webContents.session,
        preferences: popup.webContents.getLastWebPreferences()
      }
    },
    popupOrigin
  )
}

async function hasAuthCookie(electronApplication) {
  return electronApplication.evaluate(async ({ session }) => {
    const cookies = await session
      .fromPartition('persist:chatgpt-native-login-pilot')
      .cookies.get({ name: 'native_login_auth' })
    return cookies.some((cookie) => cookie.value === 'present')
  })
}

async function captureMainWindow(electronApplication) {
  const base64 = await electronApplication.evaluate(async ({ BrowserWindow }) => {
    const toolbar = BrowserWindow.getAllWindows().find((window) =>
      window.getTitle().includes('Electron 原生登录验证')
    )
    if (!toolbar) throw new Error('Toolbar window not found')
    return (await toolbar.capturePage()).toPNG().toString('base64')
  })
  return Buffer.from(base64, 'base64')
}

async function quitApplication(electronApplication) {
  const childProcess = electronApplication.process()
  if (childProcess.exitCode !== null) return
  const exited = once(childProcess, 'exit')
  void electronApplication.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out quitting Electron pilot')), 8_000)
    )
  ])
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
