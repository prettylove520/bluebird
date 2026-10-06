// 账号的添加、修改、删除

import { randomUUID } from 'crypto'
import type { Account, NewAccountInput, OAuthProvider } from '../shared/types'
import { startOAuth } from './oauth'
import { presetById, PRESETS } from './presets'
import {
  deleteSecret,
  getAccount,
  getAccounts,
  getSecret,
  removeAccount as removeFromStore,
  setSecret,
  upsertAccount
} from './store'
import { dropClient, stopWatcher, testImap } from './mail/imap'
import { testSmtp } from './mail/smtp'
import { forgetAccount } from './mail/service'

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

function nextColor(): string {
  return COLORS[getAccounts().length % COLORS.length]
}

async function testBoth(account: Account, password?: string): Promise<void> {
  // 收信和发信服务器一起测，哪个失败就报哪个
  const results = await Promise.allSettled([testImap(account, password), testSmtp(account, password)])
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as Error).message)
  if (errors.length) throw new Error(errors.join('\n'))
}

export async function addPasswordAccount(input: NewAccountInput): Promise<Account> {
  const email = input.email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('邮箱地址格式不正确')
  if (!input.password) throw new Error('请填写密码或授权码')
  if (getAccounts().some((a) => a.email === email)) throw new Error('这个邮箱已经添加过了')

  const account: Account = {
    id: randomUUID(),
    email,
    name: input.name.trim() || email.split('@')[0],
    provider: input.provider,
    imap: input.imap,
    smtp: input.smtp,
    auth: { type: 'password', user: input.user?.trim() || undefined },
    useProxy: input.useProxy,
    appendSent: input.appendSent,
    color: nextColor()
  }
  await testBoth(account, input.password)
  setSecret(account.id, { kind: 'password', password: input.password })
  upsertAccount(account)
  return account
}

const MS_CONSUMER = presetById('outlook')!.domains

export async function addOAuthAccount(provider: OAuthProvider, name?: string): Promise<Account> {
  const { email, secret } = await startOAuth(provider)
  const domain = email.split('@')[1] || ''

  // 已经添加过的账号：当作重新登录，更新令牌即可
  const existing = getAccounts().find((a) => a.email === email)
  if (existing) {
    setSecret(existing.id, secret)
    dropClient(existing.id)
    return existing
  }

  const presetId = provider === 'google' ? 'gmail' : MS_CONSUMER.includes(domain) ? 'outlook' : 'office365'
  const preset = presetById(presetId)!
  const account: Account = {
    id: randomUUID(),
    email,
    name: name?.trim() || email.split('@')[0],
    provider: preset.id,
    imap: preset.imap,
    smtp: preset.smtp,
    auth: { type: 'oauth2', oauthProvider: provider },
    useProxy: preset.foreign,
    appendSent: preset.appendSent,
    color: nextColor()
  }
  setSecret(account.id, secret)
  try {
    await testBoth(account)
  } catch (err) {
    deleteSecret(account.id)
    throw err
  }
  upsertAccount(account)
  return account
}

/** OAuth 账号重新登录 */
export async function reauthAccount(id: string): Promise<Account> {
  const account = getAccount(id)
  if (!account) throw new Error('账号不存在')
  if (account.auth.type !== 'oauth2' || !account.auth.oauthProvider) throw new Error('这个账号不是浏览器登录的')
  const { email, secret } = await startOAuth(account.auth.oauthProvider, account.email)
  if (email !== account.email) throw new Error(`登录的是 ${email}，和这个账号（${account.email}）不一致`)
  setSecret(account.id, secret)
  dropClient(account.id)
  return account
}

export interface AccountPatch {
  name?: string
  useProxy?: boolean
  appendSent?: boolean
  password?: string
  signature?: string
  tag?: string
  color?: string
  imap?: Account['imap']
  smtp?: Account['smtp']
}

export async function updateAccount(id: string, patch: AccountPatch): Promise<Account> {
  const account = getAccount(id)
  if (!account) throw new Error('账号不存在')
  const next: Account = {
    ...account,
    name: patch.name?.trim() || account.name,
    useProxy: patch.useProxy ?? account.useProxy,
    appendSent: patch.appendSent ?? account.appendSent,
    signature: patch.signature ?? account.signature,
    tag: typeof patch.tag === 'string' ? patch.tag.trim().slice(0, 8) || undefined : account.tag,
    color: patch.color && /^#[0-9a-fA-F]{6}$/.test(patch.color) ? patch.color : account.color,
    imap: patch.imap ?? account.imap,
    smtp: patch.smtp ?? account.smtp
  }
  const serverChanged = !!patch.imap || !!patch.smtp || patch.useProxy !== undefined
  if (account.auth.type === 'password' && (patch.password || serverChanged)) {
    const old = getSecret(id)
    const password = patch.password || (old?.kind === 'password' ? old.password : undefined)
    await testBoth(next, password)
    if (patch.password) setSecret(id, { kind: 'password', password: patch.password })
  }
  upsertAccount(next)
  dropClient(id)
  return next
}

export function removeAccount(id: string): void {
  stopWatcher(id)
  dropClient(id)
  forgetAccount(id)
  removeFromStore(id)
}

export function listPresets() {
  return PRESETS
}
