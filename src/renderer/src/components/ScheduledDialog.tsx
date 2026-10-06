import { useState } from 'react'
import type { Account, ScheduledMail } from '../../../shared/types'
import { friendlyTime } from '../utils'
import { Icon } from './Icon'

interface Props {
  items: ScheduledMail[]
  accounts: Account[]
  onSendNow: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>
  onClose: () => void
  /** 弹确认框 */
  confirm: (c: { title: string; message: string; confirmLabel: string; onConfirm: () => void }) => void
}

/** 定时发送队列：查看、立即发送、取消 */
export function ScheduledDialog({ items, accounts, onSendNow, onCancel, onClose, confirm }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (id: string, fn: (id: string) => Promise<void>): Promise<void> => {
    setBusy(id)
    try {
      await fn(id)
    } finally {
      setBusy(null)
    }
  }
  const sorted = [...items].sort((a, b) => a.sendAt - b.sendAt)
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="定时发送">
        <header className="dialog-head">
          <h2>定时发送</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭">
            <Icon name="x" />
          </button>
        </header>
        <div className="dialog-body">
          <p className="muted">到时间后由 Bluebird Mail 发出，所以那时程序需要开着（留在托盘也可以）。如果到点时没开，下次打开会马上补发；晚了超过 12 小时的不会自动发，会留在这里等你决定。</p>
          {!sorted.length && <p className="muted">没有等待发送的邮件。</p>}
          {sorted.map((s) => {
            const account = accounts.find((a) => a.id === s.message.accountId)
            return (
              <div key={s.id} className={`sched-item ${s.error ? 'failed' : ''}`}>
                <div className="sched-main">
                  <strong>{s.message.subject || '（无主题）'}</strong>
                  <span className="muted small">
                    发给 {s.message.to || s.message.cc || s.message.bcc}
                    {account ? `，从 ${account.email} 发出` : ''}
                  </span>
                  <span className={s.error ? 'form-error' : 'sched-time'}>
                    {s.held
                      ? `原定 ${friendlyTime(s.sendAt)} 发送。${s.error ?? ''}`
                      : s.error
                        ? `发送失败：${s.error}`
                        : s.retryAt && s.retryAt > Date.now()
                          ? `网络没连上，${friendlyTime(s.retryAt)} 自动重试`
                          : `${friendlyTime(s.sendAt)} 发送`}
                  </span>
                </div>
                <div className="sched-actions">
                  <button className="link-btn" disabled={busy === s.id} onClick={() => run(s.id, onSendNow)}>
                    {busy === s.id ? '正在发送…' : s.error && !s.held ? '重试' : '立即发送'}
                  </button>
                  <button
                    className="link-btn danger"
                    disabled={busy === s.id}
                    onClick={() =>
                      confirm({
                        title: `取消「${s.message.subject || '（无主题）'}」的定时发送？`,
                        message: '这封邮件不会再发出，写好的内容也会一起删除，无法恢复。',
                        confirmLabel: '取消定时并删除',
                        onConfirm: () => void run(s.id, onCancel)
                      })
                    }
                  >
                    取消定时
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
