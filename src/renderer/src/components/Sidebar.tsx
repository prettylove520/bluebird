import { useState } from 'react'
import type { Account, Folder, SpecialUse } from '../../../shared/types'
import { accountTags, tagMark } from '../utils'
import { Icon, type IconName } from './Icon'

const FOLDER_ICON: Record<SpecialUse, IconName> = {
  inbox: 'inbox',
  sent: 'sent',
  drafts: 'drafts',
  archive: 'archive',
  flagged: 'star',
  all: 'all',
  junk: 'junk',
  trash: 'trash'
}

// 这些文件夹不显示未读数（数字没有意义或者只会让人焦虑）
const NO_COUNT = new Set<SpecialUse | undefined>(['sent', 'drafts', 'trash', 'junk', 'all'])

interface Props {
  accounts: Account[]
  folders: Record<string, Folder[] | undefined>
  folderErrors: Record<string, string | undefined>
  view: { accountId: string; folder: string } | null
  allUnseen: number
  snoozedCount: number
  scheduledCount: number
  onOpenSnoozed: () => void
  onOpenScheduled: () => void
  onSelectAll: () => void
  onSelect: (accountId: string, folder: string) => void
  /** 在文件夹上点右键；accountId 为 * 表示「所有收件箱」 */
  onFolderMenu: (accountId: string, folder: string, x: number, y: number) => void
  onAccountMenu: (accountId: string, x: number, y: number) => void
  onRetry: (accountId: string) => void
  onCompose: () => void
  onAddAccount: () => void
  onSettings: () => void
}

export function Sidebar(props: Props) {
  const { accounts, folders, folderErrors, view } = props
  // 只有一个账号时默认展开，多个账号时默认收起，侧边栏更清爽
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (id: string): boolean => open[id] ?? (accounts.length === 1 || view?.accountId === id)
  const tags = accountTags(accounts)

  return (
    <aside className="sidebar">
      <div className="sidebar-top titlebar-drag">
        <span className="app-name">Bluebird Mail</span>
      </div>

      <div className="sidebar-actions">
        <button className="compose-btn" onClick={props.onCompose} disabled={!accounts.length} title="写邮件（N）">
          <Icon name="pen" />
          写邮件
        </button>
      </div>

      <nav className="nav">
        {accounts.length > 1 && (
          <button
            className={`nav-item ${view?.accountId === '*' ? 'active' : ''}`}
            onClick={props.onSelectAll}
            onContextMenu={(e) => {
              e.preventDefault()
              props.onFolderMenu('*', 'INBOX', e.clientX, e.clientY)
            }}
          >
            <span className="nav-icon">
              <Icon name="inbox" />
            </span>
            <span className="nav-label">所有收件箱</span>
            {props.allUnseen > 0 && <span className="nav-count">{props.allUnseen}</span>}
          </button>
        )}

        {props.snoozedCount > 0 && (
          <button className={`nav-item ${view?.accountId === '~snoozed' ? 'active' : ''}`} onClick={props.onOpenSnoozed}>
            <span className="nav-icon">
              <Icon name="clock" />
            </span>
            <span className="nav-label">稍后处理</span>
            <span className="nav-count">{props.snoozedCount}</span>
          </button>
        )}
        {props.scheduledCount > 0 && (
          <button className="nav-item" onClick={props.onOpenScheduled}>
            <span className="nav-icon">
              <Icon name="sent" />
            </span>
            <span className="nav-label">定时发送</span>
            <span className="nav-count">{props.scheduledCount}</span>
          </button>
        )}

        {accounts.length > 0 && <div className="nav-section">邮箱账号</div>}

        {accounts.map((a) => {
          const list = folders[a.id]
          const err = folderErrors[a.id]
          const expanded = isOpen(a.id)
          const inboxUnseen = list?.find((f) => f.specialUse === 'inbox')?.unseen ?? 0
          return (
            <section key={a.id} className="account">
              <button
                className="account-head"
                onClick={() => setOpen((o) => ({ ...o, [a.id]: !expanded }))}
                aria-expanded={expanded}
                title={a.email}
                onContextMenu={(e) => {
                  e.preventDefault()
                  props.onAccountMenu(a.id, e.clientX, e.clientY)
                }}
              >
                <span className="account-badge" style={{ background: a.color }}>
                  {tagMark(tags[a.id])}
                </span>
                <span className="account-text">
                  <span className="account-name">
                    {a.name}
                    <em className="account-tag-text">{tags[a.id]}</em>
                  </span>
                  <span className="account-email">{a.email}</span>
                </span>
                {!expanded && inboxUnseen > 0 && <span className="nav-count">{inboxUnseen}</span>}
                <span className={`chev ${expanded ? 'open' : ''}`}>
                  <Icon name="chevron" size={13} />
                </span>
              </button>

              {expanded && (
                <ul className="folders">
                  {!list && !err && <li className="folder-hint">正在连接…</li>}
                  {err && (
                    <li className="folder-error">
                      <p>{err}</p>
                      <button className="link-btn" onClick={() => props.onRetry(a.id)}>
                        重试
                      </button>
                    </li>
                  )}
                  {list?.map((f) => {
                    const active = view?.accountId === a.id && view.folder === f.path
                    return (
                      <li key={f.path}>
                        <button
                          className={`nav-item folder ${active ? 'active' : ''}`}
                          style={{ paddingLeft: 30 + f.depth * 14 }}
                          onClick={() => props.onSelect(a.id, f.path)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            props.onFolderMenu(a.id, f.path, e.clientX, e.clientY)
                          }}
                          title={f.path}
                        >
                          <span className="nav-icon">
                            <Icon name={f.specialUse ? FOLDER_ICON[f.specialUse] : 'folder'} />
                          </span>
                          <span className="nav-label">{f.displayName}</span>
                          {f.unseen > 0 && !NO_COUNT.has(f.specialUse) && <span className="nav-count">{f.unseen}</span>}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
      </nav>

      <div className="sidebar-foot">
        <button className="foot-btn" onClick={props.onAddAccount}>
          <Icon name="plus" />
          添加邮箱
        </button>
        <button className="foot-btn icon-only" onClick={props.onSettings} title="设置" aria-label="设置">
          <Icon name="sliders" />
        </button>
      </div>
    </aside>
  )
}
