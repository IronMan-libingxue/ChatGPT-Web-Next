import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = await mkdtemp(`${tmpdir()}/chatgpt-web-next-e2e-`)
const secondTestRoot = await mkdtemp(`${tmpdir()}/chatgpt-web-next-e2e-device-b-`)
const safetyTestRoot = await mkdtemp(`${tmpdir()}/chatgpt-web-next-e2e-safety-`)
const visualOutput = resolve(projectRoot, 'output', 'playwright')
for (const root of [testRoot, secondTestRoot, safetyTestRoot]) {
  await mkdir(resolve(root, 'app-data'), { recursive: true })
  await mkdir(resolve(root, 'browser-data'), { recursive: true })
}
await mkdir(visualOutput, { recursive: true })

let mainOrigin = ''
let authOrigin = ''
let traceDelayMs = 25
let traceRequestCount = 0
const mainServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', mainOrigin)
  if (url.pathname === '/cdn-cgi/trace') {
    traceRequestCount += 1
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('ip=203.0.113.27\nloc=TS\n')
    }, traceDelayMs)
    return
  }
  if (url.pathname === '/api/auth/session') {
    const loggedIn = /(?:^|;\s*)(?:formal_native_login_auth|chatgpt_test_login)=present(?:;|$)/u.test(
      request.headers.cookie ?? ''
    )
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(loggedIn ? '{"user":{"name":"Fixture Account"}}' : '{}')
    return
  }
  if (url.pathname === '/download/sample.txt') {
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="sample.txt"'
    })
    response.end('ChatGPT Web Next download fixture')
    return
  }
  if (url.pathname === '/download/slow.bin') {
    const chunk = Buffer.alloc(16 * 1024, 7)
    const totalBytes = chunk.length * 100
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(totalBytes),
      'content-disposition': 'attachment; filename="slow.bin"'
    })
    let sent = 0
    const timer = setInterval(() => {
      if (sent >= totalBytes) {
        clearInterval(timer)
        response.end()
        return
      }
      response.write(chunk)
      sent += chunk.length
    }, 200)
    response.on('close', () => clearInterval(timer))
    return
  }
  if (request.method === 'POST' && url.pathname === '/backend-api/f/conversation') {
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    response.end(
      url.searchParams.get('accept') === 'handoff'
        ? 'data: {"type":"stream_handoff","options":[{"type":"resume_sse_endpoint"}]}\n\n'
        : 'data: {"type":"input_message"}\n\n'
    )
    return
  }
  if (/^\/backend-api\/conversation\/[^/]+\/stream_status\/?$/u.test(url.pathname)) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end('{"status":"running"}')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (url.pathname === '/callback') {
    response.end(nativePopupCallbackPage(mainOrigin))
    return
  }
  if (url.pathname === '/direct-callback') {
    response.end(directLoginCallbackPage())
    return
  }
  response.end(nativePopupMainPage(mainOrigin, authOrigin))
})
const authServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', authOrigin)
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': 'formal_native_login_auth=present; Max-Age=86400; Path=/; SameSite=Lax'
  })
  response.end(
    url.pathname === '/direct'
      ? directLoginAuthPage(mainOrigin)
      : nativePopupAuthPage(mainOrigin)
  )
})
await listen(mainServer)
mainOrigin = serverOrigin(mainServer)
await listen(authServer)
authOrigin = serverOrigin(authServer)

const packagedExecutable = process.env.CHATGPT_WEB_NEXT_EXECUTABLE
const testStorageSecret = randomUUID()
const safetyStorageSecret = randomUUID()
const launchTestApp = (
  dataRoot = testRoot,
  storageSecret = testStorageSecret,
  environmentOverrides = {}
) =>
  electron.launch({
    args: packagedExecutable ? [] : ['.'],
    cwd: projectRoot,
    executablePath: packagedExecutable ? resolve(projectRoot, packagedExecutable) : undefined,
    env: {
      ...process.env,
      CHATGPT_WEB_NEXT_TEST_ROOT: dataRoot,
      CHATGPT_WEB_NEXT_TEST_STORAGE_SECRET: storageSecret,
      CHATGPT_WEB_NEXT_TEST_CLEAR_DATA_RESPONSES: 'cancel,accept',
      CHATGPT_WEB_NEXT_TEST_URL: `${mainOrigin}/`,
      CHATGPT_WEB_NEXT_TEST_ALLOWED_ORIGINS: `${mainOrigin},${authOrigin}`,
      CHATGPT_WEB_NEXT_TEST_AUTHENTICATION_ORIGINS: authOrigin,
      CHATGPT_WEB_NEXT_TEST_ENABLE_DETECTOR: '1',
      CHATGPT_WEB_NEXT_TEST_SAFETY_CLEAR_MS: '600000',
      CHATGPT_WEB_NEXT_TEST_SAFETY_QUIT_MS: '620000',
      ...environmentOverrides
    }
  })

let electronApp = await launchTestApp()

