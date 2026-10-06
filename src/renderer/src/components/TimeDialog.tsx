import { useState } from 'react'
import { toLocalInput } from '../utils'

interface Props {
  title: string
  confirmLabel: string
  onPick: (ts: number) => void
  onCancel: () => void
}

/** 选一个将来的时间（稍后处理、定时发送的「自定义时间」） */
export function TimeDialog({ title, confirmLabel, onPick, onCancel }: Props) {
  const [value, setValue] = useState(toLocalInput(Date.now() + 3600 * 1000))
  const ts = new Date(value).getTime()
  const valid = !isNaN(ts) && ts > Date.now()
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog confirm"
        role="dialog"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onPick(ts)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // 这一下 Esc 只关这个窗口，不能再传给主界面去关读信页、清勾选
            e.stopPropagation()
            onCancel()
          }
        }}
      >
        <h2>{title}</h2>
        <input className="time-input" type="datetime-local" value={value} min={toLocalInput(Date.now())} onChange={(e) => setValue(e.target.value)} autoFocus />
        {!valid && <p className="form-error">请选择一个将来的时间</p>}
        <div className="dialog-foot">
          <button type="button" className="ghost-btn" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="primary-btn" disabled={!valid}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
