// 发信：用 SMTP 发出，需要时再把一份存到「已发送」

import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type Mail from 'nodemailer/lib/mailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import * as socks from 'socks'
import { existsSync } from 'fs'
import { hostname } from 'os'
import type { Account, OutgoingMessage } from '../../shared/types'
import { getAccessToken, invalidateAccessToken } from '../oauth'
import { getAccount, getSecret, getSettings } from '../store'
import { proxyUrl } from '../net'
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

  const options: SMTPTransport.Options = {
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

  const proxy = getSettings().proxy
  const useProxy = account.useProxy && proxy.enabled && !!proxy.host
  if (useProxy) options.proxy = proxyUrl(proxy)

  const transporter = nodemailer.createTransport(options)
  // nodemailer 自带 HTTP 代理支持，SOCKS 代理需要手动挂上 socks 模块
  if (useProxy && proxy.type === 'socks5') {
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

  // 先在本地生成完整邮件，这样发出去的和存到「已发送」的是同一份
  const node = new MailComposer(options).compile()
  const envelope = node.getEnvelope()
  const raw = await new Promise<Buffer>((resolve, reject) =>
    node.build((err, buf) => (err ? reject(err) : resolve(buf)))
  )

  const send = async (): Promise<void> => {
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
