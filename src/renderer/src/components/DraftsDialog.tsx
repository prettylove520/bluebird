import type { Account, LocalDraft } from '../../../shared/types'
import { friendlyTime } from '../utils'
import { Icon } from './Icon'

interface Props {
  drafts: LocalDraft[]
  accounts: Account[]
  onOpen: (d: LocalDraft) => void
  onDelete: (id: string) => void
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
export function DraftsDialog({ drafts, accounts, onOpen, onDelete, onOpenServerDrafts, onClose, confirm }: Props) {
  const sorted = [...drafts].sort((a, b) => b.savedAt - a.savedAt)
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
          {!sorted.length && <p className="muted">没有草稿。写信时内容会自动保存到这里，关掉窗口也不会丢。</p>}
          {sorted.map((d) => {
            const account = accounts.find((a) => a.id === d.accountId)
            return (
              <div key={d.id} className="sched-item">
                <button className="sched-main draft-open" onClick={() => onOpen(d)} title="继续编辑">
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
