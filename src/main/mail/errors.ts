// 把各种底层错误翻译成用户能看懂的中文提示

interface MailError {
  message?: string
  code?: string
  responseText?: string
  response?: string
  authenticationFailed?: boolean
  responseCode?: number
}

export function isAuthError(err: unknown): boolean {
  const e = (err || {}) as MailError
  if (e.authenticationFailed) return true
  if (e.code === 'EAUTH') return true
  const text = `${e.responseText || ''} ${e.response || ''} ${e.message || ''}`
  return /AUTHENTICATIONFAILED|authentication failed|invalid credentials|LOGIN failed|Invalid login|\b535\b/i.test(text)
}

export function isConnectionError(err: unknown): boolean {
  const e = (err || {}) as MailError
  return (
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ETIMEOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'NoConnection', 'ESOCKET', 'ECONNECTION', 'EDNS', 'EAI_AGAIN'].includes(
      e.code || ''
    ) ||
    /Connection not available|socket|closed|timeout|timed.?out|proxy|getaddrinfo|ENOTFOUND|EAI_AGAIN|aborted|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_|NETWORK_|ADDRESS_UNREACHABLE|TIMED_OUT|PROXY_|SOCKS_|TUNNEL_)/i.test(
      e.message || ''
    )
  )
}

export function friendlyError(err: unknown, ctx?: { host?: string; useProxy?: boolean; oauth?: 'google' | 'microsoft' }): string {
  const e = (err || {}) as MailError
  const text = `${e.responseText || ''} ${e.response || ''} ${e.message || ''}`

  if (/Unsafe Login/i.test(text)) {
    return '网易邮箱拒绝了这次登录（Unsafe Login）。请确认网页版已开启 IMAP/SMTP 服务，并使用授权码而不是登录密码。'
  }
  if (isAuthError(err) && ctx?.oauth) {
    // 浏览器登录的账号没有授权码这回事，原因通常是授权时没给邮件权限，或者授权已经失效
    return ctx.oauth === 'google'
      ? '登录失败：Google 没有接受这次授权。请重新用浏览器登录一次，并在授权页面上勾选「查看、撰写、发送邮件」那一项再继续；如果是公司或学校的 Google 账号，也可能是管理员关闭了第三方邮件客户端。'
      : '登录失败：微软没有接受这次授权。请重新用浏览器登录一次；如果是公司或学校的账号，可能是管理员关闭了 IMAP 或第三方邮件客户端。'
  }
  if (isAuthError(err)) {
    return '登录失败：账号或授权码不正确。国内邮箱需要先在网页版开启 IMAP/SMTP 服务，并用「授权码」登录，而不是网页登录密码。'
  }
  if (e.code === 'ENOTFOUND') {
    return `找不到服务器 ${ctx?.host ?? ''}，请检查服务器地址是否填写正确。`
  }
  if (isConnectionError(err)) {
    const hint = ctx?.useProxy ? '请检查网络和代理设置（代理软件是否已开启、端口是否正确）。' : '请检查网络；如果是国外邮箱，可以在账号里开启「通过代理连接」。'
    return `连接服务器失败${ctx?.host ? `（${ctx.host}）` : ''}：${hint}`
  }
  const msg = (e.responseText || e.message || String(err)).trim()
  return msg || '发生未知错误'
}
