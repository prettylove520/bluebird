import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account, AppInfo, ServerConfig, Settings, Template, UpdateStatus, UserData } from '../../../shared/types'
import { api } from '../api'
import { accountTags, tagMark } from '../utils'
import { TARGET_LANGS } from '../translate'
import { AI_PRESETS, AI_TONES, aiHost, isPresetModel, presetOf } from '../../../shared/ai'
import { HOME_SCENES, resolveScene, sceneForHour } from './Home'
import { Icon, type IconName } from './Icon'
import { BackupPanel } from './BackupPanel'
import { RulesPanel } from './RulesPanel'
import { ContactsPanel } from './ContactsPanel'

export type SettingsTab = 'general' | 'look' | 'reading' | 'compose' | 'translate' | 'ai' | 'notify' | 'senders' | 'rules' | 'contacts' | 'accounts' | 'proxy' | 'oauth' | 'backup' | 'about'

interface Props {
  accounts: Account[]
  settings: Settings
  info: AppInfo | null
  data: UserData
  onSaveData: (patch: Partial<UserData>) => void
  initialTab?: SettingsTab
  /** 有新版本等着处理：「关于」页签上亮红点，和左边栏设置按钮上的红点对上 */
  updateDue?: boolean
  onClose: () => void
  onSettingsSaved: (s: Settings) => void
  onAccountUpdated: (a: Account) => void
  onAccountRemoved: (id: string) => void
  onAddAccount: () => void
  homeImage: string | null
  onHomeImage: (image: string | null) => void
  /** 关掉设置，去主屏看效果 */
  onPreviewHome: () => void
  notify: (msg: string, kind?: 'ok' | 'error') => void
  /** 弹一个「确定吗」的确认框（删除模板之类的操作用） */
  confirm: (c: { title: string; message: string; confirmLabel: string; onConfirm: () => void }) => void
  /** 外观的改动还没保存时先让主界面按改的样子显示；传 null 表示还原 */
  onPreview: (s: Settings | null) => void
}

// 这几页的内容是「设置」：改完要点保存，也可以恢复默认。其余几页（账号、发件人、备份、关于）各有各的保存方式
const SETTING_TABS: SettingsTab[] = ['general', 'look', 'notify', 'reading', 'compose', 'translate', 'ai', 'proxy', 'oauth']

/** 把某一页的设置换成默认值，返回换好的整份设置 */
function resetTab(tab: SettingsTab, s: Settings, d: Settings): Settings {
  if (tab === 'general') {
    return {
      ...s,
      general: { ...s.general, closeToTray: d.general.closeToTray, launchAtLogin: d.general.launchAtLogin, autoUpdate: d.general.autoUpdate, defaultAccountId: d.general.defaultAccountId }
    }
  }
  if (tab === 'look') {
    return {
      ...s,
      general: { ...s.general, theme: d.general.theme, layout: d.general.layout, showHome: d.general.showHome, homeBackground: d.general.homeBackground },
      reading: { ...s.reading, density: d.reading.density, darkMail: d.reading.darkMail }
    }
  }
  if (tab === 'notify') return { ...s, notify: { ...d.notify } }
  if (tab === 'reading') return { ...s, reading: { ...d.reading, density: s.reading.density, darkMail: s.reading.darkMail } }
  if (tab === 'compose') return { ...s, compose: { ...d.compose } }
  if (tab === 'translate') return { ...s, translate: { ...d.translate } }
  // 开关和服务商选择回到默认；密钥不在这里，不受影响
  if (tab === 'ai') return { ...s, ai: { ...d.ai } }
  if (tab === 'proxy') return { ...s, proxy: { ...d.proxy } }
  return s
}

const same = (a: Settings, b: Settings): boolean => JSON.stringify(a) === JSON.stringify(b)

const TABS: { id: SettingsTab; label: string; icon: IconName; color: string; gap?: boolean }[] = [
  { id: 'accounts', label: '邮箱账号', icon: 'inbox', color: '#e0559a' },
  { id: 'senders', label: '发件人', icon: 'user', color: '#a66bf0' },
  { id: 'rules', label: '邮件规则', icon: 'bolt', color: '#a66bf0' },
  { id: 'contacts', label: '联系人', icon: 'user', color: '#e0559a' },
  { id: 'general', label: '通用', icon: 'sliders', color: '#4f8cff', gap: true },
  { id: 'look', label: '外观', icon: 'palette', color: '#4f8cff' },
  { id: 'notify', label: '通知', icon: 'bell', color: '#2aa7d8' },
  { id: 'reading', label: '阅读', icon: 'mailOpen', color: '#1fb5a5', gap: true },
  { id: 'compose', label: '写信', icon: 'pen', color: '#1fb5a5' },
  { id: 'translate', label: '翻译', icon: 'globe', color: '#1fb5a5' },
  { id: 'ai', label: 'AI 助手', icon: 'sparkle', color: '#a66bf0' },
  { id: 'proxy', label: '代理', icon: 'all', color: '#3dae6b', gap: true },
  { id: 'oauth', label: '浏览器登录', icon: 'external', color: '#3dae6b' },
  { id: 'backup', label: '备份与恢复', icon: 'share', color: '#e8a23a', gap: true },
  { id: 'about', label: '关于', icon: 'info', color: '#8a8f98' }
]

const SHORTCUTS: [string, string][] = [
  ['↑ ↓ 或 K J', '上一封 / 下一封'],
  ['N 或 C', '写邮件'],
  ['R / A / F', '回复 / 全部回复 / 转发'],
  ['T', '翻译 / 显示原文'],
  ['S', '加星标 / 取消星标'],
  ['U', '标为已读 / 未读'],
  ['P', '置顶 / 取消置顶'],
  ['H', '稍后处理'],
  ['Ctrl + K', '命令中心'],
  ['E', '归档'],
  ['Delete 或 #', '删除'],
  ['X', '勾选当前邮件'],
  ['Ctrl + 点击', '勾选多封邮件'],
  ['Shift + 点击', '连续勾选一段'],
  ['Ctrl + A', '全选'],
  ['Esc', '取消勾选'],
  ['/', '搜索'],
  ['Ctrl + Enter', '发送（写信时）']
]

