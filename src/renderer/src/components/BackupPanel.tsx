import { useEffect, useState } from 'react'
import type { BackupDetect, BackupInfo, BackupMeta } from '../../../shared/types'
import { api } from '../api'
import { friendlyTime } from '../utils'
import { Icon } from './Icon'

function describe(m: BackupMeta, thisDevice: string): string {
  const who = m.device === thisDevice ? '这台电脑' : `电脑「${m.device}」`
  return `${friendlyTime(m.savedAt)}，来自${who}，共 ${m.accounts} 个邮箱`
}

/** 密码输入框：带「显示」按钮，能看到自己输的是什么，就不用再输第二遍确认了 */
function PasswordField(props: { value: string; onChange: (v: string) => void; placeholder: string; onEnter?: () => void; autoFocus?: boolean }) {
  const [show, setShow] = useState(false)
  return (
    <span className="pw-field">
      <input
        type={show ? 'text' : 'password'}
        value={props.value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        autoComplete="new-password"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onEnter?.()
        }}
      />
      <button type="button" className="link-btn" onClick={() => setShow((v) => !v)}>
        {show ? '隐藏' : '显示'}
      </button>
    </span>
  )
}

/** 设置里的「备份与恢复」：把账号和设置加密备份到云盘的同步文件夹，换电脑时从那里恢复 */
export function BackupPanel({ hasAccounts }: { hasAccounts: boolean }) {
  const [info, setInfo] = useState<BackupInfo | null>(null)
  const [detect, setDetect] = useState<BackupDetect>({ drives: [], found: [] })
  const [folder, setFolder] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** 已开启后点「更换位置」「更换密码」时展开对应的那一块 */
  const [editing, setEditing] = useState<null | 'folder' | 'password'>(null)
  const [more, setMore] = useState(false)

  const [pick, setPick] = useState<BackupMeta | null>(null)
  const [restorePass, setRestorePass] = useState('')
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restored, setRestored] = useState<number | null>(null)
  const [showRestore, setShowRestore] = useState(false)

  useEffect(() => {
    Promise.all([api.backupInfo(), api.backupDetect().catch(() => ({ drives: [], found: [] }) as BackupDetect)])
      .then(([i, d]) => {
        setInfo(i)
        setDetect(d)
        // 还没设置过：默认选中找到的第一个云盘，用户只要再设个密码就行
        setFolder(i.folder || d.drives[0]?.path || '')
        // 这台电脑上还没有账号、云盘里却有备份：多半是换了新电脑，直接把恢复摆在最前面
        const other = d.found.find((f) => f.device !== i.thisDevice) || d.found[0]
        if (!hasAccounts && other) {
          setPick(other)
          setShowRestore(true)
        }
      })
      .catch((err) => setError((err as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (fn: () => Promise<BackupInfo>, done: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const i = await fn()
      setInfo(i)
      setFolder(i.folder)
      setPass('')
      setEditing(null)
      setNote(done)
    } catch (err) {
      setError((err as Error).message)
      // 失败以后以主进程的实际状态为准，免得界面上显示的位置和真正在用的不一样
      api
        .backupInfo()
        .then(setInfo)
        .catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  const cancelEdit = (): void => {
    setEditing(null)
    setPass('')
    setError(null)
    if (info) setFolder(info.folder)
  }

  const browse = async (): Promise<void> => {
    setError(null)
    try {
      const f = await api.backupPickFolder()
      if (f) setFolder(f)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const enable = (): void => {
    if (!folder) {
      setError('请先选择备份放在哪里')
      return
    }
    if (pass.length < 6) {
      setError('备份密码至少要 6 位')
      return
    }
    void run(() => api.backupEnable(folder, pass), '自动备份已开启，第一份备份已经写好')
  }

  const browseRestore = async (): Promise<void> => {
    setRestoreError(null)
    try {
      const m = await api.backupPickFile()
      if (m) {
        setPick(m)
        setRestorePass('')
      }
    } catch (err) {
      setRestoreError((err as Error).message)
    }
  }

  const restore = async (): Promise<void> => {
    if (!pick || restoring || !restorePass) return
    setRestoring(true)
    setRestoreError(null)
    try {
      const r = await api.backupRestore(pick.file, restorePass)
      setRestored(r.accounts)
    } catch (err) {
      setRestoreError((err as Error).message)
      setRestoring(false)
    }
  }

  if (!info) return <div className="form-stack">{error ? <p className="form-error">{error}</p> : <p className="muted">正在读取…</p>}</div>

  /** 选位置：找到的云盘一键选中，另外可以自己选文件夹 */
  const places = (
    <div className="place-list">
      {detect.drives.map((d) => (
        <button key={d.path} type="button" className={`place ${folder === d.path ? 'on' : ''}`} onClick={() => setFolder(d.path)} title={d.path}>
          <span className="place-check">{folder === d.path && <Icon name="check" size={13} />}</span>
          <span className="place-text">
            <strong>{d.name}</strong>
            <span>{d.path}</span>
          </span>
        </button>
      ))}
      {folder && !detect.drives.some((d) => d.path === folder) && (
        <button type="button" className="place on" title={folder}>
          <span className="place-check">
            <Icon name="check" size={13} />
          </span>
          <span className="place-text">
            <strong>自己选的文件夹</strong>
            <span>{folder}</span>
          </span>
        </button>
      )}
      <button type="button" className="place other" onClick={browse}>
        <span className="place-check plus">
          <Icon name="plus" size={13} />
        </span>
        <span className="place-text">
          <strong>{detect.drives.length ? '放到别的文件夹…' : '选择文件夹…'}</strong>
          {!detect.drives.length && <span>没有找到云盘。选云盘的同步文件夹，或者 U 盘、移动硬盘上的文件夹都可以</span>}
        </span>
      </button>
    </div>
  )

  const restoreBlock = (
    <div className="backup-box">
      {restored != null ? (
        <p className="backup-ok">已恢复 {restored} 个邮箱，界面马上会重新加载。</p>
      ) : (
        <>
          {detect.found.length > 0 && (
            <div className="place-list">
              {detect.found.map((f) => (
                <button key={f.file} type="button" className={`place ${pick?.file === f.file ? 'on' : ''}`} onClick={() => setPick(f)} title={f.file}>
                  <span className="place-check">{pick?.file === f.file && <Icon name="check" size={13} />}</span>
                  <span className="place-text">
                    <strong>{f.drive} 里的备份</strong>
                    <span>{describe(f, info.thisDevice)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {pick && !detect.found.some((f) => f.file === pick.file) && (
            <p className="muted small">已选择：{describe(pick, info.thisDevice)}</p>
          )}
          <button type="button" className="link-btn left" onClick={browseRestore} disabled={restoring}>
            {detect.found.length || pick ? '用别的备份文件…' : '选择备份文件（Bluebird 备份.bbk）…'}
          </button>
          {pick && (
            <>
              <PasswordField value={restorePass} onChange={setRestorePass} placeholder="输入备份密码" onEnter={() => void restore()} autoFocus />
              {hasAccounts && <p className="compose-warn">恢复会用备份里的内容，替换这台电脑上现有的全部邮箱账号和设置。</p>}
              <div className="backup-actions">
                <button className="primary-btn" onClick={() => void restore()} disabled={restoring || !restorePass}>
                  {restoring ? '正在恢复…' : '恢复'}
                </button>
              </div>
            </>
          )}
          {restoreError && <p className="form-error">{restoreError}</p>}
        </>
      )}
    </div>
  )

  return (
    <div className="form-stack">
      {/* 新电脑：云盘里已经有备份，恢复放最上面 */}
      {showRestore && !info.enabled && (
        <>
          <h3>发现了以前的备份，要恢复吗？</h3>
          {restoreBlock}
        </>
      )}

      {info.enabled ? (
        <>
          <div className={`backup-status ${info.hasPassword && !info.error ? '' : 'warn'}`}>
            <span className="backup-status-icon">
              <Icon name="check" size={20} />
            </span>
            <div className="backup-status-text">
              <strong>{info.hasPassword && !info.error ? '自动备份已开启' : '自动备份需要处理一下'}</strong>
              <span title={info.folder}>{info.folder}</span>
              <span>{info.last ? `最近一次：${describe(info.last, info.thisDevice)}` : '文件夹里还没有备份文件'}</span>
            </div>
            {info.hasPassword ? (
              <button className="primary-btn" onClick={() => void run(() => api.backupNow(), '已经写好一份最新的备份')} disabled={busy}>
                {busy ? '正在备份…' : '立即备份'}
              </button>
            ) : (
              <button className="primary-btn" onClick={() => setEditing('password')} disabled={busy}>
                重新设置密码
              </button>
            )}
          </div>
          {info.error && <p className="form-error">{info.hasPassword ? `自动备份暂停了：${info.error}` : info.error}</p>}
          {note && <p className="backup-ok">{note}</p>}
          {error && <p className="form-error">{error}</p>}
          <p className="muted small">
            添加邮箱、修改设置、置顶邮件之后，十几秒内会自动更新备份，不用手动操作。换电脑时，在新电脑的 Bluebird 里打开这一页，选中这份备份、输入密码就能恢复。
          </p>

          {editing === 'folder' && (
            <div className="backup-box">
              <strong>换一个位置</strong>
              {places}
              <div className="backup-actions">
                <button className="primary-btn" disabled={busy || !folder || folder === info.folder} onClick={() => void run(() => api.backupEnable(folder), '已换到新的位置，并写好了一份备份')}>
                  保存
                </button>
                <button className="ghost-btn" onClick={cancelEdit}>
                  取消
                </button>
              </div>
            </div>
          )}
          {editing === 'password' && (
            <div className="backup-box">
              <strong>换一个密码</strong>
              <PasswordField value={pass} onChange={setPass} placeholder="新的备份密码，至少 6 位" autoFocus />
              <div className="backup-actions">
                <button
                  className="primary-btn"
                  disabled={busy || pass.length < 6}
                  onClick={() => void run(() => api.backupEnable(info.folder, pass), '密码已更换，并用新密码重新写好了备份')}
                >
                  保存
                </button>
                <button className="ghost-btn" onClick={cancelEdit}>
                  取消
                </button>
              </div>
            </div>
          )}

          {!editing && (
            <div className="backup-links">
              <button className="link-btn" onClick={() => setEditing('folder')}>
                更换位置
              </button>
              <button className="link-btn" onClick={() => setEditing('password')}>
                更换密码
              </button>
              <button className="link-btn" onClick={() => setShowRestore((v) => !v)}>
                从备份恢复
              </button>
              <button className="link-btn danger" disabled={busy} onClick={() => void run(() => api.backupDisable(), '自动备份已关闭，已有的备份文件还留在原处')}>
                关闭自动备份
              </button>
            </div>
          )}
          {showRestore && !editing && restoreBlock}
        </>
      ) : (
        <>
          <h3>{showRestore ? '或者，在这台电脑上重新开始备份' : '把账号和设置备份到云盘'}</h3>
          {!showRestore && (
            <p className="muted">开启以后，换电脑或重装系统时不用再逐个登录邮箱：在新电脑上选中备份、输入密码就全部恢复。只需要两步。</p>
          )}
          <div className="backup-box">
            <div className="backup-step">
              <span className="step-num">1</span>
              <strong>备份放在哪里</strong>
            </div>
            {places}
            <div className="backup-step">
              <span className="step-num">2</span>
              <strong>设一个备份密码</strong>
            </div>
            <PasswordField value={pass} onChange={setPass} placeholder="至少 6 位，恢复时要用" onEnter={enable} />
            <p className="muted small">备份文件里有各个邮箱的登录信息，全靠这个密码保护，请不要设得太简单。忘了密码这份备份就打不开，只能重新设密码再备份。</p>
            {error && <p className="form-error">{error}</p>}
            {note && <p className="backup-ok">{note}</p>}
            <button className="primary-btn wide" onClick={enable} disabled={busy}>
              {busy ? '正在开启…' : '开启自动备份'}
            </button>
          </div>
          {!showRestore && (
            <>
              <button className="link-btn left" onClick={() => setMore((v) => !v)}>
                {more ? '收起' : '已经有备份文件？从备份恢复'}
              </button>
              {more && restoreBlock}
            </>
          )}
        </>
      )}
    </div>
  )
}
