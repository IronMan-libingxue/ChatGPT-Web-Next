import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { net, type Session } from 'electron'
import type { NetworkSnapshot } from '../shared/types'
import { LOCATION_CACHE_MS } from '../shared/types'
import { parseTrace, unavailableNetwork, withFreshness } from '../shared/network-state'

interface LocationCacheEntry {
  ip: string
  country: string | null
  city: string | null
  timezone: string | null
  fetchedAt: string
}

interface IpWhoResponse {
  success?: boolean
  message?: string
  country?: string
  city?: string
  timezone?: { id?: string } | string
}

export interface NetworkServiceDependencies {
  now?: () => Date
  monotonicNow?: () => number
  fetchLocation?: (url: string, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
  traceUrl?: string
}

interface TraceSample {
  ip: string
  latencyMs: number
}

export class NetworkService {
  private snapshot: NetworkSnapshot = unavailableNetwork('尚未检测')
  private refreshInFlight: Promise<void> | null = null
  private activeSampleCount = 0
  private generation = 0
  private paused = false

  constructor(
    private readonly session: Session,
    private readonly cachePath: string,
    private readonly onChange: () => void,
    private readonly dependencies: NetworkServiceDependencies = {}
  ) {}

  getSnapshot(now = this.now()): NetworkSnapshot {
    return withFreshness(this.snapshot, now)
  }

  async refresh(manual = false): Promise<void> {
    if (this.paused) return
    if (this.refreshInFlight) {
      const activeSampleCount = this.activeSampleCount
      await this.refreshInFlight
      if (manual && activeSampleCount < 3 && !this.paused) {
        await this.refresh(true)
      }
      return
    }
    const sampleCount = manual ? 3 : 1
    const generation = this.generation
    this.snapshot = { ...this.snapshot, checking: true }
    this.onChange()
    this.activeSampleCount = sampleCount
    const refresh = this.performRefresh(sampleCount, generation).finally(() => {
      if (this.refreshInFlight === refresh) {
        this.refreshInFlight = null
        this.activeSampleCount = 0
      }
    })
    this.refreshInFlight = refresh
    await refresh
  }

  async refreshManually(): Promise<void> {
    await this.refresh(true)
  }

  markOffline(): void {
    this.generation += 1
    this.refreshInFlight = null
    this.activeSampleCount = 0
    this.snapshot = this.snapshot.ip
      ? {
          ...this.snapshot,
          freshness: 'stale',
          error: '网络连接已断开',
          latencyError: '延迟无法确认：网络连接已断开',
          checking: false
        }
      : unavailableNetwork('网络连接已断开')
    this.onChange()
  }

  async clearAndPause(): Promise<void> {
    this.paused = true
    this.generation += 1
    this.refreshInFlight = null
    this.activeSampleCount = 0
    this.snapshot = unavailableNetwork('自动安全清理已清除网络状态')
    await rm(this.cachePath, { force: true }).catch(() => undefined)
    this.onChange()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    void this.refresh()
  }

