// 本机保存的「用户数据」：置顶、稍后处理、重要/屏蔽发件人、模板、定时发送队列
// 这些都是 Bluebird 自己的功能，不会同步到邮箱服务器，存在 state.json 里

import { app } from 'electron'
import { rmSync } from 'fs'
import { readJsonSafe, writeJsonSafe } from './jsonfile'
import { join } from 'path'
import type { UserData } from '../shared/types'

const defaults: UserData = {
  pinned: {},
  snoozed: {},
  priority: [],
  blocked: [],
  templates: [],
  quickReplies: ['收到，谢谢。', '好的，没问题。', '我看一下，稍后回复你。'],
  scheduled: [],
  drafts: [],
  accepted: [],
  rules: [],
  invites: {}
}

let data: UserData | null = null

const file = (): string => join(app.getPath('userData'), 'state.json')

export function getData(): UserData {
  if (!data) {
    const raw = readJsonSafe<Partial<UserData>>(file(), {})
    data = { ...defaults, ...raw }
  }
  return data
}

function persist(): void {
  writeJsonSafe(file(), data)
}

/** 用给定的字段覆盖对应部分，返回更新后的完整数据 */
export function updateData(patch: Partial<UserData>): UserData {
  data = { ...getData(), ...patch }
  persist()
  return data
}

/** 删除账号时，把属于它的置顶、推迟和定时邮件一起清掉 */
export function forgetAccountData(accountId: string): UserData {
  const d = getData()
  const keep = <T>(map: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(map).filter(([k]) => !k.startsWith(accountId + '|')))
  return updateData({
    pinned: keep(d.pinned),
    snoozed: keep(d.snoozed),
    scheduled: d.scheduled.filter((s) => s.message.accountId !== accountId),
    drafts: d.drafts.filter((x) => x.accountId !== accountId)
  })
}

/** 文件夹改名或删除后，里面邮件的置顶、推迟记录都对不上了，清掉 */
export function forgetFolderData(accountId: string, folder: string): UserData {
  const d = getData()
  const prefix = `${accountId}|${folder}|`
  const keep = <T>(map: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(map).filter(([k]) => !k.startsWith(prefix)))
  return updateData({ pinned: keep(d.pinned), snoozed: keep(d.snoozed) })
}

/** 从备份恢复时整体替换 */
export function replaceData(next: Partial<UserData>): UserData {
  data = { ...defaults, ...next }
  persist()
  return data
}

/** 恢复之后，旧的 state.json.bak 里还是恢复前的草稿和定时邮件，删掉它免得以后被当成备份带回来 */
export function dropStateBackup(): void {
  try {
    rmSync(file() + '.bak', { force: true })
  } catch {
    // 删不掉就等下次保存时被覆盖
  }
}
