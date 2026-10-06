import { useEffect, useRef } from 'react'

interface Props {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => btn.current?.focus(), [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="dialog confirm"
        role="alertdialog"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // 这一下 Esc 只关这个窗口，不能再传给主界面去关读信页、清勾选
            e.stopPropagation()
            onCancel()
          }
        }}
      >
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="dialog-foot">
          <button className="ghost-btn" onClick={onCancel}>
            取消
          </button>
          <button ref={btn} className={`primary-btn ${danger ? 'danger' : ''}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
