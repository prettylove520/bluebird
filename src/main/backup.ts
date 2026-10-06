// 备份与恢复：把账号、设置、登录信息、置顶/模板等打包成一个加密文件，放进用户选的文件夹。
// 把这个文件夹选在云盘的同步目录里（OneDrive、坚果云、百度网盘同步空间…），换电脑时就能从云盘恢复。
//
// 文件用用户自己设的密码加密（scrypt 派生密钥 + AES-256-GCM）。里面有邮箱的授权码和登录令牌，
// 所以密码就是唯一的保护：没有密码，拿到文件也读不出内容；忘了密码，这个文件也就恢复不了。

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { stat } from 'fs/promises'
import { homedir, hostname } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import type { Account, BackupDetect, BackupInfo, BackupMeta, Settings, UserData } from '../shared/types'
import { onJsonWritten } from './jsonfile'
import { exportStore, getBackupConfig, getBackupKey, importStore, rollbackStore, setBackupConfig, setBackupKey, snapshotStore, type Secret } from './store'
import { dropStateBackup, getData, replaceData } from './userdata'

export const BACKUP_FILE = 'Bluebird 备份.bbk'
const SCRYPT_N = 1 << 15

interface Payload {
  settings: Settings
  accounts: Account[]
  secrets: Record<string, Secret>
  state: UserData
}

/** 文件最外层：除了 data 都是明文，方便在输入密码之前先告诉用户这是哪台电脑、什么时候的备份 */
interface Envelope {
  app: 'bluebird-backup'
  v: 1
  savedAt: number
  device: string
  accounts: number
  kdf: 'scrypt'
  n: number
  salt: string
  iv: string
  tag: string
  data: string
}

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
}

const BROKEN = '备份文件已经损坏，或者还没有从云盘下载完整'

function readEnvelope(file: string): Envelope {
  let env: Envelope
  try {
    // 正常的备份只有几十到几百 KB；大得离谱的肯定不是
    if (statSync(file).size > 64 * 1024 * 1024) throw new Error('too big')
    env = JSON.parse(readFileSync(file, 'utf8')) as Envelope
  } catch {
    throw new Error('这个文件读不出来，可能还没有从云盘下载完整，或者不是 Bluebird 的备份文件')
  }
  if (!env || env.app !== 'bluebird-backup') throw new Error('这不是 Bluebird 的备份文件')
  if (env.v !== 1) throw new Error('这个备份是更新版本的 Bluebird 生成的，请先升级 Bluebird')
  const str = (v: unknown): boolean => typeof v === 'string' && v.length > 0
  if (!str(env.salt) || !str(env.iv) || !str(env.tag) || !str(env.data) || env.n !== SCRYPT_N) throw new Error(BROKEN)
  return env
}

/** 文件里的东西不可信（可能被改过、可能没同步完），交给界面之前都转成确定的类型 */
function metaOf(file: string, env: Envelope): BackupMeta {
  return { file, savedAt: Number(env.savedAt) || 0, device: String(env.device ?? '').slice(0, 80), accounts: Number(env.accounts) || 0 }
}

export function backupMeta(file: string): BackupMeta {
  return metaOf(file, readEnvelope(file))
}

// ---------- 只接受用户亲手选过的位置 ----------
// 备份里有全部邮箱的登录信息。写到哪里、从哪里读，只认系统的选择框里选过的、或者自动找到的云盘位置，
// 界面传来的其他路径一律不认。

const allowed = new Set<string>()
const norm = (p: string): string => resolve(p).toLowerCase().replace(/[\\/]+$/, '')
export function allowPath(p: string): void {
  if (p && isAbsolute(p)) allowed.add(norm(p))
}
function ensureAllowed(p: string): void {
  const cfg = getBackupConfig()
  if (cfg.folder) allowPath(cfg.folder)
  if (!p || !isAbsolute(p) || !(allowed.has(norm(p)) || allowed.has(norm(dirname(p))))) {
    throw new Error('请用「选择文件夹」或「选择文件」重新选一次')
  }
}

