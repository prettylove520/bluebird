// 草稿同步到服务器：本机的草稿每改一次，就在对应邮箱服务器的「草稿」文件夹里存一份最新的，旧版本删掉；
// 草稿发出去了或者删掉了，服务器上的那份也删掉。这样手机、网页邮箱的草稿箱里也能看到写了一半的信。
// 只往服务器上传，不把服务器上的草稿拉回来（在手机上写的草稿，在「草稿」文件夹里照样能看到）。

import { app } from 'electron'
import { join } from 'path'
import type { LocalDraft } from '../shared/types'
import { readJsonSafe, writeJsonSafe } from './jsonfile'
import { getAccount, getSettings } from './store'
import { getData } from './userdata'
import { buildRaw } from './mail/smtp'
import { draftsFolder, dropDraft, putDraft } from './mail/service'

/** 每份草稿在服务器上的那一份：哪个邮箱、哪个文件夹、编号、对应本机的哪个版本 */
interface Mirror {
  accountId: string
  folder: string
  uid?: number
  savedAt: number
}

const file = (): string => join(app.getPath('userData'), 'draft-sync.json')
let mirrors: Record<string, Mirror> | null = null
const load = (): Record<string, Mirror> => (mirrors ??= readJsonSafe<Record<string, Mirror>>(file(), {}))
const save = (): void => {
  try {
    writeJsonSafe(file(), load())
  } catch {
    // 记不下来的话，下次启动会把草稿重新传一遍，不会丢
  }
}

let timer: NodeJS.Timeout | undefined
let running = false
let again = false
/** 失败的草稿：过一会儿再试，免得网络不好时一直重试 */
const failedAt = new Map<string, number>()

export function syncEnabled(): boolean {
  return getSettings().compose.syncDrafts !== false
}

/** 草稿有变化时调用：等写信的人停下来几秒再传，免得每敲几个字就传一次 */
export function scheduleDraftSync(delay = 5000): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    void run()
  }, delay)
}

async function run(): Promise<void> {
  if (running) {
    again = true
    return
  }
  running = true
  try {
    await syncOnce()
  } finally {
    running = false
    if (again) {
      again = false
      scheduleDraftSync(1000)
    }
  }
}

function hasContent(d: LocalDraft): boolean {
  const text = d.html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
  return !!(d.to.trim() || d.cc.trim() || d.bcc.trim() || d.subject.trim() || text || d.attachments.length)
}

async function syncOnce(): Promise<void> {
  const m = load()
  const on = syncEnabled()
  // 正在撤销倒计时里的信：还没真正发出，草稿先不动，等发出去再一起删
  const queued = new Set(getData().scheduled.filter((x) => x.undo && x.draftId).map((x) => x.draftId))
  const drafts = on ? getData().drafts.filter((d) => hasContent(d) && !queued.has(d.id)) : []
  const want = new Map(drafts.map((d) => [d.id, d]))

  // 1. 本机已经没有的（发出去了、删掉了、关掉了同步）：删掉服务器上的那份
  for (const [id, mirror] of Object.entries(m)) {
    if (want.has(id) || queued.has(id)) continue
    const account = getAccount(mirror.accountId)
    try {
      if (account && mirror.uid) await dropDraft(account, mirror.folder, mirror.uid)
      delete m[id]
      save()
    } catch (err) {
      console.warn(`[草稿同步] 删除服务器上的旧草稿失败：${(err as Error).message}`)
    }
  }

  // 2. 新写的、改过的：存一份新的上去，再删旧的
  for (const d of drafts) {
    const mirror = m[d.id]
    if (mirror && mirror.savedAt === d.savedAt && mirror.accountId === d.accountId) continue
    const last = failedAt.get(d.id)
    if (last && Date.now() - last < 60000) {
      scheduleDraftSync(60000)
      continue
    }
    const account = getAccount(d.accountId)
    if (!account) continue
    try {
      const folder = await draftsFolder(account)
      if (!folder) continue
      const { raw, messageId } = await buildRaw(
        account,
        {
          accountId: d.accountId,
          to: d.to,
          cc: d.cc,
          bcc: d.bcc,
          subject: d.subject,
          html: d.html,
          text: '',
          attachments: d.attachments,
          inReplyTo: d.inReplyTo,
          references: d.references
        },
        { id: d.id, version: d.savedAt }
      )
      // 换了发件邮箱：旧邮箱里的那份单独删
      const sameBox = mirror && mirror.accountId === d.accountId && mirror.folder === folder
      const uid = await putDraft(account, folder, raw, messageId, sameBox ? mirror.uid : undefined)
      if (mirror && !sameBox && mirror.uid) {
        const old = getAccount(mirror.accountId)
        if (old) await dropDraft(old, mirror.folder, mirror.uid).catch(() => undefined)
      }
      m[d.id] = { accountId: d.accountId, folder, uid, savedAt: d.savedAt }
      save()
      failedAt.delete(d.id)
    } catch (err) {
      failedAt.set(d.id, Date.now())
      console.warn(`[草稿同步] ${account.email} 存草稿到服务器失败，过一会儿再试：${(err as Error).message}`)
      scheduleDraftSync(60000)
    }
  }
}
