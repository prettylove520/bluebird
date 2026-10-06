import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * 给界面页面注入内容安全策略（CSP）。
 * 开发模式下 Vite 的热更新需要内联脚本和 WebSocket，所以放宽一点；
 * 打包后只允许加载自身脚本。
 * 注意：img-src 放开 http/https 是为了让「显示图片」按钮能生效，
 * 邮件正文的 iframe 自己还有一层更严格的策略，默认会拦截远程图片。
 */
function cspPlugin(): Plugin {
  let isDev = false
  return {
    name: 'bluebird-csp',
    configResolved(config) {
      isDev = config.command === 'serve'
    },
    transformIndexHtml(html) {
      const script = isDev ? "'self' 'unsafe-inline'" : "'self'"
      const connect = isDev ? "'self' ws: http://localhost:*" : "'self'"
      const csp = [
        "default-src 'self'",
        `script-src ${script}`,
        // 邮件正文的 iframe 会继承这里的限制，所以要放行网络样式表和字体；
        // 正文自己还有一层更严的策略，用户没点「显示图片」之前这些照样加载不了
        "style-src 'self' 'unsafe-inline' https: http:",
        "img-src 'self' data: blob: https: http:",
        "font-src 'self' data: https: http:",
        `connect-src ${connect}`,
        "frame-src 'self' about: data:",
        "object-src 'none'"
      ].join('; ')
      return html.replace('%CSP%', csp)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), cspPlugin()]
  }
})
