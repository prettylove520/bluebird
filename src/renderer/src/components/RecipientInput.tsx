import { useEffect, useRef, useState } from 'react'
import type { Contact } from '../../../shared/types'
import { api } from '../api'
import { avatarColor } from '../utils'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}

// 多个收件人之间的分隔符（中文的逗号、分号也算）
const SEPARATOR = /[,;，；]/

/** 正在输入的那一个收件人：最后一个分隔符之后的内容 */
function currentToken(value: string): { start: number; text: string } {
  let start = 0
  for (let i = value.length - 1; i >= 0; i--) {
    if (SEPARATOR.test(value[i])) {
      start = i + 1
      break
    }
  }
  while (start < value.length && value[start] === ' ') start++
  return { start, text: value.slice(start) }
}

function format(c: Contact): string {
  if (!c.name) return c.address
  // 名字里有逗号、引号这些符号时要加引号，否则会被当成两个收件人
  return /[,;<>"@]/.test(c.name) ? `"${c.name.replace(/"/g, '')}" <${c.address}>` : `${c.name} <${c.address}>`
}

/** 收件人输入框：打几个字就列出以前通过信的人，回车或点一下填进去 */
export function RecipientInput({ value, onChange, placeholder, inputRef }: Props) {
  const [items, setItems] = useState<Contact[]>([])
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const req = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const own = useRef<HTMLInputElement>(null)
  // 用户有没有用上下键或鼠标挑过：没挑过的话，已经打完整的地址不会被第一条提示顶替
  const picked = useRef(false)
  const ref = inputRef ?? own

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      req.current++
    },
    []
  )

  const lookup = (next: string): void => {
    if (timer.current) clearTimeout(timer.current)
    const token = currentToken(next).text.trim()
    const id = ++req.current
    // 已经是一个写完整的「名字 <地址>」就不用再提示了
    if (!token || token.includes('>')) {
      setItems([])
      return
    }
    timer.current = setTimeout(() => {
      api
        .contacts(token)
        .then((list) => {
          if (id !== req.current) return
          const lower = next.toLowerCase()
          // 已经填过的人不再列出来；输入的内容和唯一的结果完全一样时也不用提示
          const rest = list.filter((c) => !lower.slice(0, currentToken(next).start).includes(c.address.toLowerCase()))
          setItems(rest.length === 1 && rest[0].address.toLowerCase() === token.toLowerCase() && !rest[0].name ? [] : rest)
          setActive(0)
          picked.current = false
        })
        .catch(() => {
          if (id === req.current) setItems([])
        })
    }, 90)
  }

  const accept = (c: Contact): void => {
    const { start } = currentToken(value)
    onChange(value.slice(0, start) + format(c) + ', ')
    req.current++
    setItems([])
    ref.current?.focus()
  }

  const open = focused && items.length > 0

  return (
    <span className="recipient">
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value)
          // 光标在最后面打字时才提示；回到中间改字不打扰
          if ((e.target.selectionStart ?? e.target.value.length) >= e.target.value.length) lookup(e.target.value)
          else setItems([])
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          req.current++
          setItems([])
        }}
        onKeyDown={(e) => {
          if (!open || e.ctrlKey || e.metaKey || e.altKey) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            picked.current = true
            setActive((i) => (i + 1) % items.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            picked.current = true
            setActive((i) => (i - 1 + items.length) % items.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            const choice = items[Math.min(active, items.length - 1)]
            const typed = currentToken(value).text.trim().toLowerCase()
            // 自己已经打了一个完整的地址，又没有动手去挑：按回车、Tab 就是要用自己打的这个，不能换成别人
            if (!picked.current && /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(typed) && choice.address.toLowerCase() !== typed) {
              req.current++
              setItems([])
              return
            }
            e.preventDefault()
            accept(choice)
          } else if (e.key === 'Escape') {
            // 只收起提示，不关写信窗口
            e.preventDefault()
            e.stopPropagation()
            req.current++
            setItems([])
          }
        }}
      />
      {open && (
        <ul className="recipient-menu" role="listbox">
          {items.map((c, i) => (
            <li
              key={c.address}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              // 用 mousedown：等到 click 时输入框已经失去焦点，菜单就没了
              onMouseDown={(e) => {
                e.preventDefault()
                accept(c)
              }}
              onMouseEnter={() => {
                picked.current = true
                setActive(i)
              }}
            >
              <i style={{ background: avatarColor(c.address) }}>{(c.name || c.address).trim()[0]?.toUpperCase() || '?'}</i>
              <span className="recipient-name">{c.name || c.address.split('@')[0]}</span>
              <span className="recipient-address">{c.address}</span>
            </li>
          ))}
        </ul>
      )}
    </span>
  )
}
