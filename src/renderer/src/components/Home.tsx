import { useEffect, useState } from 'react'
import { Icon } from './Icon'

/** 内置的主屏背景；auto 表示跟着一天里的时间换 */
// 这些背景都是 Bluebird 自己画的插画（动画、游戏的风格），图在 scenes 文件夹里
export const HOME_SCENES: { id: string; label: string }[] = [
  { id: 'auto', label: '跟随时间' },
  { id: 'summer', label: '夏日晴空' },
  { id: 'islands', label: '浮空岛' },
  { id: 'sunset', label: '黄昏之城' },
  { id: 'sakura', label: '夜樱' },
  { id: 'starry', label: '星夜露营' },
  { id: 'aurora', label: '极光雪原' },
  { id: 'neon', label: '霓虹都市' },
  { id: 'pixel', label: '像素冒险' }
]

/** 「跟随时间」时，这个钟点用哪一张 */
export function sceneForHour(h: number): string {
  if (h >= 5 && h < 8) return 'islands'
  if (h >= 8 && h < 17) return 'summer'
  if (h >= 17 && h < 19) return 'sunset'
  if (h >= 19 && h < 22) return 'sakura'
  return 'starry'
}

/** 设置里存的背景编号换成实际要用的那一张（旧版本的编号现在没有了，按「跟随时间」处理） */
export function resolveScene(id: string, h: number): string {
  return id !== 'auto' && HOME_SCENES.some((s) => s.id === id) ? id : sceneForHour(h)
}

interface Props {
  unread: number
  /** 内置背景的编号，或 custom 表示用自己选的图片 */
  background: string
  /** 自己选的图片（data URL） */
  image: string | null
  onOpenInbox: () => void
  onCompose: () => void
  onSearch: () => void
}

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function greeting(h: number): string {
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  if (h < 23) return '晚上好'
  return '晚安'
}

/** 主屏：打开程序先看到的一屏，告诉你现在有多少未读，而不是直接把收件箱砸过来 */
export function Home({ unread, background, image, onOpenInbox, onCompose, onSearch }: Props) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(t)
  }, [])
  const h = now.getHours()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const useImage = background === 'custom' && !!image
  const scene = useImage ? 'photo' : resolveScene(background, h)
  return (
    <main className={`home scene-${scene}`} style={useImage ? { backgroundImage: `url("${image}")` } : undefined}>
      {/* 压一层渐变，保证白色的字在任何背景上都看得清 */}
      <div className="home-scrim" />
      <div className="home-drag titlebar-drag" />
      <header className="home-top">
        <div className="home-clock">
          <span>
            {WEEK[now.getDay()]}，{now.getMonth() + 1}月{now.getDate()}日
          </span>
          <strong>
            {pad(h)}:{pad(now.getMinutes())}
          </strong>
        </div>
        <div className="home-actions">
          <button className="home-round" onClick={onSearch} title="搜索邮件" aria-label="搜索邮件">
            <Icon name="search" size={18} />
          </button>
          <button className="home-round" onClick={onCompose} title="写邮件" aria-label="写邮件">
            <Icon name="pen" size={18} />
          </button>
        </div>
      </header>
      <div className="home-center">
        <h1>{greeting(h)}</h1>
        <p>{unread > 0 ? `收件箱里有 ${unread} 封未读邮件` : '收件箱里没有未读邮件'}</p>
        <button className="home-open" onClick={onOpenInbox} autoFocus>
          打开收件箱
        </button>
      </div>
    </main>
  )
}
