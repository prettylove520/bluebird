import { useState } from 'react'
import type { Account, LocalDraft } from '../../../shared/types'
import { friendlyTime } from '../utils'
import { Icon } from './Icon'

interface Props {
  drafts: LocalDraft[]
  accounts: Account[]
  onOpen: (d: LocalDraft) => void
  onDelete: (id: string) => void
  /** 一次删掉好几份（多选） */
  onDeleteMany: (ids: string[]) => void
  /** 打开邮箱服务器上的草稿箱文件夹（在别的设备或网页版里存的草稿在那里） */
  onOpenServerDrafts: () => void
  onClose: () => void
  /** 弹确认框 */
  confirm: (c: { title: string; message: string; confirmLabel: string; onConfirm: () => void }) => void
}

/** 把草稿里的 HTML 变成一行纯文字，用来预览 */
function plain(html: string): string {
  // 用 DOMParser 解析：不会像直接塞进页面那样去加载草稿里的远程图片
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
}

/** 草稿列表：写信时自动保存在本机的草稿 */
export function DraftsDialog({ drafts, accounts, onOpen, onDelete, onDeleteMany, onOpenServerDrafts, onClose, confirm }: Props) {
  const sorted = [...drafts].sort((a, b) => b.savedAt - a.savedAt)
  // 多选：勾几份，一起删掉
  const [multi, setMulti] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const toggle = (id: string): void =>
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const picked = sorted.filter((d) => sel.has(d.id))
  const exit = (): void => {
    setMulti(false)
    setSel(new Set())
  }
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="草稿">
        <header className="dialog-head">
          <h2>草稿</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭">
            <Icon name="x" />
          </button>
        </header>
        <div className="dialog-body">
          {sorted.length > 1 && (
            <div className="draft-bar">
              {multi ? (
                <>
                  <span className="muted small">{picked.length ? `已选 ${picked.length} 份` : '点草稿来选择'}</span>
                  <button className="link-btn" onClick={() => setSel(sel.size >= sorted.length ? new Set() : new Set(sorted.map((d) => d.id)))}>
                    {sel.size >= sorted.length ? '取消全选' : '全选'}
                  </button>
                  <button
                    className="link-btn danger"
                    disabled={!picked.length}
                    onClick={() =>
                      confirm({
                        title: `删除选中的 ${picked.length} 份草稿？`,
                        message: '删除后无法恢复。',
                        confirmLabel: '删除',
                        onConfirm: () => {
                          onDeleteMany(picked.map((d) => d.id))
                          exit()
                        }
                      })
                    }
                  >
                    删除所选
                  </button>
                  <button className="link-btn" onClick={exit}>
                    完成
                  </button>
                </>
              ) : (
                <button className="link-btn" onClick={() => setMulti(true)}>
                  多选
                </button>
              )}
            </div>
          )}
          {!sorted.length && <p className="muted">没有草稿。写信时内容会自动保存到这里，关掉窗口也不会丢。</p>}
          {sorted.map((d) => {
            const account = accounts.find((a) => a.id === d.accountId)
            return (
              <div key={d.id} className={`sched-item ${multi && sel.has(d.id) ? 'picked' : ''}`}>
                {multi && <input type="checkbox" className="draft-check" checked={sel.has(d.id)} onChange={() => toggle(d.id)} aria-label="选择这份草稿" />}
                <button className="sched-main draft-open" onClick={() => (multi ? toggle(d.id) : onOpen(d))} title={multi ? '选择' : '继续编辑'}>
                  <strong>{d.subject || '（无主题）'}</strong>
                  <span className="muted small">
                    {d.to ? `发给 ${d.to}` : '还没填收件人'}
                    {account && accounts.length > 1 ? `，从 ${account.email} 发出` : ''}
                  </span>
                  <span className="muted small">{plain(d.html).slice(0, 80) || '（没有正文）'}</span>
                </button>
                <div className="sched-actions">
                  <span className="muted small">{friendlyTime(d.savedAt)}</span>
                  <button
                    className="link-btn danger"
                    hidden={multi}
                    onClick={() =>
                      confirm({
                        title: `删除草稿「${d.subject || '（无主题）'}」？`,
                        message: '删除后无法恢复。',
                        confirmLabel: '删除',
                        onConfirm: () => onDelete(d.id)
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
          <button className="link-btn left" onClick={onOpenServerDrafts}>
            查看邮箱里的草稿箱文件夹
          </button>
        </div>
      </div>
    </div>
  )
}
