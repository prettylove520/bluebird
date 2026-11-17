// 发信：用 SMTP 发出，需要时再把一份存到「已发送」

import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import SMTPConnection from 'nodemailer/lib/smtp-connection'
import type Mail from 'nodemailer/lib/mailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import * as socks from 'socks'
import { existsSync } from 'fs'
import { hostname } from 'os'
import type { Account, OutgoingMessage } from '../../shared/types'
import { getAccessToken, invalidateAccessToken } from '../oauth'
import { getAccount, getSecret } from '../store'
import { proxyRouteOrDirect } from '../net'
import { noteContacts } from '../contacts'
import { friendlyError, isAuthError, isConnectionError } from './errors'
import { appendMessage, findSpecialPath, getAttachment, setFlag } from './service'

/** EHLO 里的主机名必须是 ASCII；中文电脑名会被部分服务器拒绝 */
function ehloName(): string {
  const h = hostname()
  return /^[a-zA-Z0-9.-]+$/.test(h) ? h : 'localhost'
}

async function createTransport(account: Account, password?: string) {
  const user = account.auth.user || account.email
  let auth: SMTPTransport.Options['auth']
  if (account.auth.type === 'oauth2') {
    const accessToken = await getAccessToken(account.id, account.auth.oauthProvider!)
    auth = { type: 'OAuth2', user, accessToken }
  } else {
    const pass = password ?? (getSecret(account.id) as { password?: string } | undefined)?.password
    if (!pass) throw new Error('账号缺少密码或授权码')
    auth = { user, pass }
  }

  // nodemailer 支持 proxy 这个选项，但它的类型说明里没写
  const options: SMTPTransport.Options & { proxy?: string } = {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    requireTLS: !account.smtp.secure,
    auth,
    name: ehloName(),
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
    tls: { servername: account.smtp.host }
  }

  // 代理软件的端口连不上时改成直连（虚拟网卡模式下直连也能出国）
  const route = account.useProxy ? (await proxyRouteOrDirect()).route : null
  if (route) options.proxy = route

  const transporter = nodemailer.createTransport(options)
  // nodemailer 自带 HTTP 代理支持，SOCKS 代理需要手动挂上 socks 模块
  if (route?.startsWith('socks5:')) {
    transporter.set('proxy_socks_module', socks)
  }
  return transporter
}

export async function testSmtp(account: Account, password?: string): Promise<void> {
  try {
    const t = await createTransport(account, password)
    await t.verify()
    t.close()
  } catch (err) {
    throw new Error('发信服务器（SMTP）：' + friendlyError(err, { host: account.smtp.host, useProxy: account.useProxy, oauth: account.auth.type === 'oauth2' ? account.auth.oauthProvider : undefined }))
  }
}

// ---------- 提前连好发信服务器 ----------
// 点「发送」后有几秒可以撤销。趁这几秒先把到发信服务器的连接建好、登录好，倒计时一结束直接把信交出去，
// 省掉临发才去连接、握手、登录的那两三秒（走代理时更久）。提前连接没成、或者等的时候断了，就照老办法现连现发。

interface Warm {
  conn?: SMTPConnection
  /** 连好并登录成功是 true */
  ready: Promise<boolean>
  dead: boolean
}
const warm = new Map<string, Warm>()

function dropWarm(accountId: string, w?: Warm): void {
  const cur = warm.get(accountId)
  if (!cur || (w && cur !== w)) return
  warm.delete(accountId)
  cur.dead = true
  try {
    cur.conn?.close()
  } catch {
    // 已经断了
  }
}