export function backupInfo(): BackupInfo {
  const cfg = getBackupConfig()
  const file = cfg.folder ? join(cfg.folder, BACKUP_FILE) : ''
  let last: BackupMeta | null = null
  if (file && existsSync(file)) {
    try {
      last = backupMeta(file)
    } catch {
      last = null
    }
  }
  const hasPassword = !!getBackupKey()
  const error = cfg.enabled && !hasPassword ? '备份密码丢失了，请重新设置一次备份密码' : lastError
  return { enabled: cfg.enabled, folder: cfg.folder, hasPassword, last, thisDevice: hostname(), error }
}

let lastError = ''
let timer: NodeJS.Timeout | null = null
let suspended = false

/** 文件夹里现有的备份如果是别的电脑写的、而且比这台电脑知道的更新，就返回它 */
function newerFromElsewhere(folder: string, knownAt: number): BackupMeta | null {
  const file = join(folder, BACKUP_FILE)
  if (!existsSync(file)) return null
  try {
    const m = backupMeta(file)
    return m.device !== hostname() && m.savedAt > knownAt ? m : null
  } catch {
    return null
  }
}

/**
 * 写一份备份。
 * 自动备份（force=false）：没开启就不写；内容和上次一样就不写；发现别的电脑写了更新的备份也不写（免得两台电脑互相覆盖）。
 * 手动（force=true）：一定写，写不成就报错。
 */
export function writeBackup(force = false): boolean {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const cfg = getBackupConfig()
  const saved = getBackupKey()
  if (!cfg.enabled && !force) return false
  if (!cfg.folder || !saved) {
    const why = !cfg.folder ? '还没有选择备份放在哪里' : '备份密码丢失了，请重新设置一次备份密码'
    if (force) throw new Error(why)
    lastError = why
    return false
  }
  try {
    const store = exportStore()
    const payload: Payload = { ...store, state: getData() }
    const text = JSON.stringify(payload)
    const hash = createHash('sha256').update(saved.salt).update(text).digest('hex')
    const file = join(cfg.folder, BACKUP_FILE)
    if (!force) {
      // 内容没变（比如只是登录令牌例行刷新）就不重写，云盘不用白白再传一遍
      if (hash === cfg.lastHash && existsSync(file)) return false
      const other = newerFromElsewhere(cfg.folder, cfg.lastSavedAt ?? 0)
      if (other) {
        lastError = `电脑「${other.device}」在这之后更新过备份，为了不覆盖它，这台电脑暂停了自动备份。确认要用这台电脑的内容时，点「立即备份」。`
        return false
      }
    }
    const key = Buffer.from(saved.key, 'base64')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    const env: Envelope = {
      app: 'bluebird-backup',
      v: 1,
      savedAt: Date.now(),
      device: hostname(),
      accounts: store.accounts.length,
      kdf: 'scrypt',
      n: SCRYPT_N,
      salt: saved.salt,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    }
    if (!existsSync(cfg.folder)) mkdirSync(cfg.folder, { recursive: true })
    // 先写临时文件再替换，云盘不会同步到写了一半的文件
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(env), 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      // 云盘客户端正占着旧文件时改名会失败，退一步直接覆盖，再把临时文件清掉
      writeFileSync(file, JSON.stringify(env), 'utf8')
      rmSync(tmp, { force: true })
    }
    lastError = ''
    // 记下这次写的是什么：下次内容没变就跳过，也用来判断别的电脑有没有在这之后写过
    suspended = true
    try {
      setBackupConfig({ ...getBackupConfig(), lastSavedAt: env.savedAt, lastHash: hash })
    } finally {
      suspended = false
    }
    return true
  } catch (err) {
    lastError = (err as Error).message
    console.warn('写备份失败', lastError)
    if (force) throw new Error(`备份没有写成功：${lastError}`)
    return false
  }
}

/** 数据有变化：过一会儿自动备份一次（连续改动只写一次） */
function scheduleBackup(): void {
  if (suspended || timer || !getBackupConfig().enabled) return
  timer = setTimeout(() => {
    timer = null
    writeBackup()
  }, 15000)
}

/** 退出前把还没写的那一次补上 */
export function flushBackup(): void {
  if (timer) writeBackup()
}

export function initBackup(): void {
  onJsonWritten((file) => {
    if (/(config|secrets|state)\.json$/.test(file)) scheduleBackup()
  })
}

function checkPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 6) throw new Error('备份密码至少要 6 位')
}

// 用户已经看过「这里有别的电脑的备份」的提醒、第二次点确认时放行
let overwriteArmed = ''

