import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'

export interface Command {
  label: string
  /** 右侧的补充说明，比如快捷键或所属账号 */
  hint?: string
  icon: IconName
  /** 额外的搜索关键词（拼音首字母、英文等） */
  keywords?: string
  run: () => void
}

interface Props {
  commands: Command[]
  /** 顶上的一行小字，说明这些操作是针对什么的 */
  title?: string
  onClose: () => void
}

/** 看起来像快捷键的提示（单个字母、Delete、Ctrl+A…）画成按键的样子 */
const isKey = (hint: string): boolean => /^([A-Z#/]|Delete|Esc|Enter|(Ctrl|Shift|Alt)(\+\w+)+)$/.test(hint)

/** 命令中心（Ctrl+K）：输入几个字，回车执行 */
export function CommandPalette({ commands, title, onClose }: Props) {
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return commands
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint || ''} ${c.keywords || ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [q, commands])

  useEffect(() => setIndex(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.cmd.active')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (i: number): void => {
    const c = matches[i]
    if (!c) return
    onClose()
    c.run()
  }

  return (
    <div className="overlay top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="命令中心">
        {title && (
          <div className="palette-title">
            <Icon name="bolt" size={13} />
            {title}
          </div>
        )}
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={q}
            placeholder="输入要做的事，或文件夹名称"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(matches.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(index)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {!matches.length && <div className="palette-empty">没有匹配的操作</div>}
          {matches.map((c, i) => (
            <button
              key={i}
              role="option"
              aria-selected={i === index}
              className={`cmd ${i === index ? 'active' : ''}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => run(i)}
            >
              <span className="menu-icon">
                <Icon name={c.icon} size={18} />
              </span>
              <span className="cmd-label">{c.label}</span>
              {c.hint &&
                (isKey(c.hint) ? (
                  <span className="cmd-keys">
                    {c.hint.split('+').map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                ) : (
                  <span className="cmd-hint">{c.hint}</span>
                ))}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