/** 点了「发送」、还在撤销倒计时里的时候调用 */
export function warmSmtp(account: Account): void {
  dropWarm(account.id)
  const w: Warm = { dead: false, ready: Promise.resolve(false) }
  w.ready = (async (): Promise<boolean> => {
    const t = await createTransport(account)
    // 代理的接法在 nodemailer 内部：发信前它把「怎么取到一条通到服务器的线路」放在这两个位置之一
    const inner = (t as unknown as { transporter: { options: SMTPConnection.Options; getSocket: SocketGetter; getAuth(a: object): unknown } }).transporter
    const own = (t as unknown as { getSocket?: SocketGetter | false }).getSocket
    const getSocket: SocketGetter = typeof own === 'function' ? own : inner.getSocket.bind(inner)
    const extra = await new Promise<Record<string, unknown> | false | undefined>((resolve, reject) =>
      getSocket(inner.options, (err, so) => (err ? reject(err) : resolve(so)))
    )
    if (w.dead) {
      const sock = extra ? (extra.connection as { destroy?(): void } | undefined) : undefined
      sock?.destroy?.()
      return false
    }
    const options = extra && extra.connection ? { ...inner.options, ...extra } : inner.options
    const conn = new SMTPConnection(options)
    w.conn = conn
    conn.on('error', () => {
      w.dead = true
    })
    conn.once('end', () => {
      w.dead = true
    })
    await new Promise<void>((resolve, reject) => {
      conn.once('error', reject)
      conn.connect(() => resolve())
    })
    const auth = inner.getAuth({})
    // allowsAuth：服务器在握手时说了支持登录（类型说明里没有这个字段）
    if (auth && ((conn as unknown as { allowsAuth?: boolean }).allowsAuth || (options as { forceAuth?: boolean }).forceAuth)) {
      await new Promise<void>((resolve, reject) =>
        conn.login(auth as Parameters<SMTPConnection['login']>[0], (err) => (err ? reject(err) : resolve()))
      )
    }
    return !w.dead
  })().catch(() => {
    dropWarm(account.id, w)
    return false
  })
  warm.set(account.id, w)
  // 一直没用上（撤销了、或者排到别的时间发）：一分钟后关掉，不占着服务器的连接
  setTimeout(() => dropWarm(account.id, w), 60000).unref?.()
}
type SocketGetter = (options: unknown, cb: (err: Error | null, socketOptions?: Record<string, unknown> | false) => void) => void

/** 有提前连好、现在还活着的连接就用它发，返回 true；没有就返回 false，由调用方照老办法发 */
async function sendWarm(account: Account, envelope: { from: string | false; to: string[] }, raw: Buffer): Promise<boolean> {
  const w = warm.get(account.id)
  if (!w) return false
  warm.delete(account.id)
  const ok = await w.ready
  const conn = w.conn
  if (!ok || w.dead || !conn) {
    try {
      conn?.close()
    } catch {
      // 已经断了
    }
    return false
  }
  try {
    await new Promise<void>((resolve, reject) => {
      conn.once('error', reject)
      conn.send(envelope as SMTPConnection.Envelope, raw, (err) => (err ? reject(err) : resolve()))
    })
    return true
  } finally {
    try {
      conn.close()
    } catch {
      // 已经断了
    }
  }
}

/** 把用户输入的收件人（可能用中文逗号、分号分隔）规范一下 */
function normalizeRecipients(s: string): string {
  return s
    .replace(/[，；;]/g, ',')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(', ')
}

/** 发送失败的错误；retryable 表示是网络/代理问题，过一会儿再试可能就好了 */
function sendError(err: unknown, account: Account): Error {
  return Object.assign(new Error('发送失败：' + friendlyError(err, { host: account.smtp.host, useProxy: account.useProxy, oauth: account.auth.type === 'oauth2' ? account.auth.oauthProvider : undefined })), {
    retryable: !isAuthError(err) && isConnectionError(err)
  })
}

