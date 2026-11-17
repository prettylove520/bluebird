// 界面主体（App.tsx）用到的常量、类型和不依赖界面状态的小函数。
// 从 App.tsx 里拆出来，方便别的文件复用，也让 App.tsx 短一些

import type { MessageSummary, UserData } from '../../../shared/types'
import type { MenuItem } from '../components/ContextMenu'
import type { SettingsTab } from '../components/SettingsDialog'
import { escapeHtml } from '../utils'

/** accountId 为 ALL 时表示「所有收件箱」 */
export const ALL = '*'
/** 合并视图里 folder 的取值：INBOX 是所有收件箱，下面这两个是所有邮箱的已删除、已发送 */
export const ALL_TRASH = '@trash'
export const ALL_SENT = '@sent'
export const ALL_DRAFTS = '@drafts'
export const UNIFIED_USE: Record<string, 'trash' | 'sent' | 'drafts'> = { [ALL_TRASH]: 'trash', [ALL_SENT]: 'sent', [ALL_DRAFTS]: 'drafts' }
/** 「稍后处理」是一个虚拟视图，里面是被推迟的邮件 */
export const SNOOZED = '~snoozed'
/** 「已置顶」也是虚拟视图 */
export const PINNED = '~pinned'
export const isVirtual = (id?: string): boolean => id === SNOOZED || id === PINNED

export const EMPTY_DATA: UserData = {
  pinned: {},
  snoozed: {},
  priority: [],
  blocked: [],
  templates: [],
  quickReplies: [],
  scheduled: [],
  drafts: [],
  accepted: [],
  rules: [],
  invites: {}
}

/** 邮件的键是「账号|文件夹|UID」，文件夹名里可能也有竖线，所以从两头拆 */
export function parseKey(key: string): MsgRef {
  const first = key.indexOf('|')
  const last = key.lastIndexOf('|')
  return { accountId: key.slice(0, first), folder: key.slice(first + 1, last), uid: Number(key.slice(last + 1)) }
}

export const senderOf = (m: { from: { address: string }[] }): string => (m.from[0]?.address || '').toLowerCase()

export interface View {
  accountId: string
  folder: string
}

export interface MsgRef {
  accountId: string
  folder: string
  uid: number
}

export interface Toast {
  id: number
  text: string
  /** undo：撤销发送；op：刚做的删除、归档、移动，可以撤销 */
  kind: 'ok' | 'error' | 'mail' | 'undo' | 'op' | 'update'
  /** 新邮件提示用：上面一行是发件人，点一下打开这封信 */
  title?: string
  onClick?: () => void
  /** 撤销发送用：等几秒、是哪一封 */
  seconds?: number
  sendId?: string
}

/** 搜索范围：all 是所有邮箱的所有文件夹，here 只搜当前打开的这个文件夹 */
export type SearchScope = 'all' | 'here'

export type DialogState = { kind: 'add' } | { kind: 'settings'; tab?: SettingsTab } | null

/** 一封邮件的引用；带上已读/星标状态时可以做「切换」类操作 */
export type Target = MsgRef & { seen?: boolean; flagged?: boolean }

export interface MenuState {
  x: number
  y: number
  title?: string
  items: MenuItem[]
}

export interface ConfirmState {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
}

export const keyOf = (m: MsgRef): string => `${m.accountId}|${m.folder}|${m.uid}`
export const groupOf = (m: MsgRef): string => `${m.accountId}|${m.folder}`
export const textToQuote = (text: string): string => escapeHtml(text).replace(/\r?\n/g, '<br>')
export const byDateDesc = (a: MessageSummary, b: MessageSummary): number => b.date.localeCompare(a.date)
/** 一批邮件里最早的时间，没有邮件时是空字符串 */
export const oldestDate = (list: MessageSummary[]): string => list.reduce((min, m) => (!min || m.date < min ? m.date : min), '')

/** 静默刷新：用新取到的第一页替换旧数据，同时保留每个文件夹已经加载的更早邮件 */
export function mergeFresh(fresh: MessageSummary[], prev: MessageSummary[], sortByDate: boolean, refreshed?: string[]): MessageSummary[] {
  const freshKeys = new Set(fresh.map(keyOf))
  const minUid = new Map<string, number>()
  const maxUid = new Map<string, number>()
  for (const m of fresh) {
    minUid.set(groupOf(m), Math.min(minUid.get(groupOf(m)) ?? Infinity, m.uid))
    maxUid.set(groupOf(m), Math.max(maxUid.get(groupOf(m)) ?? 0, m.uid))
  }
  const recent = Date.now() - 15 * 60 * 1000
  // refreshed：这次真正从服务器取到了的「账号|文件夹」。没取到的（比如那个账号暂时连不上）原样保留，不能让它的邮件凭空消失
  const got = refreshed ? new Set(refreshed) : null
  // 比服务器这次给的最新一封还新、又是刚到的：多半是新邮件提醒刚插进来、服务器那份列表慢了一步，先留着（放在最前面）
  const newer = prev.filter((m) => {
    if (freshKeys.has(keyOf(m))) return false
    const max = maxUid.get(groupOf(m))
    return max !== undefined && m.uid > max && Date.parse(m.date) > recent
  })
  const newerKeys = new Set(newer.map(keyOf))
  const older = prev.filter((m) => {
    if (freshKeys.has(keyOf(m)) || newerKeys.has(keyOf(m))) return false
    if (got && !got.has(groupOf(m))) return true
    const min = minUid.get(groupOf(m))
    return min !== undefined && m.uid < min
  })
  const merged = [...newer, ...fresh, ...older]
  return sortByDate ? merged.sort(byDateDesc) : merged
}

// 公共邮箱的域名，不提供「屏蔽整个域名」
export const FREE_MAIL_DOMAIN =
  /^(qq|vip\.qq|foxmail|163|126|yeah|139|189|sina|sohu|aliyun|gmail|googlemail|outlook|hotmail|live|msn|icloud|me|yahoo|proton|protonmail)\.(com|cn|net|me|com\.cn)$/i

// 列表没填满时最多自动往前补几页（每页 50 封）
export const AUTO_LOAD_LIMIT = 8