/** 开启自动备份（或更换文件夹、更换密码）。已经设过密码时可以不传 password */
export function enableBackup(folder: string, password?: string): BackupInfo {
  if (!folder) throw new Error('请先选择备份放在哪里')
  ensureAllowed(folder)
  // 选的是「云盘\Bluebird」这样还不存在的子文件夹时，替用户建好
  if (!existsSync(folder) && existsSync(dirname(folder))) mkdirSync(folder, { recursive: true })
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error('这个文件夹不存在，请重新选择')
  if (password) checkPassword(password)
  else if (!getBackupKey()) throw new Error('请先设置备份密码')

  // 这个位置已经有另一台电脑的备份：直接开启会把它覆盖掉。先提醒一次，再点才真的覆盖
  const cfg = getBackupConfig()
  const other = newerFromElsewhere(folder, norm(folder) === norm(cfg.folder || '') ? cfg.lastSavedAt ?? 0 : 0)
  if (other && overwriteArmed !== norm(folder)) {
    overwriteArmed = norm(folder)
    throw new Error(
      `这里已经有电脑「${other.device}」的备份（共 ${other.accounts} 个邮箱）。想把它恢复到这台电脑，请用「从备份恢复」；确定要用这台电脑的内容覆盖它，请再点一次。`
    )
  }
  overwriteArmed = ''

  if (password) {
    const salt = randomBytes(16)
    setBackupKey({ key: derive(password, salt).toString('base64'), salt: salt.toString('base64') })
  }
  const before = getBackupConfig()
  setBackupConfig({ enabled: true, folder })
  try {
    writeBackup(true)
  } catch (err) {
    // 新位置写不进去：配置退回原样，界面上显示的和实际的保持一致
    setBackupConfig(before)
    throw err
  }
  return backupInfo()
}

export function disableBackup(): BackupInfo {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  setBackupConfig({ ...getBackupConfig(), enabled: false })
  return backupInfo()
}

/**
 * 从备份文件恢复：替换这台电脑上现有的账号、设置和登录信息。
 * 中途任何一步失败，都退回恢复之前的样子。
 */
export function restoreBackup(file: string, password: string): { accounts: number } {
  ensureAllowed(file)
  const env = readEnvelope(file)
  let key: Buffer
  let payload: Payload
  try {
    key = derive(String(password ?? ''), Buffer.from(env.salt, 'base64'))
    const iv = Buffer.from(env.iv, 'base64')
    if (iv.length !== 12) throw new Error('bad iv')
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
    const text = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8')
    payload = JSON.parse(text) as Payload
  } catch {
    throw new Error('密码不正确，或者备份文件已经损坏')
  }
  if (!payload || !Array.isArray(payload.accounts) || !payload.settings) throw new Error('备份文件的内容不完整')

  // 备份里的定时邮件不能一恢复就自动发出去：原来那台电脑可能已经发过了，或者还开着、到点也会发。
  // 全部先停住，由用户在「定时发送」里确认。已经过了时间的「稍后处理」直接丢掉，免得把旧邮件又标成未读
  const now = Date.now()
  const state: Partial<UserData> = { ...(payload.state || {}) }
  if (Array.isArray(state.scheduled)) {
    // 备份时正好处在「撤销发送」那几秒里的邮件不带过来：它的内容在草稿里，原来那台电脑也已经把它发出去了
    state.scheduled = state.scheduled.filter((s) => !s.undo).map((s) => ({
      ...s,
      held: true,
      error: '这封定时邮件是从备份恢复的。如果原来那台电脑没有发出它，点「立即发送」；否则请取消。',
      retryAt: undefined,
      tries: 0
    }))
  }
  if (state.snoozed && typeof state.snoozed === 'object') {
    state.snoozed = Object.fromEntries(Object.entries(state.snoozed).filter(([, v]) => v && v.until > now))
  }

  const snap = snapshotStore()
  const oldState = getData()
  suspended = true
  try {
    importStore({ settings: payload.settings, accounts: payload.accounts, secrets: payload.secrets || {} })
    replaceData(state)
    setBackupKey({ key: key.toString('base64'), salt: env.salt })
    // 是从正式的备份文件恢复的，就接着往同一个位置自动备份；选的是别处的副本（比如 U 盘里的）则保持原来的备份设置
    if (basename(file) === BACKUP_FILE) {
      setBackupConfig({ enabled: true, folder: dirname(file), lastSavedAt: Number(env.savedAt) || 0, lastHash: '' })
    }
    dropStateBackup()
  } catch (err) {
    try {
      rollbackStore(snap)
      replaceData(oldState)
    } catch (err2) {
      console.error('恢复失败后没能退回原样', err2)
    }
    // touched：已经动过本机的数据（哪怕又退回去了），调用方需要把连接和界面重新来一遍
    throw Object.assign(new Error(`恢复没有完成，已经退回原来的状态：${(err as Error).message}`), { touched: true })
  } finally {
    suspended = false
  }
  return { accounts: payload.accounts.length }
}

