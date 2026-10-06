import { useState } from 'react'
import type { Account, Preset, ServerConfig, Settings } from '../../../shared/types'
import { api } from '../api'
import { Icon } from './Icon'

interface Props {
  presets: Preset[]
  settings: Settings
  onClose: () => void
  onDone: (account: Account) => void
  onOpenSettings: () => void
}

// 选择页上展示的服务商（其余的会在「其他邮箱」里按地址自动识别）
const TILES: { id: string; label: string; note?: string; mark: string; color: string }[] = [
  { id: 'gmail', label: 'Gmail', note: '浏览器登录', mark: 'G', color: '#ea4335' },
  { id: 'outlook', label: 'Outlook', note: 'Hotmail / Live', mark: 'O', color: '#0f6cbd' },
  { id: 'qq', label: 'QQ 邮箱', note: 'Foxmail', mark: 'Q', color: '#12b7f5' },
  { id: '163', label: '网易 163', mark: '网', color: '#d6262b' },
  { id: '126', label: '网易 126', mark: '网', color: '#1a9a46' },
  { id: 'exmail', label: '腾讯企业邮', mark: '企', color: '#2f6fed' },
  { id: 'qiye163', label: '网易企业邮', mark: '企', color: '#c43a30' },
  { id: 'icloud', label: 'iCloud', mark: 'i', color: '#5b8def' },
  { id: 'custom', label: '其他邮箱', note: '自动识别服务器', mark: '@', color: '#6b7280' }
]

type Step = { kind: 'choose' } | { kind: 'oauth'; preset: Preset } | { kind: 'form'; preset?: Preset }

const emptyServer = (port: number): ServerConfig => ({ host: '', port, secure: true })

