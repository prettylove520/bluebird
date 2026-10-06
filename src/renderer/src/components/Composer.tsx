import { useEffect, useRef, useState } from 'react'
import type { Account, ComposeAttachment, ComposeSettings, LocalDraft, OutgoingMessage, Template } from '../../../shared/types'
import { AI_TONES, type AiMail } from '../../../shared/ai'
import { api } from '../api'
import { escapeHtml, formatSize, timePresets } from '../utils'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { RecipientInput } from './RecipientInput'
import { TimeDialog } from './TimeDialog'

export interface ComposeInit {
  mode: 'new' | 'reply' | 'replyAll' | 'forward'
  accountId: string
  to: string
  cc: string
  subject: string
  /** 引用的原文等，放在光标下方 */
  bodyHtml: string
  inReplyTo?: string
  references?: string[]
  replyTo?: { accountId?: string; folder: string; uid: number }
  attachments: ComposeAttachment[]
  bcc?: string
  /** 从草稿恢复时，编辑器里的完整内容（有它就不再用 bodyHtml） */
  rawHtml?: string
  /** 从草稿恢复时，沿用原来的草稿编号 */
  draftId?: string
  /** 打开时就要显示的提示：比如这封信刚才没发出去的原因 */
  error?: string
  /** 回复时：被回复的那封邮件，AI 写回复要参考它 */
  aiContext?: AiMail
  /** 打开写信窗口时就展开 AI 写作面板 */
  aiOpen?: boolean
}

const QUOTE_SEL = '[data-signature],[data-quote-head],blockquote'

