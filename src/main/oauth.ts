// Gmail / Outlook 的浏览器登录（OAuth 2.0 授权码 + PKCE，本机回环地址接收回调）

import { shell } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { OAuthProvider } from '../shared/types'
import { httpFetch } from './net'
import { getSecret, getSettings, setSecret, type OAuthSecret } from './store'

interface ProviderConfig {
  authUrl: string
  tokenUrl: string
  scope: string
  redirectHost: string
  extraAuthParams: Record<string, string>
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email',
    redirectHost: '127.0.0.1',
    // select_account：每次都让你选用哪个 Google 账号，方便连续添加多个 Gmail
    extraAuthParams: { access_type: 'offline', prompt: 'select_account consent' }
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope:
      'offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
    // 微软的桌面应用回调地址注册为 http://localhost，运行时可以带任意端口
    redirectHost: 'localhost',
    extraAuthParams: { prompt: 'select_account', response_mode: 'query' }
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function clientCredentials(provider: OAuthProvider): { clientId: string; clientSecret?: string } {
  const o = getSettings().oauth
  if (provider === 'google') {
    if (!o.googleClientId) throw new Error('还没有填写 Google Client ID，请先到「设置」里填写')
    return { clientId: o.googleClientId, clientSecret: o.googleClientSecret || undefined }
  }
  if (!o.microsoftClientId) throw new Error('还没有填写 Microsoft Client ID，请先到「设置」里填写')
  return { clientId: o.microsoftClientId }
}

const PAGE = (title: string, msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,'Microsoft YaHei';display:flex;align-items:center;justify-content:center;height:90vh;color:#333">` +
  `<div style="text-align:center"><h2>${title}</h2><p>${msg}</p></div></body>`

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1]
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  id_token?: string
  /** 用户实际同意的权限，空格分隔 */
  scope?: string
  error?: string
  error_description?: string
}

async function postToken(provider: OAuthProvider, body: Record<string, string>): Promise<TokenResponse> {
  const res = await httpFetch(PROVIDERS[provider].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    useProxy: true
  })
  const json = (await res.json()) as TokenResponse
  if (!res.ok || json.error) {
    if (json.error === 'invalid_grant' && body.grant_type === 'refresh_token') {
      throw new Error(
        provider === 'google'
          ? '这个账号的登录已失效，请到「设置 → 账号」里点「重新登录」。如果每隔 7 天就失效一次，说明你的 Google 应用还处于「测试」状态，到 Google 后台的「目标对象」里点「发布应用」即可。'
          : '这个账号的登录已失效，请到「设置 → 账号」里点「重新登录」。'
      )
    }
    if (json.error === 'invalid_client') {
      throw new Error('Client ID 或 Client Secret 不正确，请到「设置 → 浏览器登录」里核对（两项要来自同一个「桌面应用」客户端）。')
    }
    throw new Error(`获取令牌失败：${json.error_description || json.error || res.status}`)
  }
  return json
}

let pending: { server: Server; cancel: () => void } | null = null

export function cancelOAuth(): void {
  pending?.cancel()
}

/** 打开系统浏览器让用户登录，返回邮箱地址和令牌 */
export async function startOAuth(
  provider: OAuthProvider,
  loginHint?: string
): Promise<{ email: string; secret: OAuthSecret }> {
  cancelOAuth()
  const cfg = PROVIDERS[provider]
  const { clientId, clientSecret } = clientCredentials(provider)
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(16))

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${cfg.redirectHost}`)
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const err = url.searchParams.get('error')
      const gotCode = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (err || !gotCode || url.searchParams.get('state') !== state) {
        res.end(PAGE('登录没有完成', '可以关闭这个页面，回到 Bluebird 重试。'))
        finish()
        reject(new Error(err === 'access_denied' ? '你取消了授权' : `授权失败：${err || '参数不正确'}`))
        return
      }
      res.end(PAGE('登录成功', '可以关闭这个页面，回到 Bluebird 了。'))
      finish()
      resolve({ code: gotCode, redirectUri })
    })

    const timer = setTimeout(() => {
      finish()
      reject(new Error('登录超时（5 分钟内没有完成授权）'))
    }, 5 * 60 * 1000)

    const finish = (): void => {
      clearTimeout(timer)
      server.close()
      pending = null
    }

    pending = {
      server,
      cancel: () => {
        finish()
        reject(new Error('已取消登录'))
      }
    }

    server.on('error', (e) => {
      finish()
      reject(e)
    })

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      redirectUri = `http://${cfg.redirectHost}:${port}`
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: cfg.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...cfg.extraAuthParams
      })
      if (loginHint) params.set('login_hint', loginHint)
      shell.openExternal(`${cfg.authUrl}?${params.toString()}`).catch(reject)
    })
  })

  const body: Record<string, string> = {
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier
  }
  if (clientSecret) body.client_secret = clientSecret
  if (provider === 'microsoft') body.scope = cfg.scope

  const tok = await postToken(provider, body)
  // Google 的授权页面可以逐项勾选权限。没勾邮件那一项的话登录看起来成功了，但收发邮件都会被拒绝，这里提前说清楚
  if (provider === 'google' && tok.scope && !tok.scope.split(/\s+/).includes('https://mail.google.com/')) {
    throw new Error('Google 没有给到邮件权限。请再点一次「用浏览器登录」，在授权页面上勾选「在 Gmail 中查看、撰写、发送和永久删除所有电子邮件」这一项，然后点继续。')
  }
  if (!tok.refresh_token) throw new Error('服务器没有返回刷新令牌，请重试')

  const claims = tok.id_token ? decodeJwtPayload(tok.id_token) : {}
  const email = String(claims.email || claims.preferred_username || loginHint || '').toLowerCase()
  if (!email) throw new Error('无法确定登录的邮箱地址')

  return {
    email,
    secret: {
      kind: 'oauth2',
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      expires: Date.now() + tok.expires_in * 1000
    }
  }
}

const refreshing = new Map<string, Promise<string>>()

/** 取一个可用的访问令牌，快过期时自动刷新 */
export async function getAccessToken(accountId: string, provider: OAuthProvider): Promise<string> {
  const s = getSecret(accountId)
  if (!s || s.kind !== 'oauth2') throw new Error('账号的登录信息丢失，请重新登录')
  if (s.accessToken && s.expires - Date.now() > 5 * 60 * 1000) return s.accessToken

  // 同一个账号同时只刷新一次
  const existing = refreshing.get(accountId)
  if (existing) return existing

  const task = (async () => {
    const { clientId, clientSecret } = clientCredentials(provider)
    const body: Record<string, string> = {
      client_id: clientId,
      refresh_token: s.refreshToken,
      grant_type: 'refresh_token'
    }
    if (clientSecret) body.client_secret = clientSecret
    if (provider === 'microsoft') body.scope = PROVIDERS.microsoft.scope
    const tok = await postToken(provider, body)
    setSecret(accountId, {
      kind: 'oauth2',
      // 微软每次会换一个新的刷新令牌，Google 一般不返回
      refreshToken: tok.refresh_token || s.refreshToken,
      accessToken: tok.access_token,
      expires: Date.now() + tok.expires_in * 1000
    })
    return tok.access_token
  })()

  refreshing.set(accountId, task)
  try {
    return await task
  } finally {
    refreshing.delete(accountId)
  }
}

/** 令牌被服务器拒绝时，强制让下次重新刷新 */
export function invalidateAccessToken(accountId: string): void {
  const s = getSecret(accountId)
  if (s && s.kind === 'oauth2') setSecret(accountId, { ...s, expires: 0 })
}
