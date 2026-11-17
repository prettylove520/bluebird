import { useEffect, useState } from 'react'

/** 点了发送以后的那几秒：显示倒计时和「撤销」；时间到了就变成「正在发送」，等主进程告诉我们结果 */
export function UndoToast({ subject, seconds, onUndo }: { subject: string; seconds: number; onUndo: () => void }) {
  const [left, setLeft] = useState(seconds)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const end = Date.now() + seconds * 1000
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 200)
    return () => clearInterval(t)
  }, [seconds])
  const waiting = left > 0 && !busy
  return (
    <div className="toast undo">
      <span className="toast-undo-text">
        <strong>{waiting ? `${left} 秒后发出` : busy ? '正在撤销…' : '正在发送…'}</strong>
        <span>{subject}</span>
      </span>
      {waiting && (
        <button
          onClick={() => {
            setBusy(true)
            onUndo()
          }}
        >
          撤销
        </button>
      )}
    </div>
  )
}