export function AddAccountDialog({ presets, settings, onClose, onDone, onOpenSettings }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 表单
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [user, setUser] = useState('')
  const [imap, setImap] = useState<ServerConfig>(emptyServer(993))
  const [smtp, setSmtp] = useState<ServerConfig>(emptyServer(465))
  const [useProxy, setUseProxy] = useState(false)
  const [appendSent, setAppendSent] = useState(true)
  const [providerId, setProviderId] = useState('custom')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [detectNote, setDetectNote] = useState<string | null>(null)
  const [suggestOAuth, setSuggestOAuth] = useState<Preset | null>(null)

  const byId = (id: string): Preset | undefined => presets.find((p) => p.id === id)

  const applyPreset = (p: Preset): void => {
    setProviderId(p.id)
    setImap(p.imap)
    setSmtp(p.smtp)
    setUseProxy(p.foreign)
    setAppendSent(p.appendSent)
  }

  const choose = (id: string): void => {
    setError(null)
    if (id === 'custom') {
      setProviderId('custom')
      setImap(emptyServer(993))
      setSmtp(emptyServer(465))
      setUseProxy(false)
      setAppendSent(true)
      setShowAdvanced(false)
      setStep({ kind: 'form' })
      return
    }
    const p = byId(id)
    if (!p) return
    if (p.auth === 'oauth2') {
      setStep({ kind: 'oauth', preset: p })
    } else {
      applyPreset(p)
      setStep({ kind: 'form', preset: p })
    }
  }

  const oauthReady = (p: Preset): boolean =>
    p.oauthProvider === 'google' ? !!settings.oauth.googleClientId : !!settings.oauth.microsoftClientId

  const startOAuth = async (p: Preset): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const account = await api.addOAuthAccount(p.oauthProvider!, name || undefined)
      onDone(account)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const detect = async (): Promise<void> => {
    if (step.kind !== 'form' || step.preset || !email.includes('@')) return
    setDetectNote('正在识别邮箱服务器…')
    setSuggestOAuth(null)
    try {
      const r = await api.detect(email)
      if (r.preset) {
        applyPreset(r.preset)
        setDetectNote(`已识别为：${r.preset.label}`)
        if (r.preset.auth === 'oauth2') setSuggestOAuth(r.preset)
      } else if (r.imap && r.smtp) {
        setImap(r.imap)
        setSmtp(r.smtp)
        if (r.source === 'ispdb') {
          setDetectNote('已自动填好服务器设置')
        } else {
          setDetectNote('没有查到这个邮箱的配置，已按常见规则猜测服务器地址，如果连不上请在「服务器设置」里修改')
          setShowAdvanced(true)
        }
      }
    } catch {
      setDetectNote(null)
    }
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setError(null)
    if (!imap.host || !smtp.host) {
      setShowAdvanced(true)
      setError('请填写收信和发信服务器地址')
      return
    }
    setBusy(true)
    try {
      const account = await api.addPasswordAccount({
        email,
        name,
        provider: providerId,
        imap,
        smtp,
        authType: 'password',
        user: user || undefined,
        password,
        useProxy,
        appendSent
      })
      onDone(account)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const preset = step.kind === 'form' ? step.preset || byId(providerId) : undefined
  const domestic = preset ? !preset.foreign : !useProxy

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-label="添加邮箱">
        <header className="dialog-head">
          {step.kind !== 'choose' && (
            <button
              className="icon-btn back"
              onClick={() => {
                if (busy) void api.cancelOAuth()
                setStep({ kind: 'choose' })
                setError(null)
                setDetectNote(null)
              }}
              aria-label="返回"
              title="返回"
            >
              <Icon name="chevron" />
            </button>
          )}
          <h2>
            {step.kind === 'choose' ? '添加邮箱' : step.kind === 'oauth' ? step.preset.label : step.preset?.label || '其他邮箱'}
          </h2>
          <button
            className="icon-btn"
            onClick={() => {
              // 正在等浏览器登录或验证服务器时也允许关掉，顺手取消还没完成的登录
              if (busy) void api.cancelOAuth().catch(() => undefined)
              onClose()
            }}
            aria-label="关闭"
            title="关闭"
          >
            <Icon name="x" />
          </button>
        </header>

        {step.kind === 'choose' && (
          <div className="tiles">
            {TILES.map((t) => (
              <button key={t.id} className="tile" onClick={() => choose(t.id)}>
                <span className="tile-mark" style={{ background: t.color }}>
                  {t.mark}
                </span>
                <span className="tile-text">
                  <strong>{t.label}</strong>
                  {t.note && <span>{t.note}</span>}
                </span>
              </button>
            ))}
          </div>
        )}

        {step.kind === 'oauth' && (
          <div className="dialog-body">
            <p className="lead">
              点击下面的按钮会打开系统浏览器，登录 {step.preset.oauthProvider === 'google' ? 'Google' : '微软'}{' '}
              账号并允许访问邮件，完成后会自动回到这里。
            </p>
            {step.preset.oauthProvider === 'google' && (
              <p className="muted">
                这个应用没有经过 Google 审核，授权页面会提示「Google 尚未验证此应用」，点「高级」再点「继续」即可。
              </p>
            )}
            {!oauthReady(step.preset) ? (
              <div className="callout">
                <p>
                  还没有填写 {step.preset.oauthProvider === 'google' ? 'Google' : 'Microsoft'} Client ID。这是你自己注册的应用标识，只需填一次。
                </p>
                <button className="primary-btn" onClick={onOpenSettings}>
                  去设置里填写
                </button>
              </div>
            ) : busy ? (
              <div className="callout">
                <p>已在浏览器中打开登录页面，请在浏览器里完成授权…</p>
                <button className="ghost-btn" onClick={() => void api.cancelOAuth()}>
                  取消登录
                </button>
              </div>
            ) : (
              <button className="primary-btn wide" onClick={() => startOAuth(step.preset)}>
                <Icon name="external" />
                用浏览器登录
              </button>
            )}
            {step.preset.id === 'gmail' && !busy && (
              <button
                className="link-btn"
                onClick={() => {
                  applyPreset(step.preset)
                  setStep({ kind: 'form', preset: step.preset })
                }}
              >
                改用「应用专用密码」登录
              </button>
            )}
            {error && <p className="form-error">{error}</p>}
          </div>
        )}

        {step.kind === 'form' && (
          <form className="dialog-body" onSubmit={submit}>
            {preset?.hint && <p className="muted">{preset.hint}</p>}
            {providerId === 'gmail' && (
              <p className="muted">应用专用密码需要先在 Google 账号里开启两步验证，然后在「安全性 → 应用专用密码」里生成。</p>
            )}

            <label className="form-row">
              <span>邮箱地址</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={detect}
                placeholder="name@example.com"
                autoFocus
                required
              />
            </label>
            {detectNote && <p className="detect-note">{detectNote}</p>}
            {suggestOAuth && (
              <div className="callout">
                <p>这个邮箱托管在 {suggestOAuth.label}，通常需要用浏览器登录。</p>
                <button type="button" className="ghost-btn" onClick={() => setStep({ kind: 'oauth', preset: suggestOAuth })}>
                  改用浏览器登录
                </button>
              </div>
            )}

            <label className="form-row">
              <span>{domestic ? '授权码' : '密码'}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={domestic ? '在网页版邮箱设置里生成的授权码' : '密码或应用专用密码'}
                required
              />
            </label>

            <label className="form-row">
              <span>显示名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="收件人看到的发件人名字（可不填）" />
            </label>

            <button type="button" className="link-btn" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? '收起服务器设置' : '服务器设置'}
            </button>

            {showAdvanced && (
              <div className="advanced">
                <ServerRow label="收信（IMAP）" value={imap} onChange={setImap} />
                <ServerRow label="发信（SMTP）" value={smtp} onChange={setSmtp} />
                <label className="form-row">
                  <span>用户名</span>
                  <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="一般和邮箱地址相同，可不填" />
                </label>
                <label className="check">
                  <input type="checkbox" checked={appendSent} onChange={(e) => setAppendSent(e.target.checked)} />
                  发送后把邮件存到「已发送」（服务器不会自动保存时打开）
                </label>
              </div>
            )}

            <label className="check">
              <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
              通过代理连接
              {useProxy && !settings.proxy.enabled && <em className="warn-inline">（设置里还没有开启代理）</em>}
            </label>

            {error && <p className="form-error">{error}</p>}

            <footer className="dialog-foot">
              <button type="button" className="ghost-btn" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button type="submit" className="primary-btn" disabled={busy}>
                {busy ? '正在验证…' : '添加'}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  )
}

function ServerRow({ label, value, onChange }: { label: string; value: ServerConfig; onChange: (v: ServerConfig) => void }) {
  return (
    <div className="server-row">
      <span className="server-label">{label}</span>
      <input
        className="server-host"
        value={value.host}
        onChange={(e) => onChange({ ...value, host: e.target.value.trim() })}
        placeholder="服务器地址"
        aria-label={`${label}服务器地址`}
      />
      <input
        className="server-port"
        type="number"
        value={value.port}
        onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 0 })}
        aria-label={`${label}端口`}
      />
      <select
        value={value.secure ? 'ssl' : 'starttls'}
        onChange={(e) => onChange({ ...value, secure: e.target.value === 'ssl' })}
        aria-label={`${label}加密方式`}
      >
        <option value="ssl">SSL/TLS</option>
        <option value="starttls">STARTTLS</option>
      </select>
    </div>
  )
}