try {
  console.log('Waiting for the local toolbar window...')
  await electronApp.firstWindow()
  const toolbar = await waitForPage(electronApp, 'view=toolbar')
  await toolbar.waitForLoadState('domcontentloaded')
  assert.equal(await toolbar.title(), 'ChatGPT Web Next')
  await toolbar.locator('.toolbar').waitFor({ state: 'visible' })

  const runtimeArchitecture = await electronApp.evaluate(() => process.arch)
  if (process.env.CHATGPT_WEB_NEXT_EXPECT_ARCH) {
    assert.equal(runtimeArchitecture, process.env.CHATGPT_WEB_NEXT_EXPECT_ARCH)
  }
  console.log(`Electron runtime architecture: ${runtimeArchitecture}`)

  const preReadyState = await toolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(preReadyState.windowKind, 'normal')
  assert.equal(preReadyState.storageStatus, 'ready')
  assert.ok(['unverified', 'healthy', 'degraded'].includes(preReadyState.work.detectorHealth))
  assert.deepEqual(
    await toolbar.evaluate(() => Object.keys(window.chatgptWebNext).sort()),
    [
      'clearCache',
      'clearDownloadRecords',
      'clearWebData',
      'closeDownloads',
      'getState',
      'hardRefresh',
      'newIncognito',
      'onState',
      'openSettings',
      'refresh',
      'refreshNetwork',
      'revealDownload',
      'selectLogo',
      'toggleDownloads'
    ]
  )
  const initialState = await waitForStorage(toolbar)
  assert.match(initialState.maskedDeviceId, /^[a-f0-9]{6}…[a-f0-9]{4}$/u)
  await waitForDebuggerState(electronApp, true, 'fresh-install Work observation')
  const readyState = await waitForToolbarState(
    toolbar,
    (state) =>
      state.work.detectorHealth === 'healthy' &&
      state.network.freshness === 'live' &&
      !state.network.checking &&
      state.network.latencySampleCount === 1,
    'fresh-install Work detector readiness'
  )
  assert.equal(readyState.maskedDeviceId, initialState.maskedDeviceId)
  assert.equal(readyState.storageStatus, 'ready', readyState.storageWarning ?? undefined)
  const statePath = resolve(
    testRoot,
    'app-data',
    'ChatGPT Web Next Device',
    'device-state.bin'
  )
  console.log('Toolbar state is available and uses an isolated test device record.')

  assert.equal(readyState.work.light, 'inactive')
  assert.equal(readyState.preferences.selectedLogoId, 'logo-121805')
  assert.equal(readyState.network.latencySampleCount, 1)
  assert.equal((await toolbar.locator('.work-chip').textContent())?.trim(), '工作状态')

  const previousLatency = readyState.network.latencyMs
  assert.notEqual(previousLatency, null)
  await waitForCondition(
    async () =>
      (await toolbar.locator('.latency-chip').textContent())?.trim() === `${previousLatency} ms`,
    'rendered latency matches the settled network state'
  )
  const traceCountBeforeManualCheck = traceRequestCount
  traceDelayMs = 300
  await toolbar.locator('.latency-chip').click()
  await waitForToolbarState(
    toolbar,
    (state) => state.network.checking,
    'manual three-sample latency check starts'
  )
  assert.equal(
    (await toolbar.locator('.latency-chip').textContent())?.trim(),
    `${previousLatency} ms`
  )
  const afterManualLatency = await waitForToolbarState(
    toolbar,
    (state) => !state.network.checking && state.network.latencySampleCount === 3,
    'manual three-sample latency check finishes'
  )
  assert.equal(traceRequestCount - traceCountBeforeManualCheck, 3)
  assert.notEqual(afterManualLatency.network.latencyMs, null)
  traceDelayMs = 25
  console.log('Manual latency check sent exactly three samples, stopped, and kept the prior result visible while checking.')

  await setTestLoginCookie(electronApp, mainOrigin)
  await waitForToolbarState(
    toolbar,
    (state) => state.loginState === 'logged-in',
    'fixture login state'
  )
  await waitForToolbarState(
    toolbar,
    (state) => !state.network.checking,
    'login transition network refresh finishes'
  )
  const traceCountAfterLoginTransition = traceRequestCount
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 31_000))
  assert.equal(
    traceRequestCount,
    traceCountAfterLoginTransition,
    'periodic login checks must not restart network testing before the 20-minute interval'
  )
  console.log('A periodic login recheck did not restart latency testing; the 20-minute schedule remains authoritative.')

  await sendFixtureSubmission(electronApp, {
    messageId: 'ordinary-chat-message',
    origin: 'composer',
    model: 'gpt-6-astra',
    acceptWithHandoff: true
  })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  const afterOrdinaryChat = await toolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(afterOrdinaryChat.work.light, 'inactive')
  assert.equal(afterOrdinaryChat.work.pendingCount, 0)

  await sendFixtureSubmission(electronApp, {
    messageId: 'ordinary-project-chat-message',
    origin: 'tpp',
    model: 'gpt-6-astra',
    conversationKind: 'gizmo_interaction',
    prepareState: 'success',
    acceptWithHandoff: true
  })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  const afterOrdinaryProjectChat = await toolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(afterOrdinaryProjectChat.work.light, 'inactive')
  assert.equal(afterOrdinaryProjectChat.work.pendingCount, 0)

  await sendFixtureSubmission(electronApp, {
    messageId: 'fresh-install-work-message',
    origin: 'tpp',
    model: 'gpt-6-astra-wm',
    conversationKind: 'gizmo_interaction',
    prepareState: 'success',
    acceptWithHandoff: false
  })
  await waitForToolbarState(
    toolbar,
    (state) => state.work.light === 'pending' && state.work.pendingCount === 1,
    'fresh-install Work pending state'
  )
  await remoteEvaluate(
    electronApp,
    "fetch('/backend-api/conversation/fresh-install-conversation/stream_status').then((response) => response.text())"
  )
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  const beforeConversationNavigation = await toolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(beforeConversationNavigation.work.light, 'pending')
  await remoteEvaluate(
    electronApp,
    `history.pushState({}, '', ${JSON.stringify(`${mainOrigin}/g/test/c/fresh-install-conversation`)})`
  )
  await waitForRemoteUrl(electronApp, '/g/test/c/fresh-install-conversation')
  const firstAcceptedState = await waitForToolbarState(
    toolbar,
    (state) =>
      state.work.light === 'active' &&
      state.work.pendingCount === 0 &&
      state.workRecords.length === 1,
    'fresh-install Work acceptance after navigation'
  )
  assert.ok(firstAcceptedState.work.lastAcceptedAt)
  assert.ok(firstAcceptedState.work.expiresAt)
  assert.equal(
    Date.parse(firstAcceptedState.work.expiresAt) - Date.parse(firstAcceptedState.work.lastAcceptedAt),
    96 * 60 * 60 * 1000
  )
  assert.equal(firstAcceptedState.safety.phase, 'countdown')
  assert.equal(firstAcceptedState.workRecords.length, 1)
  const firstAcceptedAt = firstAcceptedState.work.lastAcceptedAt
  const firstSafetyClearDueAt = firstAcceptedState.safety.clearDueAt
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  await sendFixtureSubmission(electronApp, {
    messageId: 'fresh-install-work-follow-up',
    origin: 'work',
    model: 'gpt-7-next',
    acceptWithHandoff: false
  })
  await waitForToolbarState(
    toolbar,
    (state) => state.work.pendingCount === 1,
    'fresh-install Work follow-up pending state'
  )
  await remoteEvaluate(
    electronApp,
    "fetch('/backend-api/conversation/fresh-install-conversation/stream_status').then((response) => response.text())"
  )
  const followUpAcceptedState = await waitForToolbarState(
    toolbar,
    (state) =>
      state.work.light === 'active' &&
      Boolean(state.work.lastAcceptedAt) &&
      Date.parse(state.work.lastAcceptedAt) > Date.parse(firstAcceptedAt) &&
      state.workRecords.length === 2,
    'fresh-install Work follow-up acceptance'
  )
  assert.equal(followUpAcceptedState.work.pendingCount, 0)
  assert.equal(followUpAcceptedState.workRecords.length, 2)
  assert.ok(Date.parse(followUpAcceptedState.safety.clearDueAt) > Date.parse(firstSafetyClearDueAt))
  const activeToolbarText = (await toolbar.locator('.work-chip').textContent())?.trim() ?? ''
  assert.match(activeToolbarText, /^工作状态\s*\d+小时\d+分$/u)
  assert.doesNotMatch(activeToolbarText, /已使用|未使用/u)
  console.log('Fresh-install Work detection is verified: ordinary chat stays gray, a new Work task turns the light red after server acceptance, a follow-up renews the unchanged 96-hour countdown, and the toolbar label stays fixed.')

  await electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'))
  const suspendedState = await waitForToolbarState(
    toolbar,
    (state) => state.work.timerRunning === false,
    '96-hour timer paused during sleep'
  )
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  const stillSuspendedState = await toolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(stillSuspendedState.work.remainingMs, suspendedState.work.remainingMs)
  await electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
  await waitForToolbarState(
    toolbar,
    (state) => state.work.timerRunning === true,
    '96-hour timer resumed after wake while logged in'
  )
  console.log('The 96-hour reminder pauses during sleep and resumes after wake while logged in.')

  await toolbar.evaluate(() => window.dispatchEvent(new Event('offline')))
  await waitForToolbarState(
    toolbar,
    (state) => state.network.error === '网络连接已断开',
    'offline status'
  )
  await toolbar.evaluate(() => window.dispatchEvent(new Event('online')))
  await waitForToolbarState(
    toolbar,
    (state) => state.network.error !== '网络连接已断开',
    'network recovery refresh'
  )
  await toolbar.evaluate(() => window.dispatchEvent(new Event('offline')))
  await waitForToolbarState(
    toolbar,
    (state) => state.network.error === '网络连接已断开',
    'offline status before system resume'
  )
  await electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
  await waitForToolbarState(
    toolbar,
    (state) => state.network.error !== '网络连接已断开',
    'system resume refresh'
  )
  console.log('Offline, online and system-resume network refreshes are verified.')

  const boundaries = await inspectSecurityAndLayout(electronApp)
  assert.equal(boundaries.toolbarPreferences.nodeIntegration, false)
  assert.equal(boundaries.toolbarPreferences.contextIsolation, true)
  assert.equal(boundaries.toolbarPreferences.sandbox, true)
  assert.equal(boundaries.remotePreferences.nodeIntegration, false)
  assert.equal(boundaries.remotePreferences.contextIsolation, true)
  assert.equal(boundaries.remotePreferences.sandbox, true)
  assert.equal(boundaries.remotePreferences.webSecurity, true)
  assert.equal(boundaries.remoteHasPreload, false)
  for (const layout of boundaries.layouts) {
    assert.equal(layout.remote.x, 0)
    assert.equal(layout.remote.y, 54)
    assert.equal(layout.remote.width, layout.content.width)
    assert.equal(layout.remote.height, layout.content.height - 54)
    assert.equal(layout.localScroll.width, layout.localScroll.clientWidth)
    assert.equal(layout.localScroll.height, layout.localScroll.clientHeight)
    assert.ok(layout.toolbarStatus.rightGap >= 0 && layout.toolbarStatus.rightGap <= 12)
    assert.ok(layout.toolbarStatus.maximumGap <= 5)
  }
  assert.equal(boundaries.zoom.afterIncrease.remote, 1.1)
  assert.equal(boundaries.zoom.afterIncrease.toolbar, 1)
  assert.equal(boundaries.zoom.afterReset.remote, 1)
  assert.equal(boundaries.zoom.afterReset.toolbar, 1)
  assert.equal(boundaries.menu.refreshAccelerator, 'CommandOrControl+R')
  assert.equal(boundaries.menu.hardRefreshAccelerator, 'CommandOrControl+Shift+R')
  assert.equal(await toolbar.locator('.location-block').isVisible(), true)
  assert.equal(await toolbar.locator('.clock').isVisible(), true)
  assert.equal(await toolbar.locator('.work-chip .subtle').isVisible(), true)
  console.log('Security isolation, fixed toolbar layout and page-only zoom are verified.')

  await waitForDebuggerState(electronApp, true, 'Work observation before direct login')
  await remoteEvaluate(electronApp, `location.href = ${JSON.stringify(`${authOrigin}/direct`)}`)
  await waitForRemoteUrl(electronApp, authOrigin)
  await waitForDebuggerState(electronApp, false, 'Work observation paused on direct login')
  await remoteEvaluate(
    electronApp,
    "document.querySelector('#continue-direct-login')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); true"
  )
  await waitForCondition(
    async () =>
      (await remoteEvaluate(
        electronApp,
        "document.querySelector('#direct-login-result')?.textContent"
      )) === 'direct-login-complete',
    'direct login callback'
  )
  await waitForDebuggerState(electronApp, true, 'Work observation resumed after direct login')
  await remoteEvaluate(electronApp, `location.href = ${JSON.stringify(`${mainOrigin}/`)}`)
  console.log('Direct login navigation pauses Work observation and restores it after ChatGPT returns.')

  await waitForCondition(
    async () =>
      (await remoteEvaluate(
        electronApp,
        "document.querySelector('#native-popup-fixture')?.textContent"
      )) === 'ready',
    'native popup fixture'
  )
  await remoteEvaluate(
    electronApp,
    "document.querySelector('#open-native-login')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); true"
  )
  const loginPopup = await waitForPage(electronApp, authOrigin)
  await loginPopup.locator('#continue-native-login').waitFor({ state: 'visible' })
  await waitForDebuggerState(electronApp, false, 'Work observation paused for login popup')
  assert.equal(await loginPopup.evaluate(() => window.opener !== null), true)
  const downloadsBeforeAuthAttempt = (
    await toolbar.evaluate(() => window.chatgptWebNext.getState())
  ).downloads.totalCount
  await loginPopup.locator('#auth-download').click()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  assert.equal(
    (await toolbar.evaluate(() => window.chatgptWebNext.getState())).downloads.totalCount,
    downloadsBeforeAuthAttempt
  )
  const popupRuntime = await inspectNativePopupRuntime(electronApp, authOrigin)
  assert.equal(popupRuntime.parentMatches, true)
  assert.equal(popupRuntime.sessionMatches, true)
  assert.equal(popupRuntime.preferences.nodeIntegration, false)
  assert.equal(popupRuntime.preferences.contextIsolation, true)
  assert.equal(popupRuntime.preferences.sandbox, true)
  assert.equal(popupRuntime.preferences.webSecurity, true)
  const popupClosed = loginPopup.waitForEvent('close')
  await loginPopup.locator('#continue-native-login').click()
  await popupClosed
  await waitForCondition(
    async () =>
      (await remoteEvaluate(
        electronApp,
        "document.querySelector('#native-login-result')?.textContent"
      )) === 'native-popup-login-complete',
    'native popup callback'
  )
  assert.equal(await hasNativeAuthCookie(electronApp), true)
  await waitForDebuggerState(electronApp, true, 'Work observation resumed after login popup')
  console.log('Native login popup retained its opener and shared the ChatGPT session; Work observation stayed off during authentication and resumed afterward.')

  const beforeSettings = new Set(electronApp.windows())
  await toolbar.locator('[title="设置与详细状态"]').click()
  const settings = await waitForNewPage(electronApp, beforeSettings, 'view=settings')
  await settings.locator('h1').waitFor({ state: 'visible' })
  assert.equal(await settings.locator('h1').textContent(), '设置与状态')
  assert.equal(await settings.locator('dt').filter({ hasText: '设备 ID' }).count(), 1)
  assert.equal(await settings.locator('.record-card').count(), 2)
  assert.equal(await settings.getByRole('heading', { name: '状态检测记录' }).count(), 1)
  assert.equal(await settings.getByRole('heading', { name: 'Work 使用记录' }).count(), 0)
  assert.equal(await settings.locator('.logo-choice').count(), 5)
  assert.equal(await settings.getByRole('button', { name: '忽略缓存并强制刷新' }).count(), 1)
  assert.equal(await settings.getByRole('button', { name: '清除下载记录' }).count(), 1)
  assert.equal(await settings.getByRole('button', { name: /清除.*Work|清除.*使用记录/u }).count(), 0)
  const hardRefreshButton = settings.getByRole('button', { name: '忽略缓存并强制刷新' })
  await hardRefreshButton.focus()
  assert.equal(
    await hardRefreshButton.evaluate((element) => getComputedStyle(element).outlineStyle),
    'solid'
  )
  const stateBeforeSettingsRefresh = await settings.evaluate(() => window.chatgptWebNext.getState())
  const loadBeforeSettingsRefresh = await fixtureLoadCount(electronApp)
  await hardRefreshButton.click()
  await waitForCondition(
    async () => (await fixtureLoadCount(electronApp)) > loadBeforeSettingsRefresh,
    'settings hard refresh targets its owning ChatGPT page'
  )
  const stateAfterSettingsRefresh = await settings.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(stateAfterSettingsRefresh.maskedDeviceId, stateBeforeSettingsRefresh.maskedDeviceId)
  assert.equal(stateAfterSettingsRefresh.work.lastAcceptedAt, stateBeforeSettingsRefresh.work.lastAcceptedAt)
  assert.equal(stateAfterSettingsRefresh.workRecords.length, stateBeforeSettingsRefresh.workRecords.length)
  await toolbar.emulateMedia({ colorScheme: 'light' })
  await toolbar.screenshot({ path: resolve(visualOutput, 'toolbar-light.png') })
  await settings.emulateMedia({ colorScheme: 'dark' })
  await settings.evaluate(() => window.scrollTo(0, 0))
  await settings.screenshot({ path: resolve(visualOutput, 'settings-dark.png'), fullPage: true })
  await settings.close()
  console.log('Settings window opened with device and network details.')

  const beforeIncognito = new Set(electronApp.windows())
  await toolbar.locator('[title="打开独立无痕窗口"]').click()
  const incognito = await waitForNewPage(electronApp, beforeIncognito, 'view=toolbar')
  await incognito.locator('.incognito-badge').waitFor({ state: 'visible' })
  const incognitoState = await incognito.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(incognitoState.windowKind, 'incognito')
  assert.equal(incognitoState.maskedDeviceId, initialState.maskedDeviceId)

  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      childViewCount: window.contentView.children.length
    }))
  )
  assert.ok(windows.some((window) => window.title.includes('无痕') && window.childViewCount === 1))
  await setRemoteTestCookie(electronApp, '无痕')
  assert.equal(await hasRemoteTestCookie(electronApp, '无痕'), true)
  console.log('Incognito window shares the device ID but has its own web container.')

  console.log('Closing the temporary incognito window...')
  await withTimeout(incognito.close(), 10_000, 'closing incognito window')
  const beforeSecondIncognito = new Set(electronApp.windows())
  await toolbar.locator('[title="打开独立无痕窗口"]').click()
  const secondIncognito = await waitForNewPage(
    electronApp,
    beforeSecondIncognito,
    'view=toolbar'
  )
  await secondIncognito.locator('.incognito-badge').waitFor({ state: 'visible' })
  assert.equal(await hasRemoteTestCookie(electronApp, '无痕'), false)
  await triggerIncognitoFixtureDownload(electronApp)
  const incognitoDownloadState = await waitForToolbarState(
    toolbar,
    (state) => state.downloads.all.some((record) => record.windowKind === 'incognito' && record.status === 'completed'),
    'incognito download record'
  )
  const incognitoDownloadId = incognitoDownloadState.downloads.all.find(
    (record) => record.windowKind === 'incognito'
  )?.id
  assert.ok(incognitoDownloadId)
  await withTimeout(secondIncognito.close(), 10_000, 'closing second incognito window')
  const partitionDirectories = await readDirectoryOrEmpty(
    resolve(testRoot, 'browser-data', 'Partitions')
  )
  assert.equal(partitionDirectories.some((name) => name.includes('incognito')), false)
  assert.ok(
    (await toolbar.evaluate(() => window.chatgptWebNext.getState())).downloads.all.some(
      (record) => record.id === incognitoDownloadId
    )
  )
  console.log('A reopened incognito window starts without the prior temporary login cookie.')
  console.log('Checking normal and hard refresh controls...')
  const loadBeforeToolbarRefresh = await fixtureLoadCount(electronApp)
  await toolbar.locator('[title="刷新 ChatGPT 页面（⌘R）"]').click()
  await waitForCondition(
    async () => (await fixtureLoadCount(electronApp)) > loadBeforeToolbarRefresh,
    'toolbar refresh reloads only ChatGPT'
  )
  await withTimeout(
    toolbar.evaluate(() => window.chatgptWebNext.refresh()),
    10_000,
    'normal refresh'
  )
  await withTimeout(
    toolbar.evaluate(() => window.chatgptWebNext.hardRefresh()),
    10_000,
    'hard refresh'
  )
  const loadBeforeShortcut = await fixtureLoadCount(electronApp)
  await pressAppRefreshShortcut(electronApp, false)
  await waitForCondition(
    async () => (await fixtureLoadCount(electronApp)) > loadBeforeShortcut,
    'Command-R shortcut'
  )
  const loadBeforeHardShortcut = await fixtureLoadCount(electronApp)
  await pressAppRefreshShortcut(electronApp, true)
  await waitForCondition(
    async () => (await fixtureLoadCount(electronApp)) > loadBeforeHardShortcut,
    'Shift-Command-R shortcut'
  )
  console.log('Clearing the isolated test cache...')
  await setTestCookie(electronApp)
  assert.equal(await hasTestCookie(electronApp), true)
  await withTimeout(
    toolbar.evaluate(() => window.chatgptWebNext.clearCache()),
    15_000,
    'cache clearing'
  )
  assert.equal(await hasTestCookie(electronApp), true)

  console.log('Checking cancel and confirm paths for clearing login and web data...')
  const stateBeforeWebClear = await toolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(await toolbar.evaluate(() => window.chatgptWebNext.clearWebData()), false)
  assert.equal(await hasTestCookie(electronApp), true)
  assert.equal(await toolbar.evaluate(() => window.chatgptWebNext.clearWebData()), true)
  assert.equal(await hasTestCookie(electronApp), false)
  assert.equal(await hasNativeAuthCookie(electronApp), false)
  const stateAfterWebClear = await toolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(stateAfterWebClear.maskedDeviceId, stateBeforeWebClear.maskedDeviceId)
  assert.equal(stateAfterWebClear.work.lastAcceptedAt, stateBeforeWebClear.work.lastAcceptedAt)
  assert.equal(stateAfterWebClear.workRecords.length, stateBeforeWebClear.workRecords.length)
  assert.equal(stateAfterWebClear.preferences.selectedLogoId, stateBeforeWebClear.preferences.selectedLogoId)
  assert.equal(stateAfterWebClear.work.timerRunning, false)

  const encryptedState = await readFile(statePath)
  assert.throws(() => JSON.parse(encryptedState.toString('utf8')))

  await waitForCondition(
    async () =>
      (await remoteEvaluate(
        electronApp,
        "document.querySelector('#native-popup-fixture')?.textContent"
      )) === 'ready',
    'fixture reload before parent-window close'
  )
  await remoteEvaluate(
    electronApp,
    "document.querySelector('#open-native-login')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); true"
  )
  const popupDuringParentClose = await waitForPage(electronApp, authOrigin)
  const popupClosedWithParent = popupDuringParentClose.waitForEvent('close')
  await withTimeout(toolbar.close(), 10_000, 'closing parent with an active login popup')
  await withTimeout(popupClosedWithParent, 10_000, 'closing login popup with its parent')
  console.log('Closing a parent window also closed its active login popup without a main-process error.')

  console.log('Restarting with the same isolated data to verify device persistence...')
  await quitApplication(electronApp)
  electronApp = await launchTestApp()
  await electronApp.firstWindow()
  const restartedToolbar = await waitForPage(electronApp, 'view=toolbar')
  await restartedToolbar.locator('.toolbar').waitFor({ state: 'visible' })
  const restartedState = await restartedToolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(restartedState.maskedDeviceId, initialState.maskedDeviceId)
  assert.equal(restartedState.work.light, 'active')
  assert.equal(restartedState.work.lastAcceptedAt, followUpAcceptedState.work.lastAcceptedAt)
  assert.equal(await hasNativeAuthCookie(electronApp), false)

  console.log('Comparing a second isolated device environment...')
  await quitApplication(electronApp)
  electronApp = await launchTestApp(secondTestRoot, randomUUID())
  await electronApp.firstWindow()
  const secondDeviceToolbar = await waitForPage(electronApp, 'view=toolbar')
  await waitForStorage(secondDeviceToolbar)
  await waitForDebuggerState(electronApp, true, 'second-device Work observation')
  const secondDeviceState = await waitForToolbarState(
    secondDeviceToolbar,
    (state) => state.work.detectorHealth === 'healthy',
    'second-device Work detector readiness'
  )
  assert.notEqual(secondDeviceState.maskedDeviceId, initialState.maskedDeviceId)
  assert.equal(secondDeviceState.work.light, 'inactive')

  console.log('Recovering from a deliberately corrupted isolated device record...')
  await quitApplication(electronApp)
  await writeFile(statePath, 'deliberately-corrupted-test-record')
  electronApp = await launchTestApp()
  await electronApp.firstWindow()
  const recoveredToolbar = await waitForPage(electronApp, 'view=toolbar')
  const recoveredState = await waitForStorage(recoveredToolbar)
  assert.equal(recoveredState.storageStatus, 'ready')
  assert.match(recoveredState.storageWarning ?? '', /无法读取/u)
  assert.notEqual(recoveredState.maskedDeviceId, initialState.maskedDeviceId)
  const deviceFiles = await readdir(dirname(statePath))
  assert.ok(deviceFiles.some((name) => name.startsWith('device-state.bin.unreadable-')))

  console.log('Running the real 10/30-second automatic-cleanup flow in a fresh isolated machine profile...')
  await terminateApplication(electronApp)
  electronApp = await launchTestApp(safetyTestRoot, safetyStorageSecret, {
    CHATGPT_WEB_NEXT_TEST_SAFETY_CLEAR_MS: '10000',
    CHATGPT_WEB_NEXT_TEST_SAFETY_QUIT_MS: '30000'
  })
  await electronApp.firstWindow()
  const safetyToolbar = await waitForPage(electronApp, 'view=toolbar')
  await safetyToolbar.locator('.toolbar').waitFor({ state: 'visible' })
  await waitForDebuggerState(electronApp, true, 'safety profile Work observation')
  await waitForToolbarState(
    safetyToolbar,
    (state) => state.network.freshness === 'live' && state.network.latencyMs !== null,
    'fresh safety profile network and latency'
  )
  assert.equal(await safetyToolbar.locator('.toolbar-left').getByText('⟳').count(), 0)
  await safetyToolbar.evaluate(() => window.chatgptWebNext.selectLogo('logo-124106'))
  await waitForToolbarState(
    safetyToolbar,
    (state) => state.preferences.selectedLogoId === 'logo-124106',
    'runtime logo selection'
  )
  await setTestLoginCookie(electronApp, mainOrigin)
  await waitForToolbarState(
    safetyToolbar,
    (state) => state.loginState === 'logged-in',
    'safety profile login state'
  )

  const beforeSafetyIncognito = new Set(electronApp.windows())
  await safetyToolbar.evaluate(() => window.chatgptWebNext.newIncognito())
  const safetyIncognito = await waitForNewPage(electronApp, beforeSafetyIncognito, 'view=toolbar')
  await safetyIncognito.locator('.incognito-badge').waitFor({ state: 'visible' })
  await rememberIncognitoSessionAndSetCookie(electronApp)

  await triggerFixtureDownload(electronApp, '/download/sample.txt')
  const completedDownload = await waitForToolbarState(
    safetyToolbar,
    (state) => state.downloads.all.some((record) => record.status === 'completed'),
    'completed fixture download'
  )
  const firstDownload = completedDownload.downloads.all.find((record) => record.status === 'completed')
  assert.ok(firstDownload)
  assert.equal((await stat(firstDownload.savePath)).isFile(), true)
  await stubRevealAndVerify(electronApp, safetyToolbar, firstDownload.id, firstDownload.savePath)

  await triggerFixtureDownload(electronApp, '/download/sample.txt')
  const repeatedDownloads = await waitForToolbarState(
    safetyToolbar,
    (state) => state.downloads.all.filter((record) => record.status === 'completed').length >= 2,
    'second same-name download'
  )
  const completedPaths = repeatedDownloads.downloads.all
    .filter((record) => record.status === 'completed')
    .map((record) => record.savePath)
  assert.equal(new Set(completedPaths).size, completedPaths.length)

  await cancelNextFixtureDownload(electronApp)
  await triggerFixtureDownload(electronApp, '/download/slow.bin')
  await waitForToolbarState(
    safetyToolbar,
    (state) => state.downloads.all.some((record) => record.status === 'cancelled'),
    'cancelled fixture download'
  )

  await triggerFixtureDownload(electronApp, '/download/slow.bin')
  await waitForToolbarState(
    safetyToolbar,
    (state) => state.downloads.all.some((record) => record.status === 'progressing'),
    'active slow download'
  )
  const beforeDownloadPanel = new Set(electronApp.windows())
  await safetyToolbar.locator('.download-button').click()
  const downloadsPanel = await waitForNewPage(electronApp, beforeDownloadPanel, 'view=downloads')
  await downloadsPanel.getByRole('heading', { name: '最近的下载记录' }).waitFor({ state: 'visible' })
  assert.ok(await downloadsPanel.locator('.download-row').count() >= 1)
  const downloadPanelBoundary = await inspectDownloadPanel(electronApp)
  assert.equal(downloadPanelBoundary.parentIsToolbar, true)
  assert.equal(downloadPanelBoundary.preferences.nodeIntegration, false)
  assert.equal(downloadPanelBoundary.preferences.contextIsolation, true)
  assert.equal(downloadPanelBoundary.preferences.sandbox, true)
  assert.ok(downloadPanelBoundary.panelY >= downloadPanelBoundary.parentContentY + 40)
  await downloadsPanel.emulateMedia({ colorScheme: 'light' })
  await downloadsPanel.screenshot({ path: resolve(visualOutput, 'downloads-light.png') })
  const downloadsPanelClosed = downloadsPanel.waitForEvent('close')
  await downloadsPanel.getByRole('button', { name: '关闭下载管理' }).click()
  await withTimeout(downloadsPanelClosed, 5_000, 'closing download panel')

  const beforeSafetySettings = new Set(electronApp.windows())
  const beforeDownloadHistoryPanel = new Set(electronApp.windows())
  await safetyToolbar.locator('.download-button').click()
  const downloadHistoryPanel = await waitForNewPage(
    electronApp,
    beforeDownloadHistoryPanel,
    'view=downloads'
  )
  const downloadHistoryPanelClosed = downloadHistoryPanel.waitForEvent('close')
  await downloadHistoryPanel.getByRole('button', { name: '完整的下载记录' }).click()
  const safetySettings = await waitForNewPage(electronApp, beforeSafetySettings, 'view=settings')
  await withTimeout(downloadHistoryPanelClosed, 5_000, 'closing download panel after opening history')
  await safetySettings.locator('h1').waitFor({ state: 'visible' })

  await sendFixtureSubmission(electronApp, {
    messageId: 'safety-project-work-message',
    origin: 'tpp',
    model: 'gpt-6-astra-wm',
    conversationKind: 'gizmo_interaction',
    prepareState: 'success',
    acceptWithHandoff: false
  })
  await waitForToolbarState(
    safetyToolbar,
    (state) => state.work.pendingCount === 1,
    'safety Work pending state'
  )
  await remoteEvaluate(
    electronApp,
    "fetch('/backend-api/conversation/safety-project-conversation/stream_status').then((response) => response.text())"
  )
  await remoteEvaluate(
    electronApp,
    `history.pushState({}, '', ${JSON.stringify(`${mainOrigin}/g/personal-project/c/safety-project-conversation`)})`
  )
  await waitForRemoteUrl(electronApp, '/g/personal-project/c/safety-project-conversation')
  const acceptedObservedAt = Date.now()
  const safetyAccepted = await waitForToolbarState(
    safetyToolbar,
    (state) => state.safety.phase === 'countdown' && state.workRecords.length === 1,
    'automatic safety countdown'
  )
  assert.equal(safetyAccepted.workRecords[0].projectName, 'Fixture Project')
  assert.equal(safetyAccepted.workRecords[0].chatName, 'Fixture Work Chat')
  assert.equal(safetyAccepted.workRecords[0].accountName, 'Fixture Account')
  const originalClearDueAt = safetyAccepted.safety.clearDueAt
  const originalQuitDueAt = safetyAccepted.safety.quitDueAt
  const originalAcceptedAt = safetyAccepted.work.lastAcceptedAt
  await safetyToolbar.screenshot({ path: resolve(visualOutput, 'safety-countdown.png') })

  await sendFixtureSubmission(electronApp, {
    messageId: 'safety-project-work-message',
    origin: 'tpp',
    model: 'gpt-6-astra-wm',
    conversationKind: 'gizmo_interaction',
    prepareState: 'success',
    acceptWithHandoff: false
  })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  const afterDuplicate = await safetyToolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(afterDuplicate.safety.clearDueAt, originalClearDueAt)
  assert.equal(afterDuplicate.safety.quitDueAt, originalQuitDueAt)
  assert.equal(afterDuplicate.work.lastAcceptedAt, originalAcceptedAt)
  assert.equal(afterDuplicate.workRecords.length, 1)

  await waitUntilOffset(acceptedObservedAt, 7_000)
  assert.equal(await hasTestLoginCookie(electronApp), true)
  const beforeClearState = await safetyToolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.notEqual(beforeClearState.network.ip, null)
  assert.equal(beforeClearState.safety.phase, 'countdown')
  await electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'))
  const safetySuspended = await waitForToolbarState(
    safetyToolbar,
    (state) => state.work.timerRunning === false,
    'sleep while automatic safety countdown remains active'
  )
  assert.equal(safetySuspended.safety.phase, 'countdown')

  const clearedState = await waitForToolbarState(
    safetyToolbar,
    (state) => state.safety.phase === 'cleared' && state.network.ip === null,
    '10-second login and network cleanup'
  )
  const clearObservedAt = Date.now()
  assert.ok(clearObservedAt - acceptedObservedAt >= 8_000)
  assert.ok(clearObservedAt - acceptedObservedAt <= 12_000)
  assert.equal(clearedState.network.latencyMs, null)
  assert.equal(clearedState.work.timerRunning, false)
  assert.equal(clearedState.preferences.selectedLogoId, 'logo-124106')
  assert.equal(clearedState.workRecords.length, 1)
  assert.ok(clearedState.downloads.all.some((record) => record.status === 'interrupted'))
  await waitForCondition(
    async () => !(await hasTestLoginCookie(electronApp)),
    'normal login cookie is physically removed after the 10-second lock'
  )
  await waitForCondition(
    async () => !(await rememberedIncognitoHasCookie(electronApp)),
    'incognito login cookie is physically removed after the 10-second lock'
  )
  const storageClearedAt = Date.now()
  assert.ok(storageClearedAt - acceptedObservedAt <= 12_000)
  await safetyToolbar.getByText('账号状态异常，请稍后重试').waitFor({ state: 'visible' })
  await safetyToolbar.screenshot({ path: resolve(visualOutput, 'safety-cleared.png') })
  await electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  const afterSafetyWake = await safetyToolbar.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(afterSafetyWake.safety.loginBlocked, true)
  assert.equal(afterSafetyWake.network.ip, null)
  const windowsAfterClear = electronApp.windows().length
  await safetyToolbar.evaluate(() => window.chatgptWebNext.newIncognito())
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  assert.equal(electronApp.windows().length, windowsAfterClear)

  const safetyProcess = electronApp.process()
  const safetyExited = once(safetyProcess, 'exit')
  await withTimeout(safetyExited, 24_000, '30-second automatic APP exit')
  const exitObservedAt = Date.now()
  assert.ok(exitObservedAt - acceptedObservedAt >= 28_000)
  assert.ok(exitObservedAt - acceptedObservedAt <= 32_000)
  assert.equal(safetyToolbar.isClosed(), true)
  assert.equal(safetySettings.isClosed(), true)

  electronApp = await launchTestApp(safetyTestRoot, safetyStorageSecret, {
    CHATGPT_WEB_NEXT_TEST_SAFETY_CLEAR_MS: '10000',
    CHATGPT_WEB_NEXT_TEST_SAFETY_QUIT_MS: '30000'
  })
  await electronApp.firstWindow()
  const afterSafetyRestart = await waitForPage(electronApp, 'view=toolbar')
  const persistedSafetyState = await waitForToolbarState(
    afterSafetyRestart,
    (state) => state.storageStatus === 'ready' && state.loginState === 'logged-out',
    'logged-out state after automatic cleanup restart'
  )
  assert.equal(persistedSafetyState.safety.phase, 'none')
  assert.equal(persistedSafetyState.loginState, 'logged-out')
  assert.equal(persistedSafetyState.work.light, 'active')
  assert.equal(persistedSafetyState.work.timerRunning, false)
  assert.equal(persistedSafetyState.workRecords.length, 1)
  assert.equal(persistedSafetyState.preferences.selectedLogoId, 'logo-124106')
  assert.ok(persistedSafetyState.downloads.totalCount >= 3)
  const keptPath = persistedSafetyState.downloads.all.find((record) => record.status === 'completed')?.savePath
  assert.ok(keptPath)
  await afterSafetyRestart.evaluate(() => window.chatgptWebNext.clearDownloadRecords())
  const clearedDownloadsState = await afterSafetyRestart.evaluate(() => window.chatgptWebNext.getState())
  assert.equal(clearedDownloadsState.downloads.totalCount, 0)
  assert.equal((await stat(keptPath)).isFile(), true)

  console.log('Electron smoke test passed: baseline security/login/incognito behavior plus downloads, logo persistence, response latency, Work records, real 10/30-second cleanup, forced exit and clean restart were verified.')
} finally {
  try {
    await quitApplication(electronApp)
  } catch {
    electronApp.process().kill('SIGKILL')
  }
  mainServer.close()
  authServer.close()
  await Promise.allSettled([once(mainServer, 'close'), once(authServer, 'close')])
  await rm(testRoot, { recursive: true, force: true })
  await rm(secondTestRoot, { recursive: true, force: true })
  await rm(safetyTestRoot, { recursive: true, force: true })
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

function nativePopupMainPage(openerOrigin, identityOrigin) {
  const popupUrl = `${identityOrigin}/auth`
  return `<!doctype html>
  <html><body>
    <script>
      globalThis.__CHATGPT_WEB_NEXT_TEST_METADATA__ = { accountName: 'Fixture Account', projectName: 'Fixture Project', chatName: 'Fixture Work Chat' }
      localStorage.setItem('fixture-load-count', String(Number(localStorage.getItem('fixture-load-count') || '0') + 1))
    </script>
    <p id="native-popup-fixture">ready</p>
    <p id="native-login-result">waiting</p>
    <button id="open-native-login">Open login</button>
    <script>
      window.addEventListener('message', (event) => {
        if (event.origin !== ${JSON.stringify(openerOrigin)}) return
        if (event.data?.type === 'native-login-complete') {
          document.querySelector('#native-login-result').textContent = 'native-popup-login-complete'
        }
      })
      document.querySelector('#open-native-login').addEventListener('click', () => {
        window.open(${JSON.stringify(popupUrl)}, 'chatgpt-native-auth', 'width=620,height=780')
      })
    </script>
  </body></html>`
}

function nativePopupAuthPage(callbackOrigin) {
  return `<!doctype html>
  <html><body>
    <a id="auth-download" href=${JSON.stringify(`${callbackOrigin}/download/sample.txt`)} download>Download from authentication page</a>
    <button id="continue-native-login">Continue</button>
    <script>
      document.querySelector('#continue-native-login').addEventListener('click', () => {
        location.href = ${JSON.stringify(`${callbackOrigin}/callback`)}
      })
    </script>
  </body></html>`
}

function directLoginAuthPage(callbackOrigin) {
  return `<!doctype html>
  <html><body>
    <button id="continue-direct-login">Continue</button>
    <script>
      document.querySelector('#continue-direct-login').addEventListener('click', () => {
        location.href = ${JSON.stringify(`${callbackOrigin}/direct-callback`)}
      })
    </script>
  </body></html>`
}

function directLoginCallbackPage() {
  return '<!doctype html><html><body><p id="direct-login-result">direct-login-complete</p></body></html>'
}

function nativePopupCallbackPage(openerOrigin) {
  return `<!doctype html>
  <html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'native-login-complete' }, ${JSON.stringify(openerOrigin)})
    }
    setTimeout(() => window.close(), 80)
  </script></body></html>`
}

async function sendFixtureSubmission(
  electronApplication,
  {
    messageId,
    origin,
    model,
    conversationKind = 'primary_assistant',
    prepareState = 'sent',
    acceptWithHandoff
  }
) {
  const body = {
    action: 'next',
    client_prepare_state: prepareState,
    conversation_mode: { kind: conversationKind },
    conversation_origin: origin,
    model,
    messages: [{ id: messageId, author: { role: 'user' } }]
  }
  const query = acceptWithHandoff ? '?accept=handoff' : ''
  await remoteEvaluate(
    electronApplication,
    `fetch(${JSON.stringify(`/backend-api/f/conversation${query}`)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(body))}
    }).then((response) => response.text())`
  )
}

async function quitApplication(electronApplication) {
  const childProcess = electronApplication.process()
  if (childProcess.exitCode !== null) return
  const exited = once(childProcess, 'exit')
  void electronApplication.evaluate(({ app }) => app.quit()).catch(() => undefined)
  await withTimeout(exited, 15_000, 'closing Electron test app')
}

async function terminateApplication(electronApplication) {
  const childProcess = electronApplication.process()
  if (childProcess.exitCode !== null) return
  const exited = once(childProcess, 'exit')
  childProcess.kill('SIGKILL')
  await withTimeout(exited, 8_000, 'terminating isolated Electron test app')
}

async function waitForNewPage(electronApplication, previousPages, urlFragment) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const match = electronApplication
      .windows()
      .find((page) => !previousPages.has(page) && page.url().includes(urlFragment))
    if (match) return match
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  const urls = electronApplication.windows().map((page) => page.url())
  throw new Error(`Timed out waiting for ${urlFragment}; open pages: ${urls.join(', ')}`)
}

