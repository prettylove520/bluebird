import type { Account } from '../../../shared/types'
import { tagMark } from '../utils'
import { Icon, type IconName } from './Icon'

export type RailTarget = 'home' | 'inbox' | 'pinned' | 'snoozed' | 'drafts' | 'sent' | 'trash'

interface Props {
  active: RailTarget | null
  unread: number
  pinnedCount: number
  snoozedCount: number
  draftsCount: number
  scheduledCount: number
  account?: Account
  /** 这个邮箱的短标签，小圆标上显示它的头一两个字 */
  accountTag?: string
  onGo: (t: RailTarget) => void
  onMore: () => void
  onScheduled: () => void
  onSettings: () => void
  /** 点左下角的账号圆标：弹出账号列表 */
  onAccountMenu: (x: number, y: number) => void
}

// 分三组：主屏｜收件箱和稍后处理｜置顶、草稿、已发送、已删除。gap 表示这一项前面留一段空
const ITEMS: { id: RailTarget; label: string; icon: IconName; gap?: boolean }[] = [
  { id: 'home', label: '主屏', icon: 'home' },
  { id: 'inbox', label: '收件箱', icon: 'inbox', gap: true },
  { id: 'snoozed', label: '稍后处理', icon: 'clock' },
  { id: 'pinned', label: '已置顶', icon: 'pin', gap: true },
  { id: 'drafts', label: '草稿箱', icon: 'drafts' },
  { id: 'sent', label: '已发送', icon: 'sent' },
  { id: 'trash', label: '已删除', icon: 'trash' }
]

/** 最左侧的窄图标栏：常用位置一键直达，完整的账号和文件夹在「更多」里 */
export function Rail(props: Props) {
  const badge = (id: RailTarget): number =>
    id === 'inbox' ? props.unread : id === 'pinned' ? props.pinnedCount : id === 'snoozed' ? props.snoozedCount : id === 'drafts' ? props.draftsCount : 0
  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail-drag titlebar-drag" />
      <div className="rail-items">
        {ITEMS.map((it) => (
          <button
            key={it.id}
            className={`rail-btn ${props.active === it.id ? 'active' : ''} ${it.gap ? 'gap' : ''}`}
            onClick={() => props.onGo(it.id)}
            title={it.label}
            aria-label={it.label}
            aria-current={props.active === it.id ? 'page' : undefined}
          >
            <Icon name={it.icon} size={22} />
            {badge(it.id) > 0 && <span className={`rail-badge ${it.id === 'inbox' ? 'strong' : ''}`}>{badge(it.id) > 99 ? '99+' : badge(it.id)}</span>}
          </button>
        ))}
        {props.scheduledCount > 0 && (
          <button className="rail-btn" onClick={props.onScheduled} title="定时发送" aria-label="定时发送">
            <Icon name="calendarClock" size={22} />
            <span className="rail-badge">{props.scheduledCount}</span>
          </button>
        )}
        <button className="rail-btn" onClick={props.onMore} title="全部账号和文件夹" aria-label="全部账号和文件夹">
          <Icon name="menu" size={22} />
        </button>
      </div>
      <div className="rail-foot">
        <button className="rail-btn" onClick={props.onSettings} title="设置" aria-label="设置">
          <Icon name="sliders" size={22} />
        </button>
        {props.account && (
          <button
            className="rail-avatar"
            style={{ background: props.account.color }}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              props.onAccountMenu(r.right + 8, r.top - 200)
            }}
            title="切换或添加账号"
            aria-label="切换或添加账号"
          >
            {tagMark(props.accountTag || props.account.name || props.account.email)}
          </button>
        )}
      </div>
    </nav>
  )
}
