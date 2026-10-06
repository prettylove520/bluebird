import { Fragment, useEffect, useRef, useState } from 'react'
import type { MailCategory, MessageSummary, SnoozeInfo } from '../../../shared/types'
import { avatarColor, avatarText, dateGroup, displayName, friendlyTime, shortDate } from '../utils'
import { Icon, type IconName } from './Icon'

export type RowAction = 'archive' | 'delete' | 'flag' | 'seen' | 'pin' | 'snooze'
export type CategoryTab = 'focus' | 'all' | MailCategory

/** 聚焦列表里折叠起来的一类邮件，比如「通知 18」 */
export interface Bundle {
  id: MailCategory
  label: string
  count: number
  /** seed 用来给小圆标配颜色，一般是发件人地址 */
  senders: { name: string; count: number; seed: string }[]
}
/** 列表里一个会话的概况 */
export interface ThreadInfo {
  count: number
  unread: boolean
  flagged: boolean
  attachments: boolean
  answered: boolean
  /** 参与的人，按先后顺序，自己显示成「我」 */
  names: string[]
}
export type BatchAction = 'read' | 'unread' | 'flag' | 'archive' | 'move' | 'delete'

const keyOf = (m: MessageSummary): string => `${m.accountId}|${m.folder}|${m.uid}`

interface Props {
  title: string
  subtitle: string
  messages: MessageSummary[]
  previews: Record<string, string>
  selectedKey: string | null
  /** 勾选（多选）的邮件 */
  checked: Set<string>
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  /** 已发送/草稿箱里的邮件显示收件人而不是发件人 */
  showRecipient: (m: MessageSummary) => boolean
  /** 合并成会话的那些行（键是会话里最新一封的键） */
  threads: Map<string, ThreadInfo>
  /** 搜索所有邮箱时，标出每封邮件在哪个文件夹 */
  folderLabel?: (m: MessageSummary) => string
  /** 搜索范围；不传就不显示切换 */
  scope?: 'all' | 'here'
  onScope: (scope: 'all' | 'here') => void
  /** 「所有收件箱」里标出每封邮件属于哪个邮箱：一个带颜色圆点的短标签 */
  accountMarks?: Record<string, { label: string; color: string; email: string }>
  showPreview: boolean
  compact: boolean
  /** 整屏宽的单行列表 */
  wide: boolean
  bundles: Bundle[]
  /** 智能收件箱的开关状态；不是收件箱时不传，开关就不显示 */
  smart?: boolean
  onToggleSmart: () => void
  /** 把折叠起来的那一类未读邮件全部标为已读 */
  onBundleRead: (id: MailCategory) => void
  /** 打开「操作」面板（Ctrl+K） */
  onActions: () => void
  onTitleClick: () => void
  onCompose: () => void
  /** 智能收件箱的分类页；不传就不显示 */
  tabs?: { id: CategoryTab; label: string; unread: number }[]
  tab: CategoryTab
  onTab: (t: CategoryTab) => void
  pinned: Set<string>
  /** 重要发件人（小写邮箱地址） */
  priority: Set<string>
  snoozed: Record<string, SnoozeInfo>
  hasUnread: boolean
  canArchive: (m: MessageSummary) => boolean
  canBatchArchive: boolean
  canBatchMove: boolean
  query: string
  searchActive: boolean
  onQueryChange: (q: string) => void
  onSearch: () => void
  onClearSearch: () => void
  onSelect: (m: MessageSummary) => void
  /** 鼠标停在某一行上（null 是离开了），用来提前取这封邮件 */
  onHover?: (m: MessageSummary | null) => void
  onCheck: (m: MessageSummary, range: boolean) => void
  onCheckAll: () => void
  onClearChecked: () => void
  onBatch: (action: BatchAction, anchor: { x: number; y: number }) => void
  onAction: (m: MessageSummary, action: RowAction, anchor: { x: number; y: number }) => void
  onContextMenu: (m: MessageSummary, x: number, y: number) => void
  onMarkAllRead: () => void
  /** 在标题或列表空白处点右键：弹出当前文件夹的菜单 */
  onFolderMenu: (x: number, y: number) => void
  /** auto 为 true 表示是列表没填满时自动补的，不是用户滚动或点击触发的 */
  onLoadMore: (auto?: boolean) => void
  onRefresh: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
}

// 列表一次最多先画这么多行
const RENDER_STEP = 200

