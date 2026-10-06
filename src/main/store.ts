// 账号、设置、密钥的本地存储
// 普通配置存在 config.json；密码和 OAuth 令牌用系统加密（Windows 上是 DPAPI）后存在 secrets.json

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { readJsonSafe, writeJsonSafe } from './jsonfile'
import { join } from 'path'
import type { Account, Settings } from '../shared/types'
import { AI_TONES } from '../shared/ai'

export interface PasswordSecret {
  kind: 'password'
  password: string
}

export interface OAuthSecret {
  kind: 'oauth2'
  refreshToken: string
  accessToken: string
  /** 访问令牌过期时间（毫秒时间戳） */
  expires: number
}

export type Secret = PasswordSecret | OAuthSecret

interface ConfigFile {
  /** 3：删除后可以「撤销」了，「删除前先确认」回到默认关闭（升级时替用户关一次，想要的可以再打开） */
  version: number
  settings: Settings
  accounts: Account[]
  /** 自动备份放在哪里。和电脑有关，不随备份文件带到别的电脑 */
  backup?: BackupConfig
}

export interface BackupConfig {
  enabled: boolean
  folder: string
  /** 这台电脑最后一次写（或恢复）的那份备份的时间，用来发现别的电脑有没有在这之后更新过 */
  lastSavedAt?: number
  /** 最后一次写进备份的内容的指纹，内容没变就不重写 */
  lastHash?: string
}

/** 备份密钥在 secrets.json 里用的名字（不是账号） */
const BACKUP_KEY_ID = '__backup__'

