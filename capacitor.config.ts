import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.typedreammoon.gptimageplayground',
  appName: 'GPT Image',
  webDir: 'dist',
  plugins: {
    // 安全区处理：新版 WebView 直接生效 env(safe-area-inset-*)，与 Web 端 CSS 一致
    SystemBars: {
      insetsHandling: 'native',
      initialViewportFitValueHint: 'cover',
    },
  },
  // 开发调试时取消注释可让 App 直连电脑上的 vite dev server 实现热更新：
  // server: { url: 'http://192.168.x.x:5173', cleartext: true },
}

export default config