/** AI 写的文字放进编辑器：空行分段，单个换行保留 */
function aiToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<div>${p.split('\n').map(escapeHtml).join('<br>')}</div>`)
    .join('<div><br></div>')
}

const TITLES: Record<ComposeInit['mode'], string> = {
  new: '新邮件',
  reply: '回复',
  replyAll: '全部回复',
  forward: '转发'
}

interface Props {
  init: ComposeInit
  accounts: Account[]
  settings: ComposeSettings
  /** 取某个账号的签名（HTML 片段），切换发件人时用来替换签名 */
  signatureFor: (accountId: string) => string
  templates: Template[]
  /** 设置里开了 AI 助手 */
  aiReady: boolean
  /** 设置里选的默认语气 */
  aiTone: string
  /** 定时发送：把邮件放进队列，成功后关闭写信窗口 */
  onSchedule: (msg: OutgoingMessage, sendAt: number) => Promise<void>
  /** 开了「撤销发送」时：把邮件交出去排队，过几秒才真正发出。成功后写信窗口会被关掉 */
  onQueue: (msg: OutgoingMessage, draftId: string) => Promise<void>
  /** 自动保存草稿（写在本机） */
  onSaveDraft: (draft: LocalDraft) => void
  /** 邮件发出或被放弃后，删掉对应的草稿 */
  onDiscardDraft: (id: string) => void
  /** savedDraft 为 true 表示关闭时内容已经存成草稿 */
  onClose: (savedDraft: boolean) => void
  onSent: (message: string) => void
}

export function Composer(props: Props) {
  const { init, accounts, settings, signatureFor, templates, onSchedule, onClose, onSent } = props
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null)
  const [pickTime, setPickTime] = useState(false)
  const [accountId, setAccountId] = useState(init.accountId)
  const [to, setTo] = useState(init.to)
  const [cc, setCc] = useState(init.cc)
  const [bcc, setBcc] = useState(init.bcc || '')
  const [showCc, setShowCc] = useState(!!init.cc || !!init.bcc)
  const [subject, setSubject] = useState(init.subject)
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(init.attachments)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  sendingRef.current = sending
  const [error, setError] = useState<string | null>(init.error ? `刚才没有发出去：${init.error}` : null)
  const [confirmNoSubject, setConfirmNoSubject] = useState(false)
  /** 选了定时发送但被「没有主题」提醒拦下时，记住选的时间 */
  const [pendingAt, setPendingAt] = useState<number | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [linkInput, setLinkInput] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)
  // AI 写作
  const [aiOpen, setAiOpen] = useState(!!init.aiOpen)
  const [aiMode, setAiMode] = useState<'write' | 'polish'>('write')
  const [aiTone, setAiTone] = useState(props.aiTone)
  const [aiInstr, setAiInstr] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiResult, setAiResult] = useState<{ text: string; subject?: string; polish: boolean } | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const aiRun = useRef(0)
  const toRef = useRef<HTMLInputElement>(null)
  const savedRange = useRef<Range | null>(null)
  const dirty = useRef(false)
  const draftId = useRef(init.draftId || `d${Date.now()}`)
  // 打开时的内容和上一次存下来的内容，用来判断有没有改动
  const baseline = useRef('')
  const lastSaved = useRef('')
  // 定时器里要用到最新的字段值和回调
  const latest = useRef({ props, accountId, to, cc, bcc, subject, attachments })
  latest.current = { props, accountId, to, cc, bcc, subject, attachments }

  const snapshot = (): string => {
    const v = latest.current
    return JSON.stringify([v.accountId, v.to, v.cc, v.bcc, v.subject, editorRef.current?.innerHTML ?? '', v.attachments])
  }

  /** 内容有变化就存一份草稿；返回这封邮件现在是否存有草稿 */
  const saveDraft = (force = false): boolean => {
    const snap = snapshot()
    // force：不管有没有改动都存一份（撤销发送要靠草稿把信找回来）
    if (!force && snap === baseline.current && !init.draftId) return false
    if (snap === lastSaved.current || (!force && snap === baseline.current && init.draftId)) return true
    const v = latest.current
    lastSaved.current = snap
    v.props.onSaveDraft({
      id: draftId.current,
      savedAt: Date.now(),
      mode: init.mode,
      accountId: v.accountId,
      to: v.to,
      cc: v.cc,
      bcc: v.bcc,
      subject: v.subject,
      html: editorRef.current?.innerHTML ?? '',
      attachments: v.attachments,
      inReplyTo: init.inReplyTo,
      references: init.references,
      replyTo: init.replyTo
    })
    return true
  }

  // 每隔几秒自动保存一次，意外关闭也不会丢
  useEffect(() => {
    const t = setInterval(() => {
      if (!sendingRef.current) saveDraft()
    }, 4000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    ed.innerHTML = init.rawHtml ?? '<div><br></div>' + init.bodyHtml
    baseline.current = snapshot()
    // 新邮件先填收件人；回复时光标放在正文最前面
    if (init.mode === 'new' || init.mode === 'forward') {
      toRef.current?.focus()
    } else {
      ed.focus()
      const range = document.createRange()
      range.setStart(ed, 0)
      range.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [init])

  /** 编辑器里属于「我写的」那一部分：签名、引用的原文之前的内容 */
  const userNodes = (): ChildNode[] => {
    const ed = editorRef.current
    if (!ed) return []
    const out: ChildNode[] = []
    for (const n of Array.from(ed.childNodes)) {
      if (n instanceof HTMLElement && (n.matches(QUOTE_SEL) || n.querySelector(QUOTE_SEL))) break
      out.push(n)
    }
    return out
  }
  const userText = (): string =>
    userNodes()
      .map((n) => (n instanceof HTMLElement ? n.innerText : n.textContent || ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

  const aiGenerate = (): void => {
    const polish = aiMode === 'polish'
    const draft = userText()
    const wantSubject = !polish && !init.aiContext && !subject.trim()
    const run = ++aiRun.current
    setAiBusy(true)
    setAiError(null)
    setAiResult(null)
    api
      .aiRun({
        task: polish ? 'polish' : init.aiContext ? 'reply' : 'compose',
        mail: init.aiContext,
        instruction: aiInstr.trim() || undefined,
        draft: draft || undefined,
        tone: aiTone,
        wantSubject,
        me: accounts.find((a) => a.id === accountId)?.name
      })
      .then((raw) => {
        if (run !== aiRun.current) return
        let text = raw.trim()
        let subj: string | undefined
        if (wantSubject) {
          const m = text.match(/^\s*(?:主题|Subject)\s*[:：]\s*(.+?)\s*(?:\n|$)/i)
          if (m) {
            subj = m[1].trim()
            text = text.slice(m[0].length).replace(/^\s*\n/, '').trim()
          }
        }
        setAiResult({ text, subject: subj, polish })
      })
      .catch((e: unknown) => {
        if (run === aiRun.current) setAiError(String((e as Error)?.message || e))
      })
      .finally(() => {
        if (run === aiRun.current) setAiBusy(false)
      })
  }

  /** 把 AI 写好的放进正文：replace 是换掉我已经写的那部分，否则接在后面 */
  const aiApply = (replace: boolean): void => {
    const ed = editorRef.current
    if (!ed || !aiResult) return
    const nodes = userNodes()
    const hadText = userText() !== ''
    const ref = nodes.length ? nodes[nodes.length - 1].nextSibling : ed.firstChild
    if (replace || !hadText) nodes.forEach((n) => n.remove())
    const holder = document.createElement('div')
    holder.innerHTML = (hadText && !replace ? '<div><br></div>' : '') + aiToHtml(aiResult.text) + '<div><br></div>'
    while (holder.firstChild) ed.insertBefore(holder.firstChild, ref)
    if (aiResult.subject && !subject.trim()) setSubject(aiResult.subject)
    dirty.current = true
    setAiResult(null)
    ed.focus()
  }

  const exec = (cmd: string, value?: string): void => {
    editorRef.current?.focus()
    document.execCommand(cmd, false, value)
    dirty.current = true
  }

  const openLink = (): void => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange()
    }
    setLinkInput('https://')
  }

  const applyLink = (): void => {
    const url = (linkInput || '').trim()
    setLinkInput(null)
    if (!url || url === 'https://') return
    const ed = editorRef.current
    ed?.focus()
    const sel = window.getSelection()
    if (savedRange.current && sel) {
      sel.removeAllRanges()
      sel.addRange(savedRange.current)
    }
    if (sel && !sel.isCollapsed) exec('createLink', url)
    else exec('insertHTML', `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`)
  }

  const addFiles = async (): Promise<void> => {
    try {
      const files = await api.pickFiles()
      if (files.length) {
        setAttachments((a) => [...a, ...files])
        dirty.current = true
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    const added: ComposeAttachment[] = []
    for (const f of files) {
      const path = window.bluebirdFiles?.pathFor(f)
      if (path) added.push({ path, filename: f.name, size: f.size })
    }
    if (added.length) {
      setAttachments((a) => [...a, ...added])
      dirty.current = true
    }
  }

  const totalSize = attachments.reduce((s, a) => s + a.size, 0)

  /** 检查收件人和主题，通过后返回要发出的邮件；没通过返回 null */
  const buildMessage = (): OutgoingMessage | null => {
    setError(null)
    if (!to.trim() && !cc.trim() && !bcc.trim()) {
      setError('请填写收件人')
      toRef.current?.focus()
      return null
    }
    if (settings.warnEmptySubject && !subject.trim() && !confirmNoSubject) {
      setConfirmNoSubject(true)
      return null
    }
    const ed = editorRef.current!
    return {
      accountId,
      to,
      cc,
      bcc,
      subject: subject.trim(),
      html: `<div style="font-family:'Microsoft YaHei UI','Segoe UI',Arial,sans-serif;font-size:${settings.fontSize}px;line-height:1.6">${ed.innerHTML}</div>`,
      text: ed.innerText,
      attachments,
      inReplyTo: init.inReplyTo,
      references: init.references,
      replyTo: init.replyTo
    }
  }

  const send = async (): Promise<void> => {
    if (sending) return
    // 刚才选的是定时发送，只是被「没有主题」的提醒拦了一下：这次继续按定时来，不能变成立刻发出
    if (pendingAt != null) {
      if (pendingAt > Date.now()) {
        void schedule(pendingAt)
        return
      }
      // 选的时间已经过了，就当作立即发送
      setPendingAt(null)
    }
    const msg = buildMessage()
    if (!msg) return
    setSending(true)
    if (settings.undoSeconds > 0) {
      // 先等几秒再真正发出，这期间可以撤销。草稿留着：撤销或者没发出去时从它接着改
      try {
        saveDraft(true)
        await props.onQueue(msg, draftId.current)
      } catch (err) {
        setError((err as Error).message)
        setSending(false)
      }
      return
    }
    try {
      const res = await api.send(msg)
      const account = accounts.find((a) => a.id === accountId)
      props.onDiscardDraft(draftId.current)
      onSent(account?.appendSent && !res.savedToSent ? '已发送，但没能存到「已发送」文件夹' : '已发送')
    } catch (err) {
      setError((err as Error).message)
      setSending(false)
    }
  }

  const schedule = async (sendAt: number): Promise<void> => {
    if (sending) return
    const msg = buildMessage()
    if (!msg) {
      setPendingAt(sendAt)
      return
    }
    setPendingAt(null)
    setSending(true)
    try {
      await onSchedule(msg, sendAt)
      props.onDiscardDraft(draftId.current)
    } catch (err) {
      setError((err as Error).message)
      setSending(false)
    }
  }

  const openScheduleMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.top - 8 - 36 * (timePresets().length + 1) - 30,
      title: '定时发送',
      items: [
        ...timePresets().map((p) => ({ label: `${p.label}`, icon: 'clock' as const, onClick: () => void schedule(p.at) })),
        { label: '自定义时间…', icon: 'sliders' as const, separator: true, onClick: () => setPickTime(true) }
      ]
    })
  }

  /** 插入模板：正文放到光标处（编辑器开头），主题为空时顺便填上 */
  const insertTemplate = (t: Template): void => {
    const ed = editorRef.current
    if (!ed) return
    const html = escapeHtml(t.body).replace(/\r?\n/g, '<br>')
    const block = document.createElement('div')
    block.innerHTML = html
    ed.insertBefore(block, ed.firstChild)
    if (!subject.trim() && t.subject) setSubject(t.subject)
    dirty.current = true
    ed.focus()
  }

  const openTemplateMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      title: '插入模板',
      items: templates.map((t) => ({ label: t.name, icon: 'drafts' as const, onClick: () => insertTemplate(t) }))
    })
  }

  /** 关闭窗口：有内容就存成草稿，不会丢 */
  const tryClose = (): void => {
    if (sending) return
    onClose(saveDraft())
  }

  /** 放弃这封邮件：连草稿一起删掉。有内容时要再点一次确认 */
  const discard = (): void => {
    const hasContent = snapshot() !== baseline.current || !!init.draftId
    if (hasContent && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    props.onDiscardDraft(draftId.current)
    onClose(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape' && linkInput === null && !menu && !pickTime) {
      e.preventDefault()
      tryClose()
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && tryClose()}>
      <div
        className={`composer ${dragging ? 'dragging' : ''}`}
        role="dialog"
        aria-label={TITLES[init.mode]}
        onKeyDown={onKeyDown}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false)
        }}
        onDrop={onDrop}
      >
        <header className="composer-head">
          <h2>{TITLES[init.mode]}</h2>
          <button className="icon-btn" onClick={tryClose} title="关闭并存为草稿（Esc）" aria-label="关闭">
            <Icon name="x" />
          </button>
        </header>

        <div className="fields">
          {accounts.length > 1 && (
            <label className="field">
              <span>发件人</span>
              <select
                value={accountId}
                onChange={(e) => {
                  // 换发件人时把签名换成对应账号的。签名块里如果已经写了别的内容（比如正文写在了签名那一行），就不动它，免得把正文抹掉
                  const sig = editorRef.current?.querySelector('[data-signature]')
                  if (sig) {
                    const probe = document.createElement('div')
                    probe.innerHTML = signatureFor(accountId)
                    if (sig.innerHTML === probe.innerHTML) sig.innerHTML = signatureFor(e.target.value)
                  }
                  setAccountId(e.target.value)
                }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} &lt;{a.email}&gt;
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>收件人</span>
            <RecipientInput inputRef={toRef} value={to} onChange={setTo} placeholder="输入名字或地址，多个用逗号分隔" />
            {!showCc && (
              <button type="button" className="link-btn" onClick={() => setShowCc(true)}>
                抄送/密送
              </button>
            )}
          </label>
          {showCc && (
            <>
              <label className="field">
                <span>抄送</span>
                <RecipientInput value={cc} onChange={setCc} />
              </label>
              <label className="field">
                <span>密送</span>
                <RecipientInput value={bcc} onChange={setBcc} />
              </label>
            </>
          )}
          <label className="field">
            <span>主题</span>
            <input
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value)
                setConfirmNoSubject(false)
              }}
            />
          </label>
        </div>

        <div className="format-bar" role="toolbar" aria-label="格式">
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')} title="加粗（Ctrl+B）">
            <b>B</b>
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')} title="斜体（Ctrl+I）">
            <i>I</i>
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')} title="下划线（Ctrl+U）">
            <u>U</u>
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')} title="项目符号">
            <Icon name="bullets" />
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertOrderedList')} title="编号列表">
            1.
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={openLink} title="插入链接">
            <Icon name="link" />
          </button>
          <button type="button" className="text-tool" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('removeFormat')} title="清除格式">
            清除格式
          </button>
          {templates.length > 0 && (
            <button type="button" className="text-tool" onMouseDown={(e) => e.preventDefault()} onClick={openTemplateMenu} title="插入一个保存好的模板">
              模板
            </button>
          )}
          <button
            type="button"
            className={`text-tool ai-tool ${aiOpen ? 'on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAiOpen((v) => !v)}
            title="让 AI 帮你写邮件、写回复或润色"
          >
            <Icon name="sparkle" size={15} />
            AI 写作
          </button>
          {linkInput !== null && (
            <span className="link-input">
              <input
                autoFocus
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    applyLink()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setLinkInput(null)
                  }
                }}
              />
              <button type="button" className="link-btn" onClick={applyLink}>
                插入
              </button>
            </span>
          )}
        </div>

        {aiOpen && (
          <div className="ai-panel">
            {!props.aiReady ? (
              <p className="ai-off">AI 助手还没有开启。到「设置 → AI 助手」里选好服务商、填上密钥并打开开关，就可以在这里用了。</p>
            ) : (
              <>
                <div className="ai-row">
                  <div className="ai-seg" role="tablist">
                    <button type="button" className={aiMode === 'write' ? 'on' : ''} onClick={() => setAiMode('write')}>
                      {init.aiContext ? '写回复' : '帮我写'}
                    </button>
                    <button type="button" className={aiMode === 'polish' ? 'on' : ''} onClick={() => setAiMode('polish')}>
                      润色我写的
                    </button>
                  </div>
                  <select value={aiTone} onChange={(e) => setAiTone(e.target.value)} title="语气" aria-label="语气">
                    {AI_TONES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <span className="tool-space" />
                  <button type="button" className="link-btn" onClick={() => setAiOpen(false)}>
                    收起
                  </button>
                </div>
                <textarea
                  className="ai-input"
                  rows={2}
                  value={aiInstr}
                  autoFocus={!!init.aiOpen}
                  onChange={(e) => setAiInstr(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !aiBusy) {
                      e.preventDefault()
                      aiGenerate()
                    }
                  }}
                  placeholder={
                    aiMode === 'polish'
                      ? '润色的要求（可以不写）：比如「更礼貌一点」「改短一些」'
                      : init.aiContext
                        ? '想怎么回（可以不写）：比如「同意，但时间改到周五下午」'
                        : '想写什么：比如「通知对方会议改到周五下午三点，请回复确认」'
                  }
                />
                <div className="ai-row">
                  <button type="button" className="pill-btn small primary" onClick={aiGenerate} disabled={aiBusy}>
                    <Icon name="sparkle" size={15} />
                    {aiBusy ? '正在写…' : aiResult ? '重新生成' : '生成'}
                  </button>
                  <span className="ai-tip">Ctrl+Enter 生成。AI 不会替你发信，写好后由你检查再发</span>
                </div>
                {aiError && <p className="ai-error">{aiError}</p>}
                {aiResult && (
                  <div className="ai-result">
                    {aiResult.subject && <div className="ai-subject">主题：{aiResult.subject}</div>}
                    <div className="ai-body">{aiResult.text}</div>
                    <div className="ai-row">
                      {aiResult.polish ? (
                        <button type="button" className="pill-btn small primary" onClick={() => aiApply(true)}>
                          替换我写的
                        </button>
                      ) : (
                        <button type="button" className="pill-btn small primary" onClick={() => aiApply(false)}>
                          放进正文
                        </button>
                      )}
                      {!aiResult.polish && userText() !== '' && (
                        <button type="button" className="pill-btn small" onClick={() => aiApply(true)}>
                          替换我写的
                        </button>
                      )}
                      <button type="button" className="link-btn" onClick={() => void navigator.clipboard?.writeText(aiResult.text)}>
                        复制
                      </button>
                      <button type="button" className="link-btn" onClick={() => setAiResult(null)}>
                        不要了
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div
          ref={editorRef}
          className="editor"
          style={{ fontSize: settings.fontSize }}
          contentEditable
          suppressContentEditableWarning
          onInput={() => (dirty.current = true)}
          aria-label="正文"
        />

        {attachments.length > 0 && (
          <ul className="compose-atts">
            {attachments.map((a, i) => (
              <li key={i}>
                <Icon name="clip" size={14} />
                <span className="att-name">{a.filename}</span>
                <span className="att-size">{formatSize(a.size)}</span>
                <button
                  className="icon-btn small"
                  onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))}
                  title="移除"
                  aria-label={`移除 ${a.filename}`}
                >
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {totalSize > 20 * 1024 * 1024 && <p className="compose-warn">附件总大小超过 20 MB，很多邮箱会拒收，建议改用网盘链接。</p>}
        {confirmNoSubject && pendingAt == null && <p className="compose-warn">没有填写主题。再点一次「发送」就直接发出。</p>}
        {pendingAt != null && (
          <p className="compose-warn">
            {confirmNoSubject ? '没有填写主题。' : ''}再点一次「发送」会按刚才选的时间定时发出。
            <button type="button" className="link-btn" onClick={() => setPendingAt(null)}>
              改为立即发送
            </button>
          </p>
        )}
        {confirmDiscard && (
          <p className="compose-warn">
            确定放弃这封邮件吗？内容和草稿都会删除。
            <button className="link-btn danger" onClick={discard}>
              放弃
            </button>
            <button className="link-btn" onClick={() => setConfirmDiscard(false)}>
              继续编辑
            </button>
          </p>
        )}
        {error && <p className="compose-error">{error}</p>}

        <footer className="composer-foot">
          <button className="ghost-btn" onClick={addFiles} disabled={sending}>
            <Icon name="clip" />
            添加附件
          </button>
          <button className="ghost-btn icon-only" onClick={discard} disabled={sending} title="放弃这封邮件" aria-label="放弃这封邮件">
            <Icon name="trash" />
          </button>
          <span className="foot-hint">
            {settings.undoSeconds > 0 ? `Ctrl + Enter 发送，发出前 ${settings.undoSeconds} 秒内可以撤销` : 'Ctrl + Enter 发送，内容会自动存为草稿'}
          </span>
          <button className="ghost-btn bordered" onClick={openScheduleMenu} disabled={sending} title="选一个时间，到点自动发出">
            <Icon name="clock" />
            定时
          </button>
          <button className="primary-btn" onClick={send} disabled={sending}>
            <Icon name="sent" />
            {sending ? '正在发送…' : '发送'}
          </button>
        </footer>
        {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
        {pickTime && (
          <TimeDialog
            title="定时发送"
            confirmLabel="定时发送"
            onCancel={() => setPickTime(false)}
            onPick={(ts) => {
              setPickTime(false)
              void schedule(ts)
            }}
          />
        )}
      </div>
    </div>
  )
}