const defaultSettings: Settings = {
  proxy: { enabled: false, host: '127.0.0.1', port: 7890 },
  oauth: { googleClientId: '', googleClientSecret: '', microsoftClientId: '' },
  general: { theme: 'system', layout: 'wide', showHome: true, homeBackground: 'auto', closeToTray: false, launchAtLogin: false, autoUpdate: true, defaultAccountId: '' },
  reading: {
    markReadOnOpen: true,
    autoLoadImages: false,
    darkMail: true,
    showPreview: true,
    density: 'comfortable',
    confirmDelete: false,
    smartInbox: true,
    afterRemove: 'next',
    threads: true,
    gatekeeper: true
  },
  compose: { quoteOnReply: true, fontSize: 14, warnEmptySubject: true, undoSeconds: 5 },
  notify: { enabled: true, onlyPersonal: false, sound: true, showContent: true, quietEnabled: false, quietStart: '22:00', quietEnd: '08:00', checkSeconds: 15 },
  translate: { target: 'ZH' },
  ai: { enabled: false, preset: 'deepseek', style: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', customName: '', language: 'zh', tone: 'friendly' }
}

/** 撤销发送等待的秒数：0 是关闭，最长 60 秒 */
function clampUndo(value: unknown, fallback: number): number {
  const n = Number(value)
  if (value === undefined || value === null || !Number.isFinite(n)) return fallback
  return Math.min(60, Math.max(0, Math.round(n)))
}

/** 旧版本的代理设置里还有「类型」，现在是自动识别的，去掉；地址端口不合规的换回默认 */
function cleanProxy(p: Settings['proxy'] & { type?: unknown }): Settings['proxy'] {
  const port = Math.round(Number(p.port))
  return {
    enabled: !!p.enabled,
    host: typeof p.host === 'string' && p.host.trim() ? p.host.trim() : defaultSettings.proxy.host,
    port: port > 0 && port < 65536 ? port : defaultSettings.proxy.port
  }
}

/** AI 设置：不认识的值换回默认 */
export function cleanAi(a: Settings['ai']): Settings['ai'] {
  const d = defaultSettings.ai
  const text = (v: unknown, fallback: string): string => (typeof v === 'string' ? v.trim().slice(0, 300) : fallback)
  return {
    enabled: !!a.enabled,
    preset: text(a.preset, d.preset) || d.preset,
    style: a.style === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: text(a.baseUrl, d.baseUrl).replace(/\/+$/, ''),
    model: text(a.model, d.model),
    customName: text(a.customName, '').slice(0, 40),
    language: a.language === 'en' ? 'en' : 'zh',
    tone: AI_TONES.some((t) => t.id === a.tone) ? a.tone : d.tone
  }
}

/** 把磁盘上的设置和默认值合并，旧版本缺少的项用默认值补上 */
function mergeSettings(raw?: Partial<Settings> & { notifications?: boolean }): Settings {
  const d = defaultSettings
  return {
    proxy: cleanProxy({ ...d.proxy, ...raw?.proxy }),
    oauth: { ...d.oauth, ...raw?.oauth },
    general: { ...d.general, ...raw?.general },
    reading: { ...d.reading, ...raw?.reading },
    compose: { ...d.compose, ...raw?.compose, undoSeconds: clampUndo(raw?.compose?.undoSeconds, d.compose.undoSeconds) },
    // 旧版本只有一个 notifications 开关
    notify: { ...d.notify, ...(raw?.notifications === false ? { enabled: false } : {}), ...raw?.notify },
    translate: { target: raw?.translate?.target || d.translate.target },
    ai: cleanAi({ ...d.ai, ...raw?.ai })
  }
}

function dir(): string {
  const d = app.getPath('userData')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function readJson<T>(file: string, fallback: T): T {
  return readJsonSafe(join(dir(), file), fallback)
}

function writeJson(file: string, data: unknown): void {
  writeJsonSafe(join(dir(), file), data)
}

/** 删掉账号后，备份里不能还留着它的密钥 */
function dropSecretsBackup(): void {
  try {
    rmSync(join(dir(), 'secrets.json.bak'), { force: true })
  } catch {
    // 删不掉就等下次保存时被覆盖
  }
}

let config: ConfigFile | null = null
let secrets: Record<string, string> | null = null

function load(): ConfigFile {
  if (!config) {
    const raw = readJson<Partial<ConfigFile>>('config.json', {})
    config = {
      version: 3,
      settings: mergeSettings(raw.settings),
      accounts: raw.accounts ?? [],
      backup: raw.backup
    }
    // 以前靠弹确认框防误删，现在删除、归档、移动后几秒内都能撤销，确认框默认不再弹。以后用户再打开就听用户的
    if (raw.settings && (raw.version ?? 1) < 3) {
      config.settings.reading.confirmDelete = false
      save()
    }
  }
  return config
}

function save(): void {
  if (config) writeJson('config.json', config)
}

/** 全部设置的默认值（「恢复默认」用） */
export function defaultSettingsCopy(): Settings {
  return mergeSettings(undefined)
}

export function getSettings(): Settings {
  return load().settings
}

export function saveSettings(settings: Settings): void {
  load().settings = mergeSettings(settings)
  save()
}

export function dataDir(): string {
  return dir()
}

export function getAccounts(): Account[] {
  return load().accounts
}

export function getAccount(id: string): Account | undefined {
  return load().accounts.find((a) => a.id === id)
}

export function upsertAccount(account: Account): void {
  const c = load()
  const i = c.accounts.findIndex((a) => a.id === account.id)
  if (i >= 0) c.accounts[i] = account
  else c.accounts.push(account)
  save()
}

export function removeAccount(id: string): void {
  const c = load()
  c.accounts = c.accounts.filter((a) => a.id !== id)
  save()
  const s = loadSecrets()
  delete s[id]
  writeJson('secrets.json', s)
  dropSecretsBackup()
}

// ---------- 加密存储 ----------

function loadSecrets(): Record<string, string> {
  if (!secrets) secrets = readJson<Record<string, string>>('secrets.json', {})
  return secrets
}

function encrypt(text: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(text).toString('base64')
  }
  // 极少数系统没有可用的加密后端（主要是部分 Linux），退化为 base64，仅作兜底
  console.warn('系统加密不可用，密钥将以未加密形式保存')
  return 'b64:' + Buffer.from(text, 'utf8').toString('base64')
}

function decrypt(value: string): string {
  if (value.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
  }
  if (value.startsWith('b64:')) {
    return Buffer.from(value.slice(4), 'base64').toString('utf8')
  }
  throw new Error('无法识别的密钥格式')
}

export function getSecret(accountId: string): Secret | undefined {
  const v = loadSecrets()[accountId]
  if (!v) return undefined
  try {
    return JSON.parse(decrypt(v)) as Secret
  } catch (err) {
    console.error('解密账号密钥失败', err)
    return undefined
  }
}

export function deleteSecret(accountId: string): void {
  const s = loadSecrets()
  delete s[accountId]
  writeJson('secrets.json', s)
  dropSecretsBackup()
}

export function setSecret(accountId: string, secret: Secret): void {
  const s = loadSecrets()
  s[accountId] = encrypt(JSON.stringify(secret))
  writeJson('secrets.json', s)
}

// ---------- 备份与恢复 ----------

export function getBackupConfig(): BackupConfig {
  return load().backup ?? { enabled: false, folder: '' }
}

export function setBackupConfig(cfg: BackupConfig): void {
  load().backup = cfg
  save()
}

/** 由备份密码派生出来的密钥。存它而不是存密码：自动备份时不用再问密码，也不会在本机留下密码原文 */
export function getBackupKey(): { key: string; salt: string } | undefined {
  const v = loadSecrets()[BACKUP_KEY_ID]
  if (!v) return undefined
  try {
    const k = JSON.parse(decrypt(v)) as { key?: string; salt?: string }
    return k.key && k.salt ? { key: k.key, salt: k.salt } : undefined
  } catch {
    return undefined
  }
}

/** 翻译密钥在 secrets.json 里用的名字（不是账号） */
const TRANSLATE_KEY_ID = '__deepl__'

export function getTranslateKey(): string | undefined {
  const v = loadSecrets()[TRANSLATE_KEY_ID]
  if (!v) return undefined
  try {
    return decrypt(v) || undefined
  } catch {
    return undefined
  }
}

/** 传空字符串就是删掉密钥 */
export function setTranslateKey(key: string): void {
  const s = loadSecrets()
  if (key) s[TRANSLATE_KEY_ID] = encrypt(key)
  else delete s[TRANSLATE_KEY_ID]
  writeJson('secrets.json', s)
}

// AI 密钥按「接口地址的主机名」分开保存：每个服务商各填各的，换服务商不用重填，
// 也不会把填给 A 的密钥发到 B。早期版本只有一把密钥（__ai__），算在当时设置里的那个主机名下。
const AI_KEY_ID = '__ai__'
const aiKeyId = (host: string): string => `${AI_KEY_ID}:${host}`

export function getAiKey(host: string): string | undefined {
  if (!host) return undefined
  const all = loadSecrets()
  const v = all[aiKeyId(host)] ?? (host === savedAiHost() ? all[AI_KEY_ID] : undefined)
  if (!v) return undefined
  try {
    return decrypt(v) || undefined
  } catch {
    return undefined
  }
}

function savedAiHost(): string {
  try {
    return new URL(getSettings().ai.baseUrl).host.toLowerCase()
  } catch {
    return ''
  }
}

export function setAiKey(host: string, key: string): void {
  if (!host) return
  const s = loadSecrets()
  if (key) s[aiKeyId(host)] = encrypt(key)
  else {
    delete s[aiKeyId(host)]
    if (host === savedAiHost()) delete s[AI_KEY_ID]
  }
  writeJson('secrets.json', s)
}

export function setBackupKey(k: { key: string; salt: string }): void {
  const s = loadSecrets()
  s[BACKUP_KEY_ID] = encrypt(JSON.stringify(k))
  writeJson('secrets.json', s)
}

/** 取出要放进备份的全部内容（登录信息是解密后的，由备份文件自己的密码保护） */
export function exportStore(): { settings: Settings; accounts: Account[]; secrets: Record<string, Secret> } {
  const c = load()
  const out: Record<string, Secret> = {}
  for (const a of c.accounts) {
    const secret = getSecret(a.id)
    if (!secret) continue
    // 访问令牌每小时都会换，恢复后也会自动重新取，所以不放进备份；只留长期有效的刷新令牌
    out[a.id] = secret.kind === 'oauth2' ? { ...secret, accessToken: '', expires: 0 } : secret
  }
  return { settings: c.settings, accounts: c.accounts, secrets: out }
}

/** 用备份里的内容替换现有的账号、设置和登录信息 */
export function importStore(data: { settings: Settings; accounts: Account[]; secrets: Record<string, Secret> }): void {
  const c = load()
  c.settings = mergeSettings(data.settings)
  c.accounts = data.accounts.filter((a) => a && typeof a.id === 'string' && typeof a.email === 'string')
  save()
  const keep = loadSecrets()[BACKUP_KEY_ID]
  // 翻译密钥是这台电脑上填的，备份里没有，恢复时原样留着
  const keepTranslate = loadSecrets()[TRANSLATE_KEY_ID]
  const keepAi = Object.entries(loadSecrets()).filter(([k]) => k === AI_KEY_ID || k.startsWith(AI_KEY_ID + ':'))
  const next: Record<string, string> = {}
  for (const a of c.accounts) {
    const secret = data.secrets[a.id]
    if (secret) next[a.id] = encrypt(JSON.stringify(secret))
  }
  if (keep) next[BACKUP_KEY_ID] = keep
  if (keepTranslate) next[TRANSLATE_KEY_ID] = keepTranslate
  for (const [k, v] of keepAi) next[k] = v
  secrets = next
  writeJson('secrets.json', next)
  dropSecretsBackup()
}

/** 恢复之前先留个底，恢复到一半出错时可以原样退回 */
export function snapshotStore(): { config: string; secrets: string } {
  return { config: JSON.stringify(load()), secrets: JSON.stringify(loadSecrets()) }
}

export function rollbackStore(snap: { config: string; secrets: string }): void {
  config = JSON.parse(snap.config) as ConfigFile
  secrets = JSON.parse(snap.secrets) as Record<string, string>
  save()
  writeJson('secrets.json', secrets)
}
