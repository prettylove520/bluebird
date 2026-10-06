import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  InviteAnswer,
  Account,
  AppInfo,
  UpdateStatus,
  Folder,
  LocalDraft,
  MessageDetail,
  MessagePage,
  MessageSummary,
  NewMailEvent,
  OutgoingMessage,
  Preset,
  SendDoneEvent,
  Settings,
  UserData
} from '../../shared/types'
import { api } from './api'
import { AddAccountDialog } from './components/AddAccountDialog'
import { AttachmentViewer, canPreview, type ViewerState } from './components/AttachmentViewer'
import { PromptDialog } from './components/PromptDialog'
import { Composer, type ComposeInit } from './components/Composer'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ContextMenu, type MenuItem } from './components/ContextMenu'
import { DraftsDialog } from './components/DraftsDialog'
import { Icon } from './components/Icon'
import { CommandPalette, type Command } from './components/CommandPalette'
import { Home } from './components/Home'
import { MessageList, type BatchAction, type Bundle, type CategoryTab, type RowAction, type ThreadInfo } from './components/MessageList'
import { Rail, type RailTarget } from './components/Rail'
import { ScheduledDialog } from './components/ScheduledDialog'
import { TimeDialog } from './components/TimeDialog'
import { Reader } from './components/Reader'
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { groupByThread, threadKeys } from './threads'
import { TARGET_LANGS, langName, looksForeign, translateMail, type Translated } from './translate'
import {
  accountTags,
  aiMailOf,
  displayName,
  escapeHtml,
  formatAddress,
  friendlyTime,
  fullDate,
  joinAddresses,
  buildPrintDocument,
  mailAsText,
  prefixSubject,
  quoteHeader,
  sanitizeForQuote,
  timePresets
} from './utils'

/** accountId 为 ALL 时表示「所有收件箱」 */
export const ALL = '*'
/** 合并视图里 folder 的取值：INBOX 是所有收件箱，下面这两个是所有邮箱的已删除、已发送 */
export const ALL_TRASH = '@trash'
export const ALL_SENT = '@sent'
const UNIFIED_USE: Record<string, 'trash' | 'sent'> = { [ALL_TRASH]: 'trash', [ALL_SENT]: 'sent' }
/** 「稍后处理」是一个虚拟视图，里面是被推迟的邮件 */
export const SNOOZED = '~snoozed'
/** 「已置顶」也是虚拟视图 */
export const PINNED = '~pinned'
const isVirtual = (id?: string): boolean => id === SNOOZED || id === PINNED