export function MessageList(props: Props) {
  const { messages, selectedKey, checked } = props
  const listRef = useRef<HTMLDivElement>(null)
  const selecting = checked.size > 0

  // 列表很长时不一次全画出来：先画前面一批，滚到底再接着画，几千封邮件也不会卡
  const [limit, setLimit] = useState(RENDER_STEP)
  const reveal = useRef<string | null>(null)
  useEffect(() => {
    setLimit(RENDER_STEP)
  }, [props.title, props.tab, props.searchActive])
  const rows = messages.length > limit ? messages.slice(0, limit) : messages
  const moreToRender = messages.length > limit

  // 键盘切换邮件时，让选中项保持在可见范围内
  useEffect(() => {
    if (selectedKey == null) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(selectedKey)}"]`)
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
      return
    }
    // 用键盘翻到了还没画出来的那一段：先把它画出来，画好以后再滚过去
    const idx = messages.findIndex((m) => keyOf(m) === selectedKey)
    if (idx >= limit) {
      reveal.current = selectedKey
      setLimit(idx + RENDER_STEP)
    }
  }, [selectedKey])
  useEffect(() => {
    const k = reveal.current
    if (!k) return
    reveal.current = null
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [limit])

  // 当前这一页被分类、屏蔽等筛掉大半，列表还没填满屏幕时，自动接着往前取
  const fillRef = useRef<() => void>(() => {})
  fillRef.current = () => {
    const el = listRef.current
    if (!el || moreToRender || !props.hasMore || props.loadingMore || props.loading) return
    // 列表被主页、阅读页挡住时高度是 0，这时候不取
    if (el.clientHeight === 0) return
    if (el.scrollHeight <= el.clientHeight + 200) props.onLoadMore(true)
  }
  useEffect(() => {
    fillRef.current()
  }, [messages.length, props.hasMore, props.loadingMore, props.loading, props.tab])
  // 列表从隐藏变成显示、或者窗口变大时再检查一次
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fillRef.current())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight <= el.scrollHeight - 300) return
    // 快到底了：先把已经取回来但还没画的邮件画出来，都画完了再向服务器要更早的
    if (moreToRender) setLimit((n) => n + RENDER_STEP)
    else if (props.hasMore && !props.loadingMore) props.onLoadMore()
  }

  const batch = (action: BatchAction) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    props.onBatch(action, { x: r.left, y: r.bottom + 4 })
  }

  let lastGroup = ''
  const allChecked = messages.length > 0 && checked.size >= messages.length

  return (
    <section className={`list-pane ${props.wide ? 'wide' : ''} ${props.compact ? 'compact' : ''} ${selecting ? 'selecting' : ''}`}>
      <header
        className="list-head titlebar-drag"
        onContextMenu={(e) => {
          e.preventDefault()
          props.onFolderMenu(e.clientX, e.clientY)
        }}
      >
        <div className="list-title">
          <button className="title-btn no-drag" onClick={props.onTitleClick} title="切换账号和文件夹">
            <h1>{props.title}</h1>
            <span className="title-chev">
              <Icon name="chevron" size={14} />
            </span>
          </button>
          <p>{props.subtitle}</p>
        </div>
        <div className="list-head-actions">
          {props.smart !== undefined && !props.searchActive && (
            <button
              className={`smart-switch no-drag ${props.smart ? 'on' : ''}`}
              role="switch"
              aria-checked={props.smart}
              onClick={props.onToggleSmart}
              title={props.smart ? '智能收件箱已开启：未读的通知和订阅会折叠起来。点一下显示全部邮件' : '现在显示全部邮件。点一下开启智能收件箱'}
              aria-label="智能收件箱"
            >
              <span className="smart-knob">
                <Icon name="check" size={12} />
              </span>
            </button>
          )}
          {props.hasUnread && !props.searchActive && (
            <button className="head-btn no-drag" onClick={props.onMarkAllRead} title="全部标为已读" aria-label="全部标为已读">
              <Icon name="mailOpen" size={20} />
            </button>
          )}
          <button className="head-btn no-drag" onClick={props.onCheckAll} title="全选（Ctrl+A）" aria-label="全选" disabled={!messages.length}>
            <Icon name="checkCircle" size={20} />
          </button>
          <button className="head-btn no-drag" onClick={props.onRefresh} title="刷新" aria-label="刷新">
            <Icon name="refresh" size={20} />
          </button>
          <button
            className="head-btn no-drag"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              props.onFolderMenu(r.left, r.bottom + 4)
            }}
            title="更多操作"
            aria-label="更多操作"
          >
            <Icon name="more" size={20} />
          </button>
          <button className="head-btn no-drag compose-icon" onClick={props.onCompose} title="写邮件（N）" aria-label="写邮件">
            <Icon name="pen" size={20} />
          </button>
        </div>
      </header>

      {selecting ? (
        <div className="batch-bar" role="toolbar" aria-label="批量操作">
          <label className="batch-count" title={allChecked ? '取消全选' : '全选'}>
            <input type="checkbox" checked={allChecked} onChange={() => (allChecked ? props.onClearChecked() : props.onCheckAll())} />
            已选 {checked.size} 封
          </label>
          <span className="batch-actions">
            <button onClick={batch('read')} title="标为已读" aria-label="标为已读">
              <Icon name="mailOpen" size={19} />
            </button>
            <button onClick={batch('unread')} title="标为未读" aria-label="标为未读">
              <Icon name="unread" size={19} />
            </button>
            <button onClick={batch('flag')} title="加星标 / 取消星标" aria-label="星标">
              <Icon name="star" size={19} />
            </button>
            {props.canBatchArchive && (
              <button onClick={batch('archive')} title="归档" aria-label="归档">
                <Icon name="archive" size={19} />
              </button>
            )}
            {props.canBatchMove && (
              <button onClick={batch('move')} title="移动到文件夹" aria-label="移动到文件夹">
                <Icon name="move" size={19} />
              </button>
            )}
            <button className="danger" onClick={batch('delete')} title="删除（Delete）" aria-label="删除">
              <Icon name="trash" size={19} />
            </button>
            <button className="batch-more" onClick={props.onActions} title="全部操作（Ctrl+K）">
              <Icon name="bolt" size={17} />
              操作
            </button>
            <button className="batch-done" onClick={props.onClearChecked} title="退出多选（Esc）">
              完成
            </button>
          </span>
        </div>
      ) : (
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault()
            props.onSearch()
          }}
        >
          <Icon name="search" />
          <input
            ref={props.searchRef}
            value={props.query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            placeholder={props.scope === 'here' ? '在这个文件夹里搜索' : '搜索所有邮箱'}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                props.onClearSearch()
                e.currentTarget.blur()
              }
            }}
          />
          {props.searchActive && (
            <button type="button" className="icon-btn small" onClick={props.onClearSearch} title="清除搜索" aria-label="清除搜索">
              <Icon name="x" size={14} />
            </button>
          )}
          {props.scope && (props.query.trim() || props.searchActive) && (
            <span className="scope" role="radiogroup" aria-label="搜索范围">
              <button
                type="button"
                role="radio"
                aria-checked={props.scope === 'all'}
                className={props.scope === 'all' ? 'on' : ''}
                onClick={() => props.onScope('all')}
                title="在所有邮箱的所有文件夹里找（垃圾邮件和已删除除外）"
              >
                所有邮箱
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={props.scope === 'here'}
                className={props.scope === 'here' ? 'on' : ''}
                onClick={() => props.onScope('here')}
                title="只在现在打开的这个文件夹里找"
              >
                当前文件夹
              </button>
            </span>
          )}
        </form>
      )}

      {/* 聚焦列表里点开「通知」「订阅」之后：顶上给一条返回 */}
      {props.tabs && props.tab !== 'focus' && !selecting && (
        <div className="cat-bar">
          <button className="cat-back" onClick={() => props.onTab('focus')} title="回到聚焦列表（Esc）">
            <Icon name="back" size={16} />
            聚焦列表
          </button>
          <span className="cat-name">
            {props.tabs.find((t) => t.id === props.tab)?.label}
            {(props.tabs.find((t) => t.id === props.tab)?.unread ?? 0) > 0 && (
              <span className="cat-count">{props.tabs.find((t) => t.id === props.tab)?.unread} 封未读</span>
            )}
          </span>
        </div>
      )}

      <div
        className="list"
        ref={listRef}
        onScroll={onScroll}
        role="listbox"
        aria-label="邮件列表"
        aria-multiselectable="true"
        onClick={(e) => {
          // 多选时点一下列表的空白处就退出多选
          // 只认真正点在空白处；点分组标题、「加载更早的邮件」这些不算
          if (selecting && e.target === e.currentTarget) props.onClearChecked()
        }}
        onContextMenu={(e) => {
          // 点在邮件上时由邮件自己的菜单处理，这里只管空白处
          if (e.defaultPrevented) return
          e.preventDefault()
          props.onFolderMenu(e.clientX, e.clientY)
        }}
      >
        {props.loading && !messages.length && (
          <div className="skeletons" aria-label="正在加载">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="skeleton-row">
                <span className="sk-avatar" />
                <span className="sk-lines">
                  <span className="sk-line w60" />
                  <span className="sk-line w85" />
                  <span className="sk-line w40" />
                </span>
              </div>
            ))}
          </div>
        )}
        {props.error && !props.loading && (
          <div className="list-state error">
            <p>{props.error}</p>
            <button className="link-btn" onClick={props.onRefresh}>
              重试
            </button>
          </div>
        )}
        {!props.loading && !props.loadingMore && !props.error && !messages.length && !props.bundles.length && (
          <div className="list-state">
            <Icon name="check" size={28} />
            <p>{props.searchActive ? '没有找到相关邮件' : '这里没有邮件'}</p>
          </div>
        )}

        {props.bundles.map((b) => (
          <div
            key={b.id}
            className="bundle"
            role="button"
            tabIndex={0}
            onClick={() => props.onTab(b.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) props.onTab(b.id)
            }}
            title={`查看全部${b.label}邮件`}
          >
            <button
              className="bundle-check"
              onClick={(e) => {
                e.stopPropagation()
                props.onBundleRead(b.id)
              }}
              title={`把这 ${b.count} 封${b.label}全部标为已读`}
              aria-label={`把${b.label}全部标为已读`}
            >
              <Icon name="check" size={15} />
            </button>
            <span className="bundle-icon">
              <Icon name={b.id === 'notification' ? 'bell' : 'all'} size={17} />
            </span>
            <span className="bundle-label">
              {b.label}
              <em>{b.count}</em>
            </span>
            <span className="bundle-senders">
              {b.senders.map((x) => (
                <span key={x.name} className="bundle-sender">
                  <i style={{ background: avatarColor(x.seed || x.name) }}>{(x.name.trim()[0] || '?').toUpperCase()}</i>
                  {x.name}
                  {x.count > 1 && <em>{x.count}</em>}
                </span>
              ))}
            </span>
            <span className="bundle-chev">
              <Icon name="chevron" size={16} />
            </span>
          </div>
        ))}

        {rows.map((m) => {
          const k = keyOf(m)
          const outgoing = props.showRecipient(m)
          const thread = props.threads.get(k)
          const who = outgoing ? m.to[0] : m.from[0]
          const single = outgoing ? (who ? `给 ${displayName(who)}` : '（无收件人）') : displayName(who)
          // 会话：列出参与的人，太多就只留头尾
          const name =
            thread && !outgoing && thread.names.length > 1
              ? thread.names.length > 3
                ? `${thread.names[0]} … ${thread.names.slice(-2).join('、')}`
                : thread.names.join('、')
              : single
          const unread = thread ? thread.unread : !m.seen
          const flagged = thread ? thread.flagged : m.flagged
          const isPinned = props.pinned.has(k)
          const snooze = props.snoozed[k]
          const vip = !!who && props.priority.has(who.address.toLowerCase())
          const group = props.searchActive ? '' : isPinned ? '已置顶' : dateGroup(m.date)
          const showGroup = group !== lastGroup
          lastGroup = group
          const preview = props.previews[k]
          const selected = selectedKey === k
          const isChecked = checked.has(k)
          return (
            <Fragment key={k}>
              {showGroup && group && <div className="group-label">{group}</div>}
              <div
                data-key={k}
                role="option"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected || isChecked}
                className={`msg ${unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${isChecked ? 'checked' : ''}`}
                onClick={(e) => {
                  if (e.shiftKey) props.onCheck(m, true)
                  // 已经在多选了：点一下就是勾选或取消这一封，而不是打开它
                  else if (e.ctrlKey || e.metaKey || selecting) props.onCheck(m, false)
                  else props.onSelect(m)
                }}
                onMouseEnter={() => props.onHover?.(m)}
                onMouseLeave={() => props.onHover?.(null)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  props.onContextMenu(m, e.clientX, e.clientY)
                }}
              >
                <span className="unread-dot" aria-hidden="true" />
                <span
                  className="avatar-slot"
                  title={isChecked ? '取消选择' : '选择'}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onCheck(m, e.shiftKey)
                  }}
                >
                  <span className="avatar" style={{ background: avatarColor(who?.address || single) }}>
                    {avatarText(who)}
                  </span>
                  <span className={`check-mark ${isChecked ? 'on' : ''}`} role="checkbox" aria-checked={isChecked} aria-label="选择这封邮件">
                    {isChecked && <Icon name="check" size={16} />}
                  </span>
                </span>
                <span className="msg-main">
                  <span className="msg-row">
                    <span className={`msg-from ${vip ? 'vip' : ''}`} title={vip ? '重要发件人' : undefined}>
                      <span className="from-text">{name}</span>
                      {thread && (
                        <span className="thread-count" title={`这个会话里有 ${thread.count} 封邮件`}>
                          {thread.count}
                        </span>
                      )}
                    </span>
                    <span className="msg-meta">
                      {isPinned && (
                        <span className="mark-pin" title="已置顶">
                          <Icon name="pin" size={12} filled />
                        </span>
                      )}
                      {flagged && (
                        <span className="mark-star" title="已加星标">
                          <Icon name="star" size={12} filled />
                        </span>
                      )}
                      {props.folderLabel && <span className="folder-tag">{props.folderLabel(m)}</span>}
                      {(thread ? thread.attachments : m.hasAttachments) && (
                        <span className="mark" title="有附件">
                          <Icon name="clip" size={12} />
                        </span>
                      )}
                      {props.accountMarks?.[m.accountId] && (
                        <span className="acct-tag" style={{ ['--c' as string]: props.accountMarks[m.accountId].color }} title={`${props.accountMarks[m.accountId].email} 收到的`}>
                          <i style={{ background: props.accountMarks[m.accountId].color }} />
                          {props.accountMarks[m.accountId].label}
                        </span>
                      )}
                      {snooze ? (
                        <span className="msg-date snooze" title="到这个时间会回到收件箱">
                          <Icon name="clock" size={11} /> {friendlyTime(snooze.until)}
                        </span>
                      ) : (
                        <span className="msg-date">{shortDate(m.date)}</span>
                      )}
                    </span>
                  </span>
                  <span className="msg-subject">
                    {(thread ? thread.answered : m.answered) && (
                      <span className="mark" title="已回复">
                        <Icon name="reply" size={12} />
                      </span>
                    )}
                    <span className="subject-text">{m.subject || '（无主题）'}</span>
                  </span>
                  {props.showPreview && (
                    <span className="msg-preview">{preview === undefined ? ' ' : preview || '（没有文字内容）'}</span>
                  )}
                </span>

                {!selecting && (
                  <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {(
                      [
                        props.canArchive(m) && ['archive', '归档', 'archive', ''],
                        ['seen', unread ? '标为已读' : '标为未读', unread ? 'mailOpen' : 'unread', ''],
                        ['flag', flagged ? '取消星标' : '加星标', 'star', flagged ? 'on' : ''],
                        ['pin', isPinned ? '取消置顶' : '置顶', 'pin', isPinned ? 'on' : ''],
                        ['snooze', snooze ? '取消推迟' : '稍后处理', 'clock', ''],
                        ['delete', '删除', 'trash', 'danger']
                      ] as (false | [RowAction, string, IconName, string])[]
                    ).map(
                      (it) =>
                        it && (
                          <button
                            key={it[0]}
                            className={it[3]}
                            title={it[1]}
                            aria-label={it[1]}
                            onClick={(e) => {
                              const r = e.currentTarget.getBoundingClientRect()
                              props.onAction(m, it[0], { x: r.left, y: r.bottom + 4 })
                            }}
                          >
                            <Icon name={it[2]} size={18} filled={it[0] === 'flag' && flagged} />
                          </button>
                        )
                    )}
                  </span>
                )}
              </div>
            </Fragment>
          )
        })}

        {props.hasMore && !props.loading && !moreToRender && (
          <button className="load-more" onClick={() => props.onLoadMore()} disabled={props.loadingMore}>
            {props.loadingMore ? '正在加载…' : '加载更早的邮件'}
          </button>
        )}
      </div>
    </section>
  )
}