// ---------- 自动找出这台电脑上的云盘同步文件夹 ----------

/** 是不是一个文件夹。断开的网络盘之类会卡很久，所以限时，超时就当它不存在 */
async function isDir(p: string): Promise<boolean> {
  if (!p) return false
  try {
    const st = await Promise.race([stat(p), new Promise<null>((r) => setTimeout(() => r(null), 800))])
    return !!st && st.isDirectory()
  } catch {
    return false
  }
}

/** 常见云盘在 Windows 上的同步文件夹。找到的才返回，路径不重复 */
async function cloudFolders(): Promise<{ name: string; path: string }[]> {
  const home = homedir()
  const env = process.env
  const candidates: [string, string | undefined][] = [
    ['OneDrive', env.OneDriveConsumer || env.OneDrive],
    ['OneDrive（工作或学校）', env.OneDriveCommercial],
    ['iCloud 云盘', join(home, 'iCloudDrive')],
    ['Dropbox', join(home, 'Dropbox')],
    ['坚果云', join(home, 'Nutstore Files', '我的坚果云')],
    ['坚果云', join(home, 'Nutstore', '我的坚果云')],
    ['百度网盘同步空间', join(home, 'BaiduSyncdisk')],
    ['Google 云端硬盘', join(home, 'Google Drive')],
    ['Google 云端硬盘', join(home, 'My Drive')]
  ]
  // 有些云盘装在别的盘符下，或者自己就是一个盘符（Google 云端硬盘默认是 G:）
  if (process.platform === 'win32') {
    const roots = await Promise.all([...'CDEFGHIJ'].map(async (l) => ((await isDir(`${l}:\\`)) ? `${l}:\\` : '')))
    for (const root of roots.filter(Boolean)) {
      candidates.push(
        ['坚果云', join(root, '我的坚果云')],
        ['坚果云', join(root, 'Nutstore', '我的坚果云')],
        ['百度网盘同步空间', join(root, 'BaiduSyncdisk')],
        ['Google 云端硬盘', join(root, '我的云端硬盘')],
        ['Google 云端硬盘', join(root, 'My Drive')],
        ['OneDrive', join(root, 'OneDrive')]
      )
    }
  }
  const ok = await Promise.all(candidates.map(([, p]) => isDir(p || '')))
  const out: { name: string; path: string }[] = []
  const seen = new Set<string>()
  candidates.forEach(([name, p], i) => {
    if (!ok[i] || !p) return
    const key = norm(p)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name, path: p })
  })
  return out
}

/** 设置页打开时用：列出找到的云盘，以及这些云盘里已经存在的备份（换了新电脑时可以直接恢复） */
export async function detectBackup(): Promise<BackupDetect> {
  const folders = await cloudFolders()
  const drives = folders.map((d) => ({ name: d.name, path: join(d.path, 'Bluebird') }))
  const found: (BackupMeta & { drive: string })[] = []
  const tried = new Set<string>()
  const look = (drive: string, file: string): void => {
    if (tried.has(norm(file)) || !existsSync(file)) return
    tried.add(norm(file))
    try {
      found.push({ ...backupMeta(file), drive })
    } catch {
      // 不是有效的备份文件（比如还没同步完）就略过
    }
  }
  for (const d of folders) {
    look(d.name, join(d.path, 'Bluebird', BACKUP_FILE))
    look(d.name, join(d.path, BACKUP_FILE))
  }
  const cfg = getBackupConfig()
  if (cfg.folder) look('当前的备份位置', join(cfg.folder, BACKUP_FILE))
  found.sort((a, b) => b.savedAt - a.savedAt)
  for (const d of drives) allowPath(d.path)
  for (const f of found) allowPath(f.file)
  return { drives, found }
}
