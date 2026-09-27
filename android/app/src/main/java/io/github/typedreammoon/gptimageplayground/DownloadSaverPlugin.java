package io.github.typedreammoon.gptimageplayground;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 把文件直接保存到系统「下载」目录。
 * Android 10+ 走 MediaStore.Downloads，应用自身的写入免存储权限；
 * Android 9 及以下需要运行时存储权限，直接拒绝，由 JS 侧回退到分享面板。
 *
 * saveToDownloads 一次性保存整个文件；
 * adoptFromCache 把 JS 侧流式写好的缓存文件搬入下载目录（原生流式拷贝，内存占用有界），
 * 供低内存设备导出大 ZIP 使用，避免把整个 ZIP 堆在 JS 内存里导致闪退。
 */
@CapacitorPlugin(name = "DownloadSaver")
public class DownloadSaverPlugin extends Plugin {

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String base64 = call.getString("data");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (base64 == null || fileName == null || fileName.trim().isEmpty()) {
            call.reject("data 和 fileName 必填");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("API_LEVEL_UNSUPPORTED");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("data 不是有效的 base64");
            return;
        }

        try {
            Uri uri = insertPendingEntry(fileName, mimeType);
            if (uri == null) {
                call.reject("无法写入系统下载目录");
                return;
            }
            try {
                writeAllAndFinish(uri, bytes);
            } catch (Exception e) {
                deleteEntry(uri);
                throw e;
            }

            JSObject result = new JSObject();
            result.put("path", "Download/" + fileName);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("保存到下载目录失败：" + e.getMessage());
        }
    }

    @PluginMethod
    public void adoptFromCache(PluginCall call) {
        String cacheUri = call.getString("cacheUri");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "application/zip");
        if (cacheUri == null || fileName == null || fileName.trim().isEmpty()) {
            call.reject("cacheUri 和 fileName 必填");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("API_LEVEL_UNSUPPORTED");
            return;
        }

        File cacheFile = new File(cacheUri.startsWith("file://") ? Uri.parse(cacheUri).getPath() : cacheUri);
        if (!cacheFile.isFile() || cacheFile.length() == 0) {
            call.reject("缓存文件不存在或为空");
            return;
        }

        Uri pendingUri = null;
        try {
            pendingUri = insertPendingEntry(fileName, mimeType);
            if (pendingUri == null) throw new IllegalStateException("无法写入系统下载目录");
            try (InputStream in = new FileInputStream(cacheFile);
                 OutputStream os = getContext().getContentResolver().openOutputStream(pendingUri)) {
                if (os == null) throw new IllegalStateException("下载目录输出流不可用");
                byte[] buffer = new byte[65536];
                int n;
                while ((n = in.read(buffer)) > 0) {
                    os.write(buffer, 0, n);
                }
                os.flush();
            }
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            getContext().getContentResolver().update(pendingUri, values, null, null);

            JSObject result = new JSObject();
            result.put("path", "Download/" + fileName);
            call.resolve(result);
        } catch (Exception e) {
            if (pendingUri != null) deleteEntry(pendingUri);
            call.reject("保存到下载目录失败：" + e.getMessage());
        } finally {
            cacheFile.delete();
        }
    }

    private Uri insertPendingEntry(String fileName, String mimeType) {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        return getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
    }

    private void writeAllAndFinish(Uri uri, byte[] bytes) throws Exception {
        OutputStream os = getContext().getContentResolver().openOutputStream(uri);
        if (os == null) throw new IllegalStateException("下载目录输出流不可用");
        try {
            os.write(bytes);
            os.flush();
        } finally {
            os.close();
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        getContext().getContentResolver().update(uri, values, null, null);
    }

    private void deleteEntry(Uri uri) {
        try {
            getContext().getContentResolver().delete(uri, null, null);
        } catch (Exception ignored) {
        }
    }
}
