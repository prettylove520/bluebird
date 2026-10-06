// 网络出口：代理的识别、检测，以及 HTTP 请求（OAuth 换令牌、查询邮箱服务器配置、翻译等）
//
// 代理只有一份设置：地址 + 端口（设置 → 代理）。是 SOCKS5 还是 HTTP 不用用户选，
// 连的时候自己试出来。哪些邮箱走代理由每个账号自己的开关决定（国外邮箱默认开）。
// HTTP 请求用 Electron 的 Chromium 网络栈发，走不通时会自动换另一条路再试一次。

import { session, type Session } from 'electron'
import net from 'net'
import type { ProxySettings } from '../shared/types'
import { getSettings } from './store'

export type ProxyKind = 'socks5' | 'http'

/** 设置里启用了代理，但代理软件没开（端口连不上） */
export class ProxyDownError extends Error {
  code = 'PROXY_DOWN'
  constructor(host: string, port: number) {
    super(`代理软件没有开启：连不上 ${host}:${port}。请先打开代理软件，或者到「设置 → 代理」检查地址和端口`)
  }
}

export function proxyConfigured(p: ProxySettings = getSettings().proxy): boolean {
  return !!(p.enabled && p.host && p.port > 0 && p.port < 65536)
}

/**
 * 试探 host:port 是什么代理。先按 SOCKS5 打招呼：SOCKS5 代理会回 0x05；
 * HTTP 代理听不懂，会回一个错误页或者什么都不回；连不上就是代理没开。
 */
function probe(host: string, port: number): Promise<ProxyKind | 'down'> {
  return new Promise((resolve) => {
    let connected = false
    let done = false
    const socket = net.connect({ host, port })
    const finish = (r: ProxyKind | 'down'): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(r)
    }
    // 连接 1.5 秒内要通；通了以后 0.8 秒还没有回话，就当它是 HTTP 代理（在等请求）
    let timer = setTimeout(() => finish('down'), 1500)
    socket.once('connect', () => {
      connected = true
      clearTimeout(timer)
      timer = setTimeout(() => finish('http'), 800)
      socket.write(Buffer.from([5, 1, 0]))
    })
    socket.once('data', (d) => finish(d[0] === 5 && d.length >= 2 ? 'socks5' : 'http'))
    socket.once('error', () => finish('down'))
    socket.once('close', () => finish(connected ? 'http' : 'down'))
  })
}

const kinds = new Map<string, { kind: ProxyKind | 'down'; at: number }>()
const probing = new Map<string, Promise<ProxyKind | 'down'>>()

/** 识别代理类型。结果缓存一会儿：是 SOCKS5/HTTP 记一分钟，连不上只记几秒（代理软件随时可能被打开） */
async function kindOf(host: string, port: number, fresh = false): Promise<ProxyKind | 'down'> {
  const key = `${host}:${port}`
  const hit = kinds.get(key)
  if (!fresh && hit && Date.now() - hit.at < (hit.kind === 'down' ? 3000 : 60000)) return hit.kind
  let p = probing.get(key)
  if (!p) {
    p = probe(host, port).finally(() => probing.delete(key))
    probing.set(key, p)
  }
  const kind = await p
  kinds.set(key, { kind, at: Date.now() })
  return kind
}

/**
 * 当前该用的代理地址（socks5://host:port 或 http://host:port）。
 * 没启用返回 null；启用了但代理软件没开，直接抛 ProxyDownError，不用等连接超时。
 */
export async function proxyRoute(p: ProxySettings = getSettings().proxy): Promise<string | null> {
  if (!proxyConfigured(p)) return null
  const kind = await kindOf(p.host, p.port)
  if (kind === 'down') throw new ProxyDownError(p.host, p.port)
  return `${kind === 'socks5' ? 'socks5' : 'http'}://${p.host}:${p.port}`
}

/** 同时去连代理的数量上限：开机时七八个邮箱一起通过代理建立连接，有些代理软件会直接把多出来的断掉 */
const SLOTS = 3
let busy = 0
const waiting: Array<() => void> = []
export async function withProxySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (busy >= SLOTS) await new Promise<void>((r) => waiting.push(r))
  busy++
  try {
    return await fn()
  } finally {
    busy--
    waiting.shift()?.()
  }
}

// ---------------- HTTP 请求 ----------------

type Route = 'proxy' | 'direct'

let directSession: Session | null = null
let proxiedSession: Session | null = null
let appliedProxy = ''