async function waitForPage(electronApplication, urlFragment) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const match = electronApplication.windows().find((page) => page.url().includes(urlFragment))
    if (match) return match
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  const urls = electronApplication.windows().map((page) => page.url())
  throw new Error(`Timed out waiting for ${urlFragment}; open pages: ${urls.join(', ')}`)
}

async function waitForStorage(toolbarPage) {
  const deadline = Date.now() + 30_000
  let state
  while (Date.now() < deadline) {
    state = await toolbarPage.evaluate(() => window.chatgptWebNext.getState())
    if (state.storageStatus !== 'initializing') return state
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for encrypted storage; last state: ${JSON.stringify(state)}`)
}

async function waitForToolbarState(toolbarPage, predicate, label) {
  const deadline = Date.now() + 20_000
  let state
  while (Date.now() < deadline) {
    state = await toolbarPage.evaluate(() => window.chatgptWebNext.getState())
    if (predicate(state)) return state
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(state)}`)
}

async function waitForCondition(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function remoteEvaluate(electronApplication, expression) {
  return electronApplication.evaluate(
    async ({ BrowserWindow }, source) => {
      const toolbar = BrowserWindow.getAllWindows().find((window) =>
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents.getURL().includes('view=toolbar') &&
        !window.getTitle().includes('无痕')
      )
      const remote = toolbar?.contentView.children[0]
      if (!remote) throw new Error('Remote ChatGPT view not found')
      return remote.webContents.executeJavaScript(source, true)
    },
    expression
  )
}

async function waitForRemoteUrl(electronApplication, urlFragment) {
  await waitForCondition(
    async () =>
      electronApplication.evaluate(({ BrowserWindow }, fragment) => {
        const toolbar = BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() &&
            !window.webContents.isDestroyed() &&
            window.webContents.getURL().includes('view=toolbar') &&
            !window.getTitle().includes('无痕')
        )
        const remote = toolbar?.contentView.children[0]
        return Boolean(remote && !remote.webContents.isDestroyed() && remote.webContents.getURL().includes(fragment))
      }, urlFragment),
    `remote page URL containing ${urlFragment}`
  )
}

