// IMAP 连接管理：每个账号一个「操作连接」用来读信/改标记，
// 外加一个常驻在收件箱的「监听连接」用 IDLE 接收新邮件推送

import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import type { Account } from '../../shared/types'
import { getAccessToken, invalidateAccessToken } from '../oauth'
import { getSecret, getSettings } from '../store'
import { proxyRoute, withProxySlot } from '../net'
import { friendlyError, isAuthError, isConnectionError } from './errors'
import { classify, CLASSIFY_HEADERS } from './classify'
import type { MailCategory } from '../../shared/types'

const CLIENT_INFO = { name: 'Bluebird', version: '0.1.0', vendor: 'Bluebird' }

export async function buildImapOptions(account: Account, override?: { password?: string }): Promise<ImapFlowOptions> {
  let auth: ImapFlowOptions['auth']
  const user = account.auth.user || account.email
  if (account.auth.type === 'oauth2') {
    const accessToken = await getAccessToken(account.id, account.auth.oauthProvider!)
    auth = { user, accessToken }
  } else {
    const pass = override?.password ?? (getSecret(account.id) as { password?: string } | undefined)?.password
    if (!pass) throw new Error('账号缺少密码或授权码，请在账号设置里重新填写')
    auth = { user, pass }
  }

  const opts: ImapFlowOptions = {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth,
    logger: false,
    // 网易邮箱要求客户端用 ID 命令表明身份，否则会报 Unsafe Login
    clientInfo: CLIENT_INFO,
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 5 * 60 * 1000,
    // 有些服务器会悄悄断开长时间 IDLE 的连接，定期重新发 IDLE
    maxIdleTime: 4 * 60 * 1000,
    tls: { servername: account.imap.host }
  }
  // 非 SSL 端口（一般是 143）必须先升级成加密连接再登录，避免密码明文传输
  if (!account.imap.secure) opts.doSTARTTLS = true

  // 要走代理的账号：代理软件没开会直接报错，不会干等到连接超时
  if (account.useProxy) {
    const route = await proxyRoute()
    if (route) opts.proxy = route
  }
  return opts
}

interface Conn {
  client?: ImapFlow
  connecting?: Promise<ImapFlow>
  /** 每次主动断开加一，用来识别「连上时已经被要求断开」的连接 */
  gen: number
}

function closeQuietly(client: ImapFlow): void {
  client.logout().catch(() => {
    try {
      client.close()
    } catch {
      // 已经断了
    }
  })
}

const conns = new Map<string, Conn>()

/**
 * 每个账号有两条操作连接：
 * main 给「用户正等着」的事用——打开邮件、标记、移动、发信后的收尾；
 * bg 给后台慢慢做的事用——列表里的摘要、全局搜索、找会话里自己的回复。
 * 分开以后，后台的事再慢也不会让打开邮件排队等着。
 */
export type Lane = 'main' | 'bg'
const connKey = (accountId: string, lane: Lane): string => (lane === 'bg' ? `${accountId}#bg` : accountId)

async function openClient(account: Account): Promise<ImapFlow> {
  const make = async (): Promise<ImapFlow> => {
    const client = new ImapFlow(await buildImapOptions(account))
    // 一定要监听 error，否则断线时会让整个主进程崩溃
    client.on('error', (err: Error) => console.warn(`[imap ${account.email}]`, err.message))
    // 通过代理连的话排队连：一下子冒出十几条连接，有的代理软件会直接掐断
    await (account.useProxy ? withProxySlot(() => client.connect()) : client.connect())
    return client
  }
  try {
    return await make()
  } catch (err) {
    // OAuth 令牌可能被提前吊销，强制刷新后再试一次
    if (account.auth.type === 'oauth2' && isAuthError(err)) {
      invalidateAccessToken(account.id)
      return await make()
    }
    throw err
  }
}

