import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Address, MessageDetail, MessageSummary } from '../../../shared/types'
import { avatarColor, avatarText, buildEmailDocument, displayName, formatSize, fullDate, shortDate } from '../utils'
import { canPreview } from './AttachmentViewer'
import { Icon } from './Icon'

/** 会话里的一封邮件（读信页里收起来显示成一行的那种） */
export interface ThreadItem {
  message: MessageSummary
  preview?: string
  /** 打开这个会话之前它还没读过 */
  fresh: boolean
  /** 这是我自己发出去的回复（在「已发送」里） */
  sent?: boolean
}

interface Props {
  detail: MessageDetail | null
  /** 正在看的邮件所在的会话，从早到晚；不是会话就不传 */
  thread?: ThreadItem[]
  /** 工具栏上的删除、归档会处理几封（会话里收到的那些；自己发出去的回复不算） */
  threadCount: number
  onOpenMember: (m: MessageSummary) => void
  /** 点附件：能直接看的（图片、文字、PDF）就在程序里预览 */
  onPreviewAttachment: (index: number) => void
  /** 这封邮件带的退订方式；已经退订过或者没有就不传 */
  unsubscribe?: 'oneclick' | 'mail' | 'link'
  unsubscribed: boolean
  unsubscribing: boolean
  onUnsubscribe: () => void
  /** 这个发件人第一次来信：问一下接受还是屏蔽 */
  gate: boolean
  onAcceptSender: () => void
  onBlockSender: () => void
  account?: Account
  /** 这个邮箱的短标签（QQ、公司…） */
  accountTag?: string
  showAccount: boolean
  loading: boolean
  error: string | null
  hasSelection: boolean
  canArchive: boolean
  /** 设置里开启了「自动显示远程图片」 */
  autoLoadImages: boolean
  /** 深色模式下邮件正文也用深色 */
  darkMail: boolean
  /** 邮件卡片右上角的「更多」菜单 */
  onMore: (x: number, y: number) => void
  /** 整屏阅读时显示「返回列表」按钮 */
  onBack?: () => void
  /** 返回按钮旁边的小箭头：上一封 / 下一封 */
  onNavMenu: (x: number, y: number) => void
  /** 闪电按钮：快捷回复菜单，选中后把文字填进回复框 */
  onQuickMenu: (x: number, y: number, fill: (text: string) => void) => void
  /** 这封邮件现在是不是已读 */
  seen: boolean
  onToggleSeen: () => void
  pinned: boolean
  snoozed: boolean
  quickReplies: string[]
  onTogglePin: () => void
  onSnooze: (x: number, y: number) => void
  onReply: () => void
  onReplyAll: () => void
  onForward: () => void
  onArchive: () => void
  onDelete: () => void
  onToggleFlag: () => void
  onRetry: () => void
  onSaveAttachment: (index: number) => void
  onOpenAttachment: (index: number) => void
  onRemoteImagesChange: (allowed: boolean) => void
  onQuickReply: (text: string) => Promise<void>
  onExpandReply: (text: string) => void
}

/** 附件类型小标签的颜色 */
function fileKind(name: string): { label: string; color: string } {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['pdf'].includes(ext)) return { label: 'PDF', color: '#e5484d' }
  if (['xls', 'xlsx', 'csv', 'et'].includes(ext)) return { label: ext.toUpperCase(), color: '#1f9d55' }
  if (['doc', 'docx', 'wps', 'rtf'].includes(ext)) return { label: ext.toUpperCase(), color: '#2f6fed' }
  if (['ppt', 'pptx', 'dps'].includes(ext)) return { label: ext.toUpperCase(), color: '#e8711a' }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(ext)) return { label: ext.toUpperCase(), color: '#8b5cf6' }
  if (['zip', 'rar', '7z', 'gz'].includes(ext)) return { label: ext.toUpperCase(), color: '#6b7280' }
  return { label: ext ? ext.toUpperCase().slice(0, 4) : '文件', color: '#6b7280' }
}

/** 现在是不是深色模式（跟随设置里的「颜色」） */
function useDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

function names(list: Address[], me?: string): string {
  return list.map((a) => (me && a.address.toLowerCase() === me ? '我' : a.name || a.address)).join('、')
}