async function getSession(route: Route): Promise<Session> {
  if (route === 'proxy') {
    const url = await proxyRoute()
    if (!url) throw new Error('没有启用代理')
    const ses: Session = proxiedSession ?? session.fromPartition('bluebird-proxied')
    proxiedSession = ses
    if (url !== appliedProxy) {
      await ses.setProxy({ proxyRules: url, proxyBypassRules: '<local>' })
      await (ses as unknown as { closeAllConnections(): Promise<void> }).closeAllConnections()
      appliedProxy = url
    }
    return ses
  }
  if (directSession) return directSession
  const ses: Session = session.fromPartition('bluebird-direct')
  // 不走代理时跟随系统代理（比如开着全局代理软件）
  await ses.setProxy({ mode: 'system' })
  directSession = ses
  return ses
}

/**
 * 发请求。useProxy 是「优先走代理」：设置里启用了代理就先走代理，走不通（比如代理软件没开）
 * 再直连；没优先走代理的就先直连，不通再试代理。两条路都不通才报错。
 */
export async function httpFetch(
  url: string,
  init: RequestInit & { useProxy?: boolean; timeoutMs?: number } = {}
): Promise<Response> {
  const { useProxy = false, timeoutMs = 20000, ...rest } = init
  const routes: Route[] = proxyConfigured() ? (useProxy ? ['proxy', 'direct'] : ['direct', 'proxy']) : ['direct']
  let lastError: unknown
  for (let i = 0; i < routes.length; i++) {
    const last = i === routes.length - 1
    const ctrl = new AbortController()
    // 后面还有备用的路时，这一条别等太久
    const timer = setTimeout(() => ctrl.abort(), last ? timeoutMs : Math.min(timeoutMs, 10000))
    try {
      const ses = await getSession(routes[i])
      return await ses.fetch(url, { ...rest, signal: ctrl.signal })
    } catch (err) {
      lastError = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

/** 用给定的代理设置访问一个国外地址，返回耗时和识别出的类型。用来在设置页里测试代理是否可用 */
export async function testProxy(p: ProxySettings): Promise<{ ms: number; kind: ProxyKind }> {
  if (!p.host || !p.port) throw new Error('请先填写代理地址和端口')
  const kind = await kindOf(p.host, p.port, true)
  if (kind === 'down') throw new ProxyDownError(p.host, p.port)
  const ses = session.fromPartition('bluebird-proxytest', { cache: false })
  await ses.setProxy({ proxyRules: `${kind}://${p.host}:${p.port}`, proxyBypassRules: '<local>' })
  await ses.closeAllConnections()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  const started = Date.now()
  try {
    const res = await ses.fetch('https://www.gstatic.com/generate_204', { signal: ctrl.signal, cache: 'no-store' })
    if (res.status !== 204 && !res.ok) throw new Error(`代理返回了异常状态 ${res.status}`)
    return { ms: Date.now() - started, kind }
  } catch (err) {
    const msg = (err as Error).message || ''
    if ((err as Error).name === 'AbortError') throw new Error('代理软件开着，但 10 秒内没能访问国外网站：请检查它有没有选好节点')
    if (/PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|CONNECTION_REFUSED/.test(msg)) {
      throw new Error('连不上代理：请检查代理软件是否开启，地址和端口是否正确')
    }
    throw new Error('通过代理访问失败：' + msg)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------- 自动检测 ----------------

/** 常见代理软件的本地端口：Clash 系 7890/7897，v2rayN 10808/10809，Shadowsocks/Qv2ray 等 1080、2080、20171、33210 */
const COMMON_PORTS = [7890, 7897, 7891, 10809, 10808, 1080, 1087, 2080, 20171, 33210]

export interface DetectedProxy {
  host: string
  port: number
  kind: ProxyKind
  /** 从 Windows 的系统代理设置里读到的，还是在本机常用端口里找到的 */
  source: 'system' | 'scan'
}

/** 找出电脑上正在用的代理：先看 Windows 系统代理设置，再扫一遍常用端口 */
export async function detectProxy(): Promise<DetectedProxy | null> {
  try {
    const rule = await session.defaultSession.resolveProxy('https://www.google.com/')
    for (const part of rule.split(';')) {
      const m = /^\s*(PROXY|HTTPS?|SOCKS5?|SOCKS4)\s+\[?([^\]\s]+?)\]?:(\d+)\s*$/i.exec(part)
      if (!m) continue
      const host = m[2]
      const port = Number(m[3])
      const kind = await kindOf(host, port, true)
      if (kind !== 'down') return { host, port, kind, source: 'system' }
    }
  } catch {
    // 读不到系统设置就扫端口
  }
  const found = await Promise.all(COMMON_PORTS.map(async (port) => ((await kindOf('127.0.0.1', port, true)) === 'down' ? null : port)))
  const port = found.find((p): p is number => p !== null)
  if (!port) return null
  const kind = await kindOf('127.0.0.1', port)
  return kind === 'down' ? null : { host: '127.0.0.1', port, kind, source: 'scan' }
}