export async function getClient(account: Account, lane: Lane = 'main'): Promise<ImapFlow> {
  const key = connKey(account.id, lane)
  let c = conns.get(key)
  if (!c) {
    c = { gen: 0 }
    conns.set(key, c)
  }
  if (c.client?.usable) return c.client
  if (c.connecting) return c.connecting

  const conn = c
  const gen = conn.gen
  const attempt = openClient(account)
    .then((client) => {
      // 连接途中被要求断开（改了设置、删了账号、电脑刚唤醒）：这条连接不能留着
      if (conn.gen !== gen) {
        closeQuietly(client)
        throw Object.assign(new Error('连接已被重置'), { code: 'NoConnection' })
      }
      conn.client = client
      client.on('close', () => {
        if (conn.client === client) conn.client = undefined
      })
      return client
    })
    .finally(() => {
      if (conn.connecting === attempt) conn.connecting = undefined
    })
  conn.connecting = attempt
  return attempt
}

/**
 * 断开一个账号的操作连接，下次用到时会重新连。
 * 传了 only：只有当前连接还是出问题的那一条时才断开——几个请求同时失败时，
 * 先失败的已经重连好了，后失败的不能把这条新连接又关掉。
 */
export function dropClient(accountId: string, only?: ImapFlow): void {
  // 两条连接（main 和 bg）都看一遍；accountId 本身已经带着 #bg 时只会对上它自己那一条
  for (const key of [accountId, connKey(accountId, 'bg')]) {
    const c = conns.get(key)
    if (!c) continue
    if (only) {
      if (c.client === only) c.client = undefined
      continue
    }
    c.gen++
    // 正在连的那一条已经作废，后面的请求不要再搭它的车
    c.connecting = undefined
    const client = c.client
    c.client = undefined
    if (client) closeQuietly(client)
  }
  if (only?.usable) closeQuietly(only)
}

/** 只断开后台那条连接（后台的事卡住了、不想再等的时候用） */
export function dropBackground(accountId: string): void {
  const c = conns.get(connKey(accountId, 'bg'))
  if (!c) return
  c.gen++
  c.connecting = undefined
  const client = c.client
  c.client = undefined
  if (client) closeQuietly(client)
}

/** 锁定一个文件夹执行操作；连接断了会自动重连再试一次 */
export async function withMailbox<T>(
  account: Account,
  path: string,
  fn: (client: ImapFlow) => Promise<T>,
  lane: Lane = 'main'
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let client: ImapFlow
    try {
      client = await getClient(account, lane)
    } catch (err) {
      // 正在连的时候连接被重置了，重新连一次
      if (attempt === 0 && (err as { code?: string })?.code === 'NoConnection') continue
      throw new Error(friendlyError(err, { host: account.imap.host, useProxy: account.useProxy, oauth: account.auth.type === 'oauth2' ? account.auth.oauthProvider : undefined }))
    }
    try {
      const lock = await client.getMailboxLock(path)
      try {
        return await fn(client)
      } finally {
        lock.release()
      }
    } catch (err) {
      // noRetry：这个操作已经做了一半（比如复制完了），整段重来会重复，只能把情况告诉用户
      if (attempt === 0 && !(err as { noRetry?: boolean }).noRetry && (isConnectionError(err) || !client.usable)) {
        dropClient(account.id, client)
        continue
      }
      throw new Error(friendlyError(err, { host: account.imap.host, useProxy: account.useProxy, oauth: account.auth.type === 'oauth2' ? account.auth.oauthProvider : undefined }))
    }
  }
}

/** 不需要锁定文件夹的操作（比如列出文件夹） */
export async function withClient<T>(account: Account, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let client: ImapFlow
    try {
      client = await getClient(account)
    } catch (err) {
      // 正在连的时候连接被重置了，重新连一次
      if (attempt === 0 && (err as { code?: string })?.code === 'NoConnection') continue
      throw new Error(friendlyError(err, { host: account.imap.host, useProxy: account.useProxy, oauth: account.auth.type === 'oauth2' ? account.auth.oauthProvider : undefined }))
    }
    try {
      return await fn(client)
    } catch (err) {
      if (attempt === 0 && (isConnectionError(err) || !client.usable)) {
        dropClient(account.id, client)
        continue
      }
      throw new Error(friendlyError(err, { host: account.imap.host, useProxy: account.useProxy, oauth: account.auth.type === 'oauth2' ? account.auth.oauthProvider : undefined }))
    }
  }
}