export function Reader(props: Props) {
  const { detail } = props
  const [allowRemote, setAllowRemote] = useState(props.autoLoadImages)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const detailId = detail ? `${detail.accountId}|${detail.folder}|${detail.uid}` : ''
  const threadIndex = detail && props.thread ? props.thread.findIndex((t) => t.message.uid === detail.uid && t.message.folder === detail.folder && t.message.accountId === detail.accountId) : -1

  /** 会话里前面还有好几封收起来的邮件时，把正在看的这一封滚到眼前（上面留一封的位置，看得出前面还有） */
  const revealCard = (): void => {
    const box = scrollRef.current
    const card = cardRef.current
    if (!box || !card || threadIndex < 2) return
    const top = card.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTop = Math.max(0, top - 72)
  }
  useEffect(() => {
    revealCard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId])

  // 换一封邮件就恢复成「不加载远程图片」，并清空快速回复
  useEffect(() => {
    setAllowRemote(props.autoLoadImages)
    props.onRemoteImagesChange(props.autoLoadImages)
    setReply('')
    setReplyError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.uid, detail?.folder, detail?.accountId, props.autoLoadImages])

  // 快速回复输入框随内容长高
  useEffect(() => {
    const el = replyRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [reply])

  useEffect(() => () => observer.current?.disconnect(), [])

  /** 正文 iframe 的高度跟随内容，这样标题和正文一起滚动 */
  const fitFrame = (): void => {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    if (!frame || !doc?.documentElement) return
    let last = 0
    let grows = 0
    let lastWidth = 0
    let lastGrow = 0
    let pending = 0
    const measure = (): void => {
      pending = 0
      // 换了一封信、或者同一封信重新排版（显示图片、切换深色）之后，旧文档排队的这一次就作废
      if (!frame.isConnected || frame.contentDocument !== doc) return
      const h = Math.max(Math.ceil(doc.documentElement.scrollHeight), 120)
      if (Math.abs(h - last) < 2) return
      // 有的邮件把高度写成「跟窗口一样高再多一点」，iframe 一长它也跟着长，没完没了。
      // 只拦这种一帧接一帧的自己涨：窗口宽度变了、或者隔了一会儿才涨（图片加载完），都重新计数
      const width = frame.clientWidth
      const now = performance.now()
      if (width !== lastWidth || now - lastGrow > 300) grows = 0
      lastWidth = width
      if (last && h > last) {
        lastGrow = now
        if (++grows > 40) return
      }
      last = h
      frame.style.height = h + 'px'
    }
    // 不在回调里直接改高度，等下一帧再量，避免「量一次改一次」的连锁反应
    const schedule = (): void => {
      if (!pending) pending = requestAnimationFrame(measure)
    }
    measure()
    // 正文刚排出来、高度有了以后再对一次位置：之前页面太短的话可能没滚到位
    revealCard()
    observer.current?.disconnect()
    observer.current = new ResizeObserver(schedule)
    observer.current.observe(doc.documentElement)
    // 点过正文以后键盘焦点在 iframe 里，快捷键（Esc、Delete、上下翻信…）要转给主界面才有反应
    doc.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // 上下方向键留给阅读正文用，不拿来切换邮件（J / K 仍然可以切换）
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return
      window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, shiftKey: e.shiftKey, repeat: e.repeat }))
    })
  }

  const dark = useDark() && props.darkMail
  const srcDoc = useMemo(() => (detail ? buildEmailDocument(detail, allowRemote, dark) : ''), [detail, allowRemote, dark])

  if (!props.hasSelection) {
    return (
      <section className="reader empty">
        <div className="titlebar-drag reader-drag" />
        <div className="reader-empty">
          <div className="empty-mark">
            <Icon name="unread" size={28} />
          </div>
          <p>选择一封邮件来阅读</p>
          <span>用 ↑ ↓ 切换邮件，R 回复，Delete 删除</span>
        </div>
      </section>
    )
  }

  if (props.loading && !detail) {
    return (
      <section className="reader empty">
        <div className="titlebar-drag reader-drag" />
        {props.onBack && (
          <button className="tool no-drag reader-back" onClick={props.onBack} title="返回列表（Esc）" aria-label="返回列表">
            <Icon name="back" />
          </button>
        )}
        <div className="reader-empty">
          <p>正在打开邮件…</p>
        </div>
      </section>
    )
  }

  if (props.error || !detail) {
    return (
      <section className="reader empty">
        <div className="titlebar-drag reader-drag" />
        {props.onBack && (
          <button className="tool no-drag reader-back" onClick={props.onBack} title="返回列表（Esc）" aria-label="返回列表">
            <Icon name="back" />
          </button>
        )}
        <div className="reader-empty error">
          <p>{props.error || '没能打开这封邮件'}</p>
          <button className="link-btn" onClick={props.onRetry}>
            重试
          </button>
        </div>
      </section>
    )
  }

  const sender = detail.from[0]
  const me = props.account?.email.toLowerCase()
  const thread = props.thread && threadIndex >= 0 ? props.thread : undefined
  // 会话里有自己发出去的回复时说清楚：删除、归档只动收到的那几封
  const whole = props.threadCount > 1 ? (thread && thread.some((t) => t.sent) ? `会话里收到的 ${props.threadCount} 封` : `整个会话（${props.threadCount} 封）`) : ''

  /** 会话里没展开的邮件：一行，点一下换成看它 */
  const threadRow = (t: ThreadItem) => {
    const from = t.message.from[0]
    const mine = !!me && from?.address.toLowerCase() === me
    // 打开会话时还没读的，以及看的过程中新到的回复，都标出来
    const fresh = !t.sent && (t.fresh || !t.message.seen)
    return (
      <button
        key={`${t.message.folder}|${t.message.uid}`}
        className={`thread-item ${fresh ? 'fresh' : ''}`}
        onClick={() => props.onOpenMember(t.message)}
        title="点一下展开这封邮件"
      >
        <span className="avatar" style={{ background: avatarColor(from?.address || '') }}>
          {avatarText(from)}
        </span>
        <span className="thread-item-from">{mine || t.sent ? '我' : displayName(from)}</span>
        {t.sent && <span className="thread-item-sent">我的回复</span>}
        <span className="thread-item-preview">{t.preview || (t.preview === undefined ? '' : '（没有文字内容）')}</span>
        {fresh && <span className="thread-item-new">新</span>}
        {t.message.hasAttachments && (
          <span className="mark" title="有附件">
            <Icon name="clip" size={13} />
          </span>
        )}
        <time>{shortDate(t.message.date)}</time>
      </button>
    )
  }

  const sendReply = async (): Promise<void> => {
    const text = reply.trim()
    if (!text || sending) return
    setSending(true)
    setReplyError(null)
    try {
      await props.onQuickReply(text)
      setReply('')
    } catch (err) {
      setReplyError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="reader">
      <div className="toolbar titlebar-drag" role="toolbar" aria-label="邮件操作">
        <div className={`nav-pill no-drag ${props.onBack ? '' : 'solo'}`}>
          {props.onBack && (
            <button onClick={props.onBack} title="返回列表（Esc）" aria-label="返回列表">
              <Icon name="back" size={21} />
            </button>
          )}
          <button
            className="nav-more"
            onClick={(e) => {
              const r = e.currentTarget.parentElement!.getBoundingClientRect()
              props.onNavMenu(r.left, r.bottom + 6)
            }}
            title="上一封 / 下一封"
            aria-label="上一封或下一封"
          >
            <Icon name="chevronDown" size={17} />
          </button>
        </div>

        <button className="tool no-drag danger" onClick={props.onDelete} title={whole ? `删除${whole}（Delete）` : '删除（Delete）'} aria-label="删除">
          <Icon name="trash" size={21} />
        </button>
        {props.canArchive && (
          <button className="tool no-drag" onClick={props.onArchive} title={whole ? `归档${whole}（E）` : '归档（E）'} aria-label="归档">
            <Icon name="archive" size={21} />
          </button>
        )}
        <button
          className="tool no-drag"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            props.onQuickMenu(r.left, r.bottom + 6, (text) => {
              setReply(text)
              replyRef.current?.focus()
            })
          }}
          title="快捷回复"
          aria-label="快捷回复"
        >
          <Icon name="bolt" size={21} />
        </button>
        <button
          className={`tool no-drag ${props.seen ? '' : 'on-accent'}`}
          onClick={props.onToggleSeen}
          title={props.seen ? '标为未读（U）' : '标为已读（U）'}
          aria-label={props.seen ? '标为未读' : '标为已读'}
          aria-pressed={!props.seen}
        >
          <Icon name="circle" size={21} filled={!props.seen} />
        </button>
        <button
          className={`tool no-drag ${props.pinned ? 'on-accent' : ''}`}
          onClick={props.onTogglePin}
          title={props.pinned ? '取消置顶' : '置顶'}
          aria-label="置顶"
        >
          <Icon name="pin" size={21} filled={props.pinned} />
        </button>
        <button
          className={`tool no-drag ${detail.flagged ? 'on' : ''}`}
          onClick={props.onToggleFlag}
          title={detail.flagged ? '取消星标（S）' : '加星标（S）'}
          aria-label="星标"
        >
          <Icon name="star" size={21} filled={detail.flagged} />
        </button>
        <button
          className={`tool no-drag ${props.snoozed ? 'on-accent' : ''}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            props.onSnooze(r.left, r.bottom + 6)
          }}
          title={props.snoozed ? '取消推迟' : '稍后处理'}
          aria-label="稍后处理"
        >
          <Icon name="clock" size={21} />
        </button>
        <button
          className="tool no-drag more-pill"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            props.onMore(r.left, r.bottom + 6)
          }}
          title="更多操作"
          aria-label="更多操作"
        >
          <Icon name="more" size={21} />
        </button>

        <span className="tool-space" />
        <button className="pill-btn no-drag" onClick={props.onReply} title="回复（R）">
          <Icon name="reply" size={19} />
          回复
        </button>
        <button className="pill-btn no-drag" onClick={props.onForward} title="转发（F）">
          <Icon name="forward" size={19} />
          转发
        </button>
      </div>

      <div className="reader-scroll" ref={scrollRef}>
        <div className="mail-wrap">
          <h2 className="mail-subject">
            {detail.subject || '（无主题）'}
            {thread && <span className="thread-badge">{thread.length} 封邮件</span>}
          </h2>

          {thread && thread.slice(0, threadIndex).map(threadRow)}

          <article className="mail-card" ref={cardRef}>
            <header className="mail-from">
              <span className="avatar" style={{ background: avatarColor(sender?.address || '') }}>
                {avatarText(sender)}
              </span>
              <div className="mail-meta">
                <div className="mail-sender">
                  <strong>{displayName(sender)}</strong>
                  {sender?.name && <span className="mail-address">{sender.address}</span>}
                </div>
                <div className="mail-to">
                  发给 {names(detail.to, me) || '（无）'}
                  {detail.cc.length > 0 && <>，抄送 {names(detail.cc, me)}</>}
                  {props.showAccount && props.account && (
                    <span className="mail-account">
                      <span className="acct-tag" style={{ ['--c' as string]: props.account.color }}>
                        <i style={{ background: props.account.color }} />
                        {props.accountTag}
                      </span>
                      {props.account.email}
                    </span>
                  )}
                </div>
              </div>
              <time className="mail-date">{fullDate(detail.date)}</time>
              <button
                className="icon-btn more-btn"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  props.onMore(r.right - 220, r.bottom + 4)
                }}
                title="更多操作"
                aria-label="更多操作"
              >
                <Icon name="more" />
              </button>
            </header>

            {props.gate && (
              <div className="notice gate">
                <Icon name="user" />
                <span>
                  第一次收到 <strong>{sender?.address}</strong> 的来信。认识的话点「接受」，以后不再提示；不想再看到就屏蔽
                </span>
                <button className="link-btn" onClick={props.onAcceptSender}>
                  接受
                </button>
                <button className="link-btn danger" onClick={props.onBlockSender}>
                  屏蔽
                </button>
              </div>
            )}

            {(props.unsubscribe || props.unsubscribed) && (
              <div className="notice">
                <Icon name="bell" />
                <span>{props.unsubscribed ? '已经替你退订了，对方可能过几天才会停止发送' : '这是一封订阅邮件。不想再收到的话可以直接退订'}</span>
                {props.unsubscribe && (
                  <button className="link-btn" onClick={props.onUnsubscribe} disabled={props.unsubscribing}>
                    {props.unsubscribing ? '正在退订…' : '退订'}
                  </button>
                )}
              </div>
            )}

            {detail.hasRemoteImages && !allowRemote && (
              <div className="notice">
                <Icon name="image" />
                <span>已拦截远程图片，防止发件人追踪你是否读过这封邮件</span>
                <button
                  className="link-btn"
                  onClick={() => {
                    setAllowRemote(true)
                    props.onRemoteImagesChange(true)
                  }}
                >
                  显示图片
                </button>
              </div>
            )}

            {detail.attachments.length > 0 && (
              <ul className="attachments" aria-label="附件">
                {detail.attachments.map((a) => {
                  const kind = fileKind(a.filename)
                  return (
                    <li key={a.index} className="attachment">
                      <button
                        className="att-open"
                        onClick={() => (canPreview(a.filename) ? props.onPreviewAttachment(a.index) : props.onOpenAttachment(a.index))}
                        title={canPreview(a.filename) ? `预览 ${a.filename}` : `打开 ${a.filename}`}
                      >
                        <span className="att-kind" style={{ background: kind.color }}>
                          {kind.label}
                        </span>
                        <span className="att-text">
                          <span className="att-name">{a.filename}</span>
                          <span className="att-size">{formatSize(a.size)}</span>
                        </span>
                      </button>
                      <button className="icon-btn small" onClick={() => props.onSaveAttachment(a.index)} title="保存到电脑" aria-label="保存附件">
                        <Icon name="download" size={14} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className={`mail-body ${dark ? 'dark' : ''}`}>
              {/* 沙箱：禁止脚本和表单（没有 allow-scripts，所以开放同源只用于量高度，邮件本身无法执行代码）；链接在系统浏览器打开 */}
              <iframe
                ref={frameRef}
                key={`${detail.accountId}-${detail.folder}-${detail.uid}`}
                title="邮件正文"
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                srcDoc={srcDoc}
                onLoad={fitFrame}
              />
            </div>

            <footer className="mail-card-foot">
              <button className="icon-btn" onClick={props.onReply} title="回复（R）" aria-label="回复">
                <Icon name="reply" size={18} />
              </button>
              <button className="icon-btn" onClick={props.onReplyAll} title="全部回复（A）" aria-label="全部回复">
                <Icon name="replyAll" size={18} />
              </button>
              <button className="icon-btn" onClick={props.onForward} title="转发（F）" aria-label="转发">
                <Icon name="forward" size={18} />
              </button>
            </footer>
          </article>

          {thread && thread.slice(threadIndex + 1).map(threadRow)}
        </div>
      </div>

      <div className="quick-reply">
        {props.quickReplies.length > 0 && !reply && (
          <div className="qr-chips">
            {props.quickReplies.map((t, i) => (
              <button
                key={i}
                onClick={() => {
                  setReply(t)
                  replyRef.current?.focus()
                }}
                title="填入回复框，可以再修改"
              >
                {t}
              </button>
            ))}
          </div>
        )}
        <div className={`qr-box ${reply ? 'active' : ''}`}>
          <textarea
            ref={replyRef}
            rows={1}
            value={reply}
            placeholder={`回复 ${displayName(sender)}…`}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void sendReply()
              }
            }}
            disabled={sending}
          />
          <div className="qr-actions">
            <button className="icon-btn small" title="在完整窗口里编辑" aria-label="展开" onClick={() => props.onExpandReply(reply)}>
              <Icon name="external" size={14} />
            </button>
            <button className="qr-send" onClick={sendReply} disabled={!reply.trim() || sending} title="发送（Ctrl+Enter）" aria-label="发送">
              <Icon name="sent" size={15} />
            </button>
          </div>
        </div>
        {replyError && <p className="qr-error">{replyError}</p>}
      </div>
    </section>
  )
}