async function waitForDebuggerState(electronApplication, expected, label) {
  await waitForCondition(
    async () =>
      electronApplication.evaluate(({ BrowserWindow }, expectedState) => {
        const toolbar = BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() &&
            !window.webContents.isDestroyed() &&
            window.webContents.getURL().includes('view=toolbar') &&
            !window.getTitle().includes('无痕')
        )
        const remote = toolbar?.contentView.children[0]
        if (!remote || remote.webContents.isDestroyed()) return false
        return remote.webContents.debugger.isAttached() === expectedState
      }, expected),
    label
  )
}

async function inspectNativePopupRuntime(electronApplication, popupOrigin) {
  return electronApplication.evaluate(
    ({ BrowserWindow }, origin) => {
      const toolbar = BrowserWindow.getAllWindows().find((window) =>
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents.getURL().includes('view=toolbar') &&
        !window.getTitle().includes('无痕')
      )
      const remote = toolbar?.contentView.children[0]
      const popup = BrowserWindow.getAllWindows().find((window) =>
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents.getURL().startsWith(origin)
      )
      if (!toolbar || !remote || !popup) throw new Error('Native login popup not found')
      return {
        parentMatches: popup.getParentWindow() === toolbar,
        sessionMatches: popup.webContents.session === remote.webContents.session,
        preferences: popup.webContents.getLastWebPreferences()
      }
    },
    popupOrigin
  )
}

