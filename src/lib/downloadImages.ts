import { zipSync } from 'fflate'
import type { TaskRecord } from '../types'
import { getNumberedFileNameBase, sanitizeFileNamePart } from './exportFileName'
import { appFetch, isNativeApp } from './http'
import { createDownloadsZipSink, saveBlobToDownloads, saveImageBlobToGallery } from './nativeSave'
import { ensureImageCached } from './imageCache'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface DownloadImagesResult {
  successCount: number
  failCount: number
}

export interface DownloadImageZipEntry {
  imageId: string
  fileNameBase?: string
}

type TaskOutputZipTask = Pick<TaskRecord, 'id' | 'createdAt' | 'outputImages'>

export { formatExportFileTime } from './exportFileName'

export async function downloadImageIds(imageIds: string[], fileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (imageIds.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  const multiple = imageIds.length > 1

  for (let index = 0; index < imageIds.length; index++) {
    try {
      const blob = await getImageBlob(imageIds[index])
      const order = String(index + 1).padStart(2, '0')
      const fileName = multiple
        ? `${fileNameBase}-${order}.${getBlobExtension(blob)}`
        : `${fileNameBase}.${getBlobExtension(blob)}`
      await saveBlob(blob, fileName)
      successCount++
      if (multiple) await delay(100)
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  return { successCount, failCount }
}

export async function downloadImageEntriesAsZip(entries: DownloadImageZipEntry[], zipFileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (entries.length === 0) return { successCount: 0, failCount: 0 }

  // 原生 App 走流式压缩直接写入下载目录，内存中只保留当前一张图（低内存设备友好）
  if (isNativeApp) {
    const sink = await createDownloadsZipSink(`${sanitizeFileNamePart(zipFileNameBase) || 'images'}.zip`)
    let successCount = 0
    let failCount = 0
    const usedNames = new Set<string>()

    try {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        try {
          const blob = await getImageBlob(entry.imageId)
          const order = String(index + 1).padStart(2, '0')
          const base = sanitizeFileNamePart(entry.fileNameBase || `image-${order}`) || `image-${order}`
          const ext = getBlobExtension(blob)
          let fileName = `${base}.${ext}`
          let duplicateIndex = 2
          while (usedNames.has(fileName)) {
            fileName = `${base}-${String(duplicateIndex).padStart(2, '0')}.${ext}`
            duplicateIndex++
          }
          usedNames.add(fileName)
          await sink.addFile(fileName, new Uint8Array(await blob.arrayBuffer()), new Date(), 0)
          successCount++
        } catch (err) {
          console.error(err)
          failCount++
        }
      }
      await sink.close()
    } catch (err) {
      await sink.abort()
      throw err
    }

    return { successCount, failCount }
  }

  let successCount = 0
  let failCount = 0
  const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}
  const usedNames = new Set<string>()

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    try {
      const blob = await getImageBlob(entry.imageId)
      const order = String(index + 1).padStart(2, '0')
      const base = sanitizeFileNamePart(entry.fileNameBase || `image-${order}`) || `image-${order}`
      const ext = getBlobExtension(blob)
      let fileName = `${base}.${ext}`
      let duplicateIndex = 2
      while (usedNames.has(fileName)) {
        fileName = `${base}-${String(duplicateIndex).padStart(2, '0')}.${ext}`
        duplicateIndex++
      }
      usedNames.add(fileName)
      zipFiles[fileName] = [new Uint8Array(await blob.arrayBuffer()), { mtime: new Date() }]
      successCount++
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  if (successCount > 0) {
    const zipped = zipSync(zipFiles, { level: 6 })
    const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
    await saveBlob(new Blob([buffer], { type: 'application/zip' }), `${sanitizeFileNamePart(zipFileNameBase) || 'images'}.zip`)
  }

  return { successCount, failCount }
}

export function getTaskOutputImageZipEntries(tasks: TaskOutputZipTask[]): DownloadImageZipEntry[] {
  return [...tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((task) => getImageZipEntries(task.outputImages || [], `task-${task.id}`))
}

export function getImageZipEntries(imageIds: string[], fileNameBase = 'image'): DownloadImageZipEntry[] {
  return imageIds.map((imageId, index) => ({
    imageId,
    fileNameBase: getNumberedFileNameBase(fileNameBase, index, imageIds.length),
  }))
}

async function getImageBlob(imageIdOrUrl: string): Promise<Blob> {
  let src = imageIdOrUrl
  if (!imageIdOrUrl.startsWith('data:') && !imageIdOrUrl.startsWith('http://') && !imageIdOrUrl.startsWith('https://')) {
    src = await ensureImageCached(imageIdOrUrl) ?? imageIdOrUrl
  }

  const res = await appFetch(src)
  if (!res.ok && !src.startsWith('data:')) throw new Error(`读取图片失败：${imageIdOrUrl}`)
  return await res.blob()
}

/**
 * 统一的文件保存出口：
 * - Web：blob 链接 + 锚点点击下载；
 * - 原生 App：图片直接保存到系统相册，ZIP 等其他文件直接保存到系统下载目录。
 */
export async function saveBlob(blob: Blob, fileName: string): Promise<void> {
  if (isNativeApp) {
    if (blob.type.startsWith('image/')) {
      await saveImageBlobToGallery(blob, fileName)
      return
    }
    await saveBlobToDownloads(blob, fileName)
    return
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function getBlobExtension(blob: Blob): string {
  return MIME_EXTENSIONS[blob.type.toLowerCase()] ?? blob.type.split('/')[1] ?? 'png'
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

