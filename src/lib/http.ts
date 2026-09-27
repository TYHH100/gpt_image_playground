import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type { HttpOptions, HttpResponse } from '@capacitor/core'
import { blobToBase64 } from './dataUrl'

/** 是否运行在 Capacitor 原生容器（Android/iOS App）中 */
export const isNativeApp = Capacitor.isNativePlatform()

const NATIVE_CONNECT_TIMEOUT_MS = 60_000
// 原生读超时对齐 nginx 代理的 600s；超时前的取消仍由调用方的 AbortSignal 控制
const NATIVE_READ_TIMEOUT_MS = 600_000

interface NativeFormDataEntry {
  key: string
  value: string
  type: 'string' | 'base64File'
  contentType?: string
  fileName?: string
}

function createAbortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/** 连接被本地网络栈中止/重置/超时等瞬态错误，值得自动重试（握手阶段失败时请求尚未送达，重试安全） */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /connection abort|connection reset|econnaborted|econnreset|broken pipe|software caused|timed?\s?out|etimedout/i.test(err.message)
}

function describeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 转换为原生端约定的 multipart 结构，原生侧据此组装表单（与 Capacitor 内置 fetch 补丁行为一致） */
async function toNativeFormData(formData: FormData): Promise<NativeFormDataEntry[]> {
  const entries: NativeFormDataEntry[] = []
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      entries.push({ key, value, type: 'string' })
    } else {
      entries.push({
        key,
        value: await blobToBase64(value),
        type: 'base64File',
        contentType: value.type,
        fileName: value.name || 'blob',
      })
    }
  }
  return entries
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) result[key] = value
    return result
  }
  return { ...headers }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}

function setHeaderIfMissing(headers: Record<string, string>, name: string, value: string) {
  if (!hasHeader(headers, name)) headers[name] = value
}

/**
 * responseType 为 arraybuffer 时，原生端对 JSON 内容返回已解析对象、二进制内容返回 base64 字符串；
 * 错误响应的非 JSON 文本也会以原始字符串返回，因此用特征判断是否需要 base64 解码。
 * 注意安卓原生 Base64.DEFAULT 会按 76 字符折行插入换行符，判定和解码前都要先去掉空白。
 */
function isProbablyBase64(data: string): boolean {
  const compact = data.replace(/\s/g, '')
  return compact.length >= 4 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
}

function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function buildNativeResponse(result: HttpResponse): Response {
  const status = result.status
  const noContent = status === 204 || status === 205 || status === 304
  let body: BodyInit | null = null
  if (!noContent && result.data != null) {
    if (typeof result.data === 'string') {
      body = isProbablyBase64(result.data) ? base64ToUint8Array(result.data) : result.data
    } else {
      body = JSON.stringify(result.data)
    }
  }
  return new Response(body, { status, headers: result.headers })
}

/** data: URL 不是网络请求，原生 CapacitorHttp 不支持该协议，直接在 JS 解包成 Response */
async function dataUrlToResponse(dataUrl: string): Promise<Response> {
  const match = dataUrl.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/)
  if (!match || !match[2]) return fetch(dataUrl)
  const bytes = base64ToUint8Array(match[3].replace(/\s/g, ''))
  return new Response(bytes, { status: 200, headers: { 'Content-Type': match[1] || 'application/octet-stream' } })
}

/**
 * 统一请求入口。Web 环境与原生 fetch 行为一致；
 * 原生环境改走 CapacitorHttp（原生网络栈），彻底绕开 WebView 的 CORS 限制。
 * 注意：原生路径不支持流式响应，SSE 请求应直接使用 fetch。
 */
export async function appFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const requestUrl = typeof url === 'string' ? url : url.toString()
  if (!isNativeApp) return fetch(requestUrl, init)
  if (requestUrl.startsWith('data:')) return dataUrlToResponse(requestUrl)

  const method = (init.method ?? 'GET').toUpperCase()
  const headers = normalizeHeaders(init.headers)
  const options: HttpOptions = {
    url: requestUrl,
    method,
    headers,
    responseType: 'arraybuffer',
    connectTimeout: NATIVE_CONNECT_TIMEOUT_MS,
    readTimeout: NATIVE_READ_TIMEOUT_MS,
  }

  const body = init.body
  if (body != null) {
    if (typeof body === 'string') {
      options.data = body
    } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
      options.dataType = 'formData'
      options.data = await toNativeFormData(body)
      // 原生端按 Content-Type 中的 boundary 组装 multipart，必须自带
      setHeaderIfMissing(headers, 'Content-Type', `multipart/form-data; boundary=----WebKitFormBoundary${Math.random().toString(36).slice(2, 17)}`)
    } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      options.data = body.toString()
      setHeaderIfMissing(headers, 'Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8')
    } else {
      options.data = await blobToBase64(new Blob([body as BlobPart]))
      setHeaderIfMissing(headers, 'Content-Type', 'application/octet-stream')
    }
  }

  // GET/HEAD 时 WebView 桥可能剥离 User-Agent 头，原生端会从 x-cap-user-agent 恢复
  if (method === 'GET' || method === 'HEAD') {
    const userAgent = headers['User-Agent'] ?? headers['user-agent']
    if (userAgent) headers['x-cap-user-agent'] = userAgent
  }

  const signal = init.signal
  if (signal?.aborted) throw createAbortError()

  const requestPromise = (attempts: number): Promise<HttpResponse> => {
    const attempt = CapacitorHttp.request(options)
    // 提前取消后原生请求仍会完成，挂一个空回调避免 unhandled rejection
    attempt.then(() => {}, () => {})
    return attempt.catch(async (err) => {
      if (signal?.aborted) throw createAbortError()
      // 瞬态连接错误自动重试一次，常见于 VPN/蜂窝网络下的连接中止
      if (attempts > 0 && isTransientNetworkError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return requestPromise(attempts - 1)
      }
      throw err
    })
  }

  let abortReject: ((err: Error) => void) | undefined
  const onAbort = () => abortReject?.(createAbortError())
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  try {
    const result = await Promise.race([
      requestPromise(1),
      new Promise<never>((_, reject) => {
        abortReject = reject
      }),
    ])
    return buildNativeResponse(result)
  } catch (err) {
    if (signal?.aborted) throw createAbortError()
    // 与浏览器 fetch 的网络错误类型保持一致，调用方按 TypeError 判断网络/跨域失败；
    // 消息带 network 关键字，便于轮询等场景的网络错误重试判定，并附上目标域名便于排查
    if (err instanceof Error) {
      const host = describeHost(requestUrl)
      throw new TypeError(`网络请求失败 (network error)：${err.message}${host ? `（${host}）` : ''}`)
    }
    throw err
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