async function setTestCookie(electronApplication) {
  await electronApplication.evaluate(async ({ session }) => {
    await session.fromPartition('persist:chatgpt-main').cookies.set({
      url: 'https://chatgpt.com/',
      name: 'chatgpt_web_next_clear_test',
      value: 'present',
      secure: true
    })
  })
}

async function setTestLoginCookie(electronApplication, origin) {
  await electronApplication.evaluate(async ({ session }, cookieOrigin) => {
    await session.fromPartition('persist:chatgpt-main').cookies.set({
      url: cookieOrigin,
      name: 'chatgpt_test_login',
      value: 'present'
    })
  }, origin)
}

async function hasTestCookie(electronApplication) {
  return electronApplication.evaluate(async ({ session }) => {
    const cookies = await session
      .fromPartition('persist:chatgpt-main')
      .cookies.get({ name: 'chatgpt_web_next_clear_test' })
    return cookies.length > 0
  })
}

async function hasTestLoginCookie(electronApplication) {
  return electronApplication.evaluate(async ({ session }) => {
    const cookies = await session
      .fromPartition('persist:chatgpt-main')
      .cookies.get({ name: 'chatgpt_test_login' })
    return cookies.some((cookie) => cookie.value === 'present')
  })
}

async function triggerFixtureDownload(electronApplication, path) {
  await remoteEvaluate(
    electronApplication,
    `(() => {
      const link = document.createElement('a');
      link.href = ${JSON.stringify(path)};
      link.download = '';
      document.body.appendChild(link);
      link.click();
      link.remove();
      return true;
    })()`
  )
}

