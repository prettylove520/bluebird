import { useEffect, useRef, useState } from 'react'

interface Props {
  title: string
  /** 输入框上面的一句说明 */
  message?: string
  initial?: string
  placeholder?: string
  confirmLabel: string
  /** 点确定后执行；抛出的错误会显示在输入框下面，窗口不关 */
  onSubmit: (value: string) => Promise<void>
  onCancel: () => void
}

/** 让用户填一行字的小窗口（新建文件夹、重命名用） */
export function PromptDialog({ title, message, initial, placeholder, confirmLabel, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initial || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const submit = async (): Promise<void> => {
    const v = value.trim()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(v)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form
        className="dialog confirm prompt"
        role="dialog"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            if (!busy) onCancel()
          }
        }}
      >
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        <input ref={input} value={value} maxLength={60} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} disabled={busy} />
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-foot">
          <button type="button" className="ghost-btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="submit" className="primary-btn" disabled={busy || !value.trim()}>
            {busy ? '请稍候…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