/** 添加账号时测试 IMAP 能否登录 */
export async function testImap(account: Account, password?: string): Promise<void> {
  const client = new ImapFlow(await buildImapOptions(account, { password }))
  client.on('error', () => undefined)
  try {
    await client.connect()
    await client.logout()
  } catch (err) {
    client.close()
    throw new Error('收信服务器（IMAP）：' + friendlyError(err, { host: account.imap.host, useProxy: account.useProxy, oauth: account.auth.type === 'oauth2' ? account.auth.oauthProvider : undefined }))
  }
}

// ---------------- 新邮件监听 ----------------

export interface NewMailInfo {
  uid: number
  /** 发件人邮箱地址（小写） */
  address: string
  category: MailCategory
  from: string
  subject: string
}

interface Watcher {
  client?: ImapFlow
  stopped: boolean
  retry: number
  timer?: NodeJS.Timeout
  /** 定时问一下服务器有没有新邮件 */
  poll?: NodeJS.Timeout
}

// 有的邮箱（QQ 邮箱尤其明显）虽然支持「有新邮件就推送」，实际经常不推。所以每隔一会儿主动问一次，
// 服务器回答时会顺带报告新邮件。间隔在「设置 → 通知」里可以调，默认 15 秒
function pollMs(): number {
  const sec = Number(getSettings().notify.checkSeconds)
  // 太密了服务器会嫌烦，太疏了提醒不及时，限制在 5 秒到 5 分钟之间
  return Math.min(300, Math.max(5, Number.isFinite(sec) && sec > 0 ? sec : 15)) * 1000
}

// 每个账号收件箱里已经见过的最大 UID；重连后比它大的就是断线期间到的新邮件。
// 单独放在这里而不是 Watcher 里：电脑睡眠唤醒时监听会整个重建，这个位置不能跟着丢
const lastSeenUid = new Map<string, number>()

/** 取一批邮件的发件人和主题，用来弹通知；只要未读的 */
async function fetchNewInfos(client: ImapFlow, range: string, byUid: boolean, afterUid = 0): Promise<{ mails: NewMailInfo[]; maxUid: number }> {
  const mails: NewMailInfo[] = []
  let maxUid = 0
  for await (const msg of client.fetch(range, { uid: true, envelope: true, flags: true, headers: CLASSIFY_HEADERS }, { uid: byUid })) {
    // 「n:*」这种写法即使没有更新的邮件，服务器也会把最后一封返回来，要自己筛掉
    if (msg.uid <= afterUid) continue
    if (msg.uid > maxUid) maxUid = msg.uid
    if (msg.flags?.has('\\Seen')) continue
    const f = msg.envelope?.from?.[0]
    const address = (f?.address || '').toLowerCase()
    mails.push({
      uid: msg.uid,
      address,
      category: classify(address, msg.headers, f?.name || '', msg.envelope?.subject || ''),
      from: f?.name || f?.address || '未知发件人',
      subject: msg.envelope?.subject || '（无主题）'
    })
  }
  return { mails, maxUid }
}

const watchers = new Map<string, Watcher>()

