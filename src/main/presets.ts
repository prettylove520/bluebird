// 常见邮箱服务商的服务器预设，以及自动识别逻辑

import { resolveMx } from 'dns/promises'
import type { DetectResult, Preset, ServerConfig } from '../shared/types'
import { httpFetch } from './net'

const ssl = (host: string, port: number): ServerConfig => ({ host, port, secure: true })
const starttls = (host: string, port: number): ServerConfig => ({ host, port, secure: false })

export const PRESETS: Preset[] = [
  {
    id: 'qq',
    label: 'QQ 邮箱',
    domains: ['qq.com', 'foxmail.com', 'vip.qq.com'],
    imap: ssl('imap.qq.com', 993),
    smtp: ssl('smtp.qq.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: false,
    hint: '在 QQ 邮箱网页版的「设置 → 账号」里开启 IMAP/SMTP 服务并生成授权码，这里填授权码，不是 QQ 密码。'
  },
  {
    id: '163',
    label: '网易 163 邮箱',
    domains: ['163.com'],
    imap: ssl('imap.163.com', 993),
    smtp: ssl('smtp.163.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: true,
    hint: '在 163 邮箱网页版的「设置 → POP3/SMTP/IMAP」里开启 IMAP/SMTP 服务，按提示获取授权码。'
  },
  {
    id: '126',
    label: '网易 126 邮箱',
    domains: ['126.com'],
    imap: ssl('imap.126.com', 993),
    smtp: ssl('smtp.126.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: true,
    hint: '在 126 邮箱网页版的「设置 → POP3/SMTP/IMAP」里开启服务并获取授权码。'
  },
  {
    id: 'yeah',
    label: '网易 yeah.net',
    domains: ['yeah.net'],
    imap: ssl('imap.yeah.net', 993),
    smtp: ssl('smtp.yeah.net', 465),
    auth: 'password',
    foreign: false,
    appendSent: true,
    hint: '在网页版设置里开启 IMAP/SMTP 服务并获取授权码。'
  },
  {
    id: 'qiye163',
    label: '网易企业邮箱',
    domains: [],
    imap: ssl('imap.qiye.163.com', 993),
    smtp: ssl('smtp.qiye.163.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: true,
    hint: '如果管理员开启了「客户端授权密码」，需要在网页版设置里生成后填写。'
  },
  {
    id: 'exmail',
    label: '腾讯企业邮箱',
    domains: [],
    imap: ssl('imap.exmail.qq.com', 993),
    smtp: ssl('smtp.exmail.qq.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: false,
    hint: '开启了安全登录的账号，需要在网页版「设置 → 客户端设置」里生成客户端专用密码。'
  },
  {
    id: 'aliyun',
    label: '阿里邮箱（个人）',
    domains: ['aliyun.com'],
    imap: ssl('imap.aliyun.com', 993),
    smtp: ssl('smtp.aliyun.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: true
  },
  {
    id: 'aliqiye',
    label: '阿里企业邮箱',
    domains: [],
    imap: ssl('imap.qiye.aliyun.com', 993),
    smtp: ssl('smtp.qiye.aliyun.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: true
  },
  {
    id: 'sina',
    label: '新浪邮箱',
    domains: ['sina.com', 'sina.cn'],
    imap: ssl('imap.sina.com', 993),
    smtp: ssl('smtp.sina.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: true,
    hint: '需在网页版设置里开启 IMAP/SMTP 服务。'
  },
  {
    id: 'sohu',
    label: '搜狐邮箱',
    domains: ['sohu.com'],
    imap: ssl('imap.sohu.com', 993),
    smtp: ssl('smtp.sohu.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: true
  },
  {
    id: '139',
    label: '139 邮箱',
    domains: ['139.com'],
    imap: ssl('imap.139.com', 993),
    smtp: ssl('smtp.139.com', 465),
    auth: 'password',
    foreign: false,
    appendSent: true,
    hint: '需在网页版设置里开启 IMAP/SMTP 服务并获取授权码。'
  },
  {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: ssl('imap.gmail.com', 993),
    smtp: ssl('smtp.gmail.com', 465),
    auth: 'oauth2',
    oauthProvider: 'google',
    foreign: true,
    appendSent: false,
    hint: '推荐用浏览器登录（需先在「设置」里填 Google Client ID）。也可以开启两步验证后生成「应用专用密码」，改用密码方式登录。'
  },
  {
    id: 'outlook',
    label: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'live.cn'],
    imap: ssl('outlook.office365.com', 993),
    smtp: starttls('smtp-mail.outlook.com', 587),
    auth: 'oauth2',
    oauthProvider: 'microsoft',
    foreign: true,
    appendSent: false,
    hint: '微软个人邮箱只支持浏览器登录，需先在「设置」里填 Microsoft Client ID。'
  },
  {
    id: 'office365',
    label: 'Microsoft 365（工作或学校）',
    domains: [],
    imap: ssl('outlook.office365.com', 993),
    smtp: starttls('smtp.office365.com', 587),
    auth: 'oauth2',
    oauthProvider: 'microsoft',
    foreign: true,
    appendSent: false,
    hint: '需要组织管理员允许 IMAP 和 SMTP 认证。'
  },
  {
    id: 'icloud',
    label: 'iCloud 邮件',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: ssl('imap.mail.me.com', 993),
    smtp: starttls('smtp.mail.me.com', 587),
    auth: 'password',
    foreign: true,
    appendSent: true,
    hint: '需要在 Apple 账户网站生成「App 专用密码」，用户名填 @ 前面的部分或完整地址均可。'
  },
  {
    id: 'yahoo',
    label: 'Yahoo 邮箱',
    domains: ['yahoo.com', 'ymail.com'],
    imap: ssl('imap.mail.yahoo.com', 993),
    smtp: ssl('smtp.mail.yahoo.com', 465),
    auth: 'password',
    foreign: true,
    appendSent: true,
    hint: '需要在 Yahoo 账户安全设置里生成应用密码。'
  }
]

/** 根据 MX 记录识别托管在大厂的企业域名邮箱 */
const MX_RULES: { pattern: RegExp; preset: string }[] = [
  { pattern: /(^|\.)(google\.com|googlemail\.com)$/i, preset: 'gmail' },
  { pattern: /\.mail\.protection\.outlook\.com$/i, preset: 'office365' },
  { pattern: /(^|\.)mxbiz\d*\.qq\.com$|exmail\.qq\.com$/i, preset: 'exmail' },
  { pattern: /(^|\.)(qiye163mx\d*\.mxmail\.netease\.com|qiye\.163\.com)$|mxmail\.netease\.com$/i, preset: 'qiye163' },
  { pattern: /mxhichina\.com$/i, preset: 'aliqiye' }
]

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id)
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ])
}

async function lookupMx(domain: string): Promise<Preset | undefined> {
  try {
    const records = await withTimeout(resolveMx(domain), 5000)
    for (const r of records.sort((a, b) => a.priority - b.priority)) {
      const rule = MX_RULES.find((m) => m.pattern.test(r.exchange))
      if (rule) return presetById(rule.preset)
    }
  } catch {
    // 查不到就算了
  }
  return undefined
}

function parseServer(block: string): ServerConfig | undefined {
  const host = /<hostname>([^<]+)<\/hostname>/.exec(block)?.[1]
  const port = Number(/<port>(\d+)<\/port>/.exec(block)?.[1])
  const socket = /<socketType>([^<]+)<\/socketType>/.exec(block)?.[1]
  if (!host || !port) return undefined
  return { host: host.trim(), port, secure: socket?.trim().toUpperCase() === 'SSL' }
}

/** 查询 Thunderbird 公开的邮箱配置数据库 */
async function lookupIspdb(domain: string): Promise<{ imap: ServerConfig; smtp: ServerConfig } | undefined> {
  try {
    const res = await httpFetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, {
      timeoutMs: 8000
    })
    if (!res.ok) return undefined
    const xml = await res.text()
    const imapBlock = /<incomingServer type="imap">([\s\S]*?)<\/incomingServer>/.exec(xml)?.[1]
    const smtpBlock = /<outgoingServer type="smtp">([\s\S]*?)<\/outgoingServer>/.exec(xml)?.[1]
    const imap = imapBlock ? parseServer(imapBlock) : undefined
    const smtp = smtpBlock ? parseServer(smtpBlock) : undefined
    if (imap && smtp) return { imap, smtp }
  } catch {
    // 网络不通或没有记录
  }
  return undefined
}

export async function detect(email: string): Promise<DetectResult> {
  const domain = email.split('@')[1]?.trim().toLowerCase()
  if (!domain) return { source: 'guess' }

  const direct = PRESETS.find((p) => p.domains.includes(domain))
  if (direct) return { preset: direct, imap: direct.imap, smtp: direct.smtp, source: 'preset' }

  const byMx = await lookupMx(domain)
  if (byMx) return { preset: byMx, imap: byMx.imap, smtp: byMx.smtp, source: 'mx' }

  const ispdb = await lookupIspdb(domain)
  if (ispdb) return { ...ispdb, source: 'ispdb' }

  return {
    imap: ssl(`imap.${domain}`, 993),
    smtp: ssl(`smtp.${domain}`, 465),
    source: 'guess'
  }
}