  private async performRefresh(sampleCount: number, generation: number): Promise<void> {
    const previous = this.snapshot
    const samples: TraceSample[] = []
    let lastError: string | null = null
    try {
      for (let index = 0; index < sampleCount; index += 1) {
        try {
          samples.push(await this.fetchTraceSample())
        } catch (error) {
          lastError = error instanceof Error ? error.message : '网络检测失败'
        }
      }
      if (!this.isCurrent(generation)) return
      const minimumSamples = sampleCount === 1 ? 1 : 2
      if (samples.length < minimumSamples) {
        throw new Error(
          sampleCount === 1
            ? (lastError ?? '网络检测失败')
            : `延迟无法确认：3次检测仅${samples.length}次成功${lastError ? `；${lastError}` : ''}`
        )
      }
      const ip = samples.at(-1)!.ip
      const currentRouteSamples = samples.filter((sample) => sample.ip === ip)
      if (currentRouteSamples.length < minimumSamples) {
        throw new Error('延迟无法确认：检测期间出口 IP 发生变化')
      }
      const observedAt = this.now().toISOString()
      let country = previous.ip === ip ? previous.country : null
      let city = previous.ip === ip ? previous.city : null
      let timezone = previous.ip === ip ? previous.timezone : null
      let locationError: string | null = null
      try {
        const location = await this.getLocation(ip)
        if (!this.isCurrent(generation)) return
        country = location.country
        city = location.city
        timezone = location.timezone
      } catch (error) {
        if (!this.isCurrent(generation)) return
        const message = error instanceof Error ? error.message : '位置服务检测失败'
        locationError = `位置无法确认：${message}`
      }
      this.snapshot = {
        ip,
        country,
        city,
        timezone,
        observedAt,
        freshness: 'live',
        error: null,
        locationError,
        latencyMs: median(currentRouteSamples.map((sample) => sample.latencyMs)),
        latencyObservedAt: observedAt,
        latencyError: null,
        latencySampleCount: currentRouteSamples.length,
        checking: false
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return
      const message = error instanceof Error ? error.message : '网络检测失败'
      this.snapshot = previous.ip
        ? {
            ...previous,
            freshness: 'stale',
            error: message,
            latencyError: message.startsWith('延迟无法确认')
              ? message
              : `延迟无法确认：${message}`,
            checking: false
          }
        : unavailableNetwork(message)
    }
    if (!this.isCurrent(generation)) return
    this.onChange()
  }

  private isCurrent(generation: number): boolean {
    return !this.paused && generation === this.generation
  }

  private async fetchTraceSample(): Promise<TraceSample> {
    const controller = new AbortController()
    const timeoutMs = this.dependencies.timeoutMs ?? 8_000
    const timeoutError = new Error('延迟无法确认：检测超时')
    let timeout: NodeJS.Timeout | undefined
    const startedAt = this.monotonicNow()
    const request = (async (): Promise<TraceSample> => {
      const traceResponse = await this.session.fetch(
        this.dependencies.traceUrl ?? 'https://chatgpt.com/cdn-cgi/trace',
        {
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal
        }
      )
      if (!traceResponse.ok) throw new Error(`ChatGPT 网络检测返回 ${traceResponse.status}`)
      const trace = parseTrace(await traceResponse.text())
      const ip = trace.ip
      if (!ip || isIP(ip) === 0) throw new Error('ChatGPT 网络检测没有返回有效 IP')
      return {
        ip,
        latencyMs: Math.max(0, Math.round(this.monotonicNow() - startedAt))
      }
    })()
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(timeoutError)
      }, timeoutMs)
    })
    try {
      return await Promise.race([request, timedOut])
    } catch (error) {
      if (error === timeoutError || controller.signal.aborted) {
        throw new Error('延迟无法确认：检测超时', { cause: error })
      }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async getLocation(ip: string): Promise<LocationCacheEntry> {
    const cached = await this.readCache()
    if (
      cached &&
      cached.ip === ip &&
      this.now().getTime() - Date.parse(cached.fetchedAt) < LOCATION_CACHE_MS
    ) {
      return cached
    }

    const locationUrl = `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,message,country,city,timezone`
    const data = await this.fetchLocationData(locationUrl)
    if (data.success === false) throw new Error(data.message ?? '位置服务无法识别该 IP')
    const timezone =
      typeof data.timezone === 'string' ? data.timezone : (data.timezone?.id ?? null)
    const entry: LocationCacheEntry = {
      ip,
      country: data.country ?? null,
      city: data.city ?? null,
      timezone,
      fetchedAt: this.now().toISOString()
    }
    await this.writeCache(entry)
    return entry
  }

  private async fetchLocationData(url: string): Promise<IpWhoResponse> {
    const controller = new AbortController()
    const timeoutMs = this.dependencies.timeoutMs ?? 8_000
    let timeout: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error('位置服务检测超时'))
      }, timeoutMs)
    })
    const request = (async () => {
      const init: RequestInit = {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      }
      const response = this.dependencies.fetchLocation
        ? await this.dependencies.fetchLocation(url, init)
        : await net.fetch(url, init)
      if (!response.ok) throw new Error(`位置服务返回 ${response.status}`)
      return (await response.json()) as IpWhoResponse
    })()
    try {
      return await Promise.race([request, timedOut])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async readCache(): Promise<LocationCacheEntry | null> {
    try {
      return JSON.parse(await readFile(this.cachePath, 'utf8')) as LocationCacheEntry
    } catch {
      return null
    }
  }

  private async writeCache(entry: LocationCacheEntry): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.cachePath}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temporaryPath, JSON.stringify(entry), { mode: 0o600 })
    await rename(temporaryPath, this.cachePath)
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date()
  }

  private monotonicNow(): number {
    return this.dependencies.monotonicNow?.() ?? performance.now()
  }
}

export function createLocationCachePath(appDataPath: string): string {
  return join(appDataPath, 'ChatGPT Web Next Device', 'location-cache.json')
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}
