// 主进程入口：窗口、IPC、新邮件通知

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, Tray } from 'electron'
import { mkdir, rm, stat, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { pathToFileURL } from 'url'
import type {
  Account,
  AppInfo,
  ComposeAttachment,
  NewAccountInput,
  OAuthProvider,
  OutgoingMessage,
  ProxySettings,
  MessageDetail,
  MessageSummary,
  Result,
  AttachmentPreview,
  ScheduledMail,
  SendDoneEvent,
  Settings,
  UserData
} from '../shared/types'
import { DETAIL_VERSION } from '../shared/types'
import { buildReply, parseInvite } from './calendar'
import { randomUUID } from 'crypto'
import { BlockList, isIP } from 'net'
import { lookup } from 'dns/promises'
import { dropStateBackup, forgetAccountData, forgetFolderData, getData, updateData } from './userdata'
import {
  cacheSize,
  clearCache,
  getCachedDetail,
  getCachedFolders,
  getCachedList,
  putCachedDetail,
  putCachedFolders,
  putCachedList
} from './cache'
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { addOAuthAccount, addPasswordAccount, listPresets, reauthAccount, removeAccount, updateAccount, type AccountPatch } from './accounts'
import { detect } from './presets'
import { cancelOAuth } from './oauth'
import { cleanAi, dataDir, defaultSettingsCopy, getAccount, getAccounts, getSettings, getTranslateKey, saveSettings, setAiKey, setTranslateKey } from './store'
import { translateTexts, translateUsage } from './translate'
import { detectProxy, httpFetch, testProxy } from './net'
import { isKnownSender, listContacts, removeContact, searchContacts } from './contacts'
import { aiInfo, listModels, runAi, testAi, verifyKey } from './ai'
import { aiHost } from '../shared/ai'
import type { AiRequest } from '../shared/ai'
import { checkForUpdate, checkIfStale, downloadUpdate, initUpdater, installUpdate, updateStatus } from './updater'
import { allowPath, BACKUP_FILE, backupInfo, backupMeta, detectBackup, disableBackup, enableBackup, flushBackup, initBackup, restoreBackup, writeBackup } from './backup'
import { ICON_PNG_BASE64 } from './icon'
import { dropClient, startWatcher, stopAll, stopWatcher } from './mail/imap'
import {
  archiveMessage,
  deleteMessage,
  getAttachment,
  getMessage,
  PREFETCH_MAX_BYTES,
  getPreviews,
  getRawMessage,
  resetMemoryCaches,
  searchEverywhere,
  warmContacts,
  scanContacts,
  findSentReplies,
  createFolder,
  renameFolder,
  deleteFolder,
  forgetAccount,
  listByUids,
  listFolders,
  emptyFolder,
  listMessages,
  markAll,
  moveMessage,
  searchMessages,
  setFlag,
  summarizeUids
} from './mail/service'
import { sendMessage } from './mail/smtp'
import { applyRules, cleanRules, runOnInbox } from './rules'

const APP_ID = 'com.bluebird.desktop'
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
// 另开的附件预览窗口（看 PDF 用）
const viewers = new Set<BrowserWindow>()
let rendererCrashes = 0
let crashReset: NodeJS.Timeout | undefined

// 通知对象如果只放在局部变量里，可能在用户点击之前就被回收，点了没反应。这里统一留一份引用
const liveNotes = new Set<Notification>()
function showNote(options: { title: string; body?: string; silent?: boolean }, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  const note = new Notification(options)
  liveNotes.add(note)
  const done = (): void => {
    liveNotes.delete(note)
  }
  note.on('click', () => {
    done()
    onClick?.()
  })
  note.on('close', done)
  // 记下系统有没有真的把通知弹出来：Windows 的「请勿打扰」「专注助手」会悄悄吞掉，出问题时看日志就知道
  note.on('show', () => console.warn(`[通知] 系统已弹出：${options.title}`))
  note.on('failed', (_e, err) => {
    console.warn(`[通知] 系统通知弹出失败：${err}`)
    done()
  })
  // 兜底：有的系统不触发 close，十分钟后不再保留
  setTimeout(done, 10 * 60 * 1000)
  note.show()
}

const appIcon = () => nativeImage.createFromDataURL('data:image/png;base64,' + ICON_PNG_BASE64)

function showWindow(): void {
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// 安装版没有黑色窗口可以看输出，把警告和错误写到数据文件夹的 bluebird.log 里，出问题时方便排查
function setupFileLog(): void {
  if (!app.isPackaged) return
  const file = join(app.getPath('userData'), 'bluebird.log')
  // 日志超过 2 MB 就把旧的改名留一份，重新开始写，免得越积越大
  try {
    if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, join(app.getPath('userData'), 'bluebird.old.log'))
  } catch {
    // 改名失败就继续往后写
  }
  const write = (level: string, args: unknown[]): void => {
    try {
      const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      appendFileSync(file, `${new Date().toISOString()} [${level}] ${text}\n`)
    } catch {
      // 写日志失败就算了
    }
  }
  const { warn, error } = console
  console.warn = (...args: unknown[]) => {
    write('warn', args)
    warn(...args)
  }
  console.error = (...args: unknown[]) => {
    write('error', args)
    error(...args)
  }
  process.on('uncaughtException', (err) => write('crash', [err]))
  process.on('unhandledRejection', (err) => write('reject', [err]))
}

// 只允许运行一个实例：再次打开时激活已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', () => showWindow())

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload)
}

// 主屏的背景是深色画面，窗口右上角的按钮要换成浅色才看得清
let lightSymbols = false

function titleBarColors(): { color: string; symbolColor: string; height: number } {
  // 按钮区域的底色透明，直接透出界面本身的颜色
  const light = lightSymbols || nativeTheme.shouldUseDarkColors
  return { color: 'rgba(0,0,0,0)', symbolColor: light ? '#f2f2f4' : '#3a3a3c', height: 44 }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'Bluebird Mail',
    icon: appIcon(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    // 去掉系统标题栏，界面一直铺到顶部；右上角保留 Windows 自带的最小化/最大化/关闭按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win?.show())
  // 界面里的报错也记到日志里
  // 新旧版本的 Electron 传参方式不同：旧版是 (事件, 级别数字, 内容…)，新版把它们都放在事件对象里
  win.webContents.on('console-message', (e: { level?: unknown; message?: string }) => {
    const lv = e?.level
    const isError = typeof lv === 'number' ? lv >= 3 : lv === 'error'
    const text = e?.message ?? ''
    // 这两类是浏览器内核的例行提示，不是程序出错，记下来只会把日志撑大
    if (/ResizeObserver loop|Content Security Policy/i.test(text)) return
    if (isError) console.error(`[界面] ${text}`)
  })
  win.webContents.on('render-process-gone', (_e: unknown, details: { reason: string }) => {
    console.error(`[界面] 渲染进程退出：${details.reason}`)
    // 设置窗口里正在预览的颜色不能就这么留着，换回已保存的
    nativeTheme.themeSource = getSettings().general.theme
    // 界面崩了会变成一片空白，自动重新加载；连续崩溃就不再重试，避免死循环
    if (details.reason !== 'clean-exit' && !quitting && rendererCrashes++ < 3) {
      // 重新加载后稳定运行一分钟，就不算「连续崩溃」了
      clearTimeout(crashReset)
      crashReset = setTimeout(() => {
        rendererCrashes = 0
      }, 60000)
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.reload()
      }, 500)
    }
  })
  // 系统切换深色/浅色时，标题栏按钮颜色跟着变
  nativeTheme.on('updated', () => win?.setTitleBarOverlay(titleBarColors()))
  // 开启「关闭时缩到托盘」后，点关闭只是隐藏窗口，程序继续在后台收信
  win.on('close', (e) => {
    if (!quitting && getSettings().general.closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('focus', () => {
    win?.flashFrame(false)
    checkIfStale()
  })
  win.on('closed', () => {
    win = null
    // 主窗口关了，另开的附件预览窗口也跟着关
    for (const v of [...viewers]) if (!v.isDestroyed()) v.close()
  })

  // 邮件里的链接一律用系统浏览器打开；mailto 链接在本程序里写信
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('mailto:')) {
      send('compose:mailto', url)
    } else if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => undefined)
    }
    return { action: 'deny' }
  })

  // 防止界面被导航到别的页面
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => undefined)
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------- 新邮件监听 ----------------