async function triggerIncognitoFixtureDownload(electronApplication) {
  await electronApplication.evaluate(async ({ BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.getTitle().includes('无痕')
    )
    const remote = owner?.contentView.children[0]
    if (!remote) throw new Error('Incognito remote view not found')
    await remote.webContents.executeJavaScript(`(() => {
      const link = document.createElement('a');
      link.href = '/download/sample.txt';
      link.download = '';
      document.body.appendChild(link);
      link.click();
      link.remove();
      return true;
    })()`, true)
  })
}

async function fixtureLoadCount(electronApplication) {
  return remoteEvaluate(
    electronApplication,
    "Number(localStorage.getItem('fixture-load-count') || '0')"
  )
}

async function pressAppRefreshShortcut(electronApplication, hard) {
  await electronApplication.evaluate(({ app, BrowserWindow }, useHardRefresh) => {
    const toolbar = BrowserWindow.getAllWindows().find(
      (window) =>
        !window.isDestroyed() &&
        window.webContents.getURL().includes('view=toolbar') &&
        !window.getTitle().includes('无痕')
    )
    if (!toolbar) throw new Error('Toolbar window not found for shortcut')
    app.focus({ steal: true })
    toolbar.show()
    toolbar.focus()
    const modifiers = useHardRefresh ? ['meta', 'shift'] : ['meta']
    toolbar.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers })
    toolbar.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers })
  }, hard)
}