const EMPTY_DATA: UserData = {
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
function parseKey(key: string): MsgRef {
  const first = key.indexOf('|')
  const last = key.lastIndexOf('|')
  return { accountId: key.slice(0, first), folder: key.slice(first + 1, last), uid: Number(key.slice(last + 1)) }
}

const senderOf = (m: { from: { address: string }[] }): string => (m.from[0]?.address || '').toLowerCase()

interface View {
  accountId: string
  folder: string
}

export interface MsgRef {
  accountId: string
  folder: string
  uid: number
}

interface Toast {
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
type SearchScope = 'all' | 'here'

type DialogState = { kind: 'add' } | { kind: 'settings'; tab?: SettingsTab } | null

/** 一封邮件的引用；带上已读/星标状态时可以做「切换」类操作 */
type Target = MsgRef & { seen?: boolean; flagged?: boolean }

interface MenuState {
  x: number
  y: number
  title?: string
  items: MenuItem[]
}

interface ConfirmState {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
}

export const keyOf = (m: MsgRef): string => `${m.accountId}|${m.folder}|${m.uid}`
const groupOf = (m: MsgRef): string => `${m.accountId}|${m.folder}`
const textToQuote = (text: string): string => escapeHtml(text).replace(/\r?\n/g, '<br>')
const byDateDesc = (a: MessageSummary, b: MessageSummary): number => b.date.localeCompare(a.date)
/** 一批邮件里最早的时间，没有邮件时是空字符串 */
const oldestDate = (list: MessageSummary[]): string => list.reduce((min, m) => (!min || m.date < min ? m.date : min), '')

/** 静默刷新：用新取到的第一页替换旧数据，同时保留每个文件夹已经加载的更早邮件 */
function mergeFresh(fresh: MessageSummary[], prev: MessageSummary[], sortByDate: boolean, refreshed?: string[]): MessageSummary[] {
  const freshKeys = new Set(fresh.map(keyOf))
  const minUid = new Map<string, number>()
  for (const m of fresh) minUid.set(groupOf(m), Math.min(minUid.get(groupOf(m)) ?? Infinity, m.uid))
  // refreshed：这次真正从服务器取到了的「账号|文件夹」。没取到的（比如那个账号暂时连不上）原样保留，不能让它的邮件凭空消失
  const got = refreshed ? new Set(refreshed) : null
  const older = prev.filter((m) => {
    if (freshKeys.has(keyOf(m))) return false
    if (got && !got.has(groupOf(m))) return true
    const min = minUid.get(groupOf(m))
    return min !== undefined && m.uid < min
  })
  const merged = [...fresh, ...older]
  return sortByDate ? merged.sort(byDateDesc) : merged
}

// 公共邮箱的域名，不提供「屏蔽整个域名」
const FREE_MAIL_DOMAIN =
  /^(qq|vip\.qq|foxmail|163|126|yeah|139|189|sina|sohu|aliyun|gmail|googlemail|outlook|hotmail|live|msn|icloud|me|yahoo|proton|protonmail)\.(com|cn|net|me|com\.cn)$/i

// 列表没填满时最多自动往前补几页（每页 50 封）
const AUTO_LOAD_LIMIT = 8

export default function App() {
  const [ready, setReady] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [folders, setFolders] = useState<Record<string, Folder[] | undefined>>({})
  const [folderErrors, setFolderErrors] = useState<Record<string, string | undefined>>({})
  const [view, setView] = useState<View | null>(null)
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<MessageDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [compose, setCompose] = useState<ComposeInit | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [checkedRaw, setChecked] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const lastChecked = useRef<string | null>(null)
  /** 多选模式：点邮件就是勾选 */
  const [multi, setMulti] = useState(false)
  const [data, setData] = useState<UserData>(EMPTY_DATA)
  const [tab, setTab] = useState<CategoryTab>('focus')
  const [home, setHome] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [timePick, setTimePick] = useState<{ title: string; confirmLabel: string; onPick: (ts: number) => void } | null>(null)
  const [showScheduled, setShowScheduled] = useState(false)
  const [palette, setPalette] = useState(false)
  const [showDrafts, setShowDrafts] = useState(false)
  const [homeImage, setHomeImage] = useState<string | null>(null)
  // 打开一个会话时，里面哪些邮件是刚才还没读的（读信页里给它们标个「新」）
  const [freshKeys, setFreshKeys] = useState<Set<string>>(new Set())
  const [searchScope, setSearchScope] = useState<SearchScope>('all')
  const scopeRef = useRef<SearchScope>('all')
  // 这次打开程序以来已经点过退订的发件人
  const [unsubscribed, setUnsubscribed] = useState<Set<string>>(new Set())
  const [unsubscribing, setUnsubscribing] = useState(false)
  // 正在回复哪个日历邀请（accepted / tentative / declined），空表示没有
  const [inviteBusy, setInviteBusy] = useState('')
  // 刚删除、归档、移动的邮件：先从列表里藏起来，过几秒才真正让服务器执行，这期间可以撤销
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  /** 最近一次在哪个邮箱里删除、归档、移动过邮件：在「所有收件箱」里点「已删除」时，优先看这个邮箱的 */
  const lastActed = useRef<string>('')
  const pendingOps = useRef(new Map<number, { timer: ReturnType<typeof setTimeout>; commit: () => void; undo: () => void }>())
  // 正在看的会话里，你自己发出去的回复（从「已发送」里找来的）。owner 是这个会话在列表里那一行的键
  const [extras, setExtras] = useState<{ owner: string; list: MessageSummary[] } | null>(null)
  const [sentTick, setSentTick] = useState(0)
  // 外观设置还没保存时的预览
  const [preview, setPreview] = useState<Settings | null>(null)
  const [prompt, setPrompt] = useState<{
    title: string
    message?: string
    initial?: string
    placeholder?: string
    confirmLabel: string
    onSubmit: (value: string) => Promise<void>
  } | null>(null)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  // 正在看的邮件的翻译：key 是哪一封；loading 正在翻，on 已经换成译文
  const [tr, setTr] = useState<{ key: string; state: 'loading' | 'on'; data?: Translated } | null>(null)
  const trCache = useRef(new Map<string, Translated>())
  const viewerReq = useRef(0)
  // 异步加载时要读到最新的本地数据
  const dataRef = useRef(data)
  dataRef.current = data

  const listReq = useRef(0)
  /** 列表上次从服务器更新的时间：窗口被切回来时据此决定要不要悄悄刷新一次 */
  const lastListAt = useRef(Date.now())
  const detailReq = useRef(0)
  const pendingOpen = useRef<MsgRef | null>(null)
  // 更新分三步，每一步都由用户决定：发现新版本（要不要下载）→ 下载中 → 下载好了（要不要马上重启安装）。
  // 提示一直挂在顶上，直到点了按钮或「以后再说」（以后再说只管这个版本的这一步，这次开着程序的时候）
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateLater, setUpdateLater] = useState('')
  const [updateBusy, setUpdateBusy] = useState(false)
  useEffect(() => {
    // 界面还没准备好的时候就发现了、下载好了的，也要看得到
    api.updateStatus().then(setUpdate).catch(() => undefined)
  }, [])
  /** 有新版本等着处理（发现了没下载，或者下载好了没安装） */
  const updateDue = update?.state === 'available' || update?.state === 'ready'
  const updateStep = update && (update.state === 'available' || update.state === 'downloading' || update.state === 'ready') ? `${update.state}${update.version ?? ''}` : ''
  // 提示挂一会儿就自己收起来（点「下载更新」后在下载的那几步也一样）；设置图标上的红点还在
  const hideAfter = Number(settings?.general.updateHideSeconds ?? 15)
  useEffect(() => {
    if (!updateStep || !(hideAfter > 0)) return
    const timer = setTimeout(() => setUpdateLater(updateStep), hideAfter * 1000)
    return () => clearTimeout(timer)
  }, [updateStep, hideAfter])
  const remoteAllowed = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const changeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const previewAsked = useRef(new Set<string>())
  // 「所有收件箱」里每个账号各自加载到了哪里
  // 列表没填满屏幕时自动往前补页的次数，换文件夹、换标签时清零
  const autoLoads = useRef(0)
  const loadingRef = useRef(false)
  // 单个文件夹已经翻到的最小序号。不能从列表里现算：置顶的旧邮件也在列表里，会让翻页一下子跳过中间一大段
  const pageSeq = useRef(0)
  // floor：这个账号已经完整取到的最早时间；stalled：上次翻页没连上，暂时不让它卡住别的账号
  const cursors = useRef<Record<string, { folder: string; minSeq: number; hasMore: boolean; floor: string; stalled?: boolean }>>({})

  // ---------- 提示 ----------
  const notify = (text: string, kind: 'ok' | 'error' = 'ok'): void => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3000)
  }

  // ---------- 数据加载 ----------
  const inboxPath = (accountId: string): string =>
    folders[accountId]?.find((f) => f.specialUse === 'inbox')?.path || 'INBOX'
  /** 「所有邮箱合在一起看」时，某个账号对应的真实文件夹；这个账号没有这种文件夹就返回 undefined */
  const unifiedFolder = (accountId: string, key: string): string | undefined => {
    const use = UNIFIED_USE[key]
    return use ? folders[accountId]?.find((f) => f.specialUse === use)?.path : inboxPath(accountId)
  }
  /** 合并视图要去取的每个账号的文件夹（没有对应文件夹的账号跳过） */
  const unifiedTargets = (key: string): { accountId: string; folder: string }[] =>
    accounts.flatMap((a) => {
      const folder = unifiedFolder(a.id, key)
      return folder ? [{ accountId: a.id, folder }] : []
    })

  // ---------- 列表里实际显示哪些邮件 ----------
  const snoozedView = view?.accountId === SNOOZED
  const pinnedView = view?.accountId === PINNED
  const virtualView = snoozedView || pinnedView
  const inboxView =
    !!view &&
    !virtualView &&
    ((view.accountId === ALL && !UNIFIED_USE[view.folder]) || (view.accountId !== ALL && view.folder === 'INBOX') || folders[view.accountId]?.find((f) => f.path === view.folder)?.specialUse === 'inbox')
  const smartInbox = !!settings?.reading.smartInbox && inboxView && !activeQuery
  /** 屏蔽名单里既可以是完整地址，也可以是「@域名」 */
  const isBlocked = (address: string): boolean =>
    data.blocked.includes(address) || data.blocked.includes('@' + (address.split('@')[1] || ''))
  /**
   * 「所有收件箱」是每个账号各取一页再按时间合并的。邮件多的账号一页只覆盖最近几天，
   * 邮件少的账号一页能覆盖几个月——如果全都显示，几天前的那一段看起来就像某个账号没来过信。
   * 所以只显示到「还没取完的账号里，已取到的最旧那封」为止，更早的等往下翻时一起补齐。
   */
  const waterline = ((): string => {
    if (view?.accountId !== ALL || activeQuery) return ''
    let line = ''
    for (const c of Object.values(cursors.current)) {
      // 已经取完的、暂时连不上的账号不参与：它们不应该挡住别的账号已经取回来的邮件
      if (!c.hasMore || c.minSeq <= 1 || c.stalled) continue
      if (c.floor > line) line = c.floor
    }
    return line
  })()
  const pinnedKeys = new Set(Object.keys(data.pinned))
  const prioritySet = new Set(data.priority)
  // 在所有邮箱里搜索时，结果里什么都列出来（包括推迟了的），不受当前所在文件夹的限制
  const globalSearch = !!activeQuery && (searchScope === 'all' || virtualView)
  const shown = messages.filter((m) => {
    if (hiddenKeys.size && hiddenKeys.has(keyOf(m))) return false
    if (globalSearch) return !isBlocked(senderOf(m))
    if (snoozedView) return !!data.snoozed[keyOf(m)]
    if (data.snoozed[keyOf(m)]) return false
    if (pinnedView && !data.pinned[keyOf(m)]) return false
    if (waterline && m.date < waterline && !data.pinned[keyOf(m)]) return false
    return !isBlocked(senderOf(m))
  })
  // 聚焦列表只列真人来信，通知和订阅折叠成一行；其他分类页只看那一类
  // 聚焦列表：真人来信全部列出；通知和订阅只有读过的才排进来，没读的折叠在顶上那一行里（点开就能看这一类的全部）
  const inTab =
    !smartInbox || tab === 'all'
      ? shown
      : tab === 'focus'
        ? shown.filter((m) => m.category === 'personal' || m.seen)
        : shown.filter((m) => m.category === tab)
  // ---------- 会话 ----------
  // 同一个话题来回的邮件合并成一行。搜索结果、「稍后处理」「已置顶」里不合并，一封是一封
  const threadsOn = settings?.reading.threads !== false && !activeQuery && !virtualView
  const threadIds = useMemo(() => threadKeys(messages), [messages])
  const groups = groupByThread(inTab, threadsOn ? threadIds : null)
  const groupPinned = (g: MessageSummary[]): boolean => g.some((m) => pinnedKeys.has(keyOf(m)))
  // 置顶的排在最前面（搜索结果和「稍后处理」里保持原来的顺序）
  const ordered = activeQuery || virtualView ? groups : [...groups.filter(groupPinned), ...groups.filter((g) => !groupPinned(g))]
  /** 列表里的每一行：一封邮件，或者一个会话里最新的那一封 */
  const visible = ordered.map((g) => g[0])
  /** 列表里这些行包含的所有邮件 */
  const flat = ordered.length === visible.length && ordered.every((g) => g.length === 1) ? visible : ordered.flat()
  /** 每封邮件属于哪个会话（会话里的邮件新的在前） */
  const threadMap = new Map<string, MessageSummary[]>()
  for (const g of ordered) for (const m of g) threadMap.set(keyOf(m), g)
  const threadOf = (ref: MsgRef): MessageSummary[] | undefined => threadMap.get(keyOf(ref))
  /** 把一批邮件换成它们所在的会话（去重） */
  const groupsOf = (refs: MsgRef[]): MsgRef[][] => {
    const seen = new Set<MsgRef[]>()
    const out: MsgRef[][] = []
    for (const r of refs) {
      const g: MsgRef[] = threadOf(r) ?? [r]
      // 没合并成会话的邮件各自是一组，不会重复
      if (g.length > 1) {
        if (seen.has(g)) continue
        seen.add(g)
      }
      out.push(g)
    }
    return out
  }
  /** 把一批邮件扩展成它们所在会话的全部邮件：在列表里对一行做删除、归档这些操作时，是对整个会话做 */
  const expand = (refs: MsgRef[]): MsgRef[] => {
    const gs = groupsOf(refs)
    return gs.every((g) => g.length === 1) ? refs : gs.flat()
  }
  // 正在看的如果是会话里「我发出去的回复」，它本身不在列表里：这时以它所属的那个会话为准
  // （它自己就是列表里的一行时——比如在「已发送」或搜索结果里点开它——就按普通邮件对待；它所属的会话已经不在列表里了也一样）
  const viewingSent =
    selectedKey != null &&
    !!extras &&
    !threadMap.has(selectedKey) &&
    threadMap.has(extras.owner) &&
    extras.list.some((m) => keyOf(m) === selectedKey)
  const anchorKey = viewingSent ? extras!.owner : selectedKey
  /** 正在看的邮件在列表里对应哪一行 */
  const selectedRow = anchorKey == null ? null : threadMap.get(anchorKey)?.[0]
  const selectedHeadKey = selectedRow ? keyOf(selectedRow) : anchorKey
  // 勾选只对还在列表里的行有效：新回复到了以后会话的「最新一封」会变，原来勾的那一行就不在了
  const checked = ((): Set<string> => {
    if (!checkedRaw.size) return checkedRaw
    const rows = new Set(visible.map(keyOf))
    for (const k of checkedRaw) if (!rows.has(k)) return new Set([...checkedRaw].filter((x) => rows.has(x)))
    return checkedRaw
  })()
  // 掉出列表的勾选直接清掉，免得那一行以后又回到列表时勾选突然冒出来
  useEffect(() => {
    if (checked !== checkedRaw) setChecked(checked)
  })

  const saveData = (patch: Partial<UserData>): void => {
    setData((d) => ({ ...d, ...patch }))
    api
      .updateData(patch)
      .then(setData)
      .catch((err) => notify((err as Error).message, 'error'))
  }

  const loadFolders = async (accountId: string): Promise<void> => {
    try {
      const list = await api.folders(accountId)
      setFolders((f) => ({ ...f, [accountId]: list }))
      setFolderErrors((e) => ({ ...e, [accountId]: undefined }))
    } catch (err) {
      setFolderErrors((e) => ({ ...e, [accountId]: (err as Error).message }))
    }
  }

  /** 后台补上列表里每封邮件的摘要 */
  const loadPreviews = (list: MessageSummary[], force = false): void => {
    if (!force && settings && !settings.reading.showPreview) return
    const groups = new Map<string, MessageSummary[]>()
    for (const m of list) {
      const k = keyOf(m)
      if (previewAsked.current.has(k)) continue
      previewAsked.current.add(k)
      const g = groupOf(m)
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(m)
    }
    for (const items of groups.values()) {
      const { accountId, folder } = items[0]
      for (let i = 0; i < items.length; i += 25) {
        const uids = items.slice(i, i + 25).map((m) => m.uid)
        api
          .previews(accountId, folder, uids)
          .then((res) => {
            setPreviews((p) => {
              const next = { ...p }
              for (const [uid, text] of Object.entries(res)) next[keyOf({ accountId, folder, uid: Number(uid) })] = text
              return next
            })
          })
          .catch(() => uids.forEach((uid) => previewAsked.current.delete(keyOf({ accountId, folder, uid }))))
      }
    }
  }

  /** 取第一页；「所有收件箱」会同时取每个账号的收件箱再按时间合并 */
  const fetchFirstPage = async (v: View, q: string, silent = false): Promise<MessagePage & { refreshed?: string[] }> => {
    if (isVirtual(v.accountId)) {
      // 置顶和推迟的邮件分散在各个文件夹里，按文件夹分组各取一次
      const keys = Object.keys(v.accountId === SNOOZED ? dataRef.current.snoozed : dataRef.current.pinned)
      const groups = new Map<string, MsgRef[]>()
      for (const key of keys) {
        const ref = parseKey(key)
        const g = `${ref.accountId}|${ref.folder}`
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(ref)
      }
      const results = await Promise.allSettled(
        [...groups.values()].map((refs) => api.listByUids(refs[0].accountId, refs[0].folder, refs.map((r) => r.uid)))
      )
      const list = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      if (v.accountId === SNOOZED) {
        const until = (m: MessageSummary): number => dataRef.current.snoozed[keyOf(m)]?.until ?? 0
        list.sort((a, b) => until(a) - until(b))
      } else list.sort(byDateDesc)
      return { messages: list, total: list.length, hasMore: false }
    }
    if (v.accountId !== ALL) {
      const page = await (q ? api.search(v.accountId, v.folder, q) : api.list(v.accountId, v.folder))
      return { ...page, refreshed: [groupOf({ accountId: v.accountId, folder: v.folder, uid: 0 })] }
    }
    const targets = unifiedTargets(v.folder).map((t) => ({ id: t.accountId, folder: t.folder }))
    const results = await Promise.allSettled(targets.map((t) => (q ? api.search(t.id, t.folder, q) : api.list(t.id, t.folder))))
    const merged: MessageSummary[] = []
    let sum = 0
    let failed = 0
    let firstError = ''
    const nextCursors: typeof cursors.current = {}
    const refreshed: string[] = []
    results.forEach((r, i) => {
      const t = targets[i]
      if (r.status === 'fulfilled') {
        refreshed.push(groupOf({ accountId: t.id, folder: t.folder, uid: 0 }))
        merged.push(...r.value.messages)
        sum += r.value.total
        nextCursors[t.id] = {
          folder: t.folder,
          minSeq: r.value.messages.length ? Math.min(...r.value.messages.map((m) => m.seq)) : 0,
          hasMore: !q && r.value.hasMore,
          floor: oldestDate(r.value.messages)
        }
      } else {
        failed++
        firstError ||= `${accounts.find((a) => a.id === t.id)?.email || ''}：${(r.reason as Error).message}`
      }
    })
    if (failed === results.length && failed > 0) throw new Error(firstError)
    // 后台自动刷新时不反复弹同一个错误
    if (failed && !silent) notify(firstError, 'error')
    if (silent) {
      // 后台刷新只是看看有没有新邮件：已经翻到哪一页要保留，否则「加载更早的邮件」会从头再来
      for (const [id, c] of Object.entries(nextCursors)) {
        const old = cursors.current[id]
        if (!old || old.folder !== c.folder) cursors.current[id] = c
        // 这次连上了，就不再算「暂时连不上」
        else if (old.stalled) cursors.current[id] = { ...old, stalled: false }
      }
    } else {
      cursors.current = nextCursors
    }
    return {
      messages: merged.sort(byDateDesc),
      total: sum,
      hasMore: Object.values(cursors.current).some((c) => c.hasMore),
      refreshed
    }
  }

  /** 置顶的邮件可能比较旧，不在最新一页里，单独取回来放进列表 */
  const loadPinnedExtras = async (v: View, have: MessageSummary[], reqId: number): Promise<void> => {
    const haveKeys = new Set(have.map(keyOf))
    const targets = v.accountId === ALL ? unifiedTargets(v.folder) : [v]
    const jobs: Promise<MessageSummary[]>[] = []
    for (const t of targets) {
      const uids = Object.keys(dataRef.current.pinned)
        .filter((k) => !haveKeys.has(k))
        .map(parseKey)
        .filter((r) => r.accountId === t.accountId && r.folder === t.folder)
        .map((r) => r.uid)
      if (uids.length) jobs.push(api.listByUids(t.accountId, t.folder, uids))
    }
    if (!jobs.length) return
    const extras = (await Promise.allSettled(jobs)).flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    if (reqId !== listReq.current || !extras.length) return
    setMessages((prev) => {
      const seen = new Set(prev.map(keyOf))
      return [...prev, ...extras.filter((m) => !seen.has(keyOf(m)))]
    })
  }

  const loadList = async (v: View, q: string, silent = false): Promise<void> => {
    if (!silent) {
      autoLoads.current = 0
      pageSeq.current = 0
      // 重新加载就从第一页算起；这次如果没连上，翻页位置也不能还停在上一次翻到的深处
      cursors.current = {}
    }
    // 静默刷新不抢占正在进行的正常加载
    const id = silent ? listReq.current : ++listReq.current
    if (!silent) {
      setListLoading(true)
      setListError(null)
    }
    // 先显示上次缓存的内容，再向服务器要最新的
    let fromCache = false
    if (!silent && !q && !isVirtual(v.accountId)) {
      const targets = v.accountId === ALL ? unifiedTargets(v.folder) : [v]
      const pages = await Promise.all(targets.map((t) => api.cachedList(t.accountId, t.folder).catch(() => null)))
      if (id !== listReq.current) return
      const cached = pages.flatMap((p) => p?.messages ?? [])
      if (cached.length) {
        fromCache = true
        setMessages(v.accountId === ALL ? cached.sort(byDateDesc) : cached)
      }
    }
    // 在所有邮箱里搜索：每个账号各搜各的，谁先回来先显示谁的
    if (q && (scopeRef.current === 'all' || isVirtual(v.accountId))) {
      if (silent) return
      setHasMore(false)
      setTotal(0)
      let got: MessageSummary[] = []
      let failed = 0
      let firstError = ''
      await Promise.all(
        accounts.map((a) =>
          api
            .searchAll(a.id, q)
            .then((p) => {
              if (id !== listReq.current) return
              const have = new Set(got.map(keyOf))
              got = [...got, ...p.messages.filter((m) => !have.has(keyOf(m)))].sort(byDateDesc)
              setMessages(got)
              setTotal(got.length)
            })
            .catch((err) => {
              failed++
              firstError ||= `${a.email}：${(err as Error).message}`
            })
        )
      )
      if (id !== listReq.current) return
      if (failed && failed === accounts.length) setListError(firstError)
      else if (failed) notify(`有 ${failed} 个邮箱没能搜索。${firstError}`, 'error')
      setListLoading(false)
      return
    }
    try {
      const page = await fetchFirstPage(v, q, silent)
      if (id !== listReq.current) return
      if (isVirtual(v.accountId)) {
        setMessages(page.messages)
        setHasMore(false)
      } else if (silent) {
        setMessages((prev) => mergeFresh(page.messages, prev, v.accountId === ALL, page.refreshed))
        setHasMore((h) => h || page.hasMore)
      } else {
        setMessages(page.messages)
        setHasMore(page.hasMore)
        if (v.accountId !== ALL) pageSeq.current = page.messages.length ? Math.min(...page.messages.map((m) => m.seq)) : 0
      }
      setTotal(page.total)
      lastListAt.current = Date.now()
      if (!q && !isVirtual(v.accountId)) void loadPinnedExtras(v, page.messages, id)
      const want = pendingOpen.current
      if (want) {
        pendingOpen.current = null
        const hit = page.messages.find((m) => keyOf(m) === keyOf(want))
        if (hit) {
          setFreshKeys((f) => (f.size ? new Set() : f))
          void select(hit, page.messages)
        }
      }
    } catch (err) {
      if (id === listReq.current && !silent) {
        // 有缓存可看时不整屏报错，只提示一下现在看到的不是最新的
        if (fromCache) notify(`没能连上服务器，现在显示的是上次的内容。${(err as Error).message}`, 'error')
        else setListError((err as Error).message)
      }
    } finally {
      if (id === listReq.current && !silent) setListLoading(false)
    }
  }

  const loadMore = async (auto = false): Promise<void> => {
    // loadingRef：同一瞬间来两次调用（界面刷新和尺寸变化各触发一次）时，第二次直接不算
    if (!view || virtualView || activeQuery || loadingMore || loadingRef.current || !hasMore || !messages.length) return
    loadingRef.current = true
    // 自动补页有上限：某个分类确实没几封信时，不能把整个邮箱都翻一遍
    if (auto) {
      if (autoLoads.current >= AUTO_LOAD_LIMIT) {
        loadingRef.current = false
        return
      }
      autoLoads.current++
    } else {
      autoLoads.current = 0
    }
    const id = listReq.current
    setLoadingMore(true)
    try {
      let more: MessageSummary[] = []
      let stillMore = false
      if (view.accountId === ALL) {
        const all = Object.entries(cursors.current).filter(([, c]) => c.hasMore && c.minSeq > 1)
        // 上次没连上的账号先放一边；如果剩下的全是没连上的，就再试它们
        const live = all.filter(([, c]) => !c.stalled)
        const pending = live.length ? live : all
        // 只需要给「卡住时间线」的那个账号翻页（它已取到的最早时间最晚）；其他账号手里的旧邮件还够用，不必每次都去取
        const newest = pending.reduce((a, [, c]) => (c.floor > a ? c.floor : a), '')
        const entries = pending.filter(([, c]) => !c.floor || c.floor === newest)
        // 一个账号暂时连不上，不应该让其他账号也翻不了页
        const results = await Promise.allSettled(entries.map(([acc, c]) => api.list(acc, c.folder, c.minSeq)))
        if (id !== listReq.current) return
        let firstError = ''
        results.forEach((r, i) => {
          const [acc, c] = entries[i]
          if (r.status !== 'fulfilled') {
            firstError ||= (r.reason as Error).message
            cursors.current[acc] = { ...c, stalled: true }
            return
          }
          const p = r.value
          more.push(...p.messages)
          const minSeq = p.messages.length ? Math.min(...p.messages.map((m) => m.seq)) : c.minSeq
          // 翻了一页却没有往前走，说明这个账号已经到头了；不这样判断的话它会一直卡着时间线
          const pageFloor = oldestDate(p.messages)
          cursors.current[acc] = {
            ...c,
            minSeq,
            hasMore: p.hasMore && minSeq < c.minSeq,
            floor: pageFloor && (!c.floor || pageFloor < c.floor) ? pageFloor : c.floor,
            stalled: false
          }
        })
        if (firstError && !auto) notify(firstError, 'error')
        stillMore = Object.values(cursors.current).some((c) => c.hasMore && c.minSeq > 1)
      } else {
        const minSeq = pageSeq.current || Math.min(...messages.map((m) => m.seq))
        const p = await api.list(view.accountId, view.folder, minSeq)
        if (id !== listReq.current) return
        if (p.messages.length) pageSeq.current = Math.min(...p.messages.map((m) => m.seq))
        more = p.messages
        stillMore = p.hasMore
      }
      setMessages((prev) => {
        const seen = new Set(prev.map(keyOf))
        const merged = [...prev, ...more.filter((m) => !seen.has(keyOf(m)))]
        return view.accountId === ALL ? merged.sort(byDateDesc) : merged
      })
      setHasMore(stillMore)
    } catch (err) {
      notify((err as Error).message, 'error')
    } finally {
      loadingRef.current = false
      setLoadingMore(false)
    }
  }

  const selectFolder = (accountId: string, folder: string, open?: MsgRef): void => {
    const v = { accountId, folder }
    pendingOpen.current = open ?? null
    setView(v)
    setQuery('')
    setActiveQuery('')
    detailReq.current++
    setSelectedKey(null)
    setDetail(null)
    setDetailError(null)
    setMessages([])
    setHasMore(false)
    setChecked(new Set())
    setMulti(false)
    lastChecked.current = null
    setFreshKeys((f) => (f.size ? new Set() : f))
    setExtras(null)
    setTab('focus')
    setHome(false)
    setDrawer(false)
    void loadList(v, '')
  }

  const goInbox = (): void => {
    if (accounts.length > 1) selectFolder(ALL, 'INBOX')
    else if (accounts.length) selectFolder(accounts[0].id, inboxPath(accounts[0].id))
  }

  /** 图标栏上的「草稿、已发送、已删除」指的是当前账号的对应文件夹 */
  const activeAccountId = (): string | undefined =>
    view && accounts.some((a) => a.id === view.accountId)
      ? view.accountId
      : detail?.accountId ?? (accounts.some((a) => a.id === lastActed.current) ? lastActed.current : undefined) ?? accounts[0]?.id

  const onRail = (t: RailTarget): void => {
    setDrawer(false)
    if (t === 'home') {
      setHome(true)
      return
    }
    if (t === 'inbox') return goInbox()
    if (t === 'pinned' || t === 'snoozed') return selectFolder(t === 'pinned' ? PINNED : SNOOZED, '')
    // 写信时自动保存的草稿在本机；有的话先列出来
    if (t === 'drafts' && data.drafts.some((d) => !data.scheduled.some((x) => x.undo && x.draftId === d.id))) {
      setShowDrafts(true)
      return
    }
    // 有好几个邮箱：已删除、已发送把所有邮箱的合在一起看（每封信上标着是哪个邮箱的）
    if (accounts.length > 1 && (t === 'trash' || t === 'sent')) return selectFolder(ALL, t === 'trash' ? ALL_TRASH : ALL_SENT)
    const id = activeAccountId()
    const f = id ? folders[id]?.find((x) => x.specialUse === t) : undefined
    if (id && f) {
      selectFolder(id, f.path)
      // 有好几个邮箱、又是从「所有收件箱」过来的：告诉他现在看的是哪个邮箱的，别的邮箱在「全部账号和文件夹」里
      if (accounts.length > 1 && !(view && accounts.some((a) => a.id === view.accountId))) {
        const email = accounts.find((a) => a.id === id)?.email
        if (email) notify(`现在看的是 ${email} 的${t === 'trash' ? '已删除' : t === 'sent' ? '已发送' : '草稿箱'}。其他邮箱的在左边「全部账号和文件夹」里`)
      }
    } else notify('这个邮箱没有对应的文件夹', 'error')
  }

  // ---------- 草稿 ----------
  const saveDraft = (d: LocalDraft): void => {
    saveData({ drafts: [d, ...dataRef.current.drafts.filter((x) => x.id !== d.id)] })
  }
  const discardDraft = (id: string): void => {
    if (dataRef.current.drafts.some((x) => x.id === id)) saveData({ drafts: dataRef.current.drafts.filter((x) => x.id !== id) })
  }
  const openDraft = (d: LocalDraft, error?: string): void => {
    setShowDrafts(false)
    setCompose({
      error,
      mode: d.mode,
      accountId: accounts.some((a) => a.id === d.accountId) ? d.accountId : accounts[0].id,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      bodyHtml: '',
      rawHtml: d.html,
      draftId: d.id,
      attachments: d.attachments,
      inReplyTo: d.inReplyTo,
      references: d.references,
      replyTo: d.replyTo
    })
  }

  /** 整屏阅读时回到列表 */
  const closeReader = (): void => {
    pendingOpen.current = null
    detailReq.current++
    setSelectedKey(null)
    setDetail(null)
    setDetailError(null)
  }

  const adjustUnseen = (ref: MsgRef, delta: number): void => {
    setFolders((prev) => ({
      ...prev,
      [ref.accountId]: prev[ref.accountId]?.map((f) =>
        f.path === ref.folder ? { ...f, unseen: Math.max(0, f.unseen + delta) } : f
      )
    }))
  }

  const patchMessage = (ref: MsgRef, patch: Partial<MessageSummary>): void => {
    const k = keyOf(ref)
    setMessages((list) => list.map((m) => (keyOf(m) === k ? { ...m, ...patch } : m)))
  }

  // 提前把可能马上要看的邮件取回来存好，真点开时就是读本地。同一封只提前取一次
  const prefetched = useRef(new Set<string>())
  const prefetchRows = (rows: MsgRef[]): void => {
    const groups = new Map<string, { accountId: string; folder: string; uids: number[] }>()
    for (const r of rows) {
      const k = keyOf(r)
      if (prefetched.current.has(k)) continue
      prefetched.current.add(k)
      const gk = `${r.accountId}|${r.folder}`
      if (!groups.has(gk)) groups.set(gk, { accountId: r.accountId, folder: r.folder, uids: [] })
      groups.get(gk)!.uids.push(r.uid)
    }
    // 只记最近的几百封，免得集合一直长大
    if (prefetched.current.size > 500) prefetched.current = new Set([...prefetched.current].slice(-200))
    for (const g of groups.values()) void api.prefetch(g.accountId, g.folder, g.uids).catch(() => undefined)
  }
  /** 点这一行会打开的那封（会话里是最早没读的一封，都读过就是最新的一封） */
  const targetOfRow = (m: MessageSummary): MessageSummary => {
    const g = threadOf(m) ?? [m]
    const unread = g.filter((x) => !x.seen)
    return g.length < 2 ? g[0] ?? m : unread.length ? unread[unread.length - 1] : g[0]
  }
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverRow = (m: MessageSummary | null): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    // 鼠标停了一小会儿才算「想看」，划过去的不取
    if (m) hoverTimer.current = setTimeout(() => prefetchRows([targetOfRow(m)]), 200)
  }

  const select = async (ref: MsgRef, list: MessageSummary[] = messages): Promise<void> => {
    const k = keyOf(ref)
    // 从通知点进来、列表还在加载时，用户已经改看别的信了：列表回来后不要再把他拽回去
    if (pendingOpen.current && keyOf(pendingOpen.current) !== k) pendingOpen.current = null
    setSelectedKey(k)
    setDetailError(null)
    const id = ++detailReq.current
    setDetailLoading(true)
    setDetail((d) => (d && keyOf(d) === k ? d : null))

    const markSeen = settings?.reading.markReadOnOpen !== false
    const summary = list.find((m) => keyOf(m) === k)
    if (markSeen && summary && !summary.seen) {
      patchMessage(ref, { seen: true })
      adjustUnseen(ref, -1)
    }
    try {
      const d = await api.get(ref.accountId, ref.folder, ref.uid, markSeen)
      // 正文可能来自缓存，星标以列表里的最新状态为准
      if (id === detailReq.current) setDetail(summary ? { ...d, flagged: summary.flagged } : d)
      // 这封看到了，顺手把下面三封、上面一封提前取好，接着往下翻就是秒开
      if (id === detailReq.current) {
        const at = visible.findIndex((m) => (threadOf(m) ?? [m]).some((x) => keyOf(x) === k))
        if (at >= 0) prefetchRows([1, 2, 3, -1].map((step) => visible[at + step]).filter(Boolean).map(targetOfRow))
      }
    } catch (err) {
      if (id === detailReq.current) setDetailError((err as Error).message)
    } finally {
      if (id === detailReq.current) setDetailLoading(false)
    }
  }

  /**
   * 点列表里的一行。是会话的话：有没读的就从最早那封没读的看起，都读过了就看最新的一封；
   * 其余没读的也一起标为已读（读信页里会给它们标上「新」）。skip 是马上要从列表里消失的邮件
   */
  const openRow = (m: MessageSummary, list: MessageSummary[] = messages, skip?: Set<string>): void => {
    const g = (threadOf(m) ?? [m]).filter((x) => !skip?.has(keyOf(x)))
    if (g.length < 2) {
      setFreshKeys((f) => (f.size ? new Set() : f))
      void select(g[0] ?? m, list)
      return
    }
    const unread = g.filter((x) => !x.seen)
    const target = unread.length ? unread[unread.length - 1] : g[0]
    const others = unread.filter((x) => x !== target)
    setFreshKeys(new Set(others.map(keyOf)))
    if (others.length && settings?.reading.markReadOnOpen !== false) markSeen(others, true)
    void select(target, list)
  }

  const selectedRef = (): MsgRef | null => {
    if (!selectedKey) return null
    return messages.find((m) => keyOf(m) === selectedKey) || (detail && keyOf(detail) === selectedKey ? detail : null)
  }

  const moveSelection = (delta: number): void => {
    if (!visible.length) return
    let idx = selectedHeadKey == null ? -1 : visible.findIndex((m) => keyOf(m) === selectedHeadKey)
    if (idx < 0 && selectedKey != null) {
      // 正在看的这封已经不在列表里了（比如标成未读后被折叠进「通知」）：按时间找到它原本的位置，从那里往上或往下
      const cur = messages.find((m) => keyOf(m) === selectedKey)
      if (!cur) return
      const after = visible.findIndex((m) => m.date < cur.date)
      const next = delta > 0 ? (after < 0 ? undefined : visible[after]) : visible[(after < 0 ? visible.length : after) - 1]
      if (next) openRow(next)
      return
    }
    if (idx < 0) idx = delta > 0 ? -1 : 0
    const next = visible[Math.min(visible.length - 1, Math.max(0, idx + delta))]
    if (next && keyOf(next) !== selectedHeadKey) openRow(next)
  }

  /** 一批邮件要从当前列表消失（删除、归档、推迟…）：取消勾选，并按设置打开相邻的一封或回到空白 */
  const leaveView = (keys: Set<string>, rest: MessageSummary[]): void => {
    setChecked((prev) => {
      if (!prev.size) return prev
      const next = new Set(prev)
      keys.forEach((k) => next.delete(k))
      return next
    })
    if (!selectedKey) return
    const group = (anchorKey ? threadMap.get(anchorKey) : undefined) ?? []
    // 正在看的这封被拿掉了；或者正在看的是自己发出去的回复，而它所在的会话整个被拿掉了
    const gone = keys.has(selectedKey) || (viewingSent && group.length > 0 && group.every((m) => keys.has(keyOf(m))))
    if (!gone) return
    // 拿掉的只是会话里的一部分：接着看这个会话里剩下的
    const sibling = group.find((m) => !keys.has(keyOf(m)))
    if (sibling) {
      void select(sibling, rest)
      return
    }
    const idx = visible.findIndex((m) => keyOf(m) === selectedHeadKey)
    if (settings?.reading.afterRemove !== 'none' && idx >= 0) {
      const after = visible.slice(idx + 1).find((m) => !keys.has(keyOf(m)))
      const before = visible
        .slice(0, idx)
        .reverse()
        .find((m) => !keys.has(keyOf(m)))
      const neighbor = after || before
      if (neighbor) {
        openRow(neighbor, rest, keys)
        return
      }
    }
    detailReq.current++
    setSelectedKey(null)
    setDetail(null)
  }

  /** 从列表移除一批邮件 */
  const removeFromList = (refs: MsgRef[]): void => {
    const keys = new Set(refs.map(keyOf))
    const rest = messages.filter((m) => !keys.has(keyOf(m)))
    // 用最新的列表来删：确认框开着的这段时间里可能又收到了新邮件
    setMessages((list) => list.filter((m) => !keys.has(keyOf(m))))
    leaveView(keys, rest)
  }

  // ---------- 邮件操作（单封和批量共用同一套函数） ----------

  /** 把一批邮件按「账号 + 文件夹」分组，每组只需要向服务器发一次命令 */
  const groupRefs = (refs: MsgRef[]): { accountId: string; folder: string; uids: number[] }[] => {
    const map = new Map<string, { accountId: string; folder: string; uids: number[] }>()
    for (const r of refs) {
      const g = `${r.accountId}|${r.folder}`
      if (!map.has(g)) map.set(g, { accountId: r.accountId, folder: r.folder, uids: [] })
      map.get(g)!.uids.push(r.uid)
    }
    return [...map.values()]
  }

  const reloadAfterError = (err: unknown): void => {
    notify((err as Error).message, 'error')
    if (!view) return
    void loadList(view, activeQuery)
    // 操作没成功，侧栏里提前改掉的未读数也要改回来
    const ids = isVirtual(view.accountId) || view.accountId === ALL ? accounts.map((a) => a.id) : [view.accountId]
    ids.forEach((id) => void loadFolders(id))
  }

  /** 把只知道位置的引用补上列表里的已读/星标状态 */
  const withState = (refs: MsgRef[]): Target[] => {
    // 批量操作几千封时逐个去列表里找会很慢，先建好索引
    const index = refs.length > 8 ? new Map(messages.map((x) => [keyOf(x), x])) : null
    return refs.map((r) => {
      const m = index ? index.get(keyOf(r)) : messages.find((x) => keyOf(x) === keyOf(r))
      if (m) return m
      const d = detail && keyOf(detail) === keyOf(r) ? detail : null
      return { accountId: r.accountId, folder: r.folder, uid: r.uid, seen: true, flagged: d?.flagged ?? false }
    })
  }

  const markSeen = (refs: MsgRef[], value: boolean): void => {
    const changed = withState(refs).filter((r) => r.seen !== value)
    if (!changed.length) return
    const keys = new Set(changed.map(keyOf))
    setMessages((list) => list.map((m) => (keys.has(keyOf(m)) ? { ...m, seen: value } : m)))
    for (const g of groupRefs(changed)) {
      adjustUnseen({ accountId: g.accountId, folder: g.folder, uid: 0 }, value ? -g.uids.length : g.uids.length)
      api.flag(g.accountId, g.folder, g.uids, 'seen', value).catch(reloadAfterError)
    }
  }

  const setFlagged = (refs: MsgRef[], value: boolean): void => {
    const changed = withState(refs).filter((r) => r.flagged !== value)
    if (!changed.length) return
    const keys = new Set(changed.map(keyOf))
    setMessages((list) => list.map((m) => (keys.has(keyOf(m)) ? { ...m, flagged: value } : m)))
    setDetail((d) => (d && keys.has(keyOf(d)) ? { ...d, flagged: value } : d))
    for (const g of groupRefs(changed)) {
      api.flag(g.accountId, g.folder, g.uids, 'flagged', value).catch(reloadAfterError)
    }
  }

  /** 都已读就标为未读，否则标为已读 */
  const toggleSeen = (refs: MsgRef[]): void => {
    const list = withState(refs)
    markSeen(list, !list.every((r) => r.seen))
  }

  /**
   * 对列表里的行（或者正在看的那一封）切换已读：会话里只要还有没读的，就把整个会话标为已读；
   * 都读过了，就只把给进来的这一封（列表里是最新的一封）标为未读
   */
  const toggleSeenRows = (rows: MsgRef[]): void => {
    const all = withState(expand(rows))
    if (all.every((r) => r.seen)) markSeen(rows, false)
    else markSeen(all, true)
  }

  /**
   * 列表里的行切换星标，按会话算：会话里有一封带星，这一行就算有星标。
   * 都有星标 → 把这些会话里的星全部取消；否则给还没有星标的会话的最新一封加上
   */
  const rowsFlagged = (rows: MsgRef[]): boolean => groupsOf(rows).every((g) => withState(g).some((r) => r.flagged))
  const toggleFlagRows = (rows: MsgRef[]): void => {
    const gs = groupsOf(rows).map((g) => withState(g))
    if (gs.every((g) => g.some((r) => r.flagged))) setFlagged(gs.flat(), false)
    else setFlagged(gs.filter((g) => !g.some((r) => r.flagged)).map((g) => g[0]), true)
  }

  /** 都有星标就取消，否则加上 */
  const toggleFlag = (refs: MsgRef[]): void => {
    const list = withState(refs)
    setFlagged(list, !list.every((r) => r.flagged))
  }

  const folderOf = (ref: { accountId: string; folder: string }): Folder | undefined =>
    folders[ref.accountId]?.find((f) => f.path === ref.folder)

  /**
   * 移除类操作（删除、归档、移动）的公共部分：先从界面上拿掉，等几秒再让服务器执行，这几秒里可以撤销。
   * instant：不等，马上执行（彻底删除这种已经确认过、也没法撤销的）
   */
  const removeRefs = (
    refs: MsgRef[],
    run: (g: { accountId: string; folder: string; uids: number[] }) => Promise<unknown>,
    label: string,
    instant = false
  ): void => {
    if (!refs.length) return
    // 设置里可以调撤销的秒数；关闭（0）就和「马上执行」一样
    const undoMs = Math.max(0, Math.min(60, Number(settings?.reading.undoRemoveSeconds ?? 6))) * 1000
    if (!undoMs) instant = true
    const list = withState(refs)
    const keys = new Set(list.map(keyOf))
    const backup = messages.filter((m) => keys.has(keyOf(m)))
    const from = view ? { ...view, query: activeQuery, scope: searchScope } : null
    removeFromList(list)
    const groups = groupRefs(list)
    for (const g of groups) {
      const unseen = list.filter((r) => r.accountId === g.accountId && r.folder === g.folder && r.seen === false).length
      if (unseen) adjustUnseen({ accountId: g.accountId, folder: g.folder, uid: 0 }, -unseen)
    }
    const accountIds = [...new Set(groups.map((g) => g.accountId))]
    lastActed.current = accountIds[accountIds.length - 1] ?? lastActed.current
    const unhide = (): void =>
      setHiddenKeys((h) => {
        const next = new Set(h)
        keys.forEach((k) => next.delete(k))
        return next
      })
    const commit = (): void => {
      Promise.all(groups.map(run))
        .then(() => {
          // 等待期间列表刷新过的话，这些邮件又被取回来了，这里再清一遍
          setMessages((cur) => (cur.some((m) => keys.has(keyOf(m))) ? cur.filter((m) => !keys.has(keyOf(m))) : cur))
          accountIds.forEach((id) => void handlers.current.reloadFolders(id))
          handlers.current.afterCommit()
        })
        .catch((err) => handlers.current.opFailed(err, accountIds))
        .finally(unhide)
    }
    if (instant) {
      commit()
      notify(label)
      return
    }
    setHiddenKeys((h) => new Set([...h, ...keys]))
    const id = Date.now() + Math.random()
    const closeToast = (): void => setToasts((t) => t.filter((x) => x.id !== id))
    const timer = setTimeout(() => {
      pendingOps.current.delete(id)
      closeToast()
      commit()
    }, undoMs)
    pendingOps.current.set(id, {
      timer,
      commit,
      undo: () => {
        clearTimeout(timer)
        pendingOps.current.delete(id)
        closeToast()
        unhide()
        handlers.current.restoreOp(backup, from, accountIds)
      }
    })
    setToasts((t) => [...t, { id, kind: 'op', text: label }])
  }

  /** 撤销最近一次删除、归档或移动；没有可撤销的返回 false */
  const undoLastOp = (): boolean => {
    const last = [...pendingOps.current.values()].pop()
    if (!last) return false
    last.undo()
    return true
  }

  const deleteRefs = (refs: MsgRef[]): void => {
    if (!refs.length) return
    const permanent = refs.some((r) => {
      const list = folders[r.accountId]
      return folderOf(r)?.specialUse === 'trash' || (!!list && !list.some((f) => f.specialUse === 'trash'))
    })
    const label = refs.length > 1 ? `已删除 ${refs.length} 封邮件` : '已删除'
    const run = (now: boolean) => (): void => removeRefs(refs, (g) => api.remove(g.accountId, g.folder, g.uids), label, now)
    if (permanent) {
      setConfirm({
        title: refs.length > 1 ? `彻底删除这 ${refs.length} 封邮件？` : '彻底删除这封邮件？',
        message: '这些邮件已经在「已删除」里，再删除就无法恢复了。',
        confirmLabel: '彻底删除',
        onConfirm: run(true)
      })
    } else if (settings?.reading.confirmDelete) {
      setConfirm({
        title: refs.length > 1 ? `删除这 ${refs.length} 封邮件？` : '删除这封邮件？',
        message: '邮件会移到「已删除」文件夹，之后还可以找回。',
        confirmLabel: '删除',
        onConfirm: run(false)
      })
    } else run(false)()
  }

  const canArchive = (ref: { accountId: string; folder: string } | null): boolean => {
    if (!ref) return false
    const list = folders[ref.accountId]
    if (!list) return false
    const account = accounts.find((a) => a.id === ref.accountId)
    const here = folderOf(ref)
    if (here?.specialUse === 'archive' || here?.specialUse === 'all') return false
    return list.some((f) => f.specialUse === 'archive' || (account?.provider === 'gmail' && f.specialUse === 'all'))
  }

  const archiveRefs = (refs: MsgRef[]): void => {
    const ok = refs.filter((r) => canArchive(r))
    if (!ok.length) {
      notify('这个邮箱没有归档文件夹', 'error')
      return
    }
    removeRefs(ok, (g) => api.archive(g.accountId, g.folder, g.uids), ok.length > 1 ? `已归档 ${ok.length} 封邮件` : '已归档')
  }

  const moveRefs = (refs: MsgRef[], target: Folder): void => {
    removeRefs(
      refs.filter((r) => r.folder !== target.path),
      (g) => api.move(g.accountId, g.folder, g.uids, target.path),
      `已移动到「${target.displayName}」`
    )
  }

  // ---------- 整个文件夹的操作（文件夹右键菜单、列表标题右键菜单用） ----------

  type FolderRef = { accountId: string; folder: string }

  /** 一个视图对应哪些真实文件夹：「所有收件箱」对应每个账号的收件箱 */
  const targetsOf = (v: View): FolderRef[] =>
    isVirtual(v.accountId) ? [] : v.accountId === ALL ? unifiedTargets(v.folder) : [{ ...v }]

  const refreshView = (v: View | null = view): void => {
    if (!v) return
    targetsOf(v).forEach((t) => void loadFolders(t.accountId))
    if (view && v.accountId === view.accountId && v.folder === view.folder) void loadList(view, activeQuery)
  }

  /** 把这些文件夹里的邮件全部标为已读或全部标为未读 */
  const markAllIn = (targets: FolderRef[], seen: boolean): void => {
    const inTargets = (m: MsgRef): boolean => targets.some((t) => t.accountId === m.accountId && t.folder === m.folder)
    setMessages((list) => list.map((m) => (m.seen !== seen && inTargets(m) ? { ...m, seen } : m)))
    setFolders((prev) => {
      const next = { ...prev }
      for (const t of targets) {
        next[t.accountId] = next[t.accountId]?.map((f) => (f.path === t.folder ? { ...f, unseen: seen ? 0 : f.total } : f))
      }
      return next
    })
    Promise.all(targets.map((t) => api.markAll(t.accountId, t.folder, seen)))
      .then((counts) => {
        const n = counts.reduce((a, b) => a + b, 0)
        if (!n) notify(seen ? '没有未读邮件' : '没有已读邮件')
        else notify(`已将 ${n} 封邮件标为${seen ? '已读' : '未读'}`)
        new Set(targets.map((t) => t.accountId)).forEach((id) => void loadFolders(id))
      })
      .catch(reloadAfterError)
  }

  const markAllRead = (): void => {
    if (!view) return
    // 在「聚焦 / 通知 / 订阅」分类页里，只处理这一页列出来的邮件，不碰其他分类
    if (smartInbox && tab !== 'all') {
      // 聚焦列表里，折叠在顶上的未读通知和订阅也算这一页的
      const unread = (tab === 'focus' ? shown : flat).filter((m) => !m.seen)
      if (!unread.length) notify('这一页没有未读邮件')
      else {
        markSeen(unread, true)
        notify(`已将 ${unread.length} 封邮件标为已读`)
      }
      return
    }
    const targets = targetsOf(view)
    if (targets.length > 1) {
      setConfirm({
        title: '把所有收件箱全部标为已读？',
        message: `会把 ${targets.length} 个账号收件箱里的全部未读邮件标为已读，包括还没有加载出来的更早的邮件。`,
        confirmLabel: '全部标为已读',
        onConfirm: () => markAllIn(targets, true)
      })
      return
    }
    markAllIn(targets, true)
  }

  const emptyFolder = (t: FolderRef, label: string): void => {
    setConfirm({
      title: `清空「${label}」？`,
      message: '里面的所有邮件会被彻底删除，无法恢复。',
      confirmLabel: '清空',
      onConfirm: () => {
        if (view && view.accountId === t.accountId && view.folder === t.folder) {
          // 只拿掉这个文件夹里的邮件：正在看搜索结果的话，别的文件夹的结果要留着
          const inFolder = (m: MsgRef): boolean => m.accountId === t.accountId && m.folder === t.folder
          setMessages((list) => list.filter((m) => !inFolder(m)))
          const open = selectedRef()
          if (!open || inFolder(open)) {
            detailReq.current++
            setSelectedKey(null)
            setDetail(null)
          }
          clearChecked()
        }
        api
          .emptyFolder(t.accountId, t.folder)
          .then((n) => {
            notify(n ? `已清空，共删除 ${n} 封邮件` : '文件夹本来就是空的')
            void loadFolders(t.accountId)
            if (view && !activeQuery) void loadList(view, '', true)
          })
          .catch(reloadAfterError)
      }
    })
  }

  /** 文件夹的右键菜单。v 可以是某个文件夹，也可以是「所有收件箱」 */
  const openFolderMenu = (v: View, x: number, y: number): void => {
    const targets = targetsOf(v)
    const unified = v.accountId === ALL
    const f = unified ? undefined : folderOf(v)
    const label = unified ? (v.folder === ALL_TRASH ? '所有已删除' : v.folder === ALL_SENT ? '所有已发送' : '所有收件箱') : f?.displayName || v.folder
    const total = targets.reduce((sum, t) => sum + (folderOf(t)?.total ?? 0), 0)
    const unseen = targets.reduce((sum, t) => sum + (folderOf(t)?.unseen ?? 0), 0)
    const isCurrent = !!view && view.accountId === v.accountId && view.folder === v.folder
    const items: MenuItem[] = []
    if (!isCurrent) items.push({ label: '打开', icon: 'folder', onClick: () => selectFolder(v.accountId, v.folder) })
    items.push(
      { label: '全部标为已读', icon: 'mailOpen', separator: !isCurrent, disabled: unseen === 0, onClick: () => markAllIn(targets, true) },
      {
        label: '全部标为未读',
        icon: 'unread',
        disabled: total === 0 || unseen >= total,
        onClick: () =>
          setConfirm({
            title: `把「${label}」全部标为未读？`,
            message: `这个文件夹里的 ${total} 封邮件都会变成未读状态。`,
            confirmLabel: '全部标为未读',
            onConfirm: () => markAllIn(targets, false)
          })
      },
      { label: '刷新', icon: 'refresh', separator: true, onClick: () => refreshView(v) }
    )
    if (isCurrent && visible.length) items.push({ label: '全选', icon: 'checkCircle', onClick: checkAll })
    // 文件夹管理：自己建的文件夹可以改名、删除；系统文件夹（收件箱、已发送…）不行
    if (!unified && !isVirtual(v.accountId) && accounts.some((a) => a.id === v.accountId)) {
      items.push({ label: '新建文件夹…', icon: 'plus', separator: true, onClick: () => promptNewFolder(v.accountId) })
      if (f && !f.specialUse) {
        items.push(
          { label: `在「${f.displayName}」里新建…`, icon: 'plus', onClick: () => promptNewFolder(v.accountId, f) },
          { label: '重命名…', icon: 'pen', onClick: () => promptRenameFolder(v.accountId, f) },
          { label: '删除这个文件夹…', icon: 'trash', danger: true, onClick: () => confirmDeleteFolder(v.accountId, f) }
        )
      }
    }
    if (f && (f.specialUse === 'trash' || f.specialUse === 'junk')) {
      items.push({
        label: `清空${f.displayName}`,
        icon: 'trash',
        danger: true,
        separator: true,
        disabled: f.total === 0,
        onClick: () => emptyFolder({ accountId: v.accountId, folder: v.folder }, f.displayName)
      })
    }
    setMenu({ x, y, title: `${label}${unseen ? `（${unseen} 封未读）` : ''}`, items })
  }

  /** 左下角账号圆标的菜单：切换账号、添加账号 */
  const openAccountSwitcher = (x: number, y: number): void => {
    const items: MenuItem[] = accounts.map((a) => {
      const unseen = folders[a.id]?.find((f) => f.specialUse === 'inbox')?.unseen ?? 0
      return {
        label: `${a.email}${unseen ? `（${unseen} 封未读）` : ''}`,
        icon: 'inbox' as const,
        onClick: () => selectFolder(a.id, inboxPath(a.id))
      }
    })
    if (accounts.length > 1) items.unshift({ label: '所有收件箱', icon: 'all', onClick: () => selectFolder(ALL, 'INBOX') })
    items.push(
      { label: '添加账号', icon: 'userPlus', separator: true, onClick: () => setDialog({ kind: 'add' }) },
      { label: '管理账号', icon: 'sliders', onClick: () => setDialog({ kind: 'settings', tab: 'accounts' }) }
    )
    setMenu({ x, y, title: '邮箱账号', items })
  }

  /** 账号名称上的右键菜单 */
  const openAccountMenu = (accountId: string, x: number, y: number): void => {
    const a = accounts.find((acc) => acc.id === accountId)
    if (!a) return
    const inbox = { accountId, folder: inboxPath(accountId) }
    setMenu({
      x,
      y,
      title: a.email,
      items: [
        { label: '打开收件箱', icon: 'inbox', onClick: () => selectFolder(accountId, inbox.folder) },
        {
          label: '用这个邮箱写信',
          icon: 'pen',
          onClick: () => setCompose({ ...newCompose(), accountId, bodyHtml: signatureBlock(accountId) })
        },
        { label: '收件箱全部标为已读', icon: 'mailOpen', separator: true, disabled: !(folderOf(inbox)?.unseen ?? 0), onClick: () => markAllIn([inbox], true) },
        { label: '刷新', icon: 'refresh', onClick: () => refreshView(inbox) },
        { label: '新建文件夹…', icon: 'plus', onClick: () => promptNewFolder(accountId) },
        { label: '账号设置', icon: 'sliders', separator: true, onClick: () => setDialog({ kind: 'settings', tab: 'accounts' }) }
      ]
    })
  }

  // ---------- 置顶、稍后处理、发件人 ----------

  /** 置顶是按会话算的：会话里有一封置顶，整个会话就排在最前面；取消时把里面的都取消 */
  const togglePin = (refs: MsgRef[]): void => {
    const gs = groupsOf(refs)
    const isPinned = (g: MsgRef[]): boolean => g.some((r) => data.pinned[keyOf(r)])
    const allPinned = gs.every(isPinned)
    const pinned = { ...data.pinned }
    for (const g of gs) {
      if (allPinned) g.forEach((r) => delete pinned[keyOf(r)])
      else if (!isPinned(g)) pinned[keyOf(g[0])] = Date.now()
    }
    saveData({ pinned })
    if (allPinned && pinnedView) leaveView(new Set(gs.flat().map(keyOf)), messages)
    notify(allPinned ? '已取消置顶' : '已置顶')
  }

  const snoozeRefs = (refs: MsgRef[], until: number): void => {
    const snoozed = { ...data.snoozed }
    // 一个会话一起推迟时，到点只提醒最新的那一封，其余的跟着回来就行
    const heads = new Set(groupsOf(refs).map((g) => keyOf(g[0])))
    for (const r of refs) {
      const m = messages.find((x) => keyOf(x) === keyOf(r))
      const d = detail && keyOf(detail) === keyOf(r) ? detail : null
      snoozed[keyOf(r)] = {
        until,
        subject: m?.subject ?? d?.subject ?? '',
        from: displayName((m ?? d)?.from[0]),
        ...(heads.has(keyOf(r)) ? {} : { quiet: true })
      }
    }
    saveData({ snoozed })
    if (!snoozedView) leaveView(new Set(refs.map(keyOf)), messages)
    notify(`${friendlyTime(until)} 再提醒你`)
  }

  const unsnoozeRefs = (refs: MsgRef[]): void => {
    const snoozed = { ...data.snoozed }
    for (const r of refs) delete snoozed[keyOf(r)]
    saveData({ snoozed })
    if (snoozedView) leaveView(new Set(refs.map(keyOf)), messages)
    notify('已放回收件箱')
  }

  /** 弹出「稍后处理」的时间菜单 */
  const openSnoozeMenu = (refs: MsgRef[], x: number, y: number): void => {
    if (!refs.length) return
    if (refs.every((r) => data.snoozed[keyOf(r)])) {
      unsnoozeRefs(refs)
      return
    }
    setMenu({
      x,
      y,
      title: '稍后处理：到时间再提醒我',
      items: [
        ...timePresets().map((p) => ({ label: p.label, icon: 'clock' as const, onClick: () => snoozeRefs(refs, p.at) })),
        {
          label: '自定义时间…',
          icon: 'sliders' as const,
          separator: true,
          onClick: () =>
            setTimePick({
              title: '什么时候再提醒你？',
              confirmLabel: '确定',
              onPick: (ts) => snoozeRefs(refs, ts)
            })
        }
      ]
    })
  }

  const setPriority = (address: string, on: boolean): void => {
    const list = data.priority.filter((a) => a !== address)
    saveData({ priority: on ? [...list, address] : list, blocked: on ? data.blocked.filter((a) => a !== address) : data.blocked })
    notify(on ? `已把 ${address} 设为重要发件人` : '已取消重要发件人')
  }

  const blockSender = (address: string): void => {
    setConfirm({
      title: address.startsWith('@') ? `屏蔽所有 ${address} 的邮件？` : `屏蔽 ${address}？`,
      message: address.startsWith('@')
        ? '之后这个域名下所有发件人的邮件都不会出现在列表里，也不会弹通知。邮件本身还在邮箱里，可以随时在「设置 → 发件人」里取消屏蔽。'
        : '之后这个发件人的邮件不会出现在列表里，也不会弹通知。邮件本身还在邮箱里，可以随时在「设置 → 发件人」里取消屏蔽。',
      confirmLabel: '屏蔽',
      onConfirm: () => {
        const hit = (m: MessageSummary): boolean => (address.startsWith('@') ? senderOf(m).endsWith(address) : senderOf(m) === address)
        const hidden = new Set(flat.filter(hit).map(keyOf))
        saveData({ blocked: [...data.blocked.filter((a) => a !== address), address], priority: data.priority.filter((a) => a !== address) })
        leaveView(hidden, messages)
        notify(`已屏蔽 ${address}`)
      }
    })
  }

  /** 接受一个第一次来信的发件人：以后不再问 */
  const acceptSender = (address: string): void => {
    const list = (data.accepted || []).filter((a) => a !== address)
    // 只是用来「不再提示」的名单，留最近的几千个就够了
    saveData({ accepted: [...list, address].slice(-3000) })
  }

  /** 回复日历邀请：会给组织者发一封邮件，点之前按钮旁边已经写明 */
  const respondInvite = (d: MessageDetail, answer: InviteAnswer): void => {
    if (inviteBusy) return
    setInviteBusy(answer)
    api
      .inviteRespond(d.accountId, d.folder, d.uid, answer)
      .then((next) => {
        setData(next)
        notify('已回复组织者')
      })
      .catch((err) => notify((err as Error).message, 'error'))
      .finally(() => setInviteBusy(''))
  }
  const openInvite = (d: MessageDetail): void => {
    api.inviteOpen(d.accountId, d.folder, d.uid).catch((err) => notify((err as Error).message, 'error'))
  }

  /** 退订：按邮件自己提供的方式来。动手之前先说清楚会做什么 */
  const unsubscribe = (d: MessageDetail): void => {
    if (!d.unsubscribe || unsubscribing) return
    const sender = senderOf(d)
    const who = displayName(d.from[0])
    const mine = accounts.find((a) => a.id === d.accountId)?.email || '你的邮箱'
    const message =
      d.unsubscribe === 'oneclick'
        ? `这个发件人支持一键退订：Bluebird Mail 会直接向对方的退订服务${d.unsubscribeTarget ? `（${d.unsubscribeTarget}）` : ''}提交请求，不用打开网页。对方一般需要几天才会完全停止发送。`
        : d.unsubscribe === 'mail'
          ? `这个发件人要求用邮件退订：Bluebird Mail 会用 ${mine} 给 ${d.unsubscribeTarget || '对方的退订地址'} 发一封退订邮件（会留在「已发送」里）。对方一般需要几天才会完全停止发送。`
          : `这个发件人只提供了网页退订：会在浏览器里打开对方的退订页面${d.unsubscribeTarget ? `（${d.unsubscribeTarget}）` : ''}，请按页面上的提示完成。`
    setConfirm({
      title: `退订「${who}」的邮件？`,
      message,
      confirmLabel: d.unsubscribe === 'link' ? '打开退订页面' : '退订',
      onConfirm: () => {
        setUnsubscribing(true)
        api
          .unsubscribe(d.accountId, d.folder, d.uid)
          .then((r) => {
            if (r === 'opened') {
              notify('已在浏览器里打开退订页面')
              return
            }
            if (sender) setUnsubscribed((prev) => new Set(prev).add(sender))
            notify(r === 'done' ? '已退订。对方可能过几天才会停止发送' : '已发出退订邮件。对方可能过几天才会停止发送')
          })
          .catch((err) => notify(`没能退订：${(err as Error).message}`, 'error'))
          .finally(() => setUnsubscribing(false))
      }
    })
  }

  /** 切换搜索范围；正在看搜索结果的话，马上按新的范围重新搜 */
  const changeScope = (next: SearchScope): void => {
    if (next === scopeRef.current) return
    scopeRef.current = next
    setSearchScope(next)
    if (activeQuery && view) {
      detailReq.current++
      setSelectedKey(null)
      setDetail(null)
      clearChecked()
      setMessages([])
      void loadList(view, activeQuery)
    }
  }

  // ---------- 多选 ----------

  /** 勾选的那些行（会话只算最新的一封；要对整个会话操作时用 expand 展开） */
  const checkedRefs = (): MessageSummary[] => visible.filter((m) => checked.has(keyOf(m)))

  const onCheck = (m: MessageSummary, range: boolean): void => {
    const k = keyOf(m)
    setChecked((prev) => {
      const next = new Set(prev)
      // Shift：从上一次点的那封连选到这一封；没有上一次时从当前打开的邮件算起
      const anchor = lastChecked.current ?? selectedHeadKey
      if (range && anchor && anchor !== k) {
        const a = visible.findIndex((x) => keyOf(x) === anchor)
        const b = visible.findIndex((x) => keyOf(x) === k)
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(keyOf(visible[i]))
          return next
        }
      }
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
    lastChecked.current = k
  }

  const checkAll = (): void => setChecked(new Set(visible.map(keyOf)))
  const clearChecked = (): void => {
    setChecked(new Set())
    lastChecked.current = null
  }

  /** 弹出「移动到」菜单；只有同一个账号的邮件才能一起移动 */
  const openMoveMenu = (refs: MsgRef[], x: number, y: number): void => {
    if (!refs.length) return
    const accountId = refs[0].accountId
    const sources = new Set(refs.map((r) => r.folder))
    const list = (folders[accountId] || []).filter((f) => !(sources.size === 1 && sources.has(f.path)))
    setMenu({
      x,
      y,
      title: '移动到',
      items: list.map((f) => ({ label: f.displayName, icon: 'folder', onClick: () => moveRefs(refs, f) }))
    })
  }

  const sameAccount = (refs: MsgRef[]): boolean => refs.length > 0 && refs.every((r) => r.accountId === refs[0].accountId)

  const onBatch = (action: BatchAction, anchor: { x: number; y: number }): void => {
    const rows = checkedRefs()
    if (!rows.length) return
    const refs = expand(rows)
    if (action === 'read') markSeen(refs, true)
    // 标为未读：每个会话只把最新的一封标成未读就够了
    else if (action === 'unread') markSeen(rows, false)
    else if (action === 'flag') toggleFlagRows(rows)
    else if (action === 'archive') archiveRefs(refs)
    else if (action === 'move') openMoveMenu(refs, anchor.x, anchor.y)
    else deleteRefs(refs)
    // 操作完就自动退出多选，不用再去点关闭。（移动要先选目标文件夹、删除可能要确认，它们完成时会自己清掉勾选）
    if (action === 'read' || action === 'unread' || action === 'flag') {
      clearChecked()
      notify(`已处理 ${refs.length} 封邮件`)
    }
  }

  /** 列表里一行上的小按钮：这一行是会话的话，对整个会话生效 */
  const onRowAction = (m: MessageSummary, action: RowAction, anchor: { x: number; y: number }): void => {
    const all = expand([m])
    if (action === 'pin') togglePin([m])
    else if (action === 'snooze') openSnoozeMenu(all, anchor.x, anchor.y)
    else if (action === 'archive') archiveRefs(all)
    else if (action === 'delete') deleteRefs(all)
    else if (action === 'flag') toggleFlagRows([m])
    else toggleSeenRows([m])
  }

  /** 右键菜单：点在已勾选的邮件上时作用于全部勾选的邮件，否则只作用于这一封 */
  const openContextMenu = (m: MessageSummary, x: number, y: number): void => {
    const rows = checked.has(keyOf(m)) && checked.size > 1 ? checkedRefs() : [m]
    // 一行是一个会话时，菜单里的操作对会话里的每一封都生效
    const refs = withState(expand(rows))
    const many = rows.length > 1
    const allSeen = refs.every((r) => r.seen)
    const allFlagged = rowsFlagged(rows)
    const items: MenuItem[] = []
    if (!many) {
      items.push({ label: '打开', icon: 'unread', onClick: () => openRow(m) })
    }
    items.push(
      {
        label: allSeen ? '标为未读' : '标为已读',
        icon: allSeen ? 'unread' : 'mailOpen',
        separator: !many,
        onClick: () => {
          markSeen(allSeen ? rows : refs, !allSeen)
          if (checked.has(keyOf(m))) clearChecked()
        }
      },
      {
        label: allFlagged ? '取消星标' : '加星标',
        icon: 'star',
        onClick: () => {
          toggleFlagRows(rows)
          if (checked.has(keyOf(m))) clearChecked()
        }
      }
    )
    const allPinned = groupsOf(rows).every((g) => g.some((r) => data.pinned[keyOf(r)]))
    const allSnoozed = refs.every((r) => data.snoozed[keyOf(r)])
    items.push(
      {
        label: allPinned ? '取消置顶' : '置顶',
        icon: 'pin',
        onClick: () => {
          togglePin(rows)
          if (checked.has(keyOf(m))) clearChecked()
        }
      },
      { label: allSnoozed ? '取消推迟，放回收件箱' : '稍后处理…', icon: 'clock', onClick: () => openSnoozeMenu(refs, x, y) }
    )
    if (refs.some((r) => canArchive(r))) items.push({ label: '归档', icon: 'archive', separator: true, onClick: () => archiveRefs(refs) })
    if (sameAccount(refs)) items.push({ label: '移动到…', icon: 'move', onClick: () => openMoveMenu(refs, x, y) })
    items.push({ label: '删除', icon: 'trash', danger: true, separator: true, onClick: () => deleteRefs(refs) })
    const sender = senderOf(m)
    if (!many && sender) {
      const isVip = data.priority.includes(sender)
      items.push(
        { label: isVip ? '取消重要发件人' : '设为重要发件人', icon: 'user', separator: true, onClick: () => setPriority(sender, !isVip) },
        { label: '屏蔽这个发件人', icon: 'ban', onClick: () => blockSender(sender) }
      )
    }
    if (!many && !checked.size) {
      items.push({ label: refs.length > 1 ? '选择这个会话' : '选择这封邮件', icon: 'check', separator: true, onClick: () => onCheck(m, false) })
    }
    const title = many
      ? refs.length > rows.length
        ? `已选 ${rows.length} 项，共 ${refs.length} 封邮件`
        : `已选 ${refs.length} 封`
      : refs.length > 1
        ? `会话，共 ${refs.length} 封邮件`
        : undefined
    setMenu({ x, y, title, items })
  }

  // ---------- 读信页工具栏的菜单 ----------

  /** 把一封邮件原样放进写信窗口再发一次 */
  const resend = (d: MessageDetail): void => {
    const account = accounts.find((a) => a.id === d.accountId) || accounts[0]
    setCompose({
      mode: 'new',
      accountId: account.id,
      to: d.to.map(formatAddress).join(', '),
      cc: d.cc.map(formatAddress).join(', '),
      subject: d.subject,
      bodyHtml: d.html ? sanitizeForQuote(d.html, remoteAllowed.current) : textToQuote(d.text),
      attachments: d.attachments.map((a) => ({
        filename: a.filename,
        size: a.size,
        fromMessage: { accountId: d.accountId, folder: d.folder, uid: d.uid, index: a.index }
      }))
    })
  }

  const copyText = (text: string, done: string): void => {
    api
      .copyText(text)
      .then(() => notify(done))
      .catch((err) => notify((err as Error).message, 'error'))
  }

  const printMail = (d: MessageDetail, pdf: boolean): void => {
    api
      .printMail(buildPrintDocument(d, remoteAllowed.current), pdf, d.subject || '邮件')
      .then((done) => pdf && done && notify('已保存为 PDF'))
      .catch((err) => notify((err as Error).message, 'error'))
  }

  const exportEml = (d: MessageDetail): void => {
    api
      .exportMail(d.accountId, d.folder, d.uid, d.subject || '邮件')
      .then((done) => done && notify('已导出邮件文件'))
      .catch((err) => notify((err as Error).message, 'error'))
  }

  /** 读信页的「更多」菜单，带小箭头的项点了会换成下一级菜单 */
  const openReaderMenu = (x: number, y: number): void => {
    if (!detail) return
    const d = detail
    const sender = senderOf(d)
    const domain = sender.split('@')[1] || ''
    const list = folders[d.accountId] || []
    const junk = list.find((f) => f.specialUse === 'junk')
    const inbox = list.find((f) => f.specialUse === 'inbox')
    const inJunk = !!junk && junk.path === d.folder
    const isVip = data.priority.includes(sender)
    const sub = (title: string, items: MenuItem[]) => (): void => setMenu({ x, y, title, items })

    const seen = messages.find((it) => keyOf(it) === keyOf(d))?.seen ?? true
    const items: MenuItem[] = [
      { label: seen ? '标为未读' : '标为已读', icon: seen ? 'unread' : 'mailOpen', hint: 'U', onClick: () => toggleSeen([d]) },
      { label: '回复', icon: 'reply', hint: 'R', separator: true, onClick: () => openCompose('reply') },
      { label: '全部回复', icon: 'replyAll', hint: 'A', onClick: () => openCompose('replyAll') },
      { label: '转发', icon: 'forward', hint: 'F', onClick: () => openCompose('forward') },
      { label: '重新发送', icon: 'sent', onClick: () => resend(d) },
      translatedNow
        ? { label: '显示原文', icon: 'globe', hint: 'T', onClick: () => setTr(null) }
        : { label: '翻译这封邮件', icon: 'globe', hint: 'T', onClick: translateOpen }
    ]
    if (sender) {
      const blockItems: MenuItem[] = [{ label: `屏蔽 ${sender}`, icon: 'ban', onClick: () => blockSender(sender) }]
      // 公共邮箱的域名不能整个屏蔽，否则所有用这家邮箱的人都收不到了
      if (domain && !FREE_MAIL_DOMAIN.test(domain)) {
        blockItems.push({ label: `屏蔽所有 @${domain} 的邮件`, icon: 'ban', onClick: () => blockSender('@' + domain) })
      }
      items.push(
        { label: '屏蔽', icon: 'ban', separator: true, chevron: true, onClick: sub('屏蔽', blockItems) },
        { label: isVip ? '取消重要发件人' : '设为重要发件人', icon: 'user', onClick: () => setPriority(sender, !isVip) }
      )
    }
    items.push({ label: '移动', icon: 'move', separator: !sender, chevron: true, onClick: () => openMoveMenu([d], x, y) })
    if (inJunk && inbox) items.push({ label: '这不是垃圾邮件', icon: 'inbox', onClick: () => moveRefs([d], inbox) })
    else if (junk) items.push({ label: '标记为垃圾邮件', icon: 'spam', onClick: () => moveRefs([d], junk) })
    items.push(
      {
        label: '打印',
        icon: 'printer',
        chevron: true,
        onClick: sub('打印', [
          { label: '打印…', icon: 'printer', onClick: () => printMail(d, false) },
          { label: '存为 PDF…', icon: 'download', onClick: () => printMail(d, true) }
        ])
      },
      {
        label: '复制',
        icon: 'copy',
        chevron: true,
        onClick: sub('复制', [
          { label: '复制为 Markdown', icon: 'copy', onClick: () => copyText(mailAsText(d, true), '已复制为 Markdown') },
          { label: '复制为纯文字', icon: 'copy', onClick: () => copyText(mailAsText(d, false), '已复制邮件文字') },
          { label: '复制主题', icon: 'copy', separator: true, onClick: () => copyText(d.subject, '已复制主题') },
          { label: '复制发件人地址', icon: 'user', disabled: !sender, onClick: () => copyText(sender, '已复制发件人地址') }
        ])
      },
      {
        label: '导出到',
        icon: 'share',
        chevron: true,
        onClick: sub('导出到', [
          { label: '邮件文件（.eml）', icon: 'unread', onClick: () => exportEml(d) },
          { label: 'PDF 文件', icon: 'download', onClick: () => printMail(d, true) }
        ])
      },
      { label: '全部操作', icon: 'bullets', hint: 'Ctrl+K', separator: true, onClick: () => setPalette(true) }
    )
    // 工具栏上的删除是删整个会话；只想删正在看的这一封，从这里删
    if ((threadOf(d)?.length ?? 1) > 1) {
      items.splice(items.length - 1, 0, { label: '只删除这一封', icon: 'trash', danger: true, separator: true, onClick: () => deleteRefs([d]) })
    }
    setMenu({ x, y, items })
  }

  const openNavMenu = (x: number, y: number): void => {
    const idx = selectedHeadKey == null ? -1 : visible.findIndex((m) => keyOf(m) === selectedHeadKey)
    const items: MenuItem[] = [
      { label: '上一封', icon: 'arrowUp', hint: '↑', disabled: idx <= 0, onClick: () => moveSelection(-1) },
      { label: '下一封', icon: 'arrowDown', hint: '↓', disabled: idx < 0 || idx >= visible.length - 1, onClick: () => moveSelection(1) }
    ]
    if (wide) items.push({ label: '返回列表', icon: 'back', hint: 'Esc', separator: true, onClick: closeReader })
    setMenu({ x, y, items })
  }

  const openQuickMenu = (x: number, y: number, fill: (text: string) => void): void => {
    const items: MenuItem[] = data.quickReplies.map((t) => ({ label: t, icon: 'bolt', onClick: () => fill(t) }))
    if (!items.length) items.push({ label: '还没有快捷回复', disabled: true, onClick: () => undefined })
    items.push({ label: '管理快捷回复…', icon: 'sliders', separator: true, onClick: () => setDialog({ kind: 'settings', tab: 'compose' }) })
    setMenu({ x, y, title: '快捷回复', items })
  }

  const openAttachment = (index: number, save: boolean): void => {
    if (!detail) return
    const fn = save ? api.saveAttachment : api.openAttachment
    fn(detail.accountId, detail.folder, detail.uid, index)
      .then((done) => save && done && notify('附件已保存'))
      .catch((err) => notify((err as Error).message, 'error'))
  }

  // ---------- 翻译 ----------
  const translateOpen = (): void => {
    if (!detail || !settings) return
    const key = keyOf(detail)
    const cacheKey = `${key}|${settings.translate.target}`
    const hit = trCache.current.get(cacheKey)
    if (hit) {
      setTr({ key, state: 'on', data: hit })
      return
    }
    if (tr?.key === key && tr.state === 'loading') return
    setTr({ key, state: 'loading' })
    translateMail(detail, api.translateTexts)
      .then((data) => {
        if (trCache.current.size > 40) trCache.current.clear()
        trCache.current.set(cacheKey, data)
        setTr((cur) => (cur && cur.key === key ? { key, state: 'on', data } : cur))
      })
      .catch((err) => {
        setTr((cur) => (cur && cur.key === key ? null : cur))
        const text = (err as Error).message
        notify(text, 'error')
        // 还没填密钥：直接带到填密钥的地方
        if (/还没有填 DeepL 密钥/.test(text)) setDialog({ kind: 'settings', tab: 'translate' })
      })
  }

  /** 在程序里直接看附件（图片、文字；PDF 会另开一个小窗口） */
  const previewAttachment = (index: number): void => {
    if (!detail) return
    const att = detail.attachments.find((a) => a.index === index)
    if (!att || !canPreview(att.filename)) return openAttachment(index, false)
    const req = ++viewerReq.current
    const pdf = /\.pdf$/i.test(att.filename)
    // PDF 是另开窗口看的，这里不用铺出预览层
    if (!pdf) setViewer({ index, name: att.filename, loading: true })
    api
      .previewAttachment(detail.accountId, detail.folder, detail.uid, index)
      .then((r) => {
        if (req !== viewerReq.current || r.kind === 'window') return
        setViewer((v) =>
          v && v.index === index
            ? r.kind === 'image'
              ? { index, name: r.name, loading: false, image: r.url }
              : { index, name: r.name, loading: false, text: r.text, truncated: r.truncated }
            : v
        )
      })
      .catch((err) => {
        if (pdf) notify((err as Error).message, 'error')
        else if (req === viewerReq.current) setViewer((v) => (v && v.index === index ? { ...v, loading: false, error: (err as Error).message } : v))
      })
  }
  /** 预览里能直接翻看的附件（PDF 是另开窗口的，不算） */
  const viewable = detail ? detail.attachments.filter((a) => canPreview(a.filename) && !/\.pdf$/i.test(a.filename)) : []
  const stepViewer = (delta: number): void => {
    if (!viewer) return
    const i = viewable.findIndex((a) => a.index === viewer.index)
    const next = viewable[i + delta]
    if (i >= 0 && next) previewAttachment(next.index)
  }

  // ---------- 文件夹：新建、改名、删除 ----------

  const applyFolders = (accountId: string, list: Folder[]): void => {
    setFolders((f) => ({ ...f, [accountId]: list }))
  }
  const promptNewFolder = (accountId: string, parent?: Folder): void => {
    setPrompt({
      title: parent ? `在「${parent.displayName}」里新建文件夹` : '新建文件夹',
      placeholder: '文件夹名称，比如：客户、发票',
      confirmLabel: '新建',
      onSubmit: async (name) => {
        applyFolders(accountId, await api.createFolder(accountId, name, parent?.path))
        setPrompt(null)
        notify(`已新建文件夹「${name}」`)
      }
    })
  }
  const promptRenameFolder = (accountId: string, f: Folder): void => {
    setPrompt({
      title: `给「${f.displayName}」改名`,
      initial: f.name,
      confirmLabel: '改名',
      onSubmit: async (name) => {
        if (name === f.name) {
          setPrompt(null)
          return
        }
        const list = await api.renameFolder(accountId, f.path, name)
        applyFolders(accountId, list)
        setPrompt(null)
        notify(`已改名为「${name}」`)
        // 正在看的就是这个文件夹：它的路径变了，回收件箱
        if (view && view.accountId === accountId && view.folder === f.path) selectFolder(accountId, list.find((x) => x.specialUse === 'inbox')?.path || 'INBOX')
      }
    })
  }
  const confirmDeleteFolder = (accountId: string, f: Folder): void => {
    // 刚才的删除、移动还在「可以撤销」的那几秒里：这时候文件夹里有几封邮件是说不准的，等它们做完再删
    if (pendingOps.current.size) {
      notify('刚才的删除或移动还没做完，请过几秒再删除文件夹', 'error')
      return
    }
    setConfirm({
      title: `删除文件夹「${f.displayName}」？`,
      message: f.total > 0 ? `里面的 ${f.total} 封邮件会一起彻底删除，无法恢复。想留着这些邮件的话，请先把它们移到别的文件夹。` : '这个文件夹是空的。删除后无法恢复。',
      confirmLabel: f.total > 0 ? `删除文件夹和 ${f.total} 封邮件` : '删除',
      onConfirm: () => {
        api
          .deleteFolder(accountId, f.path, f.total)
          .then((list) => {
            applyFolders(accountId, list)
            notify(`已删除文件夹「${f.displayName}」`)
            if (view && view.accountId === accountId && view.folder === f.path) selectFolder(accountId, list.find((x) => x.specialUse === 'inbox')?.path || 'INBOX')
          })
          .catch((err) => {
            notify((err as Error).message, 'error')
            // 多半是里面的邮件数变了：把文件夹列表更新一下，再点删除时看到的就是新的数字
            void loadFolders(accountId)
          })
      }
    })
  }

  // ---------- 写信 ----------
  /** 签名放在一个带标记的容器里，写信窗口切换发件人时可以整体替换 */
  const signatureInner = (accountId: string): string => {
    const sig = accounts.find((a) => a.id === accountId)?.signature?.trim()
    return sig ? `<br>${textToQuote(sig)}` : ''
  }
  const signatureBlock = (accountId: string): string =>
    `<div data-signature="1" style="color:#555">${signatureInner(accountId)}</div>`

  const newCompose = (): ComposeInit => {
    const preferred = settings?.general.defaultAccountId
    const accountId =
      preferred && accounts.some((a) => a.id === preferred)
        ? preferred
        : view && accounts.some((a) => a.id === view.accountId)
          ? view.accountId
          : detail && accounts.some((a) => a.id === detail.accountId)
            ? detail.accountId
            : accounts[0].id
    return { mode: 'new', accountId, to: '', cc: '', subject: '', bodyHtml: signatureBlock(accountId), attachments: [] }
  }

  const buildCompose = (mode: 'reply' | 'replyAll' | 'forward', d: MessageDetail): ComposeInit => {
    const account = accounts.find((a) => a.id === d.accountId) || accounts[0]
    const me = account.email.toLowerCase()
    const original = d.html ? sanitizeForQuote(d.html, remoteAllowed.current) : textToQuote(d.text)

    if (mode === 'forward') {
      const head = [
        '---------- 转发的邮件 ----------',
        `发件人：${escapeHtml(joinAddresses(d.from))}`,
        `日期：${fullDate(d.date)}`,
        `主题：${escapeHtml(d.subject)}`,
        `收件人：${escapeHtml(joinAddresses(d.to))}`,
        d.cc.length ? `抄送：${escapeHtml(joinAddresses(d.cc))}` : ''
      ]
        .filter(Boolean)
        .join('<br>')
      return {
        mode,
        accountId: account.id,
        to: '',
        cc: '',
        subject: prefixSubject(d.subject, 'Fwd'),
        bodyHtml: `${signatureBlock(account.id)}<br><div data-quote-head="1">${head}</div><br>${original}`,
        attachments: d.attachments.map((a) => ({
          filename: a.filename,
          size: a.size,
          fromMessage: { accountId: d.accountId, folder: d.folder, uid: d.uid, index: a.index }
        }))
      }
    }

    // 在「已发送」里回复自己发出的信：应该是接着发给原来的收件人，而不是发给自己
    const fromMe = (d.from[0]?.address || '').toLowerCase() === me
    const primary = d.replyTo.length ? d.replyTo : fromMe && d.to.length ? d.to : d.from
    const toList = [...primary]
    let ccList: typeof primary = []
    if (mode === 'replyAll') {
      const used = new Set(toList.map((a) => a.address.toLowerCase()))
      used.add(me)
      for (const a of d.to) {
        const k = a.address.toLowerCase()
        if (!used.has(k)) {
          toList.push(a)
          used.add(k)
        }
      }
      ccList = d.cc.filter((a) => {
        const k = a.address.toLowerCase()
        if (used.has(k)) return false
        used.add(k)
        return true
      })
    }

    return {
      mode,
      accountId: account.id,
      to: toList.filter((a) => a.address.toLowerCase() !== me || toList.length === 1).map(formatAddress).join(', '),
      cc: ccList.map(formatAddress).join(', '),
      subject: prefixSubject(d.subject, 'Re'),
      bodyHtml:
        signatureBlock(account.id) +
        (settings?.compose.quoteOnReply === false
          ? ''
          : `<br><div data-quote-head="1">${quoteHeader(d)}</div>` +
            `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${original}</blockquote>`),
      inReplyTo: d.messageId,
      references: [...d.references, ...(d.messageId ? [d.messageId] : [])],
      replyTo: { accountId: d.accountId, folder: d.folder, uid: d.uid },
      attachments: [],
      aiContext: aiMailOf(d)
    }
  }

  /** 读信页总结卡片上的「据此写回复」：打开回复窗口，AI 写作面板直接展开 */
  const openAiReply = (): void => {
    if (!accounts.length || !detail) return
    setCompose({ ...buildCompose('reply', detail), aiOpen: true })
  }

  const openCompose = (mode: ComposeInit['mode']): void => {
    if (!accounts.length) return
    if (mode === 'new' || !detail) setCompose(newCompose())
    else setCompose(buildCompose(mode, detail))
  }

  // ---------- 撤销发送 ----------

  /** 点了发送：先等几秒再真正发出，这期间可以撤销。草稿先留着，发出去以后由主进程删掉 */
  const queueSend = async (msg: OutgoingMessage, draftId: string): Promise<void> => {
    const seconds = settings?.compose.undoSeconds ?? 0
    const res = await api.sendLater(msg, seconds, draftId)
    setData(res.data)
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, kind: 'undo', text: msg.subject || '（无主题）', seconds, sendId: res.id }])
    // 保险：万一一直没等到结果，也不让这条提示永远挂着
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), seconds * 1000 + 120000)
  }

  const undoSend = (t: Toast): void => {
    if (!t.sendId) return
    const draftId = dataRef.current.scheduled.find((x) => x.id === t.sendId)?.draftId
    api
      .sendUndo(t.sendId)
      .then((d) => {
        setData(d)
        setToasts((list) => list.filter((x) => x.id !== t.id))
        const draft = d.drafts.find((x) => x.id === draftId)
        // 正在写另一封信时不打断它，撤回来的这封在草稿里
        if (draft && !compose && accounts.length) openDraft(draft)
        else notify('已撤销发送，邮件在草稿里')
      })
      .catch((err) => {
        setToasts((list) => list.filter((x) => x.id !== t.id))
        notify((err as Error).message, 'error')
      })
  }

  /** 读信页底部的快速回复：直接发出，带上引用的原文 */
  const quickReply = async (text: string): Promise<void> => {
    if (!detail) return
    const init = buildCompose('reply', detail)
    const msg: OutgoingMessage = {
      accountId: init.accountId,
      to: init.to,
      cc: '',
      bcc: '',
      subject: init.subject,
      html: `<div style="font-family:'Microsoft YaHei UI','Segoe UI',Arial,sans-serif;font-size:${settings?.compose.fontSize ?? 14}px;line-height:1.6">${textToQuote(text)}${init.bodyHtml}</div>`,
      text:
        settings?.compose.quoteOnReply === false
          ? text
          : `${text}\n\n${quoteHeader(detail).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')}\n${detail.text
              .split('\n')
              .map((l) => '> ' + l)
              .join('\n')}`,
      attachments: [],
      inReplyTo: init.inReplyTo,
      references: init.references,
      replyTo: init.replyTo
    }
    if ((settings?.compose.undoSeconds ?? 0) > 0) {
      // 可以撤销：先存一份草稿，撤销或者没发出去时从草稿接着改
      const draft: LocalDraft = {
        id: `d${Date.now()}`,
        savedAt: Date.now(),
        mode: 'reply',
        accountId: init.accountId,
        to: init.to,
        cc: '',
        bcc: '',
        subject: init.subject,
        html: `<div>${textToQuote(text)}</div>${init.bodyHtml}`,
        attachments: [],
        inReplyTo: init.inReplyTo,
        references: init.references,
        replyTo: init.replyTo
      }
      const drafts = [draft, ...dataRef.current.drafts.filter((x) => x.id !== draft.id)]
      setData(await api.updateData({ drafts }))
      try {
        await queueSend(msg, draft.id)
      } catch (err) {
        // 没排上队：这封信并没有要发出去，草稿也不用留
        saveData({ drafts: drafts.filter((x) => x.id !== draft.id) })
        throw err
      }
      return
    }
    await api.send(msg)
    patchMessage(detail, { answered: true })
    notify('回复已发送')
  }

  const expandReply = (text: string): void => {
    if (!detail) return
    const init = buildCompose('reply', detail)
    setCompose({ ...init, bodyHtml: textToQuote(text) + init.bodyHtml })
  }

  const composeFromMailto = (url: string): void => {
    if (!accounts.length) return
    try {
      const u = new URL(url)
      const p = u.searchParams
      setCompose({
        ...newCompose(),
        to: decodeURIComponent(u.pathname),
        cc: p.get('cc') || '',
        subject: p.get('subject') || '',
        bodyHtml: textToQuote(p.get('body') || '') + newCompose().bodyHtml
      })
    } catch {
      // 链接格式不对就忽略
    }
  }

  // ---------- 启动 ----------
  useEffect(() => {
    api
      .state()
      .then((s) => {
        setAccounts(s.accounts)
        setSettings(s.settings)
        setPresets(s.presets)
        setInfo(s.info)
        setData(s.data)
        setHome(s.settings.general.showHome && s.accounts.length > 0)
        // 先用上次缓存的文件夹列表，等服务器返回后再更新
        setFolders(Object.fromEntries(Object.entries(s.folders).map(([id, list]) => [id, list ?? undefined])))
        setReady(true)
        s.accounts.forEach((a) => void loadFolders(a.id))
      })
      .catch((err) => setStartError((err as Error).message))
    api
      .homeImage()
      .then(setHomeImage)
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 只给列表里实际显示出来的邮件取摘要：被分类筛掉的那些不用取，省下不少网络请求。
  // 已经问过的不会重复问（loadPreviews 里有记录）
  const previewSig = `${visible.length}|${visible.length ? keyOf(visible[0]) : ''}|${visible.length ? keyOf(visible[visible.length - 1]) : ''}`
  useEffect(() => {
    if (settings?.reading.showPreview) loadPreviews(visible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSig, messages, settings?.reading.showPreview])

  // 正在看的会话：里面每一封的摘要都要有（列表只给每个会话最新的那封取了摘要）
  // 以「选中了哪一封」为准（不是等正文取回来）：在会话里换着看几封邮件时，会话本身不变
  const detailIsSent = viewingSent
  const openAnchor = anchorKey
  /** 正在看的会话里「收到的」那些邮件（新的在前）；不是会话就是它自己 */
  const baseThread: MessageSummary[] = openAnchor ? threadMap.get(openAnchor) ?? messages.filter((m) => keyOf(m) === openAnchor) : []
  /** 这个会话里我自己发出去的回复 */
  const sentInThread =
    extras && baseThread.some((m) => keyOf(m) === extras.owner)
      ? extras.list.filter(
          (m) =>
            !hiddenKeys.has(keyOf(m)) &&
            // 同一封信在这个文件夹里已经有一份了（比如抄送了自己），就不再列第二遍
            !baseThread.some((b) => keyOf(b) === keyOf(m) || (!!m.messageId && b.messageId === m.messageId))
        )
      : []
  const openThread = [...baseThread, ...sentInThread]
  useEffect(() => {
    if (openThread.length > 1) loadPreviews(openThread, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail ? keyOf(detail) : '', openThread.length])

  // 去「已发送」里找这个会话中我自己的回复。只看会话里收到的那些邮件的编号，所以在会话里切换邮件不会重复去找。
  // 搜索结果、「稍后处理」「已置顶」里一封是一封，不找；「已发送」「草稿箱」「所有邮件」里本来就有自己发的，也不找
  const baseFolderUse = baseThread[0] ? folderOf(baseThread[0])?.specialUse : undefined
  const sentLookup =
    settings?.reading.threads !== false &&
    !activeQuery &&
    !virtualView &&
    baseThread.length &&
    baseFolderUse !== 'sent' &&
    baseFolderUse !== 'drafts' &&
    baseFolderUse !== 'all'
      ? `${baseThread[0].accountId}\n${[...baseThread].reverse().map((m) => m.messageId).filter(Boolean).join('\n')}`
      : ''
  // 查过的结果记几分钟，来回翻同一个会话不用每次都去问服务器
  const sentCache = useRef(new Map<string, { at: number; list: MessageSummary[] }>())
  useEffect(() => {
    const [accountId, ...ids] = sentLookup.split('\n')
    if (!accountId || !ids.length) return
    const owner = keyOf(baseThread[0])
    const hit = sentCache.current.get(sentLookup)
    if (hit && Date.now() - hit.at < 3 * 60 * 1000) {
      setExtras({ owner, list: hit.list })
      return
    }
    let alive = true
    api
      .threadSent(accountId, ids)
      .then((list) => {
        // 没查成（返回空值）就保持原样，不把已经列出来的回复弄没
        if (!list) return
        if (sentCache.current.size > 60) sentCache.current.clear()
        sentCache.current.set(sentLookup, { at: Date.now(), list })
        if (alive) setExtras({ owner, list })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentLookup, sentTick])

  // 换了一封邮件，附件预览就关掉，翻译也回到原文
  useEffect(() => {
    setViewer(null)
    setTr(null)
  }, [detail ? keyOf(detail) : ''])
  // 读信页里显示的内容：开着翻译就是译文，否则是原文。回复、转发、打印用的始终是原文
  const translatedNow = !!detail && !!tr && tr.state === 'on' && tr.key === keyOf(detail) && !!tr.data
  const shownDetail = useMemo(
    () => (detail && translatedNow && tr?.data ? { ...detail, subject: tr.data.subject, html: tr.data.html, text: tr.data.text } : detail),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail, translatedNow, tr?.data]
  )
  const foreign = useMemo(() => !!detail && looksForeign(detail), [detail])

  // 关窗口前，还在「可以撤销」那几秒里的删除、归档马上交给服务器去做。程序正在退出时不一定来得及做完——
  // 没做完的话邮件只是还留在原处，下次打开还在，不会丢
  useEffect(() => {
    const flush = (): void => {
      for (const op of pendingOps.current.values()) {
        clearTimeout(op.timer)
        op.commit()
      }
      pendingOps.current.clear()
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // 「稍后处理」「已置顶」里的邮件变了就重新取一次；全部处理完后回到收件箱
  const virtualKeys = Object.keys(view?.accountId === SNOOZED ? data.snoozed : view?.accountId === PINNED ? data.pinned : {})
    .sort()
    .join(',')
  useEffect(() => {
    if (!view || !isVirtual(view.accountId)) return
    // 正在看搜索结果时不动列表
    if (activeQuery) return
    // 全部处理完了就留在这里，显示「没有邮件」
    if (!virtualKeys) {
      setMessages([])
      return
    }
    void loadList(view, '', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualKeys])

  // 主屏是深色画面，让窗口右上角的按钮变成浅色
  useEffect(() => {
    api.setControls(home && accounts.length > 0).catch(() => undefined)
  }, [home, accounts.length])

  // 账号列表就绪后默认打开「所有收件箱」（只有一个账号时直接打开它的收件箱）
  useEffect(() => {
    if (!ready || view || !accounts.length) return
    // 后台先把收件箱加载好；如果正停在主屏，就继续停在主屏
    const keepHome = home
    if (accounts.length > 1) selectFolder(ALL, 'INBOX')
    else selectFolder(accounts[0].id, 'INBOX')
    setHome(keepHome)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, accounts.length])

  // 主进程推送的事件需要拿到最新的状态，用 ref 保存最新的处理函数
  const handlers = useRef({
    onNewMail: (_: NewMailEvent) => undefined as void,
    onWindowFocus: () => undefined as void,
    onToastOpen: (_: { accountId: string; folder: string; uid?: number }) => undefined as void,
    onChanged: (_: { accountId: string }) => undefined as void,
    onOpenMail: (_: { accountId: string; folder: string; uid?: number }) => undefined as void,
    onMailto: (_: string) => undefined as void,
    onComposeNew: () => undefined as void,
    onSendDone: (_: SendDoneEvent) => undefined as void,
    reloadFolders: (_: string) => undefined as void,
    opFailed: (_a: unknown, _b: string[]) => undefined as void,
    restoreOp: (_a: MessageSummary[], _b: (View & { query: string; scope: SearchScope }) | null, _c: string[]) => undefined as void,
    afterCommit: () => undefined as void,
    onKey: (_: KeyboardEvent) => undefined as void
  })
  // 删除、归档这些操作是过几秒才真正执行的，执行时界面可能已经换到别处了，所以收尾的动作要用最新的状态来做
  handlers.current.reloadFolders = (id) => void loadFolders(id)
  handlers.current.opFailed = (err, accountIds) => {
    reloadAfterError(err)
    // 提前改掉的未读数要改回来：这次操作涉及的每个账号都重新取一遍
    accountIds.forEach((id) => void loadFolders(id))
  }
  // 服务器执行完了：当前列表悄悄对一下账（比如刚把邮件移进了正在看的这个文件夹）
  handlers.current.afterCommit = () => {
    if (view && !activeQuery && !isVirtual(view.accountId)) void loadList(view, '', true)
  }
  handlers.current.restoreOp = (backup, from, accountIds) => {
    // 还停在原来那个列表里（同一个文件夹、同样的搜索）：把邮件原样放回去。已经换了地方就不往眼前这个列表里塞，回去时自然还在
    if (view && from && view.accountId === from.accountId && view.folder === from.folder && activeQuery === from.query && (!activeQuery || searchScope === from.scope)) {
      const bySeq = view.accountId !== ALL && !activeQuery && !isVirtual(view.accountId)
      setMessages((cur) => {
        const have = new Set(cur.map(keyOf))
        const merged = [...cur, ...backup.filter((m) => !have.has(keyOf(m)))]
        return merged.sort(bySeq ? (a, b) => b.seq - a.seq : byDateDesc)
      })
    }
    accountIds.forEach((id) => void loadFolders(id))
    notify('已撤销')
  }

  /** 「所有收件箱」里只刷新某一个邮箱：来了新邮件不用等其他七八个邮箱（尤其是连得慢的）一起回来 */
  const refreshOneInbox = async (accountId: string): Promise<void> => {
    const folder = inboxPath(accountId)
    const id = listReq.current
    try {
      const page = await api.list(accountId, folder)
      if (id !== listReq.current) return
      const group = groupOf({ accountId, folder, uid: 0 })
      setMessages((prev) => mergeFresh(page.messages, prev, true, [group]))
      lastListAt.current = Date.now()
    } catch {
      // 这个邮箱暂时连不上：保持原样，下次有动静再刷新
    }
  }

  const refreshIfViewing = (accountId: string, onlyInbox: boolean): void => {
    if (!view || activeQuery || isVirtual(view.accountId)) return
    if (view.accountId === ALL) {
      // 合在一起看的已删除、已发送：新邮件到了不用单独刷某个收件箱，整个重新取一遍就行
      if (UNIFIED_USE[view.folder]) {
        if (!onlyInbox) void loadList(view, '', true)
      } else if (accountId !== ALL && accounts.some((a) => a.id === accountId)) void refreshOneInbox(accountId)
      else void loadList(view, '', true)
      return
    }
    if (accountId !== ALL && view.accountId !== accountId) return
    if (onlyInbox && view.folder !== inboxPath(view.accountId)) return
    void loadList(view, '', true)
  }

  handlers.current.onNewMail = ({ accountId, notify: n, messages: fresh }) => {
    void loadFolders(accountId)
    // 监听连接已经把新邮件的摘要带来了：马上插进正在看的收件箱，不用等重新连服务器取列表（走代理时要好几秒）
    if (fresh?.length && view && !activeQuery && !isVirtual(view.accountId) && ((view.accountId === ALL && !UNIFIED_USE[view.folder]) || (view.accountId === accountId && view.folder === inboxPath(accountId)))) {
      const all = view.accountId === ALL
      setMessages((cur) => {
        const have = new Set(cur.map(keyOf))
        const add = fresh.filter((m) => !have.has(keyOf(m)))
        if (!add.length) return cur
        return [...add, ...cur].sort(all ? byDateDesc : (a, b) => b.seq - a.seq)
      })
    }
    refreshIfViewing(accountId, true)
    if (!n) return
    // 窗口里也弹一条：系统通知被 Windows 的「请勿打扰」挡住时，这里照样能看到
    const account = accounts.find((a) => a.id === accountId)
    const id = Date.now() + Math.random()
    const close = (): void => setToasts((t) => t.filter((x) => x.id !== id))
    const toast: Toast = {
      id,
      kind: 'mail',
      title: n.count > 1 ? `${account?.email ?? ''} 收到 ${n.count} 封新邮件` : n.from || '新邮件',
      text: n.count > 1 ? (n.subject ? `${n.from}：${n.subject} 等` : '点击查看') : n.subject || account?.email || '',
      onClick: () => {
        close()
        handlers.current.onToastOpen({ accountId, folder: 'INBOX', uid: n.count === 1 ? n.uid : undefined })
      }
    }
    // 最多留最近的几条；「撤销发送」那条不能被挤掉
    setToasts((t) => {
      const rest = t.filter((x) => x.kind !== 'mail')
      const keep = (x: Toast): boolean => x.kind === 'undo' || x.kind === 'op' || x.kind === 'update'
      return [...rest.filter(keep), ...rest.filter((x) => !keep(x)).slice(-3), toast]
    })
    setTimeout(close, 8000)
  }

  // 窗口从后台切回来：离上次更新超过 40 秒，就悄悄对一下账（睡眠唤醒、网络切换后常有漏掉的新邮件）
  handlers.current.onWindowFocus = () => {
    if (Date.now() - lastListAt.current < 40000) return
    lastListAt.current = Date.now()
    for (const a of accounts) void loadFolders(a.id)
    refreshIfViewing(ALL, false)
  }

  handlers.current.onChanged = ({ accountId }) => {
    const ids = accountId === ALL ? accounts.map((a) => a.id) : [accountId]
    for (const id of ids) {
      clearTimeout(changeTimers.current[id])
      changeTimers.current[id] = setTimeout(() => {
        void loadFolders(id)
        refreshIfViewing(id, false)
      }, 1000)
    }
  }

  handlers.current.onOpenMail = ({ accountId, folder: from, uid }) => {
    if (!accounts.some((a) => a.id === accountId)) return
    const inbox = inboxPath(accountId)
    // 新邮件通知带的是 INBOX；稍后处理的提醒带的是邮件原来所在的文件夹
    const folder = from && from !== 'INBOX' ? from : inbox
    const open = uid ? { accountId, folder, uid } : undefined
    if (view?.accountId === ALL && folder === inbox) selectFolder(ALL, 'INBOX', open)
    else selectFolder(accountId, folder, open)
    // 知道是哪一封就直接打开，不用等列表加载完
    if (open) void select(open, [])
  }

  // 点窗口里的新邮件提示：正在写信就不打断；开着设置之类的窗口就先关掉，再打开那封信
  handlers.current.onToastOpen = (e) => {
    if (compose) {
      notify('写完这封信再去看吧，新邮件已经在收件箱里了')
      return
    }
    setDialog(null)
    setShowDrafts(false)
    setShowScheduled(false)
    setMenu(null)
    setPalette(false)
    handlers.current.onOpenMail(e)
  }

  // 已经有一封信在写的时候，不能用新的把它顶掉
  handlers.current.onMailto = (url) => {
    if (compose) notify('请先处理正在写的这封邮件')
    else composeFromMailto(url)
  }
  handlers.current.onComposeNew = () => {
    if (compose) notify('已经有一封邮件正在写')
    else openCompose('new')
  }

  // 「撤销发送」的那封信有结果了
  handlers.current.onSendDone = ({ id, ok, error, draftId, replyTo }) => {
    setToasts((t) => t.filter((x) => x.sendId !== id))
    if (ok) {
      notify('已发送')
      if (replyTo) patchMessage(replyTo, { answered: true })
      // 存进「已发送」要一小会儿，稍后再把会话里「我的回复」找一遍
      setTimeout(() => {
        sentCache.current.clear()
        setSentTick((n) => n + 1)
      }, 5000)
      return
    }
    const draft = dataRef.current.drafts.find((x) => x.id === draftId)
    // 没发出去：把这封信重新打开，错误原因写在里面。正在写别的信就不打断，只提示一下
    if (draft && !compose && accounts.length) openDraft(draft, error)
    else notify(`邮件没有发出去：${error || '未知原因'}${draft ? '。内容还在草稿里' : ''}`, 'error')
  }

  handlers.current.onKey = (e) => {
    // 正在预览附件：Esc 关掉，左右方向键换上一个、下一个，别的键都不往下传
    if (viewer) {
      if (e.key === 'Escape') setViewer(null)
      else if (e.key === 'ArrowLeft') stepViewer(-1)
      else if (e.key === 'ArrowRight') stepViewer(1)
      else return
      e.preventDefault()
      return
    }
    if (prompt) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !compose && !dialog && !confirm && !timePick) {
      e.preventDefault()
      setMenu(null)
      setPalette((v) => !v)
      return
    }
    const t = e.target as HTMLElement | null
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable)
    // 确认框、选时间的窗口：焦点不在它们身上时（比如点过空白处）Esc 也要能关
    if (e.key === 'Escape' && !typing && !menu && (confirm || timePick)) {
      e.preventDefault()
      if (confirm) setConfirm(null)
      else setTimePick(null)
      return
    }
    // Esc 关闭设置、添加邮箱、草稿、定时发送这几个窗口（正在输入框里打字时不关，免得误触丢内容）
    if (e.key === 'Escape' && !typing && !compose && !menu && !confirm && !timePick && !palette) {
      if (dialog) {
        e.preventDefault()
        if (dialog.kind === 'add') void api.cancelOAuth().catch(() => undefined)
        setDialog(null)
        return
      }
      if (showScheduled || showDrafts) {
        e.preventDefault()
        setShowScheduled(false)
        setShowDrafts(false)
        return
      }
    }
    if (compose || dialog || menu || confirm || timePick || palette || showScheduled || showDrafts || home) return
    if (typing) return
    // 整屏读信时列表是隐藏的：这时候的快捷键只能作用于正在看的这一封，不能动看不见的勾选
    const readingNow = settings?.general.layout !== 'split' && selectedKey != null
    // Ctrl+Z：撤销刚才的删除、归档或移动
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (undoLastOp()) e.preventDefault()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      if (readingNow) return
      e.preventDefault()
      checkAll()
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // 按住不放时只有上下翻信可以连续触发，删除、归档这些不能连着来
    if (e.repeat && !['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) return
    // 有勾选时，操作作用于勾选的邮件；否则作用于当前打开的那封
    // 正在看的是会话里自己发出去的回复时，删除、归档这些键针对的是这个会话（和工具栏一致），星标针对的是眼前这一封
    const opened = selectedRef()
    const current = viewingSent && selectedRow ? selectedRow : opened
    const useChecked = !readingNow && checked.size > 0
    // rows：勾选的那些行，或者正在看的这一封；targets：把会话展开以后的全部邮件
    const rows: MsgRef[] = useChecked ? checkedRefs() : current ? [current] : []
    const targets: MsgRef[] = expand(rows)
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        moveSelection(1)
        break
      case 'ArrowUp':
      case 'k':
        moveSelection(-1)
        break
      case 'Escape':
        if ((checked.size || multi) && !readingNow) {
          clearChecked()
          setMulti(false)
        } else if (drawer) setDrawer(false)
        else if (settings?.general.layout !== 'split' && selectedKey) closeReader()
        // 在「通知」「订阅」里按 Esc 回到聚焦列表
        else if (smartInbox && tab !== 'focus') {
          autoLoads.current = 0
          setTab('focus')
        }
        else return
        break
      case 'x':
        if (selectedRow && !readingNow) onCheck(selectedRow, false)
        break
      case 'n':
      case 'c':
        openCompose('new')
        break
      case 'r':
        if (detail) openCompose('reply')
        break
      case 'a':
        if (detail) openCompose('replyAll')
        break
      case 'f':
        if (detail) openCompose('forward')
        break
      case 't':
        if (!detail) return
        if (translatedNow) setTr(null)
        else translateOpen()
        break
      case 's':
        // 星标：勾选了就给勾选的加；没勾选时只给正在看的这一封加，不动会话里的其他邮件
        if (useChecked) toggleFlagRows(rows)
        else if (opened) toggleFlag([opened])
        if (useChecked) clearChecked()
        break
      case 'u':
        if (rows.length) toggleSeenRows(rows)
        if (useChecked) clearChecked()
        break
      case 'p':
        if (rows.length) togglePin(rows)
        if (useChecked) clearChecked()
        break
      case 'h':
        if (targets.length) openSnoozeMenu(targets, window.innerWidth / 2 - 100, 140)
        break
      case 'e':
        if (targets.length) archiveRefs(targets)
        break
      case 'Delete':
      case '#':
        if (targets.length) deleteRefs(targets)
        break
      case '/':
        searchRef.current?.focus()
        break
      default:
        return
    }
    e.preventDefault()
  }

  useEffect(() => {
    const offs = [
      api.onNewMail((e) => handlers.current.onNewMail(e)),
      api.onChanged((e) => handlers.current.onChanged(e)),
      api.onOpenMail((e) => handlers.current.onOpenMail(e)),
      api.onMailto((u) => handlers.current.onMailto(u)),
      api.onComposeNew(() => handlers.current.onComposeNew()),
      api.onDataChanged(setData),
      api.onSendDone((e) => handlers.current.onSendDone(e)),
      // 新版本下载好了：底部提示一下，点了就重启安装；不点也行，下次退出程序时会自动装上
      api.onUpdateStatus((st) => {
        setUpdate(st)
        setUpdateBusy(false)
      })
    ]
    const onKey = (e: KeyboardEvent): void => handlers.current.onKey(e)
    const onFocus = (): void => handlers.current.onWindowFocus()
    window.addEventListener('keydown', onKey)
    window.addEventListener('focus', onFocus)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // ---------- 账号变化 ----------
  const onAccountAdded = (a: Account): void => {
    setAccounts((list) => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]))
    setDialog(null)
    notify(`已添加 ${a.email}`)
    void loadFolders(a.id)
    selectFolder(a.id, 'INBOX')
  }

  const onAccountUpdated = (a: Account): void => {
    setAccounts((list) => list.map((x) => (x.id === a.id ? a : x)))
    void loadFolders(a.id)
  }

  const onAccountRemoved = (id: string): void => {
    const rest = accounts.filter((a) => a.id !== id)
    setAccounts(rest)
    setFolders((f) => ({ ...f, [id]: undefined }))
    if (view && (view.accountId === id || view.accountId === ALL)) {
      if (rest.length) selectFolder(rest[0].id, inboxPath(rest[0].id))
      else {
        setView(null)
        setMessages([])
        detailReq.current++
        setDetail(null)
        setSelectedKey(null)
      }
    }
  }

  // ---------- 渲染 ----------
  if (startError) {
    return <div className="boot error">启动失败：{startError}</div>
  }
  if (!ready || !settings) {
    return <div className="boot">正在启动…</div>
  }

  const unified = view?.accountId === ALL
  const account = accounts.find((a) => a.id === view?.accountId)
  const folder = !unified && view ? folders[view.accountId]?.find((f) => f.path === view.folder) : undefined
  const inboxUnseen = accounts.reduce(
    (sum, a) => sum + (folders[a.id]?.find((f) => f.specialUse === 'inbox')?.unseen ?? 0),
    0
  )
  const title = globalSearch
    ? '搜索结果'
    : snoozedView
    ? '稍后处理'
    : pinnedView
    ? '已置顶'
    : unified
      ? view?.folder === ALL_TRASH
        ? '已删除'
        : view?.folder === ALL_SENT
          ? '已发送'
          : '所有收件箱'
      : folder?.displayName || (view?.folder === 'INBOX' ? '收件箱' : view?.folder || '')
  const unifiedUse = unified && view ? UNIFIED_USE[view.folder] : undefined
  const unseenHere = virtualView ? 0 : unified ? (unifiedUse ? 0 : inboxUnseen) : folder?.unseen ?? 0
  const activeSubtitle = (): string =>
    globalSearch
      ? listLoading
        ? `正在所有邮箱里搜索「${activeQuery}」…${shown.length ? `已找到 ${shown.length} 封` : ''}`
        : `在所有邮箱里搜索「${activeQuery}」，找到 ${shown.length} 封`
      : `在这里搜索「${activeQuery}」，找到 ${total} 封`
  const TAB_NAMES: Record<CategoryTab, string> = { focus: '聚焦列表', all: '全部邮件', personal: '个人', notification: '通知', newsletter: '订阅' }
  const subtitle = activeQuery
    ? activeSubtitle()
    : snoozedView
    ? '到时间后会回到收件箱并提醒你'
    : pinnedView
    ? '你置顶的邮件都在这里'
    : unified
      ? `${smartInbox ? TAB_NAMES[tab] : `${accounts.length} 个邮箱`}${unseenHere ? `，${unseenHere} 封未读` : ''}`
      : `${smartInbox ? TAB_NAMES[tab] : account?.email || ''}${unseenHere ? `，${unseenHere} 封未读` : ''}`
  const tags = accountTags(accounts)
  const accountMarks = Object.fromEntries(accounts.map((a) => [a.id, { label: tags[a.id], color: a.color, email: a.email }]))
  const detailAccount = detail ? accounts.find((a) => a.id === detail.accountId) : undefined
  const batchRefs = checked.size ? checkedRefs() : []
  // 一个会话一起推迟的只算一项
  const snoozedCount = Object.values(data.snoozed).filter((x) => !x.quiet).length
  // 「撤销发送」那几秒里的邮件也在队列里，但它们不算定时邮件
  const scheduledList = data.scheduled.filter((x) => !x.undo)
  // 正等着发出的那封信的草稿先不列出来：这时候去改它，改的内容不会跟着发出去
  const queuedDrafts = new Set(data.scheduled.filter((x) => x.undo && x.draftId).map((x) => x.draftId))
  const draftList = queuedDrafts.size ? data.drafts.filter((x) => !queuedDrafts.has(x.id)) : data.drafts
  // 列表里每个会话的概况：几封、有没有未读、都是谁发的
  const myAddresses = new Set(accounts.map((a) => a.email.toLowerCase()))
  const threadInfo = new Map<string, ThreadInfo>()
  for (const g of ordered) {
    if (g.length < 2) continue
    const names: string[] = []
    for (let i = g.length - 1; i >= 0; i--) {
      const from = g[i].from[0]
      const name = from && myAddresses.has(from.address.toLowerCase()) ? '我' : displayName(from)
      if (!names.includes(name)) names.push(name)
    }
    threadInfo.set(keyOf(g[0]), {
      count: g.length,
      unread: g.some((m) => !m.seen),
      flagged: g.some((m) => m.flagged),
      attachments: g.some((m) => m.hasAttachments),
      answered: g.some((m) => m.answered),
      names
    })
  }
  const pinnedRows = new Set(ordered.filter(groupPinned).map((g) => keyOf(g[0])))
  // 读信页里的会话：从早到晚排
  const sentKeys = new Set(sentInThread.map(keyOf))
  const readerThread =
    openThread.length > 1
      ? [...openThread]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((m) => ({ message: m, preview: previews[keyOf(m)], fresh: freshKeys.has(keyOf(m)), sent: sentKeys.has(keyOf(m)) }))
      : undefined
  /** 工具栏上的删除、归档、推迟针对的邮件：会话里收到的那些（自己发出去的回复留在「已发送」里不动） */
  const detailThread: MsgRef[] = baseThread.length ? baseThread : detail ? [detail] : []
  /** 置顶、已读这类「按行」的操作针对谁：一般就是眼前这封；眼前是自己发出去的回复时，针对它所在的会话 */
  const threadRow: MsgRef | null = detail ? (detailIsSent && baseThread[0] ? baseThread[0] : detail) : null
  const detailSender = detail ? senderOf(detail) : ''
  const accepted = data.accepted || []
  const showGate =
    !!detail &&
    settings.reading.gatekeeper !== false &&
    !!detail.newSender &&
    !!detailSender &&
    !accepted.includes(detailSender) &&
    !data.priority.includes(detailSender) &&
    !isBlocked(detailSender)
  const unreadIn = (c: CategoryTab): number => shown.filter((m) => !m.seen && m.category === c).length
  const tabs = smartInbox
    ? ([
        { id: 'focus', label: '聚焦' },
        { id: 'notification', label: '通知' },
        { id: 'newsletter', label: '订阅' },
        { id: 'all', label: '全部' }
      ] as { id: CategoryTab; label: string }[]).map((t) => ({
        ...t,
        // 聚焦页数的是真人来信里的未读；「全部」不再重复显示
        unread: t.id === 'focus' ? unreadIn('personal' as CategoryTab) : t.id === 'all' ? 0 : unreadIn(t.id)
      }))
    : undefined
  // 聚焦列表顶部：把未读的通知和订阅各折叠成一行
  const bundles: Bundle[] =
    smartInbox && tab === 'focus'
      ? (['notification', 'newsletter'] as const).flatMap((cat) => {
          const list = shown.filter((m) => m.category === cat && !m.seen)
          if (!list.length) return []
          const counts = new Map<string, { count: number; seed: string }>()
          for (const m of list) {
            const name = displayName(m.from[0])
            const c = counts.get(name)
            if (c) c.count++
            else counts.set(name, { count: 1, seed: m.from[0]?.address || name })
          }
          const senders = [...counts.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8)
            .map(([name, v]) => ({ name, count: v.count, seed: v.seed }))
          return [{ id: cat, label: TAB_NAMES[cat], count: list.length, senders }]
        })
      : []
  // 外观相关的几项：设置窗口里改了还没保存时，先按改的样子显示
  const look = preview ?? settings
  const wide = look.general.layout !== 'split'
  const reading = wide && selectedKey != null
  const railActive: RailTarget | null = home
    ? 'home'
    : snoozedView
    ? 'snoozed'
    : pinnedView
    ? 'pinned'
    : inboxView
    ? 'inbox'
    : unifiedUse
    ? unifiedUse
    : folder?.specialUse === 'drafts' || folder?.specialUse === 'sent' || folder?.specialUse === 'trash'
    ? folder.specialUse
    : null
  const railAccount = accounts.find((a) => a.id === activeAccountId())
  const detailKey = detail ? keyOf(detail) : ''
  const detailPinned = detailThread.some((r) => !!data.pinned[keyOf(r)])

  /** 列表右上角的开关：开 = 智能收件箱（未读的通知、订阅折叠起来），关 = 所有邮件按时间排 */
  const toggleSmart = (): void => {
    if (!settings) return
    const next = { ...settings, reading: { ...settings.reading, smartInbox: !settings.reading.smartInbox } }
    setSettings(next)
    setTab('focus')
    autoLoads.current = 0
    clearChecked()
    const prev = settings
    api
      .saveSettings(next)
      .then(setSettings)
      .catch((err) => {
        setSettings(prev)
        notify((err as Error).message, 'error')
      })
  }

  /** 「操作」面板针对的邮件：有勾选就是勾选的那些，否则是正在看的这一封 */
  const paletteTargets = (): MsgRef[] => (checked.size ? checkedRefs() : detail ? [detail] : [])

  /** 命令中心里列出的操作 */
  const buildCommands = (): Command[] => {
    const rows = paletteTargets()
    const many = checked.size > 0 && rows.length > 0
    if (many) {
      // 多选时：只列对这批邮件的操作，做完自动退出多选。勾选的是会话时，对会话里的每一封都生效
      const targets = expand(rows)
      const state = withState(targets)
      const allSeen = state.every((t) => t.seen)
      const done = (fn: () => void) => (): void => {
        fn()
        clearChecked()
      }
      const batch: Command[] = [
        { label: allSeen ? '标记为未读' : '标记为已读', hint: 'U', icon: allSeen ? 'circle' : 'mailOpen', keywords: 'read unread', run: done(() => markSeen(allSeen ? rows : targets, !allSeen)) },
        { label: '移动到回收站', hint: 'Delete', icon: 'trash', keywords: 'delete', run: () => deleteRefs(targets) },
        { label: '置顶 / 取消置顶', hint: 'P', icon: 'pin', keywords: 'pin', run: done(() => togglePin(rows)) },
        { label: '稍后处理…', hint: 'H', icon: 'clock', keywords: 'snooze later', run: () => openSnoozeMenu(targets, window.innerWidth / 2 - 100, 140) },
        { label: '加星标 / 取消星标', hint: 'S', icon: 'star', keywords: 'star flag', run: done(() => toggleFlagRows(rows)) }
      ]
      if (targets.some((t) => canArchive(t))) batch.unshift({ label: '完成（归档）', hint: 'E', icon: 'check', keywords: 'archive done', run: () => archiveRefs(targets) })
      if (sameAccount(targets)) batch.push({ label: '移动到…', icon: 'folder', keywords: 'move', run: () => openMoveMenu(targets, window.innerWidth / 2 - 100, 140) })
      batch.push({ label: '取消选择', hint: 'Esc', icon: 'x', keywords: 'cancel', run: clearChecked })
      return batch
    }
    const list: Command[] = [{ label: '写邮件', hint: 'N', icon: 'pen', keywords: 'new compose xie', run: () => openCompose('new') }]
    if (detail) {
      const whole = detailThread.length > 1
      list.push(
        { label: '回复', hint: 'R', icon: 'reply', keywords: 'reply', run: () => openCompose('reply') },
        { label: '全部回复', hint: 'A', icon: 'replyAll', keywords: 'reply all', run: () => openCompose('replyAll') },
        { label: '转发', hint: 'F', icon: 'forward', keywords: 'forward', run: () => openCompose('forward') },
        { label: detailPinned ? '取消置顶' : whole ? '置顶这个会话' : '置顶这封邮件', hint: 'P', icon: 'pin', keywords: 'pin', run: () => threadRow && togglePin([threadRow]) },
        { label: whole ? '稍后处理这个会话' : '稍后处理这封邮件', hint: 'H', icon: 'clock', keywords: 'snooze later', run: () => openSnoozeMenu(detailThread, window.innerWidth / 2 - 100, 140) },
        { label: '加星标 / 取消星标', hint: 'S', icon: 'star', keywords: 'star flag', run: () => toggleFlag([detail]) },
        { label: '标为未读', hint: 'U', icon: 'unread', keywords: 'unread', run: () => markSeen([detail], false) },
        { label: whole ? `删除整个会话（${detailThread.length} 封）` : '删除这封邮件', hint: 'Delete', icon: 'trash', keywords: 'delete', run: () => deleteRefs(detailThread) }
      )
      if (whole) list.push({ label: '只删除正在看的这一封', icon: 'trash', keywords: 'delete one', run: () => deleteRefs([detail]) })
      if (canArchive(detail)) list.push({ label: whole ? '归档整个会话' : '归档这封邮件', hint: 'E', icon: 'archive', keywords: 'archive done', run: () => archiveRefs(detailThread) })
    }
    if (view && !virtualView) {
      list.push(
        { label: '全部标为已读', icon: 'mailOpen', keywords: 'read all', run: markAllRead },
        { label: '刷新', icon: 'refresh', keywords: 'refresh reload', run: () => refreshView() },
        { label: '全选', hint: 'Ctrl+A', icon: 'checkCircle', keywords: 'select all', run: checkAll }
      )
    }
    if (accounts.length > 1) list.push({ label: '转到：所有收件箱', icon: 'inbox', keywords: 'inbox all', run: () => selectFolder(ALL, 'INBOX') })
    list.push({ label: '转到：主屏', icon: 'home', keywords: 'home', run: () => setHome(true) })
    if (Object.keys(data.pinned).length) list.push({ label: '转到：已置顶', icon: 'pin', keywords: 'pinned', run: () => selectFolder(PINNED, '') })
    if (snoozedCount) list.push({ label: '转到：稍后处理', icon: 'clock', keywords: 'snoozed', run: () => selectFolder(SNOOZED, '') })
    for (const a of accounts) {
      for (const f of folders[a.id] || []) {
        list.push({
          label: `转到：${f.displayName}`,
          hint: accounts.length > 1 ? a.email : undefined,
          icon: 'folder',
          keywords: f.path,
          run: () => selectFolder(a.id, f.path)
        })
      }
    }
    if (draftList.length) list.push({ label: '查看草稿', icon: 'drafts', keywords: 'draft', run: () => setShowDrafts(true) })
    if (scheduledList.length) list.push({ label: '查看定时发送', icon: 'sent', keywords: 'scheduled', run: () => setShowScheduled(true) })
    list.push(
      { label: '添加邮箱', icon: 'userPlus', keywords: 'account add', run: () => setDialog({ kind: 'add' }) },
      { label: '设置', icon: 'sliders', keywords: 'settings preferences', run: () => setDialog({ kind: 'settings' }) },
      { label: '设置：模板和快捷回复', icon: 'drafts', keywords: 'template', run: () => setDialog({ kind: 'settings', tab: 'compose' }) },
      { label: '设置：重要和屏蔽的发件人', icon: 'user', keywords: 'block vip sender', run: () => setDialog({ kind: 'settings', tab: 'senders' }) }
    )
    return list
  }

  const sidebar = (
    <Sidebar
      accounts={accounts}
      folders={folders}
      folderErrors={folderErrors}
      view={view}
      allUnseen={inboxUnseen}
      snoozedCount={snoozedCount}
      scheduledCount={scheduledList.length}
      onOpenSnoozed={() => selectFolder(SNOOZED, '')}
      onOpenScheduled={() => {
        setDrawer(false)
        setShowScheduled(true)
      }}
      onSelectAll={() => selectFolder(ALL, 'INBOX')}
      onFolderMenu={(id, path, x, y) => openFolderMenu({ accountId: id, folder: path }, x, y)}
      onAccountMenu={openAccountMenu}
      onSelect={(id, path) => selectFolder(id, path)}
      onRetry={(id) => {
        setFolderErrors((e) => ({ ...e, [id]: undefined }))
        void loadFolders(id)
      }}
      onCompose={() => {
        setDrawer(false)
        openCompose('new')
      }}
      onAddAccount={() => {
        setDrawer(false)
        setDialog({ kind: 'add' })
      }}
      onSettings={() => {
        setDrawer(false)
        setDialog({ kind: 'settings', tab: updateDue ? 'about' : undefined })
      }}
    />
  )

  return (
    <div className={`app ${wide ? 'wide' : 'split'} ${reading ? 'reading' : ''} ${home && accounts.length ? 'home-on' : ''}`}>
      <Rail
        active={railActive}
        unread={inboxUnseen}
        pinnedCount={0}
        snoozedCount={snoozedCount}
        draftsCount={draftList.length}
        scheduledCount={scheduledList.length}
        account={railAccount}
        accountTag={railAccount ? tags[railAccount.id] : undefined}
        onGo={onRail}
        onMore={() => setDrawer((v) => !v)}
        onScheduled={() => setShowScheduled(true)}
        onSettings={() => setDialog({ kind: 'settings', tab: updateDue ? 'about' : undefined })}
        updateReady={updateDue}
        onAccountMenu={openAccountSwitcher}
      />

      {update && updateStep && updateLater !== updateStep && dialog?.kind !== 'settings' && (
        <div className="update-banner" role="alert">
          <Icon name="refresh" size={16} />
          {update.state === 'available' && (
            <>
              <span>
                发现新版本 <strong>{update.version}</strong>
              </span>
              <button
                className="update-go"
                disabled={updateBusy}
                onClick={() => {
                  setUpdateBusy(true)
                  api.updateDownload().then(setUpdate).catch((err) => notify((err as Error).message, 'error')).finally(() => setUpdateBusy(false))
                }}
              >
                下载更新
              </button>
              <button className="update-later" onClick={() => setUpdateLater(updateStep)}>
                以后再说
              </button>
            </>
          )}
          {update.state === 'downloading' && (
            <>
              <span>
                正在下载新版本 <strong>{update.version}</strong>… {update.percent ? `${update.percent}%` : ''}
              </span>
              <button className="update-later" onClick={() => setUpdateLater(updateStep)}>
                隐藏
              </button>
            </>
          )}
          {update.state === 'ready' && (
            <>
              <span>
                新版本 <strong>{update.version}</strong> 已经下载好了，要现在重启更新吗？
              </span>
              <button className="update-go" onClick={() => api.updateInstall().catch((err) => notify((err as Error).message, 'error'))}>
                重启并更新
              </button>
              <button className="update-later" onClick={() => setUpdateLater(updateStep)}>
                稍后
              </button>
            </>
          )}
        </div>
      )}

      {drawer && (
        <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <div className="drawer">{sidebar}</div>
        </div>
      )}

      {home && accounts.length > 0 && (
        <Home
          unread={inboxUnseen}
          background={look.general.homeBackground}
          image={homeImage}
          onOpenInbox={() => {
            setHome(false)
            if (!view || !inboxView) goInbox()
          }}
          onCompose={() => openCompose('new')}
          onSearch={() => {
            setHome(false)
            if (!view) goInbox()
            setTimeout(() => searchRef.current?.focus(), 50)
          }}
        />
      )}

      {accounts.length === 0 ? (
        <main className="welcome">
          <div className="titlebar-drag" />
          <div className="welcome-card">
            <div className="welcome-mark">
              <Icon name="inbox" size={30} />
            </div>
            <h1>欢迎使用 Bluebird Mail</h1>
            <p>把 QQ、163、企业邮箱和 Gmail、Outlook 放在一个地方收发。先添加你的第一个邮箱吧。</p>
            <button className="primary-btn large" onClick={() => setDialog({ kind: 'add' })}>
              添加邮箱
            </button>
            <button className="link-btn welcome-restore" onClick={() => setDialog({ kind: 'settings', tab: 'backup' })}>
              以前用过 Bluebird Mail？从备份恢复
            </button>
          </div>
        </main>
      ) : (
        <>
          <MessageList
            title={title}
            subtitle={subtitle}
            messages={visible}
            previews={previews}
            tabs={tabs}
            tab={tab}
            onTab={(t) => {
              autoLoads.current = 0
              setTab(t)
              clearChecked()
            }}
            pinned={pinnedRows}
            threads={threadInfo}
            priority={prioritySet}
            snoozed={data.snoozed}
            selectedKey={selectedHeadKey}
            checked={checked}
            multi={multi}
            onToggleMulti={() => {
              if (multi) clearChecked()
              setMulti(!multi)
            }}
            showPreview={settings.reading.showPreview}
            compact={look.reading.density === 'compact'}
            wide={wide}
            bundles={bundles}
            smart={inboxView && !activeQuery ? !!settings.reading.smartInbox : undefined}
            onToggleSmart={toggleSmart}
            onBundleRead={(cat) => {
              const list = shown.filter((m) => m.category === cat && !m.seen)
              if (!list.length) return
              markSeen(list, true)
              notify(`已将 ${list.length} 封邮件标为已读`)
            }}
            onActions={() => setPalette(true)}
            onTitleClick={() => setDrawer(true)}
            onCompose={() => openCompose('new')}
            hasUnread={!virtualView && (unseenHere > 0 || flat.some((m) => !m.seen))}
            canBatchArchive={batchRefs.some((m) => canArchive(m))}
            canBatchMove={sameAccount(batchRefs)}
            onCheck={onCheck}
            onCheckAll={checkAll}
            onClearChecked={clearChecked}
            onBatch={onBatch}
            onContextMenu={openContextMenu}
            onMarkAllRead={markAllRead}
            onFolderMenu={(x, y) => view && openFolderMenu(view, x, y)}
            loading={listLoading}
            loadingMore={loadingMore}
            error={listError}
            hasMore={hasMore && !activeQuery}
            showRecipient={(m) => {
              const use = folderOf(m)?.specialUse
              return use === 'sent' || use === 'drafts'
            }}
            folderLabel={globalSearch ? (m) => folderOf(m)?.displayName || (m.folder === 'INBOX' ? '收件箱' : m.folder) : undefined}
            scope={virtualView ? undefined : searchScope}
            onScope={changeScope}
            accountMarks={unified || (globalSearch && accounts.length > 1) ? accountMarks : undefined}
            canArchive={(m) => canArchive(m)}
            query={query}
            searchActive={!!activeQuery}
            emptyText={pinnedView ? '还没有置顶的邮件。在邮件上点图钉就能置顶' : snoozedView ? '没有推迟的邮件。在邮件上点时钟可以稍后再处理' : undefined}
            searchRef={searchRef}
            onQueryChange={setQuery}
            onSearch={() => {
              if (!view) return
              const q = query.trim()
              setActiveQuery(q)
              detailReq.current++
              setSelectedKey(null)
              setDetail(null)
              clearChecked()
              // 上一次的结果先清掉，免得和新结果（或者当前文件夹的内容）混在一起
              if (q || activeQuery) setMessages([])
              setExtras(null)
              void loadList(view, q)
            }}
            onClearSearch={() => {
              setQuery('')
              if (activeQuery && view) {
                setActiveQuery('')
                // 搜索结果来自各个文件夹，不能留在列表里冒充当前文件夹的内容
                detailReq.current++
                setSelectedKey(null)
                setDetail(null)
                clearChecked()
                setMessages([])
                // 「稍后处理」「已置顶」在搜索期间已经清空了的话，就显示空的
                if (isVirtual(view.accountId) && !virtualKeys) setMessages([])
                else void loadList(view, '')
              }
            }}
            onSelect={(m) => openRow(m)}
            onHover={hoverRow}
            onAction={onRowAction}
            onLoadMore={(auto) => void loadMore(auto)}
            onRefresh={() => {
              // 手动刷新：先断开重连，邮箱服务器那边改过的设置才会生效
              const ids = view && !isVirtual(view.accountId) ? (view.accountId === ALL ? accounts.map((a) => a.id) : [view.accountId]) : []
              void api
                .reconnect(ids)
                .catch(() => undefined)
                .finally(() => {
                  refreshView()
                  notify('正在重新连接并刷新…')
                })
            }}
          />
          <Reader
            detail={shownDetail}
            translation={translatedNow ? 'on' : detail && tr?.key === keyOf(detail) ? 'loading' : 'off'}
            translationNote={
              tr?.data
                ? `已从${langName(tr.data.from)}翻译成${TARGET_LANGS.find((l) => l.id === settings.translate.target)?.label ?? '中文'}${tr.data.partial ? '（邮件比较长，只翻译了前面一部分）' : ''}`
                : ''
            }
            suggestTranslate={foreign && settings.translate.target.startsWith('ZH')}
            onTranslate={translateOpen}
            onShowOriginal={() => setTr(null)}
            account={detailAccount}
            accountTag={detailAccount ? tags[detailAccount.id] : undefined}
            showAccount={accounts.length > 1}
            loading={detailLoading}
            error={detailError}
            hasSelection={selectedKey != null}
            canArchive={canArchive(detail)}
            thread={readerThread}
            threadCount={detailThread.length}
            onOpenMember={(m) => void select(m)}
            onPreviewAttachment={(i) => previewAttachment(i)}
            unsubscribe={detail?.unsubscribe && !unsubscribed.has(detailSender) ? detail.unsubscribe : undefined}
            unsubscribed={!!detail?.unsubscribe && unsubscribed.has(detailSender)}
            unsubscribing={unsubscribing}
            onUnsubscribe={() => detail && unsubscribe(detail)}
            inviteStatus={detail?.invite ? data.invites?.[`${detail.invite.uid}|${detail.invite.sequence}`] : undefined}
            inviteBusy={inviteBusy}
            inviteMine={!!detail?.invite?.organizer && accounts.some((a) => a.email.toLowerCase() === detail.invite!.organizer!.address)}
            onInviteRespond={(answer) => detail && respondInvite(detail, answer)}
            onInviteOpen={() => detail && openInvite(detail)}
            gate={showGate}
            onAcceptSender={() => detailSender && acceptSender(detailSender)}
            onBlockSender={() => detailSender && blockSender(detailSender)}
            autoLoadImages={settings.reading.autoLoadImages}
            darkMail={look.reading.darkMail}
            onMore={openReaderMenu}
            onNavMenu={openNavMenu}
            onQuickMenu={openQuickMenu}
            seen={withState(detailThread).every((r) => r.seen !== false)}
            onToggleSeen={() => threadRow && toggleSeenRows([threadRow])}
            onBack={wide ? closeReader : undefined}
            pinned={detailPinned}
            snoozed={!!data.snoozed[detailKey]}
            quickReplies={data.quickReplies}
            onTogglePin={() => threadRow && togglePin([threadRow])}
            onSnooze={(x, y) => detail && openSnoozeMenu(detailThread, x, y)}
            onReply={() => openCompose('reply')}
            onReplyAll={() => openCompose('replyAll')}
            onForward={() => openCompose('forward')}
            onArchive={() => detail && archiveRefs(detailThread)}
            onDelete={() => detail && deleteRefs(detailThread)}
            onToggleFlag={() => detail && toggleFlag([detail])}
            onRetry={() => {
              const ref = selectedRef()
              if (ref) void select(ref)
            }}
            onSaveAttachment={(i) => openAttachment(i, true)}
            onOpenAttachment={(i) => openAttachment(i, false)}
            onRemoteImagesChange={(v) => (remoteAllowed.current = v)}
            onQuickReply={quickReply}
            onExpandReply={expandReply}
            aiReady={settings.ai.enabled}
            onAiReply={openAiReply}
            onAiSetup={() => setDialog({ kind: 'settings', tab: 'ai' })}
          />
        </>
      )}

      {compose && (
        <Composer
          init={compose}
          accounts={accounts}
          settings={settings.compose}
          signatureFor={signatureInner}
          templates={data.templates}
          aiReady={settings.ai.enabled}
          aiTone={settings.ai.tone}
          onSchedule={async (msg: OutgoingMessage, sendAt: number) => {
            setData(await api.scheduleAdd(msg, sendAt))
            setCompose(null)
            notify(`已安排在 ${friendlyTime(sendAt)} 发送`)
          }}
          onQueue={async (msg, draftId) => {
            await queueSend(msg, draftId)
            setCompose(null)
          }}
          onSaveDraft={saveDraft}
          onDiscardDraft={discardDraft}
          onClose={(saved) => {
            setCompose(null)
            if (saved) notify('已存为草稿')
          }}
          onSent={(msg) => {
            const r = compose.replyTo
            setCompose(null)
            notify(msg)
            setTimeout(() => {
              sentCache.current.clear()
              setSentTick((n) => n + 1)
            }, 5000)
            if (r) patchMessage({ accountId: r.accountId || compose.accountId, folder: r.folder, uid: r.uid }, { answered: true })
          }}
        />
      )}

      {dialog?.kind === 'add' && (
        <AddAccountDialog
          presets={presets}
          settings={settings}
          onClose={() => setDialog(null)}
          onDone={onAccountAdded}
          onOpenSettings={() => setDialog({ kind: 'settings', tab: 'oauth' })}
        />
      )}

      {dialog?.kind === 'settings' && (
        <SettingsDialog
          accounts={accounts}
          settings={settings}
          info={info}
          data={data}
          onSaveData={saveData}
          initialTab={dialog.tab}
          onClose={() => setDialog(null)}
          onSettingsSaved={setSettings}
          updateDue={updateDue}
          onAccountUpdated={onAccountUpdated}
          onAccountRemoved={onAccountRemoved}
          onAddAccount={() => setDialog({ kind: 'add' })}
          homeImage={homeImage}
          onHomeImage={setHomeImage}
          onPreviewHome={() => {
            setDialog(null)
            setHome(true)
          }}
          notify={notify}
          confirm={setConfirm}
          onPreview={setPreview}
        />
      )}

      {showScheduled && (
        <ScheduledDialog
          items={scheduledList}
          accounts={accounts}
          onClose={() => setShowScheduled(false)}
          confirm={setConfirm}
          onSendNow={async (id) => {
            try {
              setData(await api.scheduleSendNow(id))
              notify('已发送')
            } catch (err) {
              notify((err as Error).message, 'error')
            }
          }}
          onCancel={async (id) => {
            try {
              setData(await api.scheduleCancel(id))
              notify('已取消定时发送')
            } catch (err) {
              notify((err as Error).message, 'error')
            }
          }}
        />
      )}

      {showDrafts && (
        <DraftsDialog
          drafts={draftList}
          accounts={accounts}
          onClose={() => setShowDrafts(false)}
          confirm={setConfirm}
          onOpen={openDraft}
          onDelete={discardDraft}
          onDeleteMany={(ids) => saveData({ drafts: dataRef.current.drafts.filter((x) => !ids.includes(x.id)) })}
          onOpenServerDrafts={() => {
            setShowDrafts(false)
            const id = activeAccountId()
            const f = id ? folders[id]?.find((x) => x.specialUse === 'drafts') : undefined
            if (id && f) selectFolder(id, f.path)
            else notify('这个邮箱没有草稿箱文件夹', 'error')
          }}
        />
      )}

      {timePick && (
        <TimeDialog
          title={timePick.title}
          confirmLabel={timePick.confirmLabel}
          onCancel={() => setTimePick(null)}
          onPick={(ts) => {
            const run = timePick.onPick
            setTimePick(null)
            run(ts)
          }}
        />
      )}

      {palette && (
        <CommandPalette
          commands={buildCommands()}
          title={batchRefs.length ? `操作 · 已选 ${batchRefs.length} 封邮件` : detail ? `操作 · ${detail.subject || '（无主题）'}` : '操作'}
          onClose={() => setPalette(false)}
        />
      )}

      {viewer && (
        <AttachmentViewer
          key={viewer.index}
          state={viewer}
          onPrev={viewable.findIndex((a) => a.index === viewer.index) > 0 ? () => stepViewer(-1) : undefined}
          onNext={
            viewable.findIndex((a) => a.index === viewer.index) >= 0 && viewable.findIndex((a) => a.index === viewer.index) < viewable.length - 1
              ? () => stepViewer(1)
              : undefined
          }
          onSave={() => openAttachment(viewer.index, true)}
          onOpen={() => openAttachment(viewer.index, false)}
          onClose={() => setViewer(null)}
        />
      )}

      {prompt && <PromptDialog key={prompt.title} {...prompt} onCancel={() => setPrompt(null)} />}

      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const run = confirm.onConfirm
            setConfirm(null)
            run()
          }}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          t.kind === 'mail' ? (
            <button key={t.id} className="toast mail" onClick={t.onClick} title="点击打开">
              <span className="toast-mail-icon">
                <Icon name="unread" size={18} />
              </span>
              <span className="toast-mail-text">
                <strong>{t.title}</strong>
                <span>{t.text}</span>
              </span>
            </button>
          ) : t.kind === 'update' ? (
            <div key={t.id} className="toast undo">
              <span className="toast-undo-text">
                <strong>{t.text}</strong>
                <span>重启一下就能用上；不重启的话，下次退出时自动更新</span>
              </span>
              <button onClick={() => api.updateInstall().catch((err) => notify((err as Error).message, 'error'))}>重启并更新</button>
              <button className="toast-later" onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}>
                以后再说
              </button>
            </div>
          ) : t.kind === 'op' ? (
            <div key={t.id} className="toast undo">
              <span className="toast-undo-text">
                <strong>{t.text}</strong>
              </span>
              <button onClick={() => pendingOps.current.get(t.id)?.undo()} title="撤销（Ctrl+Z）">
                撤销
              </button>
            </div>
          ) : t.kind === 'undo' ? (
            <UndoToast key={t.id} subject={t.text} seconds={t.seconds ?? 5} onUndo={() => undoSend(t)} />
          ) : (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.kind === 'ok' && <Icon name="check" size={14} />}
              {t.text}
            </div>
          )
        ))}
      </div>
    </div>
  )
}

/** 点了发送以后的那几秒：显示倒计时和「撤销」；时间到了就变成「正在发送」，等主进程告诉我们结果 */
function UndoToast({ subject, seconds, onUndo }: { subject: string; seconds: number; onUndo: () => void }) {
  const [left, setLeft] = useState(seconds)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const end = Date.now() + seconds * 1000
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 200)
    return () => clearInterval(t)
  }, [seconds])
  const waiting = left > 0 && !busy
  return (
    <div className="toast undo">
      <span className="toast-undo-text">
        <strong>{waiting ? `${left} 秒后发出` : busy ? '正在撤销…' : '正在发送…'}</strong>
        <span>{subject}</span>
      </span>
      {waiting && (
        <button
          onClick={() => {
            setBusy(true)
            onUndo()
          }}
        >
          撤销
        </button>
      )}
    </div>
  )
}