/** 现在是否处于免打扰时间段（支持跨零点，比如 22:00 到 08:00） */
function inQuietHours(): boolean {
  const n = getSettings().notify
  if (!n.quietEnabled) return false
  const toMin = (t: string): number => {
    const [h, m] = t.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = toMin(n.quietStart)
  const end = toMin(n.quietEnd)
  if (start === end) return false
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

function watch(account: Account): void {
  startWatcher(
    account,
    async (incoming) => {
      console.warn(`[新邮件] ${account.email} 收到 ${incoming.length} 封`)
      let mails = incoming
      let gone = new Set<number>()
      // 先按邮件规则处理（最多等 8 秒，服务器慢的话不耽误提醒和刷新列表）
      try {
        const done = await Promise.race([
          applyRules(account, 'INBOX', incoming.map((m) => ({ uid: m.uid, from: `${m.fromName} ${m.address}`.trim().toLowerCase(), to: m.to, subject: m.subject }))),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
        ])
        // 已读的、规则要求不弹通知的、已经被移走的邮件不再提醒
        if (done) {
          mails = incoming.filter((m) => !done.quiet.has(m.uid))
          gone = done.gone
        }
      } catch (err) {
        console.warn(`[规则 ${account.email}] 执行失败：`, (err as Error).message)
      }
      const n = getSettings().notify
      // 屏蔽的发件人不提醒；开启「只通知真人来信」后，通知和订阅类邮件也不提醒（重要发件人除外）
      const d = getData()
      mails = mails.filter((m) => {
        if (d.blocked.includes(m.address) || d.blocked.includes('@' + (m.address.split('@')[1] || ''))) return false
        return !n.onlyPersonal || m.category === 'personal' || d.priority.includes(m.address)
      })
      const quiet = !n.enabled || inQuietHours()
      // 界面要刷新列表；该提醒的那几封也带过去，窗口里会弹一条提示
      const first = mails[0]
      // 新邮件的列表摘要：存进本地缓存（下次打开收件箱先显示的就是它），也随事件交给界面直接插进列表
      const fresh = incoming.filter((m) => m.summary && !gone.has(m.uid)).map((m) => m.summary as MessageSummary)
      if (fresh.length) {
        try {
          const cached = getCachedList(account.id, 'INBOX')
          if (cached) {
            const have = new Set(cached.messages.map((m) => m.uid))
            const add = fresh.filter((m) => !have.has(m.uid))
            if (add.length) putCachedList(account.id, 'INBOX', { ...cached, messages: [...add, ...cached.messages].slice(0, 100), total: cached.total + add.length })
          }
        } catch (err) {
          console.warn(`[新邮件] 更新本地缓存失败`, (err as Error).message)
        }
      }
      send('mail:new', {
        accountId: account.id,
        count: incoming.length,
        messages: fresh,
        notify: quiet || !first ? undefined : { count: mails.length, uid: first.uid, from: n.showContent ? first.from : '', subject: n.showContent ? first.subject : '' }
      })
      if (quiet || !mails.length) {
        console.warn(`[通知] ${account.email} 的 ${incoming.length} 封新邮件没有提醒：${!n.enabled ? '通知开关是关的' : quiet ? '在免打扰时间内' : '已读、被规则静音或被屏蔽'}`)
        return
      }
      // 窗口没在前面时，让任务栏图标闪一下
      if (win && !win.isDestroyed() && win.isVisible() && !win.isFocused()) win.flashFrame(true)
      if (!Notification.isSupported()) {
        console.warn('[通知] 这台电脑不支持系统通知')
        return
      }
      const silent = !n.sound
      const options = !n.showContent
        ? { title: 'Bluebird Mail', body: `${account.email} 有 ${mails.length} 封新邮件`, silent }
        : mails.length === 1
          ? { title: mails[0].from, body: mails[0].subject, silent }
          : { title: `${account.email} 收到 ${mails.length} 封新邮件`, body: mails.map((m) => m.subject).slice(0, 3).join('\n'), silent }
      const only = mails.length === 1 ? mails[0].uid : undefined
      showNote(options, () => {
        showWindow()
        send('mail:open', { accountId: account.id, folder: 'INBOX', uid: only })
      })
    },
    () => send('mail:changed', { accountId: account.id }),
    (client, uids) => summarizeUids(client, account, 'INBOX', uids)
  )
}

// 一个个错开启动：七八个邮箱同时去建立监听连接，会和正在加载邮件列表的连接抢网络（尤其是经过代理的时候）
let watchTimers: NodeJS.Timeout[] = []
function watchAll(): void {
  for (const t of watchTimers) clearTimeout(t)
  watchTimers = getAccounts().map((a, i) =>
    setTimeout(() => {
      const fresh = getAccount(a.id)
      if (fresh) watch(fresh)
    }, i * 1500)
  )
}

// ---------------- 定时任务：稍后处理到点、定时发送 ----------------

const pushData = (): void => send('data:changed', getData())

/** 邮件的键是「账号|文件夹|UID」，文件夹名里可能也有竖线，所以从两头拆 */
function parseKey(key: string): { accountId: string; folder: string; uid: number } {
  const first = key.indexOf('|')
  const last = key.lastIndexOf('|')
  return { accountId: key.slice(0, first), folder: key.slice(first + 1, last), uid: Number(key.slice(last + 1)) }
}

const sending = new Set<string>()
// 已经发出去的邮件对应的草稿。界面保存草稿时是整份列表一起交过来的，万一它手里的列表还是旧的，不能把这些草稿又带回来
const sentDrafts = new Set<string>()

// 因为网络没通而没发出去时，隔多久再试（分钟）。试完这几次还不行才标记为失败
const RETRY_MINUTES = [1, 2, 5, 10, 20, 30]
// 晚了不超过这么久的，打开程序后直接补发；更久的先问用户
const MISSED_HOURS = 12

// 正在发的邮件，退出程序前要等它们发完
const inflight = new Map<string, Promise<void>>()
// 这次运行里点「发送」排进来的邮件（用户就在跟前）。不在这里面的是上次没来得及发、这次补发的
const liveUndo = new Set<string>()

/**
 * manual：用户手动点的「立即发送」，失败了直接报错，不排队重试。
 * unattended：用户不在跟前（上次留下的补发、退出程序时赶着发）——暂时连不上就留在队列里过会儿再试，而不是当场报失败
 */
function sendScheduled(item: ScheduledMail, manual = false, unattended = false): Promise<void> {
  const running = inflight.get(item.id)
  if (running) return running
  const job = doSendScheduled(item, manual, unattended).finally(() => inflight.delete(item.id))
  inflight.set(item.id, job)
  return job
}

async function doSendScheduled(item: ScheduledMail, manual: boolean, unattended: boolean): Promise<void> {
  if (sending.has(item.id)) return
  sending.add(item.id)
  const subject = item.message.subject || '（无主题）'
  // 服务器是不是已经收下了。收下以后不管再出什么岔子，都不能再当成「没发出去」
  let accepted = false
  const remove = (): void => {
    const d = getData()
    const patch: Partial<UserData> = { scheduled: d.scheduled.filter((s) => s.id !== item.id) }
    // 「撤销发送」的邮件发出去了，对应的草稿就没用了
    if (item.undo && item.draftId) {
      sentDrafts.add(item.draftId)
      if (d.drafts.some((x) => x.id === item.draftId)) patch.drafts = d.drafts.filter((x) => x.id !== item.draftId)
    }
    updateData(patch)
    // 上一版 state.json 的备份里还有这封信：万一以后主文件读不出来、退回去用备份，不能把它再发一遍
    if (item.undo) dropStateBackup()
  }
  const announce = (): void => {
    if (!item.undo) return
    const r = item.message.replyTo
    const done: SendDoneEvent = {
      id: item.id,
      ok: true,
      replyTo: r ? { accountId: r.accountId || item.message.accountId, folder: r.folder, uid: r.uid } : undefined
    }
    send('send:done', done)
  }
  try {
    const account = getAccount(item.message.accountId)
    if (!account) throw new Error('发件账号已被删除')
    // 服务器一收下就把它移出队列：后面存「已发送」可能要很久，这期间退出程序不能导致下次启动再发一遍
    await sendMessage(account, item.message, {
      onAccepted: () => {
        accepted = true
        // 先告诉界面「已发送」，不用等存「已发送」文件夹
        announce()
        remove()
        pushData()
      }
    })
    if (!accepted) {
      accepted = true
      announce()
    }
    remove()
    if (!item.undo) showNote({ title: '定时邮件已发送', body: subject, silent: true })
  } catch (err) {
    const error = (err as Error).message
    if (accepted) {
      // 信已经发出去了，只是收尾（多半是写本机的记录）出了问题
      console.warn('邮件已发出，但收尾时出错', error)
      return
    }
    const tries = item.tries ?? 0
    const retryable =
      !manual && (!item.undo || unattended) && (err as { retryable?: boolean }).retryable === true && tries < RETRY_MINUTES.length
    if (retryable) {
      // 多半是刚开机、刚唤醒，网络或代理还没准备好：过一会儿自动再试
      const retryAt = Date.now() + RETRY_MINUTES[tries] * 60 * 1000
      updateData({ scheduled: getData().scheduled.map((s) => (s.id === item.id ? { ...s, tries: tries + 1, retryAt } : s)) })
      console.warn(`邮件暂时没发出去，${RETRY_MINUTES[tries]} 分钟后重试：${error}`)
    } else if (item.undo) {
      // 刚点「发送」的邮件没发出去：不留在定时队列里，内容还在草稿里，让用户改了再发
      updateData({ scheduled: getData().scheduled.filter((s) => s.id !== item.id) })
      dropStateBackup()
      const done: SendDoneEvent = { id: item.id, ok: false, error, draftId: item.draftId }
      send('send:done', done)
      if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) {
        showNote({ title: '邮件没有发出去', body: `${subject}\n${error}\n内容还在草稿里` }, () => showWindow())
      }
    } else {
      updateData({ scheduled: getData().scheduled.map((s) => (s.id === item.id ? { ...s, error, held: undefined, retryAt: undefined } : s)) })
      showNote({ title: '定时邮件发送失败', body: `${subject}\n${error}` }, () => showWindow())
    }
  } finally {
    sending.delete(item.id)
    liveUndo.delete(item.id)
    pushData()
  }
}

function tick(): void {
  const now = Date.now()
  const d = getData()

  // 推迟的邮件到点了：放回收件箱、标为未读、弹提醒
  const due = Object.entries(d.snoozed).filter(([, s]) => s.until <= now)
  if (due.length) {
    const rest = { ...d.snoozed }
    for (const [key] of due) delete rest[key]
    updateData({ snoozed: rest })
    pushData()
    for (const [key, info] of due) {
      const ref = parseKey(key)
      const account = getAccount(ref.accountId)
      if (!account) continue
      // 一个会话一起推迟的：只提醒最新的那一封，其余的悄悄回到列表里
      if (info.quiet) {
        send('mail:changed', { accountId: ref.accountId })
        continue
      }
      const unread = (): Promise<void> => setFlag(account, ref.folder, ref.uid, 'seen', false)
      unread()
        // 刚开机、刚唤醒时网络可能还没好：一分钟后再试一次
        .catch(() => new Promise<void>((resolve) => setTimeout(resolve, 60000)).then(unread))
        .catch((err) => console.warn('稍后处理到点，但没能把邮件标为未读', (err as Error).message))
        .finally(() => send('mail:changed', { accountId: ref.accountId }))
      if (getSettings().notify.enabled) {
        showNote({ title: `提醒：${info.from}`, body: info.subject || '（无主题）', silent: !getSettings().notify.sound }, () => {
          showWindow()
          send('mail:open', { accountId: ref.accountId, folder: ref.folder, uid: ref.uid })
        })
      }
    }
  }

  // 定时发送：到点的发出去。网络问题会自动重试几次；其他失败等用户处理
  const missed: ScheduledMail[] = []
  for (const item of d.scheduled) {
    if (item.sendAt > now || item.error || (item.retryAt ?? 0) > now || sending.has(item.id)) continue
    // 点了「发送」、还没来得及发就退出了程序的邮件：用户本来就是要立刻发的，不管隔了多久都补发
    if (item.undo) {
      void sendScheduled(item, false, !liveUndo.has(item.id))
      continue
    }
    // 程序没开或电脑睡着，错过了很久：不自作主张补发，等用户决定（按最后一次打算发送的时间算，重试过的也一样）
    if (now - Math.max(item.sendAt, item.retryAt ?? 0) > MISSED_HOURS * 3600 * 1000) missed.push(item)
    else void sendScheduled(item)
  }
  if (missed.length) {
    const ids = new Set(missed.map((m) => m.id))
    const error = `已经过了计划时间 ${MISSED_HOURS} 个多小时（当时 Bluebird Mail 没有运行），没有自动发出。`
    updateData({ scheduled: getData().scheduled.map((s) => (ids.has(s.id) ? { ...s, error, held: true } : s)) })
    pushData()
    showNote(
      { title: '有定时邮件错过了发送时间', body: missed.map((m) => m.message.subject || '（无主题）').slice(0, 3).join('\n') },
      () => showWindow()
    )
  }
}

// ---------------- 让设置生效 ----------------

function applySettings(): void {
  const g = getSettings().general
  nativeTheme.themeSource = g.theme

  if (g.closeToTray && !tray) {
    tray = new Tray(appIcon().resize({ width: 16, height: 16 }))
    tray.setToolTip('Bluebird Mail')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 Bluebird Mail', click: () => showWindow() },
        {
          label: '写邮件',
          click: () => {
            showWindow()
            send('compose:new', null)
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true
            app.quit()
          }
        }
      ])
    )
    tray.on('click', () => showWindow())
  } else if (!g.closeToTray && tray) {
    tray.destroy()
    tray = null
  }

  // 开发模式下登记开机启动会把 electron.exe 本身加进去，所以只对安装版生效
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: g.launchAtLogin })
  }
}

