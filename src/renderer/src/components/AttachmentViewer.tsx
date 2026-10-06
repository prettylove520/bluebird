import { useState } from 'react'
import { Icon } from './Icon'

export interface ViewerState {
  /** 正在看的是这封邮件的第几个附件 */
  index: number
  name: string
  loading: boolean
  error?: string
  image?: string
  text?: string
  truncated?: boolean
}

interface Props {
  state: ViewerState
  /** 这封邮件里前一个、后一个能预览的附件；没有就不传 */
  onPrev?: () => void
  onNext?: () => void
  onSave: () => void
  onOpen: () => void
  onClose: () => void
}

/** 在程序里直接看附件：图片和文字。铺满整个窗口，Esc 关闭，左右方向键换上一个、下一个 */
export function AttachmentViewer({ state, onPrev, onNext, onSave, onOpen, onClose }: Props) {
  // 图片默认缩到窗口里放得下；点一下看原始大小，再点一下缩回去
  const [full, setFull] = useState(false)
  return (
    <div className="viewer" role="dialog" aria-label={`预览 ${state.name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <header className="viewer-bar">
        <span className="viewer-name" title={state.name}>
          {state.name}
        </span>
        <button onClick={onSave} title="保存到电脑">
          <Icon name="download" size={18} />
          保存
        </button>
        <button onClick={onOpen} title="用电脑上的其他程序打开">
          <Icon name="external" size={18} />
          用其他程序打开
        </button>
        <button className="viewer-close" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
          <Icon name="x" size={20} />
        </button>
      </header>
      <div className={`viewer-body ${full ? 'full' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {state.loading && <p className="viewer-note">正在打开…</p>}
        {state.error && <p className="viewer-note">{state.error}</p>}
        {state.image && !state.loading && (
          <img src={state.image} alt={state.name} onClick={() => setFull((v) => !v)} title={full ? '点一下缩回窗口大小' : '点一下看原始大小'} draggable={false} />
        )}
        {state.text !== undefined && !state.loading && (
          <pre className="viewer-text">
            {state.text}
            {state.truncated ? '\n\n…… 文件比较大，这里只显示了前面一部分。要看完整内容请点上面的「保存」或「用其他程序打开」。' : ''}
          </pre>
        )}
      </div>
      {onPrev && (
        <button className="viewer-nav prev" onClick={onPrev} title="上一个（←）" aria-label="上一个">
          <Icon name="back" size={24} />
        </button>
      )}
      {onNext && (
        <button className="viewer-nav next" onClick={onNext} title="下一个（→）" aria-label="下一个">
          <Icon name="chevron" size={24} />
        </button>
      )}
    </div>
  )
}

const PREVIEW_EXT = /\.(png|jpe?g|gif|webp|bmp|txt|log|csv|md|json|xml|ini|ya?ml|pdf)$/i

/** 这个附件能不能直接预览（图片、文字、PDF） */
export function canPreview(filename: string): boolean {
  return PREVIEW_EXT.test(filename || '')
}
