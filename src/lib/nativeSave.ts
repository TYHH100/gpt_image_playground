import { registerPlugin } from '@capacitor/core'
import { Zip, ZipDeflate } from 'fflate'
import { Media } from '@capacitor-community/media'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { blobToBase64, blobToDataUrl, bytesToBase64 } from './dataUrl'

const GALLERY_ALBUM_NAME = 'GPT Image'

interface DownloadSaverPlugin {
  saveToDownloads(opts: { data: string; fileName: string; mimeType: string }): Promise<{ path: string }>
  adoptFromCache(opts: { cacheUri: string; fileName: string; mimeType: string }): Promise<{ path: string }>
}

const DownloadSaver = registerPlugin<DownloadSaverPlugin>('DownloadSaver')

let galleryAlbumIdentifier: string | null = null

async function getOrCreateGalleryAlbumIdentifier(): Promise<string> {
  if (galleryAlbumIdentifier) return galleryAlbumIdentifier

  const { albums } = await Media.getAlbums()
  const existing = albums.find((album) => album.name === GALLERY_ALBUM_NAME)
  if (existing) {
    galleryAlbumIdentifier = existing.identifier
    return galleryAlbumIdentifier
  }

  await Media.createAlbum({ name: GALLERY_ALBUM_NAME })
  const created = (await Media.getAlbums()).albums.find((album) => album.name === GALLERY_ALBUM_NAME)
  if (!created) throw new Error('无法创建相册')
  galleryAlbumIdentifier = created.identifier
  return galleryAlbumIdentifier
}

/** 把图片写入系统相册的「GPT Image」相册 */
export async function saveImageBlobToGallery(blob: Blob, fileName: string): Promise<void> {
  const albumIdentifier = await getOrCreateGalleryAlbumIdentifier()
  await Media.savePhoto({
    path: await blobToDataUrl(blob),
    albumIdentifier,
    // 插件会按图片类型自行补扩展名，这里只传基础名
    fileName: fileName.replace(/\.[^.]+$/, ''),
  })
}

/** 通过系统分享面板保存文件（ZIP 等），用户可在面板中选择保存位置 */
export async function shareBlobFile(blob: Blob, fileName: string): Promise<void> {
  const base64 = await blobToBase64(blob)
  const result = await Filesystem.writeFile({
    path: fileName,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  })
  await Share.share({
    title: fileName,
    dialogTitle: '保存或分享文件',
    files: [result.uri],
  })
}

/**
 * 把文件（ZIP 等）直接保存到系统「下载」目录。
 * Android 9 及以下不支持免权限写入，回退到分享面板。
 */
export async function saveBlobToDownloads(blob: Blob, fileName: string): Promise<void> {
  try {
    await DownloadSaver.saveToDownloads({
      data: await blobToBase64(blob),
      fileName,
      mimeType: blob.type || 'application/octet-stream',
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes('API_LEVEL_UNSUPPORTED')) {
      await shareBlobFile(blob, fileName)
      return
    }
    throw err
  }
}

export interface NativeZipSink {
  addFile(name: string, bytes: Uint8Array, mtime: Date, level?: 0): Promise<void>
  close(): Promise<{ path: string }>
  abort(): Promise<void>
}

const STREAM_CHUNK_BYTES = 1024 * 1024

/**
 * 在系统下载目录创建一个可流式写入的 ZIP 文件。
 * 数据先经 Filesystem.appendFile 流式写入应用缓存（成熟可靠的官方插件通道），
 * 完成后由原生把缓存文件流式拷贝进下载目录——全程内存中只保留当前文件和待刷新块，
 * 供低内存设备导出大量图片时使用。
 */
export async function createDownloadsZipSink(fileName: string): Promise<NativeZipSink> {
  const cachePath = `stream-export-${Date.now()}.zip`
  const created = await Filesystem.writeFile({ path: cachePath, data: '', directory: Directory.Cache, recursive: true })
  const cacheUri = created.uri

  const pending: Uint8Array[] = []
  let pendingBytes = 0
  let zipError: Error | null = null

  const zip = new Zip((err: Error | null, chunk: Uint8Array) => {
    if (err) {
      zipError = err instanceof Error ? err : new Error(String(err))
      return
    }
    pending.push(chunk)
    pendingBytes += chunk.length
  })

  const flush = async () => {
    if (!pendingBytes) return
    const merged = new Uint8Array(pendingBytes)
    let offset = 0
    for (const chunk of pending) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    pending.length = 0
    pendingBytes = 0
    await Filesystem.appendFile({ path: cachePath, data: bytesToBase64(merged), directory: Directory.Cache })
  }

  const deleteCache = () => Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache }).catch(() => {})

  return {
    async addFile(name, bytes, mtime, level = 0) {
      if (zipError) throw zipError
      const deflate = new ZipDeflate(name, { level })
      deflate.mtime = mtime
      zip.add(deflate)
      // 分片推入并即时刷新：单条 bridge 消息过大时会被 WebView 静默丢弃导致挂起
      const PUSH_CHUNK_BYTES = 1024 * 1024
      for (let offset = 0; offset < bytes.length; offset += PUSH_CHUNK_BYTES) {
        deflate.push(bytes.subarray(offset, Math.min(offset + PUSH_CHUNK_BYTES, bytes.length)), false)
        await flush()
      }
      deflate.push(new Uint8Array(0), true)
      await flush()
      if (zipError) throw zipError
    },
    async close() {
      zip.end()
      await flush()
      if (zipError) {
        await deleteCache()
        throw zipError
      }
      // 单步加超时保护：一旦原生侧异常不返回回调，就走报错清理，不允许无限挂起
      const result = await new Promise<{ path: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('保存到下载目录超时')), 60_000)
        DownloadSaver.adoptFromCache({ cacheUri, fileName, mimeType: 'application/zip' }).then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (err) => {
            clearTimeout(timer)
            reject(err)
          },
        )
      })
      await deleteCache()
      return result
    },
    async abort() {
      await deleteCache()
    },
  }
}