// ---------------- IPC ----------------

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_e, ...args): Promise<Result<R>> => {
    const started = Date.now()
    try {
      return { ok: true, data: await fn(...(args as A)) }
    } catch (err) {
      console.error(`[${channel}]`, err)
      return { ok: false, error: (err as Error)?.message || String(err) }
    } finally {
      // 哪一步慢了记到日志里，以后查「为什么卡」有据可依（只记是哪种操作和用时，不记内容）
      const ms = Date.now() - started
      // 打开邮件是用户直接等着的，1.2 秒就记；其余的 3 秒才记
      if (ms > (channel === 'mail:get' ? 1200 : 3000)) console.warn(`[慢] ${channel} 用了 ${(ms / 1000).toFixed(1)} 秒`)
    }
  })
}

// 内网、本机这类地址段：邮件里给的网址指向这些地方的话不替用户访问
const PRIVATE_NETS = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15]
] as [string, number][]) {
  PRIVATE_NETS.addSubnet(net, bits, 'ipv4')
}
for (const [net, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['64:ff9b::', 96]
] as [string, number][]) {
  PRIVATE_NETS.addSubnet(net, bits, 'ipv6')
}

function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '')
  const family = isIP(ip)
  if (family === 4) return PRIVATE_NETS.check(ip, 'ipv4')
  if (family !== 6) return false
  // 「::ffff:1.2.3.4」这种写法其实是 IPv4 地址
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return PRIVATE_NETS.check(mapped[1], 'ipv4')
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (hex) {
    const a = parseInt(hex[1], 16)
    const b = parseInt(hex[2], 16)
    return PRIVATE_NETS.check(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`, 'ipv4')
  }
  return PRIVATE_NETS.check(ip, 'ipv6')
}

/** 退订网址能不能替用户访问：必须是公网上的正常域名，解析出来的地址也不能是内网或本机 */
async function isSafePublicHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare)) return !isPrivateAddress(bare)
  // 没有点的主机名、本机和内网专用的后缀
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp|intranet|home\.arpa)$/.test(host)) return false
  try {
    const found = await lookup(host, { all: true })
    return found.length > 0 && found.every((a) => !isPrivateAddress(a.address))
  } catch {
    // 本机解析不出来（比如只有走代理才能解析）：交给后面的请求去试，域名本身看起来是正常的公网域名
    return true
  }
}

/** 交给界面之前：去掉只给主进程用的退订地址，补上「是不是陌生发件人」 */
function forReader(account: Account, detail: MessageDetail): MessageDetail {
  const { unsubscribeInfo: _info, inviteIcs: _ics, ...rest } = detail
  const sender = (detail.from[0]?.address || '').toLowerCase()
  const d = getData()
  const mine = getAccounts().some((a) => a.email.toLowerCase() === sender)
  const newSender =
    !!sender &&
    !mine &&
    // 订阅邮件有退订按钮就够了；机器发的通知也不用问
    !detail.unsubscribe &&
    !/(^|[-_.+])(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer(-daemon)?|postmaster|bounces?)([-_.+]|@)/i.test(sender) &&
    !d.priority.includes(sender) &&
    !d.blocked.includes(sender) &&
    !(d.accepted || []).includes(sender) &&
    !isKnownSender(sender)
  void account
  // 退订会联系谁：给界面一个只用来显示的说明（邮箱地址，或者网址的域名），让用户确认前看得到
  let unsubscribeTarget: string | undefined
  if (_info) {
    try {
      if (detail.unsubscribe === 'mail' && _info.mailto) unsubscribeTarget = decodeURIComponent(_info.mailto.replace(/^mailto:/i, '').split('?')[0]).slice(0, 120)
      else if (_info.url) unsubscribeTarget = new URL(_info.url).hostname
    } catch {
      // 地址写得不规范就不显示
    }
  }
  return { ...rest, newSender, unsubscribeTarget }
}

function need(accountId: string): Account {
  const a = getAccount(accountId)
  if (!a) throw new Error('账号不存在')
  return a
}

// 双击就能执行代码、或者能绕过系统安全提示的文件类型：不直接打开，只允许另存
const DANGEROUS_EXT = new Set(
  (
    '.exe .bat .cmd .com .scr .pif .js .jse .vbs .vbe .vb .wsf .wsh .ws .wsc .sct .ps1 .psm1 .ps1xml .msi .msp .msc .lnk .hta .jar .reg .cpl ' +
    '.chm .url .scf .inf .gadget .application .appref-ms .appx .msix .appinstaller .iso .img .vhd .vhdx .xll .settingcontent-ms .library-ms .diagcab .py .pyw'
  ).split(' ')
)

/**
 * 给从邮件里存下来的文件打上「来自互联网」的标记（和浏览器下载的文件一样），
 * 这样 Office 会用受保护视图打开，Windows 运行它之前也会先提醒
 */
async function markFromInternet(file: string): Promise<void> {
  if (process.platform !== 'win32') return
  await writeFile(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => undefined)
}

// 可以直接在界面里看的图片（类型按扩展名定，不信邮件里自己写的）
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}
const TEXT_EXT = new Set(['.txt', '.log', '.csv', '.md', '.json', '.xml', '.ini', '.yml', '.yaml'])

let pdfSes: ReturnType<typeof session.fromPartition> | null = null
/** 看 PDF 的窗口用单独的一套网络环境：只许读本机的这个文件，任何联网请求都拦掉（PDF 自己也不能往外发东西） */
function pdfSession(): ReturnType<typeof session.fromPartition> {
  if (!pdfSes) {
    pdfSes = session.fromPartition('bluebird-pdf-viewer')
    pdfSes.webRequest.onBeforeRequest((details, done) => {
      done({ cancel: /^(https?|wss?|ftp):/i.test(details.url) })
    })
  }
  return pdfSes
}

function safeFilename(name: string): string {
  return (name || '附件').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180)
}

function registerIpc(): void {
  const info = (): AppInfo => ({ version: app.getVersion(), dataDir: dataDir(), packaged: app.isPackaged })

  handle('app:state', () => ({
    accounts: getAccounts(),
    settings: getSettings(),
    presets: listPresets(),
    info: info(),
    data: getData(),
    // 上次缓存的文件夹列表，界面可以立刻显示出来
    folders: Object.fromEntries(getAccounts().map((a) => [a.id, getCachedFolders(a.id) ?? null]))
  }))

  // 界面只能改这几项；定时发送队列由主进程自己管理
  handle('data:update', (patch: Partial<UserData>) => {
    const allowed: Partial<UserData> = {}
    if (patch.pinned) allowed.pinned = patch.pinned
    if (patch.snoozed) allowed.snoozed = patch.snoozed
    if (patch.priority) allowed.priority = patch.priority
    if (patch.blocked) allowed.blocked = patch.blocked
    if (patch.templates) allowed.templates = patch.templates
    if (patch.quickReplies) allowed.quickReplies = patch.quickReplies
    if (patch.drafts) allowed.drafts = patch.drafts.filter((x) => !sentDrafts.has(x.id))
    if (patch.accepted) allowed.accepted = patch.accepted
    if (patch.rules) allowed.rules = cleanRules(patch.rules)
    return updateData(allowed)
  })

  // 对收件箱里现有的邮件运行一次规则（只看最新的一页）
  handle('rules:run', async () => {
    let handled = 0
    for (const a of getAccounts()) {
      try {
        handled += await runOnInbox(a)
      } catch (err) {
        console.warn(`[规则 ${a.email}] 运行失败：`, (err as Error).message)
      }
    }
    return handled
  })

  handle('schedule:add', (message: OutgoingMessage, sendAt: number) => {
    need(message.accountId)
    if (!message.to.trim() && !message.cc.trim() && !message.bcc.trim()) throw new Error('请至少填写一个收件人')
    return updateData({ scheduled: [...getData().scheduled, { id: randomUUID(), sendAt, message }] })
  })
  // 撤销发送：点「发送」后先等几秒再真正发出。放进和定时发送同一个队列里，这样即使这几秒里退出了程序，下次打开也会补发
  handle('send:later', (message: OutgoingMessage, seconds: number, draftId?: string) => {
    need(message.accountId)
    if (!message.to.trim() && !message.cc.trim() && !message.bcc.trim()) throw new Error('请至少填写一个收件人')
    const wait = Math.min(60, Math.max(1, Math.round(Number(seconds) || 5))) * 1000
    const item: ScheduledMail = {
      id: randomUUID(),
      sendAt: Date.now() + wait,
      message,
      undo: true,
      draftId: typeof draftId === 'string' ? draftId : undefined
    }
    liveUndo.add(item.id)
    const data = updateData({ scheduled: [...getData().scheduled, item] })
    setTimeout(() => {
      const current = getData().scheduled.find((s) => s.id === item.id)
      if (current) void sendScheduled(current)
    }, wait)
    return { id: item.id, data }
  })
  handle('send:undo', (id: string) => {
    if (sending.has(id)) throw new Error('来不及了，这封邮件已经在发送')
    if (!getData().scheduled.some((s) => s.id === id)) throw new Error('来不及了，这封邮件已经发出去了')
    liveUndo.delete(id)
    const data = updateData({ scheduled: getData().scheduled.filter((s) => s.id !== id) })
    // 上一版 state.json 的备份里还留着这封信，删掉它：撤销了的信绝不能因为读了旧备份又被发出去
    dropStateBackup()
    return data
  })
  handle('schedule:cancel', (id: string) => updateData({ scheduled: getData().scheduled.filter((s) => s.id !== id) }))
  handle('schedule:sendNow', async (id: string) => {
    const item = getData().scheduled.find((s) => s.id === id)
    if (!item) throw new Error('这封定时邮件已经不在队列里了')
    if (sending.has(id)) throw new Error('这封邮件正在发送中，请稍候')
    updateData({ scheduled: getData().scheduled.map((s) => (s.id === id ? { ...s, error: undefined, held: undefined, retryAt: undefined, tries: 0 } : s)) })
    await sendScheduled({ ...item, error: undefined }, true)
    const failed = getData().scheduled.find((s) => s.id === id)
    if (failed?.error) throw new Error(failed.error)
    return getData()
  })
  handle('mail:listByUids', (accountId: string, folder: string, uids: number[]) => listByUids(need(accountId), folder, uids))


  handle('settings:defaults', () => defaultSettingsCopy())
  handle('settings:save', (settings: Settings) => {
    const before = JSON.stringify(getSettings().proxy)
    saveSettings(settings)
    applySettings()
    // 只有代理变了才需要重新建立连接
    if (JSON.stringify(getSettings().proxy) !== before) {
      for (const a of getAccounts()) dropClient(a.id)
      watchAll()
    }
    return getSettings()
  })

  // 主屏背景图：选好的图片缩小后存到数据文件夹，界面用 data URL 显示
  const homeImageFile = (): string => join(dataDir(), 'home-background.jpg')
  const readHomeImage = (): string | null =>
    existsSync(homeImageFile()) ? 'data:image/jpeg;base64,' + readFileSync(homeImageFile()).toString('base64') : null

  handle('home:image', () => readHomeImage())
  handle('home:pick', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: '选择主屏背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    let img = nativeImage.createFromPath(res.filePaths[0])
    if (img.isEmpty()) throw new Error('这张图片打不开，请换一张 JPG 或 PNG 图片')
    // 太大的照片缩到 2560 像素宽，够清晰又不占地方
    if (img.getSize().width > 2560) img = img.resize({ width: 2560, quality: 'best' })
    writeFileSync(homeImageFile(), img.toJPEG(88))
    return readHomeImage()
  })
  handle('home:clear', () => {
    if (existsSync(homeImageFile())) unlinkSync(homeImageFile())
    return true
  })

  handle('window:controls', (light: boolean) => {
    lightSymbols = !!light
    win?.setTitleBarOverlay(titleBarColors())
    return true
  })

  handle('proxy:test', (proxy: ProxySettings) => testProxy(proxy))
  handle('proxy:detect', () => detectProxy())

  handle('app:openDataDir', async () => {
    const err = await shell.openPath(dataDir())
    if (err) throw new Error(err)
    return true
  })

  handle('accounts:detect', (email: string) => detect(email))

  handle('accounts:addPassword', async (input: NewAccountInput) => {
    const account = await addPasswordAccount(input)
    watch(account)
    return account
  })

  handle('accounts:addOAuth', async (provider: OAuthProvider, name?: string) => {
    const account = await addOAuthAccount(provider, name)
    watch(account)
    return account
  })

  handle('accounts:cancelOAuth', () => cancelOAuth())

  handle('accounts:reauth', async (id: string) => {
    const account = await reauthAccount(id)
    watch(account)
    return account
  })

  handle('accounts:update', async (id: string, patch: AccountPatch) => {
    const account = await updateAccount(id, patch)
    watch(account)
    return account
  })

  handle('accounts:remove', (id: string) => {
    stopWatcher(id)
    removeAccount(id)
    forgetAccountData(id)
    clearCache(id)
    pushData()
    return true
  })

  handle('mail:folders', async (accountId: string) => {
    const folders = await listFolders(need(accountId))
    putCachedFolders(accountId, folders)
    return folders
  })
  handle('mail:list', async (accountId: string, folder: string, before?: number) => {
    const page = await listMessages(need(accountId), folder, before)
    // 只缓存最新的一页，下次打开时先显示它
    if (!before) putCachedList(accountId, folder, page)
    return page
  })
  handle('cache:list', (accountId: string, folder: string) => getCachedList(accountId, folder) ?? null)
  handle('cache:info', () => cacheSize())
  handle('cache:clear', () => {
    resetMemoryCaches()
    clearCache()
    return cacheSize()
  })
  handle('mail:search', (accountId: string, folder: string, q: string) => searchMessages(need(accountId), folder, q))
  handle('mail:previews', (accountId: string, folder: string, uids: number[]) => getPreviews(need(accountId), folder, uids))
  handle('mail:get', async (accountId: string, folder: string, uid: number, markSeen?: boolean) => {
    const account = need(accountId)
    // 读过的邮件正文不会变，直接用缓存；已读标记在后台补上
    const cached = getCachedDetail(accountId, folder, uid)
    // 旧版本存下来的缓存里没有退订信息，遇到就重新取一次
    if (cached && cached.v === DETAIL_VERSION) {
      if (markSeen !== false) setFlag(account, folder, uid, 'seen', true).catch(() => undefined)
      return forReader(account, cached)
    }
    let detail: MessageDetail
    try {
      detail = await getMessage(account, folder, uid, markSeen !== false)
    } catch (err) {
      // 没连上服务器：旧缓存虽然没有退订信息，正文还是能看的
      if (cached) return forReader(account, cached)
      throw err
    }
    putCachedDetail(detail)
    return forReader(account, detail)
  })
  // 提前把马上可能要看的邮件取回来存好（鼠标停在上面、J/K 翻信时的前后几封）。不改已读状态，走后台连接，出错不吭声
  const prefetching = new Set<string>()
  handle('mail:prefetch', async (accountId: string, folder: string, uids: number[]) => {
    const account = need(accountId)
    const list = (Array.isArray(uids) ? uids : []).filter((u) => Number.isInteger(u) && u > 0).slice(0, 6)
    for (const uid of list) {
      const key = `${accountId}|${folder}|${uid}`
      if (prefetching.has(key)) continue
      const cached = getCachedDetail(accountId, folder, uid)
      if (cached && cached.v === DETAIL_VERSION) continue
      prefetching.add(key)
      try {
        const detail = await getMessage(account, folder, uid, false, { lane: 'bg', maxSize: PREFETCH_MAX_BYTES })
        putCachedDetail(detail)
      } catch {
        // 取不到就算了，真点开的时候会再取一次并报告错误
      } finally {
        prefetching.delete(key)
      }
    }
    return true
  })
  handle('mail:searchAll', (accountId: string, q: string) => searchEverywhere(need(accountId), String(q || '')))
  handle('contacts:search', (q: string) => searchContacts(String(q || '')))
  handle('contacts:list', () => listContacts())
  handle('contacts:remove', (address: string) => removeContact(String(address || '')))
  handle('contacts:scan', async () => {
    let seen = 0
    for (const a of getAccounts()) seen += await scanContacts(a).catch(() => 0)
    return { scanned: seen, total: listContacts().length }
  })

  // 退订：地址以邮件头里写的为准（重新从邮件里读，不用界面传来的），按能做到的最省事的方式来
  handle('mail:unsubscribe', async (accountId: string, folder: string, uid: number) => {
    const account = need(accountId)
    const cached = getCachedDetail(accountId, folder, uid)
    const detail = cached && cached.v === DETAIL_VERSION ? cached : await getMessage(account, folder, uid, false)
    const info = detail.unsubscribeInfo
    if (!info) throw new Error('这封邮件没有提供退订方式')
    if (info.oneClick && info.url) {
      const u = new URL(info.url)
      if (u.protocol !== 'https:' || u.username || u.password || !(await isSafePublicHost(u.hostname))) {
        throw new Error('这封邮件给的退订地址不正常，没有替你访问')
      }
      let res: Response
      try {
        res = await httpFetch(info.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
          // 不跟着跳转走（跳转可以把请求引到别的地方去），也不带任何登录信息
          redirect: 'error',
          credentials: 'omit',
          useProxy: account.useProxy,
          timeoutMs: 20000
        })
      } catch (err) {
        throw new Error(`没能连上对方的退订服务：${(err as Error).message || '请求失败'}`)
      }
      void res.body?.cancel().catch(() => undefined)
      if (!res.ok) throw new Error(`对方的退订服务没有接受这次请求（${res.status}）`)
      return 'done' as const
    }
    if (info.mailto) {
      const m = /^mailto:([^?]+)(?:\?(.*))?$/i.exec(info.mailto)
      const to = m ? decodeURIComponent(m[1]) : ''
      if (!/^[^@\s,;]+@[^@\s,;]+$/.test(to)) throw new Error('这封邮件给的退订地址不正常')
      const params = new URLSearchParams(m?.[2] || '')
      // 主题和正文按对方要求的写（有的退订系统靠里面的编号认人），但只留普通文字：去掉换行等控制字符，长度也有限
      const clean = (text: string | null, max: number, keepLines: boolean): string =>
        (text || '')
          .replace(keepLines ? /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]+/g : /[\x00-\x1f\x7f]+/g, ' ')
          .trim()
          .slice(0, max)
      const subject = clean(params.get('subject'), 150, false) || 'unsubscribe'
      const body = clean(params.get('body'), 500, true) || 'unsubscribe'
      await sendMessage(account, { accountId, to, cc: '', bcc: '', subject, html: '', text: body, attachments: [] }, { skipContacts: true })
      return 'mailed' as const
    }
    if (info.url && /^https?:\/\//i.test(info.url)) {
      await shell.openExternal(info.url)
      return 'opened' as const
    }
    throw new Error('这封邮件没有提供可用的退订方式')
  })
  // 日历邀请：回复「接受 / 待定 / 拒绝」。邀请内容以邮件原文为准（重新读，不用界面传来的），回复只发给邀请里写的组织者
  const inviteDetail = async (accountId: string, folder: string, uid: number): Promise<{ account: Account; detail: MessageDetail }> => {
    const account = need(accountId)
    const cached = getCachedDetail(accountId, folder, uid)
    const detail = cached && cached.v === DETAIL_VERSION ? cached : await getMessage(account, folder, uid, false)
    return { account, detail }
  }
  handle('invite:respond', async (accountId: string, folder: string, uid: number, answer: string) => {
    if (answer !== 'accepted' && answer !== 'tentative' && answer !== 'declined') throw new Error('不认识的回复方式')
    const { account, detail } = await inviteDetail(accountId, folder, uid)
    const parsed = detail.inviteIcs ? parseInvite(detail.inviteIcs) : undefined
    if (!parsed || parsed.invite.method !== 'REQUEST' || parsed.invite.cancelled) throw new Error('这封邮件不是可以回复的邀请')
    const organizer = parsed.invite.organizer
    if (!organizer) throw new Error('这个邀请没有写明组织者，没法回复')
    const mine = account.email.toLowerCase()
    const reply = buildReply(parsed, { name: account.name || '', address: parsed.attendeeAddresses.includes(mine) ? mine : account.email }, answer)
    await sendMessage(
      account,
      { accountId, to: organizer.address, cc: '', bcc: '', subject: reply.subject, html: '', text: reply.text, attachments: [], calendarReply: reply.ics },
      { skipContacts: true }
    )
    const key = `${parsed.invite.uid}|${parsed.invite.sequence}`
    const invites = { ...(getData().invites || {}), [key]: answer }
    // 只留最近的几百条
    const keys = Object.keys(invites)
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete invites[k]
    return updateData({ invites })
  })
  // 添加到日历：把邀请存成临时的 .ics，交给系统里的日历程序（Outlook、Windows 日历之类）打开
  handle('invite:open', async (accountId: string, folder: string, uid: number) => {
    const { detail } = await inviteDetail(accountId, folder, uid)
    if (!detail.inviteIcs || !parseInvite(detail.inviteIcs)) throw new Error('这封邮件里没有日历邀请')
    const file = join(app.getPath('temp'), `Bluebird-日历-${randomUUID().slice(0, 8)}.ics`)
    await writeFile(file, detail.inviteIcs, 'utf8')
    await markFromInternet(file)
    const err = await shell.openPath(file)
    // 程序有时要几秒才读完这个文件；过一阵再删
    setTimeout(() => void rm(file, { force: true }).catch(() => undefined), 10 * 60 * 1000)
    if (err) throw new Error('没有找到能打开日历文件的程序。可以先在 Windows 里装好 Outlook 或设置默认的日历应用')
    return true
  })

  handle('mail:flag', (accountId: string, folder: string, uids: number | number[], flag: 'seen' | 'flagged', value: boolean) =>
    setFlag(need(accountId), folder, uids, flag, value)
  )
  handle('mail:markAll', (accountId: string, folder: string, seen: boolean) => markAll(need(accountId), folder, seen))
  handle('mail:empty', (accountId: string, folder: string) => emptyFolder(need(accountId), folder))
  // 会话里你自己发出去的回复（在「已发送」里）。有的邮箱不支持这样查，没查成就返回空值（界面保持原样）
  handle('mail:threadSent', (accountId: string, ids: string[]) =>
    findSentReplies(need(accountId), Array.isArray(ids) ? ids.slice(0, 200) : []).catch(() => null)
  )
  // 文件夹：新建、改名、删除。改名和删除后，这个文件夹原来的缓存、置顶和推迟记录都作废
  const afterFolderChange = (accountId: string, folders: Awaited<ReturnType<typeof listFolders>>, gone?: string): typeof folders => {
    if (gone) {
      clearCache(accountId)
      forgetFolderData(accountId, gone)
      pushData()
    }
    putCachedFolders(accountId, folders)
    return folders
  }
  handle('folders:create', async (accountId: string, name: string, parent?: string) =>
    afterFolderChange(accountId, await createFolder(need(accountId), name, parent || undefined))
  )
  handle('folders:rename', async (accountId: string, path: string, name: string) => {
    const folders = await renameFolder(need(accountId), String(path), name)
    // 名字没变的话什么都没发生，原来的缓存和记录都留着
    return afterFolderChange(accountId, folders, folders.some((f) => f.path === String(path)) ? undefined : String(path))
  })
  handle('folders:delete', async (accountId: string, path: string, expectedTotal: number) =>
    afterFolderChange(accountId, await deleteFolder(need(accountId), String(path), Number(expectedTotal) || 0), String(path))
  )
  // 外观设置还没保存时先看看效果：只是临时换一下颜色，传空就换回已保存的
  handle('theme:preview', (theme: string | null) => {
    nativeTheme.themeSource = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : getSettings().general.theme
    return true
  })
  handle('mail:delete', (accountId: string, folder: string, uids: number | number[]) => deleteMessage(need(accountId), folder, uids))
  handle('mail:archive', (accountId: string, folder: string, uids: number | number[]) => archiveMessage(need(accountId), folder, uids))
  handle('mail:move', (accountId: string, folder: string, uids: number | number[], target: string) =>
    moveMessage(need(accountId), folder, uids, target)
  )
  handle('mail:send', (msg: OutgoingMessage) => sendMessage(need(msg.accountId), msg))

  handle('attachment:save', async (accountId: string, folder: string, uid: number, index: number) => {
    const att = await getAttachment(need(accountId), folder, uid, index)
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath('downloads'), safeFilename(att.filename || '附件'))
    })
    if (res.canceled || !res.filePath) return false
    await writeFile(res.filePath, att.content)
    await markFromInternet(res.filePath)
    return true
  })

  // 把邮件导出成 .eml 原文件，Outlook、Foxmail 等都能打开
  handle('mail:export', async (accountId: string, folder: string, uid: number, name: string) => {
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath('downloads'), safeFilename(name || '邮件') + '.eml'),
      filters: [{ name: '邮件文件', extensions: ['eml'] }]
    })
    if (res.canceled || !res.filePath) return false
    await writeFile(res.filePath, await getRawMessage(need(accountId), folder, uid))
    return true
  })

  // 打印 / 存成 PDF：在一个看不见的窗口里排版。这个窗口禁用脚本，邮件里的代码不会执行
  handle('mail:print', async (html: string, pdf: boolean, name: string) => {
    let target = ''
    if (pdf) {
      const res = await dialog.showSaveDialog(win!, {
        defaultPath: join(app.getPath('downloads'), safeFilename(name || '邮件') + '.pdf'),
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
      })
      if (res.canceled || !res.filePath) return false
      target = res.filePath
    }
    const dir = join(app.getPath('temp'), 'bluebird', 'print-' + Date.now())
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'mail.html')
    await writeFile(file, html, 'utf8')
    const pw = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    pw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 邮件里如果藏了自动跳转，不让它把这个窗口带到别的网页去
    pw.webContents.on('will-navigate', (e: { preventDefault(): void }) => e.preventDefault())
    const cleanup = (): void => {
      if (!pw.isDestroyed()) pw.destroy()
      void rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
    try {
      await pw.loadFile(file)
      if (pdf) {
        const data: Buffer = await pw.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
        await writeFile(target, data)
        return true
      }
      return await new Promise<boolean>((resolve, reject) => {
        pw.webContents.print({ printBackground: true }, (ok: boolean, reason: string) => {
          // 用户在打印对话框里点了取消不算出错
          if (ok || !reason || /cancel/i.test(reason)) resolve(ok)
          else reject(new Error(`打印失败：${reason}`))
        })
      })
    } finally {
      cleanup()
    }
  })

  // ---------- 备份与恢复 ----------
  handle('backup:info', () => backupInfo())
  handle('backup:detect', () => detectBackup())
  handle('backup:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: '选择存放备份的文件夹（建议选云盘的同步文件夹）',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    allowPath(res.filePaths[0])
    return res.filePaths[0]
  })
  handle('backup:enable', (folder: string, password?: string) => enableBackup(folder, password || undefined))
  handle('backup:disable', () => disableBackup())
  handle('backup:now', () => {
    writeBackup(true)
    return backupInfo()
  })
  handle('backup:pickFile', async () => {
    const cfg = backupInfo()
    const res = await dialog.showOpenDialog(win!, {
      title: '选择 Bluebird Mail 的备份文件',
      defaultPath: cfg.folder ? join(cfg.folder, BACKUP_FILE) : undefined,
      properties: ['openFile'],
      filters: [{ name: 'Bluebird 备份', extensions: ['bbk'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    allowPath(res.filePaths[0])
    return backupMeta(res.filePaths[0])
  })
  handle('backup:restore', (file: string, password: string) => {
    const before = getAccounts().map((a) => a.id)
    // 账号换了一批之后：连接、缓存和界面都按现在磁盘上的账号重新来一遍
    const resync = (): void => {
      stopAll()
      for (const id of before) forgetAccount(id)
      resetMemoryCaches()
      clearCache()
      // 自己选的主屏背景图不在备份里，这台电脑上没有的话就换回默认背景
      const s = getSettings()
      if (s.general.homeBackground === 'custom' && !existsSync(join(dataDir(), 'home-background.jpg'))) {
        saveSettings({ ...s, general: { ...s.general, homeBackground: 'auto' } })
      }
      applySettings()
      watchAll()
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.reload()
      }, 600)
    }
    try {
      const result = restoreBackup(file, password)
      resync()
      return result
    } catch (err) {
      // 密码不对、文件读不了这类情况什么都没动，直接把原因告诉用户；
      // 已经动过数据又退回去的，也要重新同步一遍，免得界面和后台对不上
      if ((err as { touched?: boolean }).touched) resync()
      throw err
    }
  })

  // 设置里的「发一条测试通知」：用来确认系统通知到底能不能弹出来
  // 翻译。密钥只进不出：界面只知道「填了没有」和最后四位
  const translateInfo = (): { hasKey: boolean; tail: string } => {
    const key = getTranslateKey() || ''
    return { hasKey: !!key, tail: key ? key.replace(/:fx$/, '').slice(-4) : '' }
  }
  handle('translate:info', () => translateInfo())
  handle('translate:setKey', async (key: string) => {
    const k = String(key || '').trim()
    if (k) {
      if (!/^[A-Za-z0-9:_-]{20,80}$/.test(k)) throw new Error('这不像是 DeepL 的密钥。密钥在 DeepL 网站的「账户 → API 密钥」里，一般是一长串字母数字，免费版以 :fx 结尾')
      // 先试一下能不能用，不能用就不保存
      await translateUsage(k)
    }
    setTranslateKey(k)
    return translateInfo()
  })
  handle('translate:usage', () => translateUsage())
  handle('translate:texts', (texts: string[], xml: boolean) => translateTexts(texts, !!xml))
  // AI 助手。密钥只进不出：界面只知道「填了没有」和最后四位
  handle('ai:info', (candidate: Settings['ai']) => aiInfo(cleanAi(candidate)))
  handle('ai:setKey', async (key: string, candidate: Settings['ai']) => {
    const k = String(key || '').trim()
    const ai = cleanAi(candidate)
    const host = aiHost(ai.baseUrl)
    if (!host) throw new Error('先填好接口地址，再保存密钥（密钥只会发到这个地址）')
    let note: string | undefined
    if (k) {
      if (k.length < 8 || k.length > 400 || /\s/.test(k)) throw new Error('这不像是一个 API 密钥。密钥是一长串字母数字，中间没有空格，请重新复制一下')
      // 先向服务商确认一下，不能用就不保存
      note = (await verifyKey(ai, k)).note
    }
    setAiKey(host, k)
    return { ...aiInfo(ai), note }
  })
  handle('ai:models', (candidate: Settings['ai']) => listModels(cleanAi(candidate)))
  handle('ai:test', (candidate: Settings['ai']) => testAi(cleanAi(candidate)))
  handle('ai:run', (req: AiRequest) => runAi(req))
  handle('update:status', () => updateStatus())
  handle('update:check', () => checkForUpdate(true))
  handle('update:download', () => downloadUpdate())
  handle('update:install', () => {
    if (inflight.size > 0 || getData().scheduled.some((x) => x.undo)) throw new Error('有邮件正在发送，等它发完再更新')
    // 这是真的要退出了：不能被「关闭时留在托盘」拦下来
    quitting = true
    installUpdate()
    return true
  })
  handle('notify:test', () => {
    if (!Notification.isSupported()) return { supported: false }
    showNote({ title: 'Bluebird Mail 测试通知', body: '能看到这一条，说明新邮件通知可以正常弹出。', silent: !getSettings().notify.sound }, () => showWindow())
    return { supported: true }
  })

  handle('clipboard:write', (text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  // 预览附件：图片和文字交给界面直接显示；PDF 另开一个只读的小窗口。都只是看，不会运行任何东西
  handle('attachment:preview', async (accountId: string, folder: string, uid: number, index: number): Promise<AttachmentPreview> => {
    const att = await getAttachment(need(accountId), folder, uid, index)
    const name = safeFilename(att.filename || '附件').replace(/[. ]+$/, '') || '附件'
    const ext = extname(name).toLowerCase()
    const image = IMAGE_TYPES[ext]
    if (image) {
      if (att.content.length > 15 * 1024 * 1024) throw new Error('这张图片太大了，请用「保存」或「用其他程序打开」来看')
      return { kind: 'image', name, url: `data:${image};base64,${att.content.toString('base64')}` }
    }
    if (TEXT_EXT.has(ext)) {
      const limit = 400 * 1024
      const part = att.content.subarray(0, limit)
      let text = part.toString('utf8')
      // 很多国内软件导出的文本、表格是 GBK 编码，按 UTF-8 读出来全是乱码时换 GBK 再读
      if ((text.match(/\ufffd/g) || []).length > 3) {
        try {
          text = new TextDecoder('gbk').decode(part)
        } catch {
          // 这个环境不支持 GBK 就还用原来的
        }
      }
      return { kind: 'text', name, text, truncated: att.content.length > limit }
    }
    if (ext === '.pdf') {
      const dir = join(app.getPath('temp'), 'bluebird', String(Date.now()))
      await mkdir(dir, { recursive: true })
      const file = join(dir, name)
      await writeFile(file, att.content)
      await markFromInternet(file)
      const v = new BrowserWindow({
        width: 1000,
        height: 820,
        title: name,
        icon: appIcon(),
        autoHideMenuBar: true,
        backgroundColor: '#525659',
        // 这个窗口只用来看 PDF：没有任何程序接口，也不允许跳转或再开新窗口
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true, session: pdfSession() }
      })
      v.setMenu(null)
      viewers.add(v)
      v.on('closed', () => {
        viewers.delete(v)
        void rm(dir, { recursive: true, force: true }).catch(() => undefined)
      })
      v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      v.webContents.on('will-navigate', (e) => e.preventDefault())
      // PDF 里的链接点了也不跳转（看 PDF 的部件在子框架里，要单独拦）
      v.webContents.on('will-frame-navigate', (e: { url: string; preventDefault: () => void }) => {
        if (/^(https?|ftp|mailto):/i.test(e.url)) e.preventDefault()
      })
      v.on('page-title-updated', (e) => e.preventDefault())
      try {
        // 文件名里可能有 %、# 这些符号，要换成规范的文件地址才打得开
        await v.loadURL(pathToFileURL(file).href)
      } catch (err) {
        if (!v.isDestroyed()) v.destroy()
        throw new Error(`没能打开预览：${(err as Error).message}。可以点附件右边的保存按钮存下来再看`)
      }
      return { kind: 'window', name }
    }
    throw new Error('这种文件不能直接预览，请用「打开」')
  })

  handle('attachment:open', async (accountId: string, folder: string, uid: number, index: number) => {
    const att = await getAttachment(need(accountId), folder, uid, index)
    // Windows 会忽略文件名结尾的点和空格，先去掉再判断类型，防止「xxx.exe.」这种写法蒙混过关
    const name = safeFilename(att.filename || '附件').replace(/[. ]+$/, '') || '附件'
    if (DANGEROUS_EXT.has(extname(name).toLowerCase())) {
      throw new Error('这是可执行文件，为了安全不直接打开。如果确认来源可靠，请先「保存」再自行处理。')
    }
    const dir = join(app.getPath('temp'), 'bluebird', String(Date.now()))
    await mkdir(dir, { recursive: true })
    const file = join(dir, name)
    await writeFile(file, att.content)
    await markFromInternet(file)
    const err = await shell.openPath(file)
    if (err) throw new Error(err)
    return true
  })

  handle('dialog:pickFiles', async (): Promise<ComposeAttachment[]> => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
    if (res.canceled) return []
    const out: ComposeAttachment[] = []
    for (const p of res.filePaths) {
      const s = await stat(p)
      out.push({ path: p, filename: basename(p), size: s.size })
    }
    return out
  })

  handle('shell:open', (url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    throw new Error('不支持的链接')
  })
}

// ---------------- 启动 ----------------

app.whenReady().then(() => {
  if (!gotLock) return
  setupFileLog()
  initBackup()
  // Windows 靠这个标识决定通知归谁。安装版用固定的标识（和开始菜单里的快捷方式对应）；
  // 没安装、直接运行的开发版没有快捷方式，用固定标识的话系统会把通知悄悄丢掉，所以改用程序自己的路径
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath)
  // 安装版不需要浏览器自带的菜单：否则 Ctrl+R 会刷新界面、Ctrl+W 会关窗口、Ctrl+Shift+I 会打开开发者工具
  if (app.isPackaged) Menu.setApplicationMenu(null)
  // 清掉以前「打开附件」「打印」留下的临时文件
  void rm(join(app.getPath('temp'), 'bluebird'), { recursive: true, force: true }).catch(() => undefined)
  registerIpc()
  let notifiedVersion = ''
  initUpdater((s) => {
    send('update:status', s)
    // 发现新版本、或者下载好了：窗口没在前面（缩在托盘里、被别的窗口盖住）时，用系统通知提醒一次
    if ((s.state === 'available' || s.state === 'ready') && s.version && `${s.state}${s.version}` !== notifiedVersion) {
      notifiedVersion = `${s.state}${s.version}`
      if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) {
        showNote(
          {
            title: s.state === 'available' ? 'Bluebird Mail 发现新版本' : 'Bluebird Mail 新版本已下载好',
            body: s.state === 'available' ? `${s.version} 可以更新了，点这里打开程序，再决定要不要下载` : `${s.version} 已经下载好，点这里打开程序，再点「重启并更新」`,
            silent: true
          },
          () => showWindow()
        )
      }
    }
  })
  applySettings()
  createWindow()
  watchAll()
  // 启动后稍等一下处理错过的定时任务，之后每 20 秒检查一次
  setTimeout(tick, 5000)
  setInterval(tick, 20000)
  // 稍后在后台把「已发送」里最近的收件人记成联系人（一个账号一个账号来，失败了也无所谓）
  setTimeout(() => {
    void (async () => {
      for (const a of getAccounts()) await warmContacts(a).catch(() => undefined)
    })()
  }, 25000)

  // 电脑睡眠唤醒后，旧连接基本都断了，全部重建
  powerMonitor.on('resume', () => {
    for (const a of getAccounts()) dropClient(a.id)
    watchAll()
    send('mail:changed', { accountId: '*' })
  })
})

app.on('window-all-closed', () => {
  // 收信的连接在 before-quit 里统一断开：有邮件还没发完的话，要先留着连接把它发完
  app.quit()
})

let flushedSends = false
let flushingSends = false

app.on('before-quit', (e) => {
  // 刚点了「发送」、还在可以撤销的那几秒里就退出程序：用户是要这封信发出去的，所以先把它发完再退出。
  // 正在发的邮件（包括定时邮件）也等它发完，免得发到一半被掐断
  const waiting = getData().scheduled.filter((x) => x.undo && !x.error && !sending.has(x.id) && (x.retryAt ?? 0) <= Date.now())
  if (!flushedSends && (waiting.length > 0 || inflight.size > 0)) {
    e.preventDefault()
    if (flushingSends) return
    flushingSends = true
    if (win && !win.isDestroyed()) win.hide()
    const jobs = [...inflight.values(), ...waiting.map((item) => sendScheduled(item, false, true))]
    const limit = new Promise<void>((resolve) => setTimeout(resolve, 45000))
    void Promise.race([Promise.allSettled(jobs).then(() => undefined), limit]).finally(() => {
      flushedSends = true
      quitting = true
      app.quit()
    })
    return
  }
  quitting = true
  // 还没来得及写的自动备份，退出前补上
  flushBackup()
  stopAll()
})