export function startWatcher(
  account: Account,
  onNew: (mails: NewMailInfo[]) => void,
  onChange: () => void
): void {
  stopWatcher(account.id)
  const w: Watcher = { stopped: false, retry: 0 }
  watchers.set(account.id, w)

  const schedule = (proxyDown = false): void => {
    if (w.stopped) return
    const delays = [5, 15, 30, 60, 120, 300]
    // 代理软件没开的时候不用越等越久：它一开就该马上连上，探一下代理端口很便宜
    const delay = proxyDown ? 10000 : delays[Math.min(w.retry, delays.length - 1)] * 1000
    if (!proxyDown) w.retry++
    w.timer = setTimeout(run, delay)
  }

  const run = async (): Promise<void> => {
    if (w.stopped) return
    let client: ImapFlow
    try {
      client = await openClient(account)
    } catch (err) {
      console.warn(`[watch ${account.email}] 连接失败`, (err as Error).message)
      schedule((err as { code?: string }).code === 'PROXY_DOWN')
      return
    }
    if (w.stopped) {
      client.logout().catch(() => undefined)
      return
    }
    w.client = client
    client.on('close', () => {
      if (w.client === client) w.client = undefined
      if (w.poll) clearTimeout(w.poll)
      w.poll = undefined
      schedule()
    })
    client.on('exists', async (data: { count: number; prevCount: number }) => {
      if (data.count <= data.prevCount) return
      try {
        const { mails, maxUid } = await fetchNewInfos(client, `${data.prevCount + 1}:${data.count}`, false)
        // 取的这会儿监听已经被换掉了（唤醒、改设置）：新的监听会负责，这里不要再提醒一遍
        if (w.stopped) return
        if (maxUid > (lastSeenUid.get(account.id) ?? 0)) lastSeenUid.set(account.id, maxUid)
        if (mails.length) onNew(mails)
        else onChange()
      } catch (err) {
        console.warn(`[watch ${account.email}] 获取新邮件失败`, (err as Error).message)
        onChange()
      }
    })
    client.on('expunge', () => onChange())
    client.on('flags', () => onChange())

    try {
      await client.mailboxOpen('INBOX')
      if (w.stopped) return
      w.retry = 0
      if (w.poll) clearTimeout(w.poll)
      // 每次问完再定下一次：间隔随时按设置里的最新值来，上一次还没回来也不会堆积
      const ask = (): void => {
        if (w.stopped || w.client !== client || !client.usable) return
        client
          .noop()
          .catch(() => undefined)
          .finally(() => {
            if (!w.stopped && w.client === client) w.poll = setTimeout(ask, pollMs())
          })
      }
      w.poll = setTimeout(ask, pollMs())
      // 打开后 imapflow 会自动进入 IDLE 等待推送；服务器不支持 IDLE 时会退化成定时 NOOP
      const box = client.mailbox
      const newest = box && box.uidNext ? box.uidNext - 1 : 0
      const after = lastSeenUid.get(account.id)
      if (after === undefined) {
        // 第一次连上：只记下当前位置，已有的邮件不提醒
        if (newest) lastSeenUid.set(account.id, newest)
      } else if (newest > after) {
        // 断线重连：把断线期间到的新邮件补上提醒。范围只到打开邮箱那一刻为止，之后再到的由上面的 exists 负责，免得提醒两遍
        try {
          const { mails } = await fetchNewInfos(client, `${after + 1}:${newest}`, true, after)
          if (w.stopped) return
          // 取成功了才往前挪位置；这次没取到的话，下次重连还会再补
          if (newest > (lastSeenUid.get(account.id) ?? 0)) lastSeenUid.set(account.id, newest)
          if (mails.length) onNew(mails.slice(-20))
          else onChange()
        } catch (err) {
          console.warn(`[watch ${account.email}] 补取断线期间的新邮件失败`, (err as Error).message)
          onChange()
        }
      } else if (newest) {
        // 重连了但没有新邮件：已读状态之类可能变了，让界面刷新一下
        onChange()
      }
    } catch (err) {
      console.warn(`[watch ${account.email}] 打开收件箱失败`, (err as Error).message)
      client.close()
    }
  }

  void run()
}

export function stopWatcher(accountId: string): void {
  const w = watchers.get(accountId)
  if (!w) return
  w.stopped = true
  if (w.timer) clearTimeout(w.timer)
  if (w.poll) clearTimeout(w.poll)
  w.client?.logout().catch(() => w.client?.close())
  watchers.delete(accountId)
}

export function stopAll(): void {
  for (const id of [...watchers.keys()]) stopWatcher(id)
  for (const id of [...conns.keys()]) dropClient(id)
}