export async function sendMessage(
  account: Account,
  msg: OutgoingMessage,
  hooks?: {
    /** 服务器已经收下这封信（之后存「已发送」等收尾工作还没做） */
    onAccepted?: () => void
    /** 这封信不是用户自己写给谁的（比如退订邮件），收件人不记进联系人 */
    skipContacts?: boolean
  }
): Promise<{ savedToSent: boolean }> {
  const to = normalizeRecipients(msg.to)
  const cc = normalizeRecipients(msg.cc)
  const bcc = normalizeRecipients(msg.bcc)
  if (!to && !cc && !bcc) throw new Error('请至少填写一个收件人')

  const attachments: Mail.Attachment[] = []
  for (const a of msg.attachments) {
    if (a.path) {
      // 草稿或定时邮件是从别的电脑的备份里恢复来的话，附件原来的位置在这台电脑上不存在
      if (!existsSync(a.path)) throw new Error(`附件「${a.filename}」在这台电脑上找不到了，请重新添加后再发送`)
      attachments.push({ filename: a.filename, path: a.path })
    } else if (a.fromMessage) {
      // 转发的附件来自原邮件所在的账号，不一定是现在发信的账号
      const source = getAccount(a.fromMessage.accountId)
      if (!source) throw new Error('原邮件所在的账号已被删除，无法转发附件')
      let att: Awaited<ReturnType<typeof getAttachment>>
      try {
        att = await getAttachment(source, a.fromMessage.folder, a.fromMessage.uid, a.fromMessage.index)
      } catch (err) {
        // 取原邮件附件时连不上服务器，也算「过一会儿再试可能就好」
        const text = (err as Error).message
        throw Object.assign(new Error(`没能取到要转发的附件：${text}`), { retryable: /连接服务器失败|找不到服务器/.test(text) })
      }
      attachments.push({ filename: att.filename || a.filename, content: att.content, contentType: att.contentType })
    }
  }

  const options: Mail.Options = {
    from: { name: account.name || account.email, address: account.email },
    to: to || undefined,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    attachments,
    inReplyTo: msg.inReplyTo,
    references: msg.references?.length ? msg.references : undefined
  }

  // 回复日历邀请：除了文字，再附上一份日历回复，对方的日历程序才能识别
  if (msg.calendarReply) (options as Mail.Options & { icalEvent?: unknown }).icalEvent = { method: 'REPLY', content: msg.calendarReply }

  // 先在本地生成完整邮件，这样发出去的和存到「已发送」的是同一份
  const node = new MailComposer(options).compile()
  const envelope = node.getEnvelope()
  const raw = await new Promise<Buffer>((resolve, reject) =>
    node.build((err, buf) => (err ? reject(err) : resolve(buf)))
  )

  const send = async (): Promise<void> => {
    // 撤销倒计时里已经提前连好的话，直接用那条连接发
    if (await sendWarm(account, envelope, raw)) return
    const t = await createTransport(account)
    try {
      await t.sendMail({ envelope, raw })
    } finally {
      t.close()
    }
  }

  try {
    await send()
  } catch (err) {
    if (account.auth.type === 'oauth2' && isAuthError(err)) {
      invalidateAccessToken(account.id)
      try {
        await send()
      } catch (err2) {
        throw sendError(err2, account)
      }
    } else {
      throw sendError(err, account)
    }
  }

  try {
    hooks?.onAccepted?.()
  } catch {
    // 回调出错不影响发送结果
  }
  // 给谁发过信，下次写信时就能自动补全
  try {
    const list: { name: string; address: string }[] = []
    const re = /(?:"?([^"<,;]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>|([^\s,;<>"]+@[^\s,;<>"]+)/g
    let hit: RegExpExecArray | null
    while ((hit = re.exec(`${to}, ${cc}, ${bcc}`))) list.push({ name: (hit[1] || '').trim(), address: hit[2] || hit[3] })
    if (!hooks?.skipContacts) noteContacts(list, 'sent')
  } catch {
    // 记不下来也不影响发信
  }

  // 下面这些失败了不影响「已发出」这个结果
  let savedToSent = false
  if (account.appendSent) {
    try {
      const sent = await findSpecialPath(account, 'sent')
      if (sent) {
        await appendMessage(account, sent, raw, ['\\Seen'])
        savedToSent = true
      }
    } catch (err) {
      console.warn('保存到已发送失败', err)
    }
  }
  if (msg.replyTo) {
    // 回复时可能换了发件账号，「已回复」要标在原邮件所在的账号上
    const owner = (msg.replyTo.accountId && getAccount(msg.replyTo.accountId)) || account
    setFlag(owner, msg.replyTo.folder, msg.replyTo.uid, 'answered', true).catch(() => undefined)
  }
  return { savedToSent }
}
