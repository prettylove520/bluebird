// 导出诊断信息：把版本、系统、账号概况、关键设置和最近的日志拼成一个文本文件，交给用户发给开发者。
// 不含任何密码、授权码、令牌、密钥；日志里看起来像令牌或密钥的长串也一律打码。

import { app } from 'electron'
import { existsSync, readFileSync, statSync } from 'fs'
import { arch, release, totalmem } from 'os'
import { join } from 'path'
import { getAccounts, getSettings } from './store'

/** 日志最多带最后这么多字节（新旧两个日志合起来） */
const LOG_TAIL = 1.5 * 1024 * 1024

function tail(file: string, bytes: number): string {
  try {
    if (!existsSync(file)) return ''
    const size = statSync(file).size
    const buf = readFileSync(file)
    const text = buf.subarray(Math.max(0, size - bytes)).toString('utf8')
    // 从第一个完整的行开始
    return size > bytes ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  }
}

/** 日志里可能夹带的敏感串：令牌、密钥、授权头、长随机串、网址里的参数 */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [已隐去]')
    .replace(/\b(access_token|refresh_token|id_token|client_secret|password|passwd|token|api[_-]?key|auth_key|secret)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1$2[已隐去]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[已隐去]')
    .replace(/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[已隐去]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[已隐去]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:fx\b/gi, '[已隐去]')
    .replace(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{48,}={0,2}(?![A-Za-z0-9+/=_-])/g, '[长串已隐去]')
}

export function buildDiagnostics(): string {
  const s = getSettings()
  const lines: string[] = []
  const now = new Date()
  lines.push('==== 青鸟邮 诊断信息 ====')
  lines.push(`生成时间：${now.toISOString()}（本机 ${now.toLocaleString('zh-CN')}）`)
  lines.push(`版本：${app.getVersion()}  Electron ${process.versions.electron}  Chrome ${process.versions.chrome}`)
  lines.push(`系统：Windows ${release()} ${arch()}  内存 ${Math.round(totalmem() / 1024 ** 3)} GB`)
  lines.push('')
  lines.push('---- 设置（只列和收发有关的，不含任何密钥）----')
  lines.push(`代理：${s.proxy.enabled ? `开 ${s.proxy.host}:${s.proxy.port}` : '关'}`)
  lines.push(`主题：${s.general.theme}  智能收件箱：${s.reading.smartInbox ? '开' : '关'}  打开即已读：${s.reading.markReadOnOpen !== false ? '是' : '否'}`)
  lines.push('')
  lines.push('---- 账号（不含密码和令牌）----')
  for (const a of getAccounts()) {
    lines.push(
      `${a.id.slice(0, 8)}  ${a.email}  服务商 ${a.provider}  登录方式 ${a.auth.type}${a.auth.oauthProvider ? `/${a.auth.oauthProvider}` : ''}  ` +
        `IMAP ${a.imap.host}:${a.imap.port}  SMTP ${a.smtp.host}:${a.smtp.port}  ${a.useProxy ? '走代理' : '直连'}`
    )
  }
  lines.push('')
  const dir = app.getPath('userData')
  const cur = tail(join(dir, 'bluebird.log'), LOG_TAIL)
  const old = cur.length < LOG_TAIL ? tail(join(dir, 'bluebird.old.log'), LOG_TAIL - cur.length) : ''
  if (old) {
    lines.push('---- 上一份日志（末尾部分）----')
    lines.push(redact(old))
  }
  lines.push('---- 当前日志 ----')
  lines.push(cur ? redact(cur) : '（没有日志：开发版不写日志文件）')
  return lines.join('\n')
}