async function rememberIncognitoSessionAndSetCookie(electronApplication) {
  await electronApplication.evaluate(async ({ BrowserWindow }, origin) => {
    const owner = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.getTitle().includes('无痕')
    )
    const remote = owner?.contentView.children[0]
    if (!remote) throw new Error('Incognito remote view not found')
    globalThis.__chatGptWebNextRememberedIncognitoSession = remote.webContents.session
    await remote.webContents.session.cookies.set({
      url: origin,
      name: 'incognito_safety_cookie',
      value: 'present'
    })
  }, mainOrigin)
}

async function rememberedIncognitoHasCookie(electronApplication) {
  return electronApplication.evaluate(async () => {
    const remembered = globalThis.__chatGptWebNextRememberedIncognitoSession
    if (!remembered) throw new Error('Remembered incognito session not found')
    const cookies = await remembered.cookies.get({ name: 'incognito_safety_cookie' })
    return cookies.length > 0
  })
}

async function stubRevealAndVerify(electronApplication, toolbarPage, id, expectedPath) {
  await electronApplication.evaluate(({ shell }) => {
    globalThis.__chatGptWebNextRevealedPath = null
    shell.showItemInFolder = (path) => {
      globalThis.__chatGptWebNextRevealedPath = path
    }
  })
  assert.equal(
    await toolbarPage.evaluate((downloadId) => window.chatgptWebNext.revealDownload(downloadId), id),
    'revealed'
  )
  assert.equal(
    await electronApplication.evaluate(() => globalThis.__chatGptWebNextRevealedPath),
    expectedPath
  )
}

