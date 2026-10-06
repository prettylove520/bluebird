// HTTP 请求（OAuth 换令牌、查询邮箱服务器配置等）
// 用 Electron 的 Chromium 网络栈发请求，这样可以方便地套用代理设置

import { session, type Session } from 'electron'
import type { ProxySettings } from '../shared/types'
import { getSettings } from './store'

let directSession: Session | null = null
let proxiedSession: Session | null = null
let appliedProxy = ''

export function proxyUrl(p: ProxySettings): string {
  return `${p.type === 'http' ? 'http' : 'socks5'}://${p.host}:${p.port}`
}

async function getSession(useProxy: boolean): Promise<Session> {
  const p = getSettings().proxy
  if (useProxy && p.enabled && p.host) {
    const ses: Session = proxiedSession ?? session.fromPartition('bluebird-proxied')
    proxiedSession = ses
    const url = proxyUrl(p)
    if (url !== appliedProxy) {
      await ses.setProxy({ proxyRules: url, proxyBypassRules: '<local>' })
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

export async function httpFetch(
  url: string,
  init: RequestInit & { useProxy?: boolean; timeoutMs?: number } = {}
): Promise<Response> {
  const { useProxy = false, timeoutMs = 20000, ...rest } = init
  const ses = await getSession(useProxy)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await ses.fetch(url, { ...rest, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 用给定的代理设置访问一个国外地址，返回耗时（毫秒）。用来在设置页里测试代理是否可用 */
export async function testProxy(p: ProxySettings): Promise<number> {
  if (!p.host || !p.port) throw new Error('请先填写代理地址和端口')
  const ses = session.fromPartition('bluebird-proxytest', { cache: false })
  await ses.setProxy({ proxyRules: proxyUrl(p), proxyBypassRules: '<local>' })
  await ses.closeAllConnections()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  const started = Date.now()
  try {
    const res = await ses.fetch('https://www.gstatic.com/generate_204', { signal: ctrl.signal, cache: 'no-store' })
    if (res.status !== 204 && !res.ok) throw new Error(`代理返回了异常状态 ${res.status}`)
    return Date.now() - started
  } catch (err) {
    const msg = (err as Error).message || ''
    if ((err as Error).name === 'AbortError') throw new Error('连接超时：代理没有响应，请检查代理软件是否开启')
    if (/PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|CONNECTION_REFUSED/.test(msg)) {
      throw new Error('连不上代理：请检查代理软件是否开启，地址和端口是否正确')
    }
    throw new Error('通过代理访问失败：' + msg)
  } finally {
    clearTimeout(timer)
  }
}
