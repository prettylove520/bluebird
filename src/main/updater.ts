// 自动更新：新版本由 GitHub 那边打包好放在仓库的「发布」里，这里负责发现、下载、安装。
// 只有安装版才更新；用「启动 Bluebird.bat」直接运行的开发版不参与。

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { proxyRoute } from './net'
import { getSettings } from './store'

let status: UpdateStatus = { state: app.isPackaged ? 'idle' : 'unsupported' }
let notify: (s: UpdateStatus) => void = () => undefined
let checking = false
let started = false
/** 这一轮检查是不是静默的（已经有待处理的新版本） */
let checkQuiet = false

let lastCheck = 0

function set(next: UpdateStatus): void {
  // 状态变化写进日志（下载进度不写），自动更新没动静时能从日志里看出卡在哪
  if (next.state !== status.state) console.warn('[更新] 状态：' + next.state + (next.version ? ` ${next.version}` : '') + (next.error ? ` ——${next.error}` : ''))
  status = next
  try {
    notify(status)
  } catch {
    // 界面还没准备好就算了，它打开设置时会自己来问
  }
}

export function updateStatus(): UpdateStatus {
  return status
}

/** 把更新过程中的各种报错换成看得懂的话 */
function friendly(err: unknown): string {
  const text = String((err as Error)?.message || err || '')
  if (/404|Cannot find .*latest\.yml|No published versions|HttpError: 406/i.test(text)) return '更新服务器上还没有发布过新版本'
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_PROXY|ERR_TUNNEL|ERR_INTERNET|net::/i.test(text)) {
    return getSettings().proxy.enabled
      ? '连不上更新服务器（GitHub）。请确认代理软件开着，过一会儿再试'
      : '连不上更新服务器（GitHub）。在国内一般要走代理：到「设置 → 代理」里启用后再试'
  }
  if (/sha512|checksum|signature/i.test(text)) return '下载下来的更新文件不完整，已经丢弃。过一会儿会重新下载'
  return `更新没有成功：${text.split('\n')[0].slice(0, 200)}`
}

/** 更新走不走代理跟着设置来：启用了代理就走代理（国内直连 GitHub 经常连不上） */
async function applyProxy(): Promise<void> {
  try {
    // 启用了代理就走代理；代理软件没开的话改回跟随系统，别让更新卡死在一条走不通的路上
    const route = await proxyRoute().catch(() => null)
    await autoUpdater.netSession.setProxy(route ? { proxyRules: route, proxyBypassRules: '<local>' } : { mode: 'system' })
  } catch {
    // 设置代理失败就按原样去连
  }
}

/**
 * 检查有没有新版本，有就在后台下载。manual：用户自己点的「检查更新」（关了自动更新也照样查）
 */
export async function checkForUpdate(manual = false): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  if (!manual && getSettings().general.autoUpdate === false) return status
  // 正在下载时不打断；其余情况（包括已经提示过、没更新的旧版本）都照常查，这样发了更新的版本就直接提示最新的
  if (checking || status.state === 'downloading') return status
  // 已经有「可下载 / 已下载」的版本时静默查：界面不闪、查不到也不报错，只在发现更新的版本时才换成它
  const quiet = status.state === 'available' || status.state === 'ready'
  checking = true
  lastCheck = Date.now()
  checkQuiet = quiet
  if (!quiet) set({ state: 'checking' })
  try {
    await applyProxy()
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.warn('[更新] 检查失败：' + String((err as Error)?.message || err).split('\n')[0])
    if (!quiet) set({ state: 'error', error: friendly(err), checkedAt: Date.now() })
  } finally {
    checking = false
    checkQuiet = false
  }
  return status
}

/** 用户点了「下载更新」：开始下载，下载好了会变成 ready，由用户决定要不要马上重启安装 */
export async function downloadUpdate(): Promise<UpdateStatus> {
  console.warn('[更新] 收到下载请求，当前状态：' + status.state)
  if (status.state !== 'available') return status
  set({ state: 'downloading', version: status.version, percent: 0 })
  try {
    await applyProxy()
    await autoUpdater.downloadUpdate()
  } catch (err) {
    console.warn('[更新] 下载失败：' + String((err as Error)?.message || err).split('\n')[0])
    // 下载途中 error 事件可能已经把状态改成出错了，没改的话这里补上
    if ((status as UpdateStatus).state === 'downloading') set({ state: 'error', error: friendly(err), version: status.version, checkedAt: Date.now() })
  }
  return status
}

/** 窗口被切回来时：离上次检查超过 10 分钟就再查一次（程序常年开着，光靠定时器容易错过） */
export function checkIfStale(): void {
  if (Date.now() - lastCheck > 10 * 60 * 1000) void checkForUpdate()
}

/** 退出程序并装上已经下载好的新版本，装完自动重新打开 */
export function installUpdate(): void {
  if (status.state !== 'ready') throw new Error('新版本还没有下载好')
  // 安装程序不弹窗口，装完自动打开
  autoUpdater.quitAndInstall(true, true)
}

export function initUpdater(onStatus: (s: UpdateStatus) => void): void {
  notify = onStatus
  if (!app.isPackaged || started) return
  started = true
  // 发现新版本先告诉用户，由用户决定下不下载；下载好了再问要不要马上重启
  autoUpdater.autoDownload = false
  // 下载好了但用户选了「稍后」：下次正常退出程序时会自动装上
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[更新]', m),
    warn: (m: unknown) => console.warn('[更新]', m),
    error: (m: unknown) => console.warn('[更新]', m),
    debug: () => undefined
  }
  autoUpdater.on('update-available', (info: { version: string }) => {
    // 查到的还是已经提示/下载好的那个版本：保持原状态，别把「已下载」退回「可下载」
    if (checkQuiet && status.version === info.version) return
    set({ state: 'available', version: info.version, checkedAt: Date.now() })
  })
  autoUpdater.on('update-not-available', () => {
    if (checkQuiet) return
    set({ state: 'latest', checkedAt: Date.now() })
  })
  autoUpdater.on('download-progress', (p: { percent: number }) => {
    const percent = Math.max(0, Math.min(100, Math.round(p.percent || 0)))
    // 进度变化不到 1% 就不通知界面，免得刷得太勤
    if (status.state === 'downloading' && status.percent !== percent) set({ ...status, percent })
  })
  autoUpdater.on('update-downloaded', (info: { version: string }) => set({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err: Error) => {
    console.warn('[更新] 出错：' + String(err?.message || err).split('\n')[0])
    // 已经下载好了的话，后面再报什么错都不影响安装
    if (checkQuiet) return
    if (status.state !== 'ready') set({ state: 'error', error: friendly(err), version: status.version, checkedAt: Date.now() })
  })
  // 打开程序 10 秒后查一次，之后每 15 分钟查一次（只是读一个很小的版本说明文件）；切回窗口时离上次超过 10 分钟也会查
  setTimeout(() => void checkForUpdate(), 10000)
  setInterval(() => void checkForUpdate(), 15 * 60 * 1000)
}
