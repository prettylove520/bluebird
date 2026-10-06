// 本地缓存：把文件夹列表、每个文件夹最新一页邮件、正文摘要和读过的邮件正文存到磁盘
// 作用：启动和切换文件夹时先显示缓存，再在后台向服务器要最新的；断网时也能看已经缓存的内容
// 位置：数据文件夹下的 cache 目录，按账号分开。附件不缓存，需要时再下载

import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import type { Folder, MessageDetail, MessagePage } from '../shared/types'

const MAX_DETAILS_PER_ACCOUNT = 400
const MAX_DETAIL_BYTES = 3 * 1024 * 1024

const root = (): string => join(app.getPath('userData'), 'cache')

function dirFor(accountId: string, sub: string): string {
  const d = join(root(), accountId.replace(/[^a-zA-Z0-9-]/g, '_'), sub)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

const hash = (s: string): string => createHash('sha1').update(s).digest('hex')

function read<T>(file: string): T | undefined {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 写缓存失败不影响任何功能，所以只记一条日志 */
function write(file: string, data: unknown): void {
  writeFile(file, JSON.stringify(data), 'utf8').catch((err) => console.warn('写缓存失败', (err as Error).message))
}

export function getCachedFolders(accountId: string): Folder[] | undefined {
  return read<Folder[]>(join(dirFor(accountId, ''), 'folders.json'))
}

export function putCachedFolders(accountId: string, folders: Folder[]): void {
  write(join(dirFor(accountId, ''), 'folders.json'), folders)
}

export function getCachedList(accountId: string, folder: string): MessagePage | undefined {
  return read<MessagePage>(join(dirFor(accountId, 'lists'), hash(folder) + '.json'))
}

export function putCachedList(accountId: string, folder: string, page: MessagePage): void {
  write(join(dirFor(accountId, 'lists'), hash(folder) + '.json'), page)
}

const detailFile = (accountId: string, folder: string, uid: number): string =>
  join(dirFor(accountId, 'mails'), hash(`${folder}|${uid}`) + '.json')

export function getCachedDetail(accountId: string, folder: string, uid: number): MessageDetail | undefined {
  return read<MessageDetail>(detailFile(accountId, folder, uid))
}

let writesSincePrune = 0

export function putCachedDetail(detail: MessageDetail): void {
  const json = JSON.stringify(detail)
  // 特别大的邮件（通常是内嵌了很多图片）不缓存
  if (json.length > MAX_DETAIL_BYTES) return
  writeFile(detailFile(detail.accountId, detail.folder, detail.uid), json, 'utf8').catch(() => undefined)
  if (++writesSincePrune >= 50) {
    writesSincePrune = 0
    prune(detail.accountId)
  }
}

/** 正文缓存太多时，删掉最久没动过的 */
function prune(accountId: string): void {
  try {
    const dir = dirFor(accountId, 'mails')
    const files = readdirSync(dir).map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs }))
    if (files.length <= MAX_DETAILS_PER_ACCOUNT) return
    files.sort((a, b) => a.time - b.time)
    for (const f of files.slice(0, files.length - MAX_DETAILS_PER_ACCOUNT)) unlinkSync(join(dir, f.name))
  } catch {
    // 清理失败无所谓
  }
}

// ---------- 正文摘要 ----------

let previews: Record<string, string> | null = null
let previewTimer: NodeJS.Timeout | null = null
const previewFile = (): string => {
  if (!existsSync(root())) mkdirSync(root(), { recursive: true })
  return join(root(), 'previews.json')
}

export function loadPreviews(): Record<string, string> {
  if (!previews) previews = read<Record<string, string>>(previewFile()) || {}
  return previews
}

/** 摘要变化很频繁，攒几秒再一起写盘 */
export function savePreviews(map: Map<string, string>): void {
  if (previewTimer) return
  previewTimer = setTimeout(() => {
    previewTimer = null
    write(previewFile(), Object.fromEntries(map))
  }, 4000)
}

// ---------- 清理 ----------

export function clearCache(accountId?: string): void {
  try {
    if (accountId) rmSync(join(root(), accountId.replace(/[^a-zA-Z0-9-]/g, '_')), { recursive: true, force: true })
    else {
      rmSync(root(), { recursive: true, force: true })
      previews = {}
    }
  } catch (err) {
    console.warn('清除缓存失败', (err as Error).message)
  }
}

/** 缓存占了多少空间（字节） */
export function cacheSize(): number {
  const walk = (dir: string): number => {
    let total = 0
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      total += st.isDirectory() ? walk(p) : st.size
    }
    return total
  }
  try {
    return existsSync(root()) ? walk(root()) : 0
  } catch {
    return 0
  }
}