async function cancelNextFixtureDownload(electronApplication) {
  await electronApplication.evaluate(({ session }) => {
    session.fromPartition('persist:chatgpt-main').once('will-download', (_event, item) => {
      setTimeout(() => item.cancel(), 500)
    })
  })
}

async function waitUntilOffset(startedAt, offsetMs) {
  const remaining = startedAt + offsetMs - Date.now()
  if (remaining > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, remaining))
}

async function hasNativeAuthCookie(electronApplication) {
  return electronApplication.evaluate(async ({ session }) => {
    const cookies = await session
      .fromPartition('persist:chatgpt-main')
      .cookies.get({ name: 'formal_native_login_auth' })
    return cookies.some((cookie) => cookie.value === 'present')
  })
}

async function inspectSecurityAndLayout(electronApplication) {
  return electronApplication.evaluate(async ({ BrowserWindow, Menu }) => {
    const toolbarWindow = BrowserWindow.getAllWindows().find((window) =>
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      window.webContents.getURL().includes('view=toolbar') &&
      !window.getTitle().includes('无痕')
    )
    if (!toolbarWindow) throw new Error('Toolbar BrowserWindow not found')
    const remoteView = toolbarWindow.contentView.children[0]
    if (!remoteView) throw new Error('Remote WebContentsView not found')

    const loadDeadline = Date.now() + 15_000
    while (remoteView.webContents.isLoadingMainFrame() && Date.now() < loadDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }

    const layouts = []
    for (const [width, height] of [
      [1440, 900],
      [1100, 720],
      [980, 640]
    ]) {
      toolbarWindow.setContentSize(width, height)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      layouts.push({
        content: toolbarWindow.getContentBounds(),
        remote: remoteView.getBounds(),
        localScroll: await toolbarWindow.webContents.executeJavaScript(`({
          width: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          height: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight
        })`),
        toolbarStatus: await toolbarWindow.webContents.executeJavaScript(`(() => {
          const status = document.querySelector('.toolbar-statuses')
          const clock = document.querySelector('.clock')
          if (!(status instanceof HTMLElement) || !(clock instanceof HTMLElement)) {
            throw new Error('Toolbar status layout not found')
          }
          const children = [...status.children].filter((element) => element instanceof HTMLElement)
          const rectangles = children.map((element) => element.getBoundingClientRect())
          const gaps = rectangles.slice(1).map((rectangle, index) => rectangle.left - rectangles[index].right)
          return {
            rightGap: window.innerWidth - clock.getBoundingClientRect().right,
            maximumGap: gaps.length > 0 ? Math.max(...gaps) : 0
          }
        })()`)
      })
    }

    const toolbarPreferences = toolbarWindow.webContents.getLastWebPreferences()
    const remotePreferences = remoteView.webContents.getLastWebPreferences()
    const zoomIn = Menu.getApplicationMenu()?.getMenuItemById('page-zoom-in')
    const zoomReset = Menu.getApplicationMenu()?.getMenuItemById('page-zoom-reset')
    if (!zoomIn?.click || !zoomReset?.click) throw new Error('Page zoom menu items not found')
    zoomIn.click(zoomIn, toolbarWindow, {})
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    const afterIncrease = {
      toolbar: toolbarWindow.webContents.getZoomFactor(),
      remote: remoteView.webContents.getZoomFactor()
    }
    zoomReset.click(zoomReset, toolbarWindow, {})
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    const afterReset = {
      toolbar: toolbarWindow.webContents.getZoomFactor(),
      remote: remoteView.webContents.getZoomFactor()
    }

    const displayMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === '显示')
    const refreshMenu = displayMenu?.submenu?.items.find((item) => item.label === '刷新 ChatGPT')
    const hardRefreshMenu = displayMenu?.submenu?.items.find((item) => item.label === '忽略缓存并刷新')

    return {
      layouts,
      toolbarPreferences,
      remotePreferences,
      remoteHasPreload: Boolean(remotePreferences.preload),
      zoom: { afterIncrease, afterReset },
      menu: {
        refreshAccelerator: refreshMenu?.accelerator ?? null,
        hardRefreshAccelerator: hardRefreshMenu?.accelerator ?? null
      }
    }
  })
}

async function inspectDownloadPanel(electronApplication) {
  return electronApplication.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows().find((window) =>
      !window.isDestroyed() && window.webContents.getURL().includes('view=downloads')
    )
    if (!panel) throw new Error('Download panel BrowserWindow not found')
    const parent = panel.getParentWindow()
    const panelBounds = panel.getBounds()
    const parentContent = parent?.getContentBounds()
    return {
      parentIsToolbar: Boolean(parent?.webContents.getURL().includes('view=toolbar')),
      panelY: panelBounds.y,
      parentContentY: parentContent?.y ?? 0,
      preferences: panel.webContents.getLastWebPreferences()
    }
  })
}

async function setRemoteTestCookie(electronApplication, titleFragment) {
  await electronApplication.evaluate(
    async ({ BrowserWindow }, expectedTitle) => {
      const owner = BrowserWindow.getAllWindows().find((window) =>
        !window.isDestroyed() && window.getTitle().includes(expectedTitle)
      )
      const remote = owner?.contentView.children[0]
      if (!remote) throw new Error(`Remote view not found for ${expectedTitle}`)
      await remote.webContents.session.cookies.set({
        url: 'https://chatgpt.com/',
        name: 'chatgpt_web_next_incognito_test',
        value: 'temporary',
        secure: true
      })
    },
    titleFragment
  )
}

async function hasRemoteTestCookie(electronApplication, titleFragment) {
  return electronApplication.evaluate(
    async ({ BrowserWindow }, expectedTitle) => {
      const owner = BrowserWindow.getAllWindows().find((window) =>
        !window.isDestroyed() && window.getTitle().includes(expectedTitle)
      )
      const remote = owner?.contentView.children[0]
      if (!remote) throw new Error(`Remote view not found for ${expectedTitle}`)
      const cookies = await remote.webContents.session.cookies.get({
        name: 'chatgpt_web_next_incognito_test'
      })
      return cookies.length > 0
    },
    titleFragment
  )
}

async function readDirectoryOrEmpty(path) {
  try {
    return await readdir(path)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out while ${label}`)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
