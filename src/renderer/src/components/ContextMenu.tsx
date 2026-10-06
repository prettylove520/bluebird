import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'

export interface MenuItem {
  label: string
  icon?: IconName
  danger?: boolean
  disabled?: boolean
  /** 在这一项上方画一条分隔线 */
  separator?: boolean
  /** 右边显示小箭头，表示点了会打开下一级菜单 */
  chevron?: boolean
  /** 右边显示的灰色小字，比如快捷键 */
  hint?: string
  onClick: () => void
}

interface Props {
  x: number
  y: number
  title?: string
  items: MenuItem[]
  onClose: () => void
}

/** 右键菜单 / 弹出菜单：自动避开窗口边缘，点别处或按 Esc 关闭 */
export function ContextMenu({ x, y, title, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
    })
  }, [x, y, items.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div
      className="menu-backdrop"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div ref={ref} className="menu" role="menu" style={pos} onMouseDown={(e) => e.stopPropagation()}>
        {title && <div className="menu-title">{title}</div>}
        {items.map((it, i) => (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? 'danger' : ''} ${it.separator ? 'sep' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            <span className="menu-icon">{it.icon && <Icon name={it.icon} size={15} />}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.chevron && (
              <span className="menu-chev">
                <Icon name="chevron" size={13} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