/** 一行设置：左边是名称和说明，右边是控件 */
function TestNotifyButton() {
  const [state, setState] = useState<'idle' | 'sent' | 'unsupported'>('idle')
  return (
    <span className="test-notify">
      {state === 'sent' && <span className="muted small">已发出，看看屏幕右下角</span>}
      {state === 'unsupported' && <span className="form-error">这台电脑的系统通知不可用</span>}
      <button
        type="button"
        className="ghost-btn"
        onClick={() =>
          api
            .testNotify()
            .then((r) => setState(r.supported ? 'sent' : 'unsupported'))
            .catch(() => setState('unsupported'))
        }
      >
        发一条测试通知
      </button>
    </span>
  )
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SettingsDialog(props: Props) {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab || 'accounts')
  const [draft, setDraft] = useState<Settings>(props.settings)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  // 只有一个邮箱时直接展开它
  const [openAccount, setOpenAccount] = useState<string | null>(props.accounts.length === 1 ? props.accounts[0].id : null)
  // 默认设置（「恢复默认」用）
  const [defaults, setDefaults] = useState<Settings | null>(null)
  // 有修改没保存就要关窗口时，先问一句
  const [askClose, setAskClose] = useState(false)
  useEffect(() => {
    api
      .settingsDefaults()
      .then(setDefaults)
      .catch(() => undefined)
  }, [])

  // 改了以后先放在这里，点「保存」才真正生效
  const dirty = !same(draft, props.settings)
  // 外观（颜色、布局、密度、背景）改了马上就能在后面的主界面上看到效果，不保存的话关掉窗口就还原
  const themeDraft = draft.general.theme
  useEffect(() => {
    props.onPreview(dirty ? draft : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty])
  useEffect(() => {
    void api.previewTheme(themeDraft).catch(() => undefined)
  }, [themeDraft])
  useEffect(
    () => () => {
      props.onPreview(null)
      void api.previewTheme(null).catch(() => undefined)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const apply = (next: Settings): void => {
    setDraft(next)
    setAskClose(false)
  }

  /** 关窗口：有没保存的修改就先问 */
  const tryClose = (): void => {
    if (dirty) setAskClose(true)
    else props.onClose()
  }
  // Esc 关窗口也要经过上面那一问。主界面自己也在监听 Esc，所以要赶在它前面拦下来
  const guard = useRef({ dirty, saving })
  guard.current = { dirty, saving }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !guard.current.dirty) return
      // 上面还盖着确认框、菜单时，Esc 是给它们的
      if (document.querySelector('.dialog.confirm, .menu')) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      e.stopPropagation()
      e.preventDefault()
      setAskClose(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const setGeneral = (p: Partial<Settings['general']>): void => apply({ ...draft, general: { ...draft.general, ...p } })
  const setReading = (p: Partial<Settings['reading']>): void => apply({ ...draft, reading: { ...draft.reading, ...p } })
  const setCompose = (p: Partial<Settings['compose']>): void => apply({ ...draft, compose: { ...draft.compose, ...p } })
  const setNotify = (p: Partial<Settings['notify']>): void => apply({ ...draft, notify: { ...draft.notify, ...p } })
  const setTranslate = (p: Partial<Settings['translate']>): void => apply({ ...draft, translate: { ...draft.translate, ...p } })
  const setAi = (p: Partial<Settings['ai']>): void => apply({ ...draft, ai: { ...draft.ai, ...p } })

  /** 保存；成功返回 true */
  const saveNow = async (): Promise<boolean> => {
    setSaving(true)
    try {
      const s = await api.saveSettings(draft)
      props.onSettingsSaved(s)
      setDraft(s)
      setAskClose(false)
      props.notify('设置已保存')
      return true
    } catch (err) {
      props.notify((err as Error).message, 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  /** 把现在这一页换成默认值（还要点保存才生效，点「撤销修改」可以反悔） */
  const restoreTab = (): void => {
    if (!defaults) return
    const next = resetTab(tab, draft, defaults)
    if (same(next, draft)) props.notify('这一页已经是默认设置了')
    else {
      apply(next)
      props.notify('这一页已换回默认值，点「保存」后生效')
    }
  }

  /** 全部设置换成默认值：账号、代理地址、浏览器登录用的 Client ID 不动 */
  const restoreAll = (): void => {
    if (!defaults) return
    const next: Settings = { ...defaults, proxy: draft.proxy, oauth: draft.oauth, translate: draft.translate, ai: draft.ai }
    if (same(next, draft)) props.notify('所有设置已经是默认值了')
    else {
      apply(next)
      props.notify('全部设置已换回默认值，点「保存」后生效')
    }
  }

  const testProxy = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.testProxy(draft.proxy)
      setTestResult({
        ok: true,
        text: `代理可用（${r.kind === 'socks5' ? 'SOCKS5' : 'HTTP'}），访问 Google 用时 ${r.ms} 毫秒。${dirty ? '点「保存」让它生效。' : '这就是已经保存的设置，不用再保存。'}`
      })
    } catch (err) {
      setTestResult({ ok: false, text: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const detectProxy = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const found = await api.detectProxy()
      if (!found) {
        setTestResult({ ok: false, text: '没有找到正在运行的代理。请先打开代理软件（Clash、v2rayN 等），再点一次；或者在上面手动填它显示的端口' })
      } else {
        const saved = props.settings.proxy
        const unchanged = saved.enabled && saved.host === found.host && saved.port === found.port
        setDraft((d) => ({ ...d, proxy: { ...d.proxy, enabled: true, host: found.host, port: found.port } }))
        setTestResult({
          ok: true,
          text: `找到了 ${found.host}:${found.port}（${found.kind === 'socks5' ? 'SOCKS5' : 'HTTP'}，${found.source === 'system' ? '来自系统代理设置' : '常用端口'}）。` +
            (unchanged ? '和已经保存的设置一模一样，不用再保存（所以「保存」是灰的）。' : '已填好并启用，点「测试代理」确认能访问国外网站，再点「保存」。')
        })
      }
    } catch (err) {
      setTestResult({ ok: false, text: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const { general, reading, compose, notify } = draft

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && tryClose()}>
      <div className="dialog settings" role="dialog" aria-label="设置">
        <header className="dialog-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={tryClose} aria-label="关闭" title="关闭">
            <Icon name="x" />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`${tab === t.id ? 'active' : ''} ${t.gap ? 'gap' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="tab-icon" style={{ color: t.color }}>
                  <Icon name={t.icon} size={18} />
                </span>
                {t.label}
                {t.id === 'about' && props.updateDue && (
                  <span className="tab-badge" title="有新版本">
                    新版本
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="tab-body">
            {tab === 'general' && (
              <div className="set-list">
                <Row title="关闭窗口时留在托盘" hint="点关闭按钮后程序缩到右下角托盘，继续收信和弹通知。要彻底退出，右键托盘图标选「退出」">
                  <Switch label="关闭窗口时留在托盘" checked={general.closeToTray} onChange={(closeToTray) => setGeneral({ closeToTray })} />
                </Row>
                <Row
                  title="开机自动启动"
                  hint={props.info && !props.info.packaged ? '现在是开发运行方式，这一项要打包成安装程序后才会生效' : '登录 Windows 后自动打开 Bluebird Mail'}
                >
                  <Switch label="开机自动启动" checked={general.launchAtLogin} onChange={(launchAtLogin) => setGeneral({ launchAtLogin })} />
                </Row>
                <Row title="自动检查更新" hint="定时检查有没有新版本，有的话先提醒你，由你决定要不要下载；下载好以后再问你要不要马上重启安装。更新要连 GitHub，在国内一般需要开着代理">
                  <Switch label="自动检查更新" checked={general.autoUpdate !== false} onChange={(autoUpdate) => setGeneral({ autoUpdate })} />
                </Row>
                <Row title="更新提示自动隐藏" hint="左下角的新版本提示过一会儿自己收起来，不再一直挂着。收起后设置图标上的红点还在，到「设置 → 关于」随时可以更新">
                  <select value={String(general.updateHideSeconds ?? 15)} onChange={(e) => setGeneral({ updateHideSeconds: Number(e.target.value) })}>
                    <option value="8">8 秒后</option>
                    <option value="15">15 秒后</option>
                    <option value="30">30 秒后</option>
                    <option value="60">1 分钟后</option>
                    <option value="0">不自动隐藏</option>
                  </select>
                </Row>
                <Row title="恢复全部默认设置" hint="把通用、外观、通知、阅读、写信这几页全部换回刚装好时的样子。邮箱账号、代理地址、浏览器登录的 Client ID、模板和发件人名单都不会动">
                  <button className="ghost-btn bordered" onClick={restoreAll} disabled={!defaults}>
                    全部恢复默认
                  </button>
                </Row>
                <Row title="默认发件账号" hint="写新邮件时默认用哪个邮箱发出">
                  <select value={general.defaultAccountId} onChange={(e) => setGeneral({ defaultAccountId: e.target.value })}>
                    <option value="">当前查看的邮箱</option>
                    {props.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.email}
                      </option>
                    ))}
                  </select>
                </Row>
              </div>
            )}

            {tab === 'look' && (
              <div className="set-list">
                <Row title="颜色" hint="选择浅色或深色，或者跟随 Windows 的设置">
                  <Segmented
                    value={general.theme}
                    onChange={(theme) => setGeneral({ theme })}
                    options={[
                      { value: 'system', label: '跟随系统' },
                      { value: 'light', label: '浅色' },
                      { value: 'dark', label: '深色' }
                    ]}
                  />
                </Row>
                <Row title="布局" hint="整屏列表：邮件列表占满窗口，点开后整屏阅读。左右分栏：左边列表、右边阅读，两边同时看得到">
                  <Segmented
                    value={general.layout}
                    onChange={(layout) => setGeneral({ layout })}
                    options={[
                      { value: 'wide', label: '整屏列表' },
                      { value: 'split', label: '左右分栏' }
                    ]}
                  />
                </Row>
                <Row title="列表密度" hint="紧凑模式下一屏能看到更多邮件">
                  <Segmented
                    value={reading.density}
                    onChange={(density) => setReading({ density })}
                    options={[
                      { value: 'comfortable', label: '宽松' },
                      { value: 'compact', label: '紧凑' }
                    ]}
                  />
                </Row>
                <Row title="深色模式下邮件正文也用深色" hint="把邮件的白底变成深色，晚上看不刺眼，图片保持原样。个别排版复杂的邮件颜色可能不太准，可以关掉">
                  <Switch label="深色模式下邮件正文也用深色" checked={reading.darkMail} onChange={(darkMail) => setReading({ darkMail })} />
                </Row>
                <div className="set-block">
                  <div className="set-title">主屏背景</div>
                  <div className="set-hint">内置的几张是 Bluebird Mail 自己画的插画；想用喜欢的动画、游戏壁纸，点下面的「选择图片」换成自己的</div>
                  <div className="bg-grid">
                    {HOME_SCENES.map((sc) => (
                      <button
                        key={sc.id}
                        className={`bg-tile scene-${sc.id === 'auto' ? sceneForHour(new Date().getHours()) : sc.id} ${
                          general.homeBackground === sc.id || (sc.id === 'auto' && general.homeBackground !== 'custom' && resolveScene(general.homeBackground, 0) !== general.homeBackground) ? 'on' : ''
                        }`}
                        onClick={() => setGeneral({ homeBackground: sc.id })}
                        aria-pressed={general.homeBackground === sc.id}
                      >
                        <span>{sc.label}</span>
                      </button>
                    ))}
                    {props.homeImage && (
                      <button
                        className={`bg-tile scene-photo ${general.homeBackground === 'custom' ? 'on' : ''}`}
                        style={{ backgroundImage: `url("${props.homeImage}")` }}
                        onClick={() => setGeneral({ homeBackground: 'custom' })}
                        aria-pressed={general.homeBackground === 'custom'}
                      >
                        <span>我的图片</span>
                      </button>
                    )}
                  </div>
                  <div className="bg-actions">
                    <button
                      className="ghost-btn bordered"
                      onClick={() =>
                        api
                          .pickHomeImage()
                          .then((img) => {
                            if (!img) return
                            props.onHomeImage(img)
                            setGeneral({ homeBackground: 'custom' })
                          })
                          .catch((err) => props.notify((err as Error).message, 'error'))
                      }
                    >
                      <Icon name="image" />
                      {props.homeImage ? '换一张图片' : '选择图片'}
                    </button>
                    {props.homeImage && (
                      <button
                        className="ghost-btn"
                        onClick={() =>
                          api
                            .clearHomeImage()
                            .then(() => {
                              props.onHomeImage(null)
                              if (general.homeBackground === 'custom') setGeneral({ homeBackground: 'auto' })
                            })
                            .catch((err) => props.notify((err as Error).message, 'error'))
                        }
                      >
                        移除我的图片
                      </button>
                    )}
                    <span className="tool-gap" />
                    <button
                      className="link-btn"
                      onClick={async () => {
                        // 还没保存的背景要先保存，不然去主屏看到的还是旧的
                        if (dirty && !(await saveNow())) return
                        props.onPreviewHome()
                      }}
                    >
                      去主屏看效果
                    </button>
                  </div>
                </div>
                <Row title="启动时显示主屏" hint="打开 Bluebird Mail 先看到时间、问候和未读数，而不是直接进入收件箱">
                  <Switch label="启动时显示主屏" checked={general.showHome} onChange={(showHome) => setGeneral({ showHome })} />
                </Row>
              </div>
            )}

            {tab === 'reading' && (
              <div className="set-list">
                <Row title="智能收件箱" hint="未读的通知和订阅邮件折叠成收件箱顶上的一行，读过以后回到时间线里；真人来信始终直接列出。列表右上角的开关也能随时切换">
                  <Switch label="智能收件箱" checked={reading.smartInbox} onChange={(smartInbox) => setReading({ smartInbox })} />
                </Row>
                <Row title="邮件会话" hint="同一个话题来回的邮件在列表里合并成一行，点开后按先后顺序排在一起。在列表里删除、归档这一行，是对整个会话操作">
                  <Switch label="邮件会话" checked={reading.threads !== false} onChange={(threads) => setReading({ threads })} />
                </Row>
                <Row title="陌生发件人把关" hint="有人第一次给你来信时，在信的上方问一下「接受还是屏蔽」。通知、订阅这类机器发的邮件不会问">
                  <Switch label="陌生发件人把关" checked={reading.gatekeeper !== false} onChange={(gatekeeper) => setReading({ gatekeeper })} />
                </Row>
                <Row title="打开邮件时标为已读" hint="关闭后，邮件要手动标为已读">
                  <Switch label="打开邮件时标为已读" checked={reading.markReadOnOpen} onChange={(markReadOnOpen) => setReading({ markReadOnOpen })} />
                </Row>
                <Row title="自动显示远程图片" hint="开启后图片直接显示，但发件人可以借此知道你读了邮件；关闭时每封邮件可以单独点「显示图片」">
                  <Switch label="自动显示远程图片" checked={reading.autoLoadImages} onChange={(autoLoadImages) => setReading({ autoLoadImages })} />
                </Row>
                <Row title="列表里显示正文摘要" hint="在主题下面显示两行正文">
                  <Switch label="列表里显示正文摘要" checked={reading.showPreview} onChange={(showPreview) => setReading({ showPreview })} />
                </Row>
                <Row title="删除前先确认" hint="不开也不怕误删：删除、归档、移动之后几秒内，底部会有「撤销」（也可以按 Ctrl+Z）。打开这一项，每次删除前还会再问一遍。彻底删除总会先确认">
                  <Switch label="删除前先确认" checked={reading.confirmDelete} onChange={(confirmDelete) => setReading({ confirmDelete })} />
                </Row>
                <Row title="删除或归档后" hint="处理完当前这封邮件之后显示什么">
                  <Segmented
                    value={reading.afterRemove}
                    onChange={(afterRemove) => setReading({ afterRemove })}
                    options={[
                      { value: 'next', label: '打开下一封' },
                      { value: 'none', label: '回到列表' }
                    ]}
                  />
                </Row>
              </div>
            )}

            {tab === 'compose' && (
              <div className="set-list">
                <Row title="回复时带上原文" hint="在回复下方引用对方的邮件内容">
                  <Switch label="回复时带上原文" checked={compose.quoteOnReply} onChange={(quoteOnReply) => setCompose({ quoteOnReply })} />
                </Row>
                <Row title="正文字号" hint="你写的邮件默认用多大的字">
                  <Segmented
                    value={String(compose.fontSize)}
                    onChange={(v) => setCompose({ fontSize: Number(v) })}
                    options={[
                      { value: '13', label: '小' },
                      { value: '14', label: '标准' },
                      { value: '16', label: '大' },
                      { value: '18', label: '特大' }
                    ]}
                  />
                </Row>
                <Row title="撤销发送" hint="点「发送」后先等几秒再真正发出，这期间可以反悔，邮件会回到写信窗口。选「关闭」就立刻发出">
                  <select value={String(compose.undoSeconds ?? 5)} onChange={(e) => setCompose({ undoSeconds: Number(e.target.value) })}>
                    <option value="0">关闭</option>
                    <option value="5">5 秒</option>
                    <option value="10">10 秒</option>
                    <option value="20">20 秒</option>
                    <option value="30">30 秒</option>
                  </select>
                </Row>
                <Row title="没写主题时提醒" hint="发送没有主题的邮件前先提示一次">
                  <Switch label="没写主题时提醒" checked={compose.warnEmptySubject} onChange={(warnEmptySubject) => setCompose({ warnEmptySubject })} />
                </Row>
                <Row title="签名" hint="每个邮箱可以有自己的签名">
                  <button className="ghost-btn bordered" onClick={() => setTab('accounts')}>
                    去邮箱账号里设置
                  </button>
                </Row>
                <TemplateEditor templates={props.data.templates} onChange={(templates) => props.onSaveData({ templates })} confirm={props.confirm} />
                <QuickReplyEditor items={props.data.quickReplies} onChange={(quickReplies) => props.onSaveData({ quickReplies })} confirm={props.confirm} />
              </div>
            )}

            {tab === 'translate' && (
              <div className="set-list">
                <p className="muted">
                  看不懂的外语邮件，点邮件上方的「翻译」就能换成中文，版式、图片、链接都保持原样。翻译用的是 DeepL：需要你在 DeepL 网站注册并拿到一个 API 密钥，免费版每个月可以翻译 50 万个字符，日常看邮件足够。
                </p>
                <TranslateKeyRow notify={props.notify} confirm={props.confirm} />
                <Row title="翻译成" hint="外语邮件翻译成哪种语言">
                  <select value={draft.translate.target} onChange={(e) => setTranslate({ target: e.target.value })}>
                    {TARGET_LANGS.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </Row>
              </div>
            )}

            {tab === 'ai' && (
              <div className="set-list">
                <Row title="启用 AI 助手" hint="打开后，读邮件时有「AI 总结」，写邮件时有「AI 写作」。只有你点了这些按钮，才会把那一封邮件的文字发给你选的服务商；Bluebird Mail 不会在后台自己去读你的邮件">
                  <Switch label="启用 AI 助手" checked={draft.ai.enabled} onChange={(enabled) => setAi({ enabled })} />
                </Row>
                <AiConnect ai={draft.ai} setAi={setAi} notify={props.notify} confirm={props.confirm} />
                <Row title="总结用的语言" hint="「AI 总结」把邮件总结成哪种语言。写邮件时会自动和对方邮件用同一种语言">
                  <select value={draft.ai.language} onChange={(e) => setAi({ language: e.target.value === 'en' ? 'en' : 'zh' })}>
                    <option value="zh">简体中文</option>
                    <option value="en">English</option>
                  </select>
                </Row>
                <Row title="写邮件的默认语气">
                  <select value={draft.ai.tone} onChange={(e) => setAi({ tone: e.target.value })}>
                    {AI_TONES.map((t) => (
                      <option key={t.id} value={t.id} title={t.hint}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Row>
                <p className="muted small">
                  提醒：发给 AI 的邮件内容会交给你选的服务商处理，请按它的规定使用，涉及机密的邮件请不要用。AI 写的内容可能出错，发送前请自己看一遍；它只负责写文字，不会替你发送邮件。
                </p>
              </div>
            )}

            {tab === 'notify' && (
              <div className="set-list">
                <Row title="新邮件通知" hint="收件箱收到新邮件时弹出 Windows 通知">
                  <Switch label="新邮件通知" checked={notify.enabled} onChange={(enabled) => setNotify({ enabled })} />
                </Row>
                <Row title="只通知真人来信" hint="系统通知和订阅邮件不弹通知；重要发件人的邮件始终会通知">
                  <Switch label="只通知真人来信" checked={notify.onlyPersonal} onChange={(onlyPersonal) => setNotify({ onlyPersonal })} />
                </Row>
                <Row title="多久检查一次新邮件" hint="越短提醒越及时。即使选 10 秒，占用的网络和电量也很小；经常连不稳代理时可以选长一点">
                  <select value={String(notify.checkSeconds || 15)} onChange={(e) => setNotify({ checkSeconds: Number(e.target.value) })}>
                    <option value="10">每 10 秒</option>
                    <option value="15">每 15 秒</option>
                    <option value="30">每 30 秒</option>
                    <option value="60">每 1 分钟</option>
                    <option value="120">每 2 分钟</option>
                  </select>
                </Row>
                <Row title="通知声音">
                  <Switch label="通知声音" checked={notify.sound} onChange={(sound) => setNotify({ sound })} />
                </Row>
                <Row title="测试通知" hint="点一下，右下角应该弹出一条通知。没弹出来的话，多半是 Windows 的「请勿打扰」开着，或者在「系统设置 → 通知」里把 Bluebird Mail 的通知关了">
                  <TestNotifyButton />
                </Row>
                <Row title="通知里显示发件人和主题" hint="关闭后只提示「有新邮件」，旁人看不到内容">
                  <Switch label="通知里显示发件人和主题" checked={notify.showContent} onChange={(showContent) => setNotify({ showContent })} />
                </Row>
                <Row title="免打扰时段" hint="这段时间内照常收信，但不弹通知">
                  <Switch label="免打扰时段" checked={notify.quietEnabled} onChange={(quietEnabled) => setNotify({ quietEnabled })} />
                </Row>
                {notify.quietEnabled && (
                  <Row title="时间范围" hint="可以跨过零点，比如晚上 10 点到早上 8 点">
                    <span className="time-range">
                      <input type="time" value={notify.quietStart} onChange={(e) => e.target.value && setNotify({ quietStart: e.target.value })} aria-label="开始时间" />
                      <span>到</span>
                      <input type="time" value={notify.quietEnd} onChange={(e) => e.target.value && setNotify({ quietEnd: e.target.value })} aria-label="结束时间" />
                    </span>
                  </Row>
                )}
              </div>
            )}

            {tab === 'senders' && (
              <div className="form-stack">
                <AddressList
                  title="重要发件人"
                  hint="他们的邮件始终算作「个人」，名字会高亮显示，并且一定会弹通知。"
                  empty="还没有重要发件人。在邮件上点右键可以直接添加。"
                  items={props.data.priority}
                  onChange={(priority) => props.onSaveData({ priority, blocked: props.data.blocked.filter((a) => !priority.includes(a)) })}
                  confirm={props.confirm}
                />
                <AddressList
                  title="屏蔽的发件人"
                  hint="他们的邮件不会出现在列表里，也不会弹通知。邮件本身仍然留在邮箱里。"
                  empty="没有屏蔽任何人。"
                  items={props.data.blocked}
                  onChange={(blocked) => props.onSaveData({ blocked, priority: props.data.priority.filter((a) => !blocked.includes(a)) })}
                  confirm={props.confirm}
                />
              </div>
            )}

            {tab === 'rules' && (
              <RulesPanel rules={props.data.rules || []} accounts={props.accounts} onChange={(rules) => props.onSaveData({ rules })} notify={props.notify} />
            )}

            {tab === 'contacts' && <ContactsPanel notify={props.notify} />}

            {tab === 'accounts' && (
              <div className="account-cards">
                <div className="acct-head">
                  <div>
                    <h3>我的邮箱</h3>
                    <p className="muted small">可以添加多个邮箱，在「所有收件箱」里一起看。点一个邮箱修改它的名称、颜色、签名等。</p>
                  </div>
                  <button className="primary-btn" onClick={props.onAddAccount}>
                    <Icon name="plus" />
                    添加账号
                  </button>
                </div>
                {!props.accounts.length && <p className="muted">还没有添加邮箱。</p>}
                {props.accounts.map((a) => (
                  <div key={a.id} className={`acct-item ${openAccount === a.id ? 'open' : ''}`}>
                    <button className="acct-row" onClick={() => setOpenAccount(openAccount === a.id ? null : a.id)} aria-expanded={openAccount === a.id}>
                      <span className="account-badge" style={{ background: a.color }}>
                        {tagMark(accountTags(props.accounts)[a.id])}
                      </span>
                      <span className="acct-text">
                        <strong>{a.name}</strong>
                        <span className="muted small">{a.email}</span>
                      </span>
                      <span className="muted small">{a.auth.type === 'oauth2' ? '浏览器登录' : '授权码登录'}</span>
                      <span className={`chev ${openAccount === a.id ? 'open' : ''}`}>
                        <Icon name="chevron" size={14} />
                      </span>
                    </button>
                    {openAccount === a.id && <AccountCard account={a} {...props} />}
                  </div>
                ))}
              </div>
            )}

            {tab === 'proxy' && (
              <div className="form-stack">
                <p className="muted">
                  Gmail、Outlook 这类国外邮箱在国内需要代理。这里填你电脑上代理软件的本地地址就行，是 SOCKS5 还是 HTTP 不用选，Bluebird Mail 自己会识别。
                  哪些邮箱走代理，在每个账号里单独设置：国外邮箱默认走，国内邮箱默认直连。
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.proxy.enabled}
                    onChange={(e) => setDraft({ ...draft, proxy: { ...draft.proxy, enabled: e.target.checked } })}
                  />
                  启用代理
                </label>
                <div className="proxy-row">
                  <input
                    value={draft.proxy.host}
                    onChange={(e) => setDraft({ ...draft, proxy: { ...draft.proxy, host: e.target.value.trim() } })}
                    placeholder="127.0.0.1"
                    aria-label="代理地址"
                  />
                  <input
                    type="number"
                    value={draft.proxy.port}
                    onChange={(e) => setDraft({ ...draft, proxy: { ...draft.proxy, port: Number(e.target.value) || 0 } })}
                    aria-label="代理端口"
                  />
                </div>
                <p className="muted small">
                  不知道填什么就点「自动检测」，它会先看 Windows 的系统代理设置，再找常见的代理端口（Clash 7890、v2rayN 10808/10809 等）。
                </p>
                {testResult && <p className={testResult.ok ? 'test-ok' : 'form-error'}>{testResult.text}</p>}
                <div className="save-bar">
                  <button className="ghost-btn bordered" onClick={detectProxy} disabled={testing}>
                    {testing ? '请稍等…' : '自动检测'}
                  </button>
                  <button className="ghost-btn bordered" onClick={testProxy} disabled={testing}>
                    测试代理
                  </button>
                </div>
                <p className="muted small">
                  更新程序、浏览器登录、翻译也会用这里的代理：启用后优先走代理，代理软件没开时会自动改成直连，不用另外设置。
                </p>
              </div>
            )}

            {tab === 'oauth' && (
              <div className="form-stack">
                <p className="muted">
                  Gmail 和 Outlook 用浏览器登录时，需要你自己在 Google 和微软的开发者后台各注册一个免费的应用，把得到的 Client ID 填在这里。只需要做一次，Google 的步骤见下面，微软的步骤见项目里的 README。
                </p>
                <h3>Google（Gmail）</h3>
                <ol className="guide-steps">
                  <li>
                    打开{' '}
                    <button className="link-btn" onClick={() => void api.openExternal('https://console.cloud.google.com/projectcreate')}>
                      Google Cloud 后台
                    </button>
                    ，新建一个项目（名字随意，比如 Bluebird Mail）。
                  </li>
                  <li>
                    进入{' '}
                    <button className="link-btn" onClick={() => void api.openExternal('https://console.cloud.google.com/auth/overview')}>
                      Google Auth Platform
                    </button>
                    ，点「开始」：应用名称随意，目标对象选「外部」，邮箱填你自己的。
                  </li>
                  <li>
                    在「
                    <button className="link-btn" onClick={() => void api.openExternal('https://console.cloud.google.com/auth/audience')}>
                      目标对象
                    </button>
                    」里点「发布应用」。不发布的话，登录每 7 天会失效一次。
                  </li>
                  <li>
                    在「
                    <button className="link-btn" onClick={() => void api.openExternal('https://console.cloud.google.com/auth/clients')}>
                      客户端
                    </button>
                    」里创建客户端，应用类型选「桌面应用」，把得到的 Client ID 和 Client Secret 填到下面并保存。
                  </li>
                  <li>回到「账号」页添加 Gmail。浏览器里出现「Google 尚未验证此应用」时，点「高级」→「前往…（不安全）」继续，这是你自己的应用。</li>
                </ol>
                <label className="form-row">
                  <span>Client ID</span>
                  <input
                    value={draft.oauth.googleClientId}
                    onChange={(e) => setDraft({ ...draft, oauth: { ...draft.oauth, googleClientId: e.target.value.trim() } })}
                    placeholder="xxxx.apps.googleusercontent.com"
                  />
                </label>
                <label className="form-row">
                  <span>Client Secret</span>
                  <input
                    type="password"
                    value={draft.oauth.googleClientSecret}
                    onChange={(e) => setDraft({ ...draft, oauth: { ...draft.oauth, googleClientSecret: e.target.value.trim() } })}
                    placeholder="桌面应用类型的密钥"
                  />
                </label>
                <h3>Microsoft（Outlook / Hotmail）</h3>
                <label className="form-row">
                  <span>Client ID</span>
                  <input
                    value={draft.oauth.microsoftClientId}
                    onChange={(e) => setDraft({ ...draft, oauth: { ...draft.oauth, microsoftClientId: e.target.value.trim() } })}
                    placeholder="应用程序（客户端）ID"
                  />
                </label>
              </div>
            )}

            {tab === 'backup' && <BackupPanel hasAccounts={props.accounts.length > 0} />}

            {tab === 'about' && (
              <div className="form-stack">
                <div className="about-head">
                  <div className="about-mark">
                    <Icon name="inbox" size={26} />
                  </div>
                  <div>
                    <strong>Bluebird Mail</strong>
                    <p className="muted">版本 {props.info?.version ?? '0.1.0'}</p>
                  </div>
                </div>
                <UpdateRow notify={props.notify} />
                <Row title="数据文件夹" hint={props.info?.dataDir || ''}>
                  <button
                    className="ghost-btn bordered"
                    onClick={() => api.openDataDir().catch((err) => props.notify((err as Error).message, 'error'))}
                  >
                    打开
                  </button>
                </Row>
                <CacheRow notify={props.notify} />
                <p className="muted small">
                  账号和设置保存在这个文件夹里。授权码和登录令牌用 Windows 系统加密后保存在本机，不会上传到任何地方。为了打开更快，最近的邮件列表和读过的邮件正文会缓存在本机，附件不缓存。
                </p>
                <h3>快捷键</h3>
                <table className="shortcuts">
                  <tbody>
                    {SHORTCUTS.map(([k, v]) => (
                      <tr key={k}>
                        <td>
                          <kbd>{k}</kbd>
                        </td>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {(SETTING_TABS.includes(tab) || dirty) &&
          (askClose ? (
            <footer className="settings-foot ask">
              <span className="foot-note warn">有修改还没保存，要保存吗？</span>
              <button className="ghost-btn" onClick={() => setAskClose(false)}>
                继续修改
              </button>
              <button className="ghost-btn bordered" onClick={props.onClose}>
                不保存
              </button>
              <button
                className="primary-btn"
                disabled={saving}
                onClick={async () => {
                  if (await saveNow()) props.onClose()
                }}
              >
                {saving ? '正在保存…' : '保存并关闭'}
              </button>
            </footer>
          ) : (
            <footer className="settings-foot">
              {SETTING_TABS.includes(tab) && tab !== 'oauth' && (
                <button className="ghost-btn bordered" onClick={restoreTab} disabled={!defaults} title="把这一页的设置换回刚装好时的样子">
                  恢复本页默认
                </button>
              )}
              <span className={`foot-note ${dirty ? 'warn' : ''}`}>
                {dirty ? (tab === 'look' ? '现在看到的是预览，点「保存」才会留下来' : '有修改还没保存') : tab === 'proxy' && props.settings.proxy.enabled ? '代理已启用并保存；改了地址或端口后才需要再保存' : '这些设置改完以后要点「保存」才生效'}
              </span>
              {dirty && (
                <button className="ghost-btn" onClick={() => apply(props.settings)} disabled={saving}>
                  撤销修改
                </button>
              )}
              <button className="primary-btn" onClick={() => void saveNow()} disabled={!dirty || saving}>
                {saving ? '正在保存…' : '保存'}
              </button>
            </footer>
          ))}
      </div>
    </div>
  )
}

/** 模型输入框：可以直接手填，也可以点开下拉列表选（列表来自服务商，输入时按名字筛选） */
function ModelPicker({ value, onChange, options, heading }: { value: string; onChange: (v: string) => void; options: string[]; heading: string }) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => {
    const q = value.trim().toLowerCase()
    // 输入框里正好是列表里的一个：说明是选好了的，打开时还是显示全部
    if (!q || options.includes(value)) return options
    return options.filter((o) => o.toLowerCase().includes(q))
  }, [value, options])
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', off)
    // 列表在窗口下半部分时，滚一下让它完整出现在眼前
    const t = setTimeout(() => box.current?.querySelector('.mp-list')?.scrollIntoView({ block: 'nearest' }), 30)
    return () => {
      document.removeEventListener('mousedown', off)
      clearTimeout(t)
    }
  }, [open])
  const pick = (m: string): void => {
    onChange(m)
    setOpen(false)
    setHi(-1)
  }
  return (
    <div className="model-picker" ref={box}>
      <div className="mp-field">
        <input
          value={value}
          onChange={(e) => {
            onChange(e.target.value.trim())
            setOpen(true)
            setHi(-1)
          }}
          onFocus={() => options.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setHi((h) => Math.min(shown.length - 1, h + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((h) => Math.max(0, h - 1))
            } else if (e.key === 'Enter' && open && hi >= 0 && shown[hi]) {
              e.preventDefault()
              pick(shown[hi])
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }
          }}
          placeholder="选一个，或者直接填模型名"
          aria-label="模型"
          spellCheck={false}
          autoComplete="off"
        />
        <button type="button" className={`mp-arrow ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)} aria-label="展开模型列表" title="展开模型列表" disabled={!options.length}>
          <Icon name="chevron" size={16} />
        </button>
      </div>
      {open && options.length > 0 && (
        <ul className="mp-list" role="listbox">
          <li className="mp-head">{heading}</li>
          {shown.length === 0 && <li className="mp-none">列表里没有叫这个名字的，会直接用你填的</li>}
          {shown.map((m, i) => (
            <li key={m} role="option" aria-selected={m === value} className={`${m === value ? 'on' : ''} ${i === hi ? 'hi' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)}>
              {m}
              {m === value && <Icon name="check" size={14} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type ModelState = { state: 'idle' | 'loading' | 'ok' | 'error'; list: string[]; suggested: string; text: string }

/**
 * 服务商、接口地址、密钥、模型放在一起：密钥保存后自动向服务商要最新的模型列表，
 * 所以服务商出了新模型，这里马上就能选，不用等 Bluebird 更新。密钥按服务商分开保存，只对它自己的接口地址有效
 */
function AiConnect({ ai, setAi, notify, confirm }: { ai: Settings['ai']; setAi: (p: Partial<Settings['ai']>) => void; notify: (msg: string, kind?: 'ok' | 'error') => void; confirm: Props['confirm'] }) {
  const preset = presetOf(ai.preset)
  const host = aiHost(ai.baseUrl)
  const [info, setInfo] = useState<{ hasKey: boolean; tail: string } | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [models, setModels] = useState<ModelState>({ state: 'idle', list: [], suggested: '', text: '' })
  const [notice, setNotice] = useState('')
  const run = useRef(0)
  const aiRef = useRef(ai)
  aiRef.current = ai
  const setAiRef = useRef(setAi)
  setAiRef.current = setAi
  // 离开「其他」时记下自己填的地址和模型，切回来不用重填
  const lastCustom = useRef<{ baseUrl: string; style: Settings['ai']['style']; model: string } | null>(null)

  // 换了服务商或地址：重新看这个服务商有没有填过密钥
  useEffect(() => {
    setInfo(null)
    setResult(null)
    setValue('')
    if (!host) return
    let live = true
    api
      .aiInfo(aiRef.current)
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo({ hasKey: false, tail: '' }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host])

  const fetchModels = (): void => {
    const id = ++run.current
    setModels((m) => ({ ...m, state: 'loading', text: '' }))
    api
      .aiModels(aiRef.current)
      .then((r) => {
        if (id !== run.current) return
        setModels({ state: 'ok', list: r.models, suggested: r.suggested, text: '' })
        const cur = aiRef.current.model
        // 没选、或者是以前预设里带的老名字（服务商这边已经没有了）：自动换成服务商现有的
        if (r.suggested && r.models.length && !r.models.includes(cur) && isPresetModel(cur)) {
          setAiRef.current({ model: r.suggested })
          setNotice(cur ? `「${cur}」服务商已经没有了，自动换成了「${r.suggested}」` : `已经替你选了「${r.suggested}」，不合适可以换`)
        }
      })
      .catch((err) => id === run.current && setModels({ state: 'error', list: [], suggested: '', text: (err as Error).message }))
  }

  // 有密钥、地址也对：自动获取模型列表（地址改动时稍等一下，免得每敲一个字就去问一次）
  useEffect(() => {
    run.current++
    setNotice('')
    if (!info?.hasKey || !host) {
      setModels({ state: 'idle', list: [], suggested: '', text: '' })
      return
    }
    const t = setTimeout(fetchModels, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.hasKey, info?.tail, host, ai.style])

  const save = async (key: string): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const i = await api.aiSetKey(key, ai)
      setInfo(i)
      setValue('')
      if (i.note) setResult({ ok: false, text: i.note })
      else notify(i.hasKey ? '密钥可以用，已经保存' : '密钥已删除')
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const test = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await api.aiTest(ai)
      setResult({ ok: true, text: `连接正常，${(r.ms / 1000).toFixed(1)} 秒收到回复` })
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const custom = ai.preset === 'custom'
  const label = (p: (typeof AI_PRESETS)[number]): string => (p.id === 'custom' && ai.customName ? `其他：${ai.customName}` : p.label)
  const fetched = models.state === 'ok' && models.list.length > 0
  const options = fetched ? models.list : preset.models
  const missing = fetched && !!ai.model && !models.list.includes(ai.model)
  const urlOk = /^https:\/\//i.test(ai.baseUrl) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(ai.baseUrl)

  return (
    <>
      <Row title="服务商" hint="用你自己的账号和密钥直接连，不经过 Bluebird Mail 的任何服务器。国内的服务不用代理，Claude 和 OpenAI 需要开着代理">
        <select
          value={ai.preset}
          onChange={(e) => {
            const p = presetOf(e.target.value)
            if (ai.preset === 'custom') lastCustom.current = { baseUrl: ai.baseUrl, style: ai.style, model: ai.model }
            // 换服务商：地址、接口类型、默认模型一起换；选「其他」时地址留给自己填（回来时恢复上次填的）
            setAi(p.id === 'custom' ? { preset: p.id, baseUrl: lastCustom.current?.baseUrl ?? '', style: lastCustom.current?.style ?? 'openai', model: lastCustom.current?.model ?? '' } : { preset: p.id, style: p.style, baseUrl: p.baseUrl, model: p.models[0] ?? '' })
          }}
        >
          {AI_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p)}
            </option>
          ))}
        </select>
      </Row>
      {custom && (
        <>
          <Row title="名称" hint="给这个服务商起个名字，方便认，比如「公司内网模型」「OpenRouter」。只用来显示">
            <input className="wide-input" value={ai.customName} maxLength={40} onChange={(e) => setAi({ customName: e.target.value })} placeholder="比如：OpenRouter" aria-label="服务商名称" />
          </Row>
          <Row title="接口类型" hint="绝大多数服务（包括自己电脑上跑的 Ollama、LM Studio 等）都选「兼容 OpenAI」">
            <select value={ai.style} onChange={(e) => setAi({ style: e.target.value === 'anthropic' ? 'anthropic' : 'openai' })}>
              <option value="openai">兼容 OpenAI</option>
              <option value="anthropic">Claude 官方格式</option>
            </select>
          </Row>
        </>
      )}
      <Row title="接口地址" hint={custom ? '服务商文档里的 Base URL，一般以 /v1 结尾，必须是 https://（本机的可以用 http://localhost）。填好后再填密钥，模型列表会自动出来' : '选了服务商会自动填好，一般不用改'}>
        <input className="wide-input" value={ai.baseUrl} onChange={(e) => setAi({ baseUrl: e.target.value.trim() })} placeholder="https://api.example.com/v1" aria-label="接口地址" spellCheck={false} />
      </Row>
      {ai.baseUrl && !urlOk && <p className="form-error">接口地址必须以 https:// 开头（本机的可以用 http://localhost）</p>}

      <div className="set-block">
        <div className="set-title">API 密钥{host ? <span className="set-sub">（只对 {host} 有效）</span> : null}</div>
        <div className="set-hint">
          {info?.hasKey ? `已经填好了（末四位 ${info.tail}）。` : '还没有填。'}
          每个服务商各填各的，换来换去不用重填。密钥只保存在这台电脑上，用 Windows 系统加密，只在你点 AI 按钮时用来向这个服务商证明身份。请自己粘贴在下面，不要发给别人。
          {preset.keyUrl && (
            <button className="link-btn" onClick={() => void api.openExternal(preset.keyUrl)}>
              去申请密钥
            </button>
          )}
        </div>
        <form
          className="addr-add"
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) void save(value.trim())
          }}
        >
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={info?.hasKey ? '要换一个密钥就填在这里' : '把密钥粘贴到这里'} autoComplete="off" aria-label="AI 密钥" disabled={!urlOk} />
          <button type="submit" className="primary-btn" disabled={busy || !value.trim() || !urlOk}>
            {busy ? '正在检查…' : '保存密钥'}
          </button>
          {info?.hasKey && (
            <>
              <button type="button" className="ghost-btn bordered" disabled={busy || !ai.model} title={ai.model ? '' : '先选好模型'} onClick={() => void test()}>
                测试连接
              </button>
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => confirm({ title: '删除这个服务商的密钥？', message: `删除后就不能用 ${host} 的 AI 了，以后可以再填。别的服务商的密钥不受影响。`, confirmLabel: '删除', onConfirm: () => void save('') })}>
                删除
              </button>
            </>
          )}
        </form>
        {result && <p className={result.ok ? 'test-ok' : 'form-error'}>{result.text}</p>}
      </div>

      <div className="set-block">
        <div className="set-title">模型</div>
        <div className="set-hint">
          {info?.hasKey ? '下面是服务商现在提供的模型，新出的也在里面，点右边的小箭头选。' : '保存密钥后，会自动向服务商要最新的模型列表。没有密钥时也可以先手填。'}
          写邮件和总结用主力型号里便宜快的就够（Flash、Plus、Sonnet、Mini 这类），不必选最大最贵的。
        </div>
        <div className="mp-row">
          <ModelPicker value={ai.model} onChange={(model) => setAi({ model })} options={options} heading={fetched ? `服务商提供的模型（${models.list.length} 个，新的在前）` : '常用参考（可能不是最新，保存密钥后会换成服务商的真实列表）'} />
          <button type="button" className="ghost-btn bordered" onClick={fetchModels} disabled={!info?.hasKey || models.state === 'loading' || !urlOk} title="重新向服务商获取模型列表">
            <Icon name="refresh" size={15} />
            {models.state === 'loading' ? '获取中…' : '刷新'}
          </button>
        </div>
        {models.state === 'ok' && !models.list.length && <p className="set-hint">服务商没有返回可用的模型，请直接填模型名。</p>}
        {models.state === 'error' && <p className="form-error">{models.text}。也可以直接手填模型名。</p>}
        {notice && <p className="test-ok">{notice}</p>}
        {missing && (
          <p className="form-error">
            服务商的模型列表里没有「{ai.model}」，可能已经下线。
            {models.suggested && (
              <button className="link-btn" onClick={() => setAi({ model: models.suggested })}>
                改用 {models.suggested}
              </button>
            )}
          </p>
        )}
      </div>
    </>
  )
}

function TranslateKeyRow({ notify, confirm }: { notify: (msg: string, kind?: 'ok' | 'error') => void; confirm: Props['confirm'] }) {
  const [info, setInfo] = useState<{ hasKey: boolean; tail: string } | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<string>('')
  const loadUsage = (): void => {
    api
      .translateUsage()
      .then((u) => setUsage(u.limit ? `这个月已经用了 ${u.used.toLocaleString()} / ${u.limit.toLocaleString()} 个字符` : `这个月已经用了 ${u.used.toLocaleString()} 个字符`))
      .catch((err) => setUsage((err as Error).message))
  }
  useEffect(() => {
    api
      .translateInfo()
      .then((i) => {
        setInfo(i)
        if (i.hasKey) loadUsage()
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const save = async (key: string): Promise<void> => {
    setBusy(true)
    try {
      const i = await api.translateSetKey(key)
      setInfo(i)
      setValue('')
      setUsage('')
      if (i.hasKey) {
        notify('密钥可以用，已经保存')
        loadUsage()
      } else notify('密钥已删除')
    } catch (err) {
      notify((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="set-block">
      <div className="set-title">DeepL 密钥</div>
      <div className="set-hint">
        {info?.hasKey ? `已经填好了（末四位 ${info.tail}）。${usage}` : '还没有填。'}
        密钥只保存在这台电脑上，用 Windows 系统加密。
        <button className="link-btn" onClick={() => void api.openExternal('https://www.deepl.com/zh/your-account/keys')}>
          去 DeepL 网站拿密钥
        </button>
      </div>
      <form
        className="addr-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) void save(value.trim())
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={info?.hasKey ? '要换一个密钥就填在这里' : '把密钥粘贴到这里，免费版的以 :fx 结尾'}
          autoComplete="off"
          aria-label="DeepL 密钥"
        />
        <button type="submit" className="primary-btn" disabled={busy || !value.trim()}>
          {busy ? '正在检查…' : '保存密钥'}
        </button>
        {info?.hasKey && (
          <button
            type="button"
            className="ghost-btn"
            disabled={busy}
            onClick={() => confirm({ title: '删除 DeepL 密钥？', message: '删除后就不能翻译邮件了，以后可以再填。', confirmLabel: '删除', onConfirm: () => void save('') })}
          >
            删除
          </button>
        )}
      </form>
    </div>
  )
}

/** 「关于」页里的更新：现在是什么情况、手动检查、下载好了就重启安装 */
function UpdateRow({ notify }: { notify: (msg: string, kind?: 'ok' | 'error') => void }) {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    api
      .updateStatus()
      .then(setSt)
      .catch(() => undefined)
    return api.onUpdateStatus(setSt)
  }, [])
  if (!st) return null
  const hint =
    st.state === 'unsupported'
      ? '现在是用「启动 Bluebird.bat」直接运行的，不参与更新。装上安装版以后才能检查和下载更新'
      : st.state === 'checking'
        ? '正在检查有没有新版本…'
        : st.state === 'available'
          ? `发现新版本 ${st.version ?? ''}。点「下载更新」开始下载，下载好以后再决定要不要马上重启安装`
          : st.state === 'downloading'
          ? `正在下载新版本 ${st.version ?? ''}…${st.percent ? ` ${st.percent}%` : ''}`
          : st.state === 'ready'
            ? `新版本 ${st.version ?? ''} 已经下载好了。点「重启并更新」马上装上；不点的话，下次退出程序时会自动装上`
            : st.state === 'latest'
              ? '已经是最新版本'
              : st.state === 'error'
                ? st.error || '更新没有成功'
                : '打开程序后会自动检查，也可以现在手动查一次'
  return (
    <Row title="软件更新" hint={hint}>
      {st.state === 'ready' ? (
        <button className="primary-btn" onClick={() => api.updateInstall().catch((err) => notify((err as Error).message, 'error'))}>
          重启并更新
        </button>
      ) : st.state === 'available' ? (
        <button className="primary-btn" onClick={() => api.updateDownload().then(setSt).catch((err) => notify((err as Error).message, 'error'))}>
          下载更新
        </button>
      ) : (
        <button
          className="ghost-btn bordered"
          disabled={st.state === 'unsupported' || st.state === 'checking' || st.state === 'downloading'}
          onClick={() => api.updateCheck().then(setSt).catch((err) => notify((err as Error).message, 'error'))}
        >
          {st.state === 'checking' ? '正在检查…' : st.state === 'downloading' ? '正在下载…' : '检查更新'}
        </button>
      )}
    </Row>
  )
}

/** 本地缓存占用和清除 */
function CacheRow({ notify }: { notify: (msg: string, kind?: 'ok' | 'error') => void }) {
  const [size, setSize] = useState<number | null>(null)
  useEffect(() => {
    api
      .cacheInfo()
      .then(setSize)
      .catch(() => setSize(null))
  }, [])
  const text = size == null ? '' : size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
  return (
    <Row title="本地缓存" hint={`缓存让启动和切换文件夹更快，断网时也能看已读过的邮件。${text ? `现在占用 ${text}` : ''}`}>
      <button
        className="ghost-btn bordered"
        onClick={() =>
          api
            .cacheClear()
            .then((n) => {
              setSize(n)
              notify('缓存已清除')
            })
            .catch((err) => notify((err as Error).message, 'error'))
        }
      >
        清除缓存
      </button>
    </Row>
  )
}

/** 重要 / 屏蔽发件人列表：可以手动添加和移除 */
type Ask = Props['confirm']

function AddressList(props: { title: string; hint: string; empty: string; items: string[]; onChange: (items: string[]) => void; confirm: Ask }) {
  const [value, setValue] = useState('')
  const add = (): void => {
    const v = value.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || props.items.includes(v)) return
    props.onChange([...props.items, v])
    setValue('')
  }
  return (
    <section className="addr-block">
      <h3>{props.title}</h3>
      <p className="muted small">{props.hint}</p>
      <form
        className="addr-add"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="name@example.com" aria-label={`添加${props.title}`} />
        <button type="submit" className="ghost-btn bordered">
          添加
        </button>
      </form>
      {!props.items.length && <p className="muted small">{props.empty}</p>}
      <ul className="addr-items">
        {props.items.map((a) => (
          <li key={a}>
            <span>{a}</span>
            <button
              className="icon-btn small"
              onClick={() =>
                props.confirm({
                  title: `把 ${a} 从「${props.title}」里移除？`,
                  message: '移除后可以随时再加回来。',
                  confirmLabel: '移除',
                  onConfirm: () => props.onChange(props.items.filter((x) => x !== a))
                })
              }
              title="移除"
              aria-label={`移除 ${a}`}
            >
              <Icon name="x" size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 邮件模板：写信时点「模板」可以一键插入 */
function TemplateEditor({ templates, onChange, confirm }: { templates: Template[]; onChange: (t: Template[]) => void; confirm: Ask }) {
  const [editing, setEditing] = useState<Template | null>(null)
  const save = (): void => {
    if (!editing || !editing.name.trim() || !editing.body.trim()) return
    const exists = templates.some((t) => t.id === editing.id)
    onChange(exists ? templates.map((t) => (t.id === editing.id ? editing : t)) : [...templates, editing])
    setEditing(null)
  }
  return (
    <section className="addr-block spaced">
      <h3>邮件模板</h3>
      <p className="muted small">把常写的内容存成模板，比如报价回复、会议邀请。写信时点工具栏的「模板」插入。</p>
      {templates.map((t) => (
        <div key={t.id} className="tpl-item">
          <div className="tpl-text">
            <strong>{t.name}</strong>
            <span className="muted small">{t.body.replace(/\s+/g, ' ').slice(0, 60)}</span>
          </div>
          <button className="link-btn" onClick={() => setEditing(t)}>
            编辑
          </button>
          <button
            className="link-btn danger"
            onClick={() =>
              confirm({
                title: `删除模板「${t.name}」？`,
                message: '删除后无法恢复，要用的话得重新写一遍。',
                confirmLabel: '删除',
                onConfirm: () => onChange(templates.filter((x) => x.id !== t.id))
              })
            }
          >
            删除
          </button>
        </div>
      ))}
      {editing ? (
        <div className="advanced">
          <label className="form-row">
            <span>模板名称</span>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="比如：报价回复" autoFocus />
          </label>
          <label className="form-row">
            <span>邮件主题</span>
            <input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} placeholder="可以不填" />
          </label>
          <label className="form-row top">
            <span>正文</span>
            <textarea rows={6} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </label>
          <div className="save-bar">
            <button className="ghost-btn" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="primary-btn" onClick={save} disabled={!editing.name.trim() || !editing.body.trim()}>
              保存模板
            </button>
          </div>
        </div>
      ) : (
        <button className="ghost-btn bordered left" onClick={() => setEditing({ id: String(Date.now()), name: '', subject: '', body: '' })}>
          <Icon name="plus" />
          新建模板
        </button>
      )}
    </section>
  )
}

/** 快捷回复：读信页底部的几句常用回复 */
function QuickReplyEditor({ items, onChange, confirm }: { items: string[]; onChange: (items: string[]) => void; confirm: Ask }) {
  const [value, setValue] = useState('')
  const add = (): void => {
    const v = value.trim()
    if (!v || items.includes(v)) return
    onChange([...items, v])
    setValue('')
  }
  return (
    <section className="addr-block spaced">
      <h3>快捷回复</h3>
      <p className="muted small">显示在读信页底部，点一下就填进回复框，还可以再改。</p>
      <form
        className="addr-add"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="比如：收到，谢谢。" aria-label="添加快捷回复" />
        <button type="submit" className="ghost-btn bordered">
          添加
        </button>
      </form>
      <ul className="addr-items">
        {items.map((t) => (
          <li key={t}>
            <span>{t}</span>
            <button
              className="icon-btn small"
              onClick={() =>
                confirm({
                  title: '删除这条快捷回复？',
                  message: `「${t}」`,
                  confirmLabel: '删除',
                  onConfirm: () => onChange(items.filter((x) => x !== t))
                })
              }
              title="删除"
              aria-label={`删除 ${t}`}
            >
              <Icon name="x" size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

const ACCOUNT_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#0ea5e9']

const sameServer = (a: ServerConfig, b: ServerConfig): boolean => a.host === b.host && a.port === b.port && a.secure === b.secure

function ServerFields({ label, value, onChange }: { label: string; value: ServerConfig; onChange: (v: ServerConfig) => void }) {
  return (
    <div className="server-row">
      <span className="server-label">{label}</span>
      <input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} aria-label={`${label}服务器地址`} />
      <input
        type="number"
        value={value.port}
        onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 0 })}
        aria-label={`${label}端口`}
      />
      <select value={value.secure ? 'ssl' : 'starttls'} onChange={(e) => onChange({ ...value, secure: e.target.value === 'ssl' })} aria-label={`${label}加密方式`}>
        <option value="ssl">SSL/TLS</option>
        <option value="starttls">STARTTLS</option>
      </select>
    </div>
  )
}

function AccountCard({ account, accounts, onAccountUpdated, onAccountRemoved, notify }: { account: Account } & Props) {
  const [name, setName] = useState(account.name)
  const [tag, setTag] = useState(account.tag || '')
  const [signature, setSignature] = useState(account.signature || '')
  const [color, setColor] = useState(account.color)
  const [useProxy, setUseProxy] = useState(account.useProxy)
  const [appendSent, setAppendSent] = useState(account.appendSent)
  const [password, setPassword] = useState('')
  const [imap, setImap] = useState(account.imap)
  const [smtp, setSmtp] = useState(account.smtp)
  const [showServers, setShowServers] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const serverChanged = !sameServer(imap, account.imap) || !sameServer(smtp, account.smtp)
  const changed =
    name !== account.name ||
    tag.trim() !== (account.tag || '') ||
    signature !== (account.signature || '') ||
    color !== account.color ||
    useProxy !== account.useProxy ||
    appendSent !== account.appendSent ||
    !!password ||
    serverChanged

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const a = await api.updateAccount(account.id, {
        name,
        tag: tag.trim(),
        signature,
        color,
        useProxy: useProxy !== account.useProxy ? useProxy : undefined,
        appendSent,
        password: password || undefined,
        imap: sameServer(imap, account.imap) ? undefined : imap,
        smtp: sameServer(smtp, account.smtp) ? undefined : smtp
      })
      setPassword('')
      onAccountUpdated(a)
      notify('账号已更新')
    } catch (err) {
      notify((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const reauth = async (): Promise<void> => {
    setBusy(true)
    try {
      const a = await api.reauthAccount(account.id)
      onAccountUpdated(a)
      notify('已重新登录')
    } catch (err) {
      notify((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.removeAccount(account.id)
      onAccountRemoved(account.id)
      notify('账号已删除')
    } catch (err) {
      notify((err as Error).message, 'error')
      setBusy(false)
    }
  }

  return (
    <div className="account-card">
      <label className="form-row">
        <span>显示名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="form-row">
        <span>标签</span>
        <input
          value={tag}
          maxLength={8}
          onChange={(e) => setTag(e.target.value)}
          placeholder={`不填就用「${accountTags(accounts.map((a) => (a.id === account.id ? { ...a, tag: undefined } : a)))[account.id]}」`}
          title="在「所有收件箱」里，每封邮件旁边会标上这个名字，一眼看出是哪个邮箱收到的。比如：公司、私人、QQ"
        />
      </label>
      <div className="form-row">
        <span>颜色</span>
        <div className="swatches" role="radiogroup" aria-label="账号颜色">
          {ACCOUNT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              className={color === c ? 'on' : ''}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>
      <label className="form-row top">
        <span>签名</span>
        <textarea
          rows={3}
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          placeholder={'写在每封邮件末尾，比如：\n张三 | 销售部\n电话 138 0000 0000'}
        />
      </label>
      {account.auth.type === 'password' && (
        <label className="form-row">
          <span>新授权码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="不修改就留空" />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
        通过代理连接
      </label>
      <label className="check">
        <input type="checkbox" checked={appendSent} onChange={(e) => setAppendSent(e.target.checked)} />
        发送后存到「已发送」
      </label>
      {account.auth.type === 'password' && (
        <>
          <button type="button" className="link-btn left" onClick={() => setShowServers((v) => !v)}>
            {showServers ? '收起服务器设置' : '服务器设置'}
          </button>
          {showServers && (
            <div className="advanced">
              <ServerFields label="收信（IMAP）" value={imap} onChange={setImap} />
              <ServerFields label="发信（SMTP）" value={smtp} onChange={setSmtp} />
              <p className="muted small">修改后点「保存」会先测试能否连接，连不上不会保存。</p>
            </div>
          )}
        </>
      )}
      <div className="account-card-actions">
        {confirmRemove ? (
          <>
            <span className="muted small">确定删除？只会从本程序移除，不影响服务器上的邮件。</span>
            <button className="link-btn danger" onClick={remove} disabled={busy}>
              删除
            </button>
            <button className="link-btn" onClick={() => setConfirmRemove(false)}>
              取消
            </button>
          </>
        ) : (
          <>
            <button className="link-btn danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
              删除账号
            </button>
            {account.auth.type === 'oauth2' && (
              <button className="link-btn" onClick={reauth} disabled={busy}>
                重新登录
              </button>
            )}
            <span className="tool-gap" />
            <button className="primary-btn" onClick={save} disabled={!changed || busy}>
              {busy ? '正在保存…' : '保存'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
