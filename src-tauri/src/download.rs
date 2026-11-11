//! 视频下载：后台任务化。`download_start` 注册任务立即返回，分片下载在异步 runtime
//! 里跑；进度经 `hg-download-progress`、完成经 `hg-download-done` 事件推给前端。
//! 另提供任务查询 / 取消 / 已下载文件列表 / 删除 / 打开目录，供「下载管理」使用。
//!
//! 与播放共用 `net::fetch_bytes`（同一条带 Referer / 代理 / 重试的链路），
//! 产物写入系统下载目录下的 `HGhub/`。

use crate::net::fetch_bytes;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

/// 同时在飞的分片数：大了怕被源站限速，小了长剧集太慢
const CONCURRENCY: usize = 4;
/// 已结束任务在列表里保留的数量（重启后清空）
const FINISHED_KEEP: usize = 50;

/* ───────────────────────── 任务注册表 ───────────────────────── */

#[derive(Clone, serde::Serialize)]
pub struct TaskInfo {
    id: String,
    name: String,
    done: usize,
    total: usize,
    /// running / done / failed / cancelled
    status: String,
    path: Option<String>,
    err: Option<String>,
}

static TASKS: Lazy<Mutex<Vec<TaskInfo>>> = Lazy::new(|| Mutex::new(Vec::new()));
static HANDLES: Lazy<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn task_update(id: &str, f: impl FnOnce(&mut TaskInfo)) {
    let mut tasks = TASKS.lock().unwrap();
    if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
        f(t);
    }
    // 已结束任务限量保留
    let finished = tasks.iter().filter(|t| t.status != "running").count();
    if finished > FINISHED_KEEP {
        if let Some(pos) = tasks.iter().position(|t| t.status != "running") {
            tasks.remove(pos);
        }
    }
}

fn task_get(id: &str) -> Option<TaskInfo> {
    TASKS.lock().unwrap().iter().find(|t| t.id == id).cloned()
}

/// 文件名清洗：去掉路径分隔与控制字符，保证各平台都能落盘
fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    // 两端点号也去掉：防 ".." 之类的相对路径片段
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() { "video".to_string() } else { trimmed.chars().take(80).collect() }
}

fn download_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    let dir = base.join("HGhub");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
    Ok(dir)
}

/* ───────────────────────── HLS 解析 ───────────────────────── */

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// 属性行里取某个 key 的引号值（引号内可含逗号，不能 split(',')；
/// key 前必须是行首/逗号，避免 `URI` 误配到 `KEYFORMATURI`）
fn attr_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = line;
    while let Some(pos) = rest.find(key) {
        let boundary = pos == 0 || matches!(rest.as_bytes()[pos - 1], b',' | b' ' | b':');
        let after = &rest[pos + key.len()..];
        if boundary {
            if let Some(v) = after.strip_prefix("=\"") {
                let end = v.find('"')?;
                return Some(&v[..end]);
            }
        }
        rest = after;
    }
    None
}

/// 无引号数值/十六进制属性（BANDWIDTH、IV）：读到逗号或行尾；
/// 同样要求边界，避免 `AVERAGE-BANDWIDTH` 误配 `BANDWIDTH`
fn attr_plain<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = line;
    while let Some(pos) = rest.find(key) {
        let boundary = pos == 0 || matches!(rest.as_bytes()[pos - 1], b',' | b' ' | b':');
        let after = &rest[pos + key.len()..];
        if boundary {
            if let Some(v) = after.strip_prefix('=') {
                if v.starts_with('"') {
                    return None; // 引号值走 attr_value
                }
                let end = v.find(',').unwrap_or(v.len());
                return Some(v[..end].trim());
            }
        }
        rest = after;
    }
    None
}

#[derive(Clone)]
struct Key {
    uri: String,
    iv: Option<[u8; 16]>,
}

struct MediaList {
    segments: Vec<String>,
    /// 每段生效的 key（EXT-X-KEY 对后续所有段生效，直到下一条 KEY 或 METHOD=NONE）
    keys: Vec<Option<Key>>,
    init: Option<String>,
    /// 首段媒体序列号：EXT-X-KEY 未给 IV 时按规范用它推导
    media_sequence: u64,
}

async fn fetch_playlist(url: &str) -> Result<String, String> {
    let (_, bytes) = fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8 文本")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".into());
    }
    Ok(text.to_string())
}

/// 主清单 → 选带宽最高的子清单地址；媒体清单 → None
fn master_variant(text: &str) -> Option<String> {
    let mut best: Option<(u64, usize)> = None; // (bandwidth, line_index_of_uri)
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if !line.starts_with("#EXT-X-STREAM-INF") {
            continue;
        }
        let bw = attr_plain(line, "BANDWIDTH").and_then(|v| v.parse().ok()).unwrap_or(0);
        if best.is_none_or(|(b, _)| bw >= b) {
            best = Some((bw, i));
        }
    }
    best.and_then(|(_, i)| lines.get(i + 1)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn parse_media(base: &str, text: &str) -> Result<MediaList, String> {
    let mut list = MediaList { segments: Vec::new(), keys: Vec::new(), init: None, media_sequence: 0 };
    let mut cur_key: Option<Key> = None;
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            list.media_sequence = rest.trim().parse().unwrap_or(0);
        } else if line.starts_with("#EXT-X-KEY:") {
            if line.contains("METHOD=NONE") {
                cur_key = None;
            } else if line.contains("METHOD=AES-128") {
                let uri = attr_value(line, "URI").ok_or("EXT-X-KEY 缺 URI")?;
                let iv = attr_plain(line, "IV").and_then(|v| {
                    let hex = v.strip_prefix("0x").or_else(|| v.strip_prefix("0X")).unwrap_or(v);
                    let bytes = hex_decode(hex)?;
                    <[u8; 16]>::try_from(bytes.as_slice()).ok()
                });
                cur_key = Some(Key { uri: absolutize(base, uri), iv });
            }
            // SAMPLE-AES 等其它方式不支持，按明文拼（大概率播不了，但不至于崩）
        } else if line.starts_with("#EXT-X-MAP:") {
            if let Some(uri) = attr_value(line, "URI") {
                list.init = Some(absolutize(base, uri));
            }
        } else if !line.starts_with('#') {
            list.segments.push(absolutize(base, line));
            list.keys.push(cur_key.clone());
        }
    }
    if list.segments.is_empty() {
        return Err("播放列表里没有分片".into());
    }
    Ok(list)
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// AES-128-CBC 解密（HLS 规范：整块 CBC，末尾 PKCS7 填充可去可留——
/// TS 有同步字节兜底，fMP4 长度写在盒头，多出的填充字节不影响播放）
fn aes128_decrypt(key: &[u8], iv: [u8; 16], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() % 16 != 0 {
        return Err("加密分片长度不是 16 的倍数".into());
    }
    let cipher = Aes128::new_from_slice(key).map_err(|_| "AES KEY 长度非法")?;
    let mut prev = iv;
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Ok(out)
}

/// 分片 IV：EXT-X-KEY 显式给 IV 用它，否则用媒体序列号的大端 16 字节
fn segment_iv(key: &Key, seq: u64) -> [u8; 16] {
    key.iv.unwrap_or_else(|| {
        let mut iv = [0u8; 16];
        iv[8..].copy_from_slice(&seq.to_be_bytes());
        iv
    })
}

/* ───────────────────────── 下载执行 ───────────────────────── */

fn unique_path(dir: &std::path::Path, name: &str, ext: &str) -> std::path::PathBuf {
    let candidate = dir.join(format!("{name}.{ext}"));
    if !candidate.exists() {
        return candidate;
    }
    for i in 1..1000 {
        let p = dir.join(format!("{name} ({i}).{ext}"));
        if !p.exists() {
            return p;
        }
    }
    candidate
}

/// 实际下载。`on_progress(done,total)` 每写完一个分片回调；
/// `on_file(path)` 在输出文件创建时回调（供取消清理）。
async fn perform(
    dir: &std::path::Path,
    url: &str,
    name: &str,
    on_progress: impl Fn(usize, usize),
    on_file: impl Fn(String),
) -> Result<String, String> {
    /* 非 HLS（直连 mp4 等）：整个拉下来按扩展名落盘 */
    if !url.to_ascii_lowercase().split('?').next().unwrap_or("").ends_with(".m3u8") {
        on_progress(0, 1);
        let (_, bytes) = fetch_bytes(url).await?;
        let ext = url
            .split('?').next().unwrap_or("")
            .rsplit('.').next()
            .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
            .unwrap_or("mp4");
        let path = unique_path(dir, &sanitize_name(name), ext);
        on_file(path.display().to_string());
        std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
        on_progress(1, 1);
        return Ok(path.display().to_string());
    }

    let text = fetch_playlist(url).await?;
    let (media_url, media_text) = if let Some(variant) = master_variant(&text) {
        let v = absolutize(url, &variant);
        let t = fetch_playlist(&v).await?;
        (v, t)
    } else {
        (url.to_string(), text)
    };
    let list = parse_media(&media_url, &media_text)?;

    let first = list.segments[0].split('?').next().unwrap_or("").to_ascii_lowercase();
    let fmp4 = list.init.is_some() || first.ends_with(".m4s") || first.ends_with(".mp4");
    let ext = if fmp4 { "mp4" } else { "ts" };
    let path = unique_path(dir, &sanitize_name(name), ext);
    let mut file = std::fs::File::create(&path).map_err(|e| format!("创建文件失败: {e}"))?;
    on_file(path.display().to_string());

    let total = list.segments.len();
    let result = download_segments(&list, &mut file, total, &on_progress).await;
    if result.is_err() {
        drop(file);
        let _ = std::fs::remove_file(&path);
    }
    result?;
    Ok(path.display().to_string())
}

async fn download_segments(
    list: &MediaList,
    file: &mut std::fs::File,
    total: usize,
    on_progress: &impl Fn(usize, usize),
) -> Result<(), String> {
    use std::io::Write;

    if let Some(init) = &list.init {
        let (_, bytes) = fetch_bytes(init).await?;
        file.write_all(&bytes).map_err(|e| format!("写入初始化段失败: {e}"))?;
    }

    /* 解密 key 按 URI 缓存：任务里新拉的 key 带回主循环填进缓存 */
    let mut key_cache: HashMap<String, Vec<u8>> = HashMap::new();
    let mut pending: HashMap<usize, Vec<u8>> = HashMap::new();
    let mut next_write = 0usize;
    let mut spawn_at = 0usize;
    on_progress(0, total);

    let mut set = tokio::task::JoinSet::new();
    while next_write < total {
        while spawn_at < total && set.len() < CONCURRENCY {
            let idx = spawn_at;
            let seg_url = list.segments[idx].clone();
            let key = list.keys[idx].as_ref().map(|k| (k.uri.clone(), segment_iv(k, list.media_sequence + idx as u64)));
            let cached = key.as_ref().and_then(|(uri, _)| key_cache.get(uri).cloned());
            set.spawn(async move {
                let (_, bytes) = fetch_bytes(&seg_url).await?;
                let mut fetched: Option<(String, Vec<u8>)> = None;
                let data = if let Some((uri, iv)) = key {
                    let k = match cached {
                        Some(k) => k,
                        None => {
                            let (_, b) = fetch_bytes(&uri).await?;
                            fetched = Some((uri.clone(), b.clone()));
                            b
                        }
                    };
                    aes128_decrypt(&k, iv, &bytes)?
                } else {
                    bytes
                };
                Ok::<(usize, Vec<u8>, Option<(String, Vec<u8>)>), String>((idx, data, fetched))
            });
            spawn_at += 1;
        }
        let joined = set.join_next().await.ok_or("下载任务异常退出")?;
        // 双层 Result：外层是 JoinError（任务 panic / 被取消），内层是分片下载/解密错误
        let (idx, data, new_key) = joined.map_err(|e| format!("下载任务失败: {e}"))??;
        if let Some((uri, k)) = new_key {
            key_cache.insert(uri, k);
        }
        pending.insert(idx, data);
        while let Some(bytes) = pending.remove(&next_write) {
            file.write_all(&bytes).map_err(|e| format!("写入分片失败: {e}"))?;
            next_write += 1;
            on_progress(next_write, total);
        }
    }
    file.flush().map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(())
}

/* ───────────────────────── 命令 ───────────────────────── */

/// 启动后台下载，立即返回任务 id；进度/完成走事件。
#[tauri::command]
pub async fn download_start(app: tauri::AppHandle, url: String, name: String) -> Result<String, String> {
    let dir = download_dir(&app)?;
    let id = format!("dl-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    TASKS.lock().unwrap().push(TaskInfo {
        id: id.clone(),
        name: name.clone(),
        done: 0,
        total: 0,
        status: "running".into(),
        path: None,
        err: None,
    });

    let task_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit_progress = |done: usize, total: usize| {
            task_update(&task_id, |t| { t.done = done; t.total = total; });
            let _ = app.emit("hg-download-progress", json!({ "id": task_id, "done": done, "total": total }));
        };
        let on_file = |path: String| task_update(&task_id, |t| t.path = Some(path));

        let result = perform(&dir, &url, &name, emit_progress, on_file).await;
        HANDLES.lock().unwrap().remove(&task_id);

        let (ok, path, err) = match result {
            Ok(p) => {
                crate::playback_log::record("download.done", json!({"id": task_id, "file": p}));
                task_update(&task_id, |t| { t.status = "done".into(); t.path = Some(p.clone()); });
                (true, Some(p), None)
            }
            Err(e) => {
                // 被取消的任务 aborted：join error 不会走到这里（handle 已被移除标记），
                // 这里都是真实失败
                crate::playback_log::record("download.failed", json!({"id": task_id, "err": e}));
                task_update(&task_id, |t| { t.status = "failed".into(); t.err = Some(e.clone()); });
                (false, None, Some(e))
            }
        };
        let info = task_get(&task_id);
        let _ = app.emit("hg-download-done", json!({
            "id": task_id,
            "name": info.as_ref().map(|t| t.name.clone()).unwrap_or_default(),
            "ok": ok,
            "path": path,
            "err": err,
        }));
    });
    HANDLES.lock().unwrap().insert(id.clone(), handle);
    Ok(id)
}

/// 取消下载：中止任务、删掉半成品文件。
#[tauri::command]
pub async fn download_cancel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if let Some(h) = HANDLES.lock().unwrap().remove(&id) {
        h.abort();
    }
    let info = task_get(&id).ok_or("任务不存在")?;
    if info.status != "running" {
        return Ok(());
    }
    task_update(&id, |t| { t.status = "cancelled".into(); });
    if let Some(p) = &info.path {
        let _ = std::fs::remove_file(p);
    }
    let _ = app.emit("hg-download-done", json!({
        "id": id, "name": info.name, "ok": false, "path": null, "err": "已取消",
    }));
    Ok(())
}

/// 全部任务（进行中 + 最近结束的），管理界面用。
#[tauri::command]
pub async fn download_tasks() -> Result<Vec<TaskInfo>, String> {
    Ok(TASKS.lock().unwrap().clone())
}

#[derive(Clone, serde::Serialize)]
pub struct FileInfo {
    name: String,
    size: u64,
    /// 修改时间（Unix 秒）
    mtime: u64,
}

/// 已下载文件列表（新的在前）。
#[tauri::command]
pub async fn download_files(app: tauri::AppHandle) -> Result<Vec<FileInfo>, String> {
    let dir = download_dir(&app)?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取下载目录失败: {e}"))?;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(FileInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            size: meta.len(),
            mtime,
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

/// 删除已下载文件（只允许下载目录内的文件名）。
#[tauri::command]
pub async fn download_delete_file(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.trim_matches('.').is_empty() {
        return Err("非法文件名".into());
    }
    let path = download_dir(&app)?.join(&name);
    std::fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))
}

/// 在系统文件管理器里打开下载目录。
#[tauri::command]
pub async fn download_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = download_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_picks_highest_bandwidth_variant() {
        let text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2400000\nhi.m3u8\n";
        assert_eq!(master_variant(text).as_deref(), Some("hi.m3u8"));
        // AVERAGE-BANDWIDTH 不能误配成 BANDWIDTH
        let avg_first = "#EXTM3U\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=500000,BANDWIDTH=800000\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=700000\nb.m3u8\n";
        assert_eq!(master_variant(avg_first).as_deref(), Some("a.m3u8"));
        // 媒体清单（无 STREAM-INF）不当主清单
        let media = "#EXTM3U\n#EXTINF:4,\nseg1.ts\n";
        assert!(master_variant(media).is_none());
    }

    #[test]
    fn media_parse_tracks_key_and_sequence() {
        let base = "https://cdn.example/v/abc/index.m3u8?auth_key=k";
        let text = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=k\",IV=0x00000000000000000000000000000001\n#EXTINF:4,\nseg-1.ts?auth_key=k\n#EXTINF:4,\nseg-2.ts?auth_key=k\n#EXT-X-ENDLIST\n";
        let list = parse_media(base, text).expect("parse");
        assert_eq!(list.segments.len(), 2);
        assert_eq!(list.media_sequence, 7);
        let key = list.keys[0].as_ref().expect("key");
        assert_eq!(key.uri, "https://cdn.example/v/abc/key.bin?auth_key=k");
        // 显式 IV（无引号 hex）必须被解析出来
        assert_eq!(key.iv.expect("iv")[15], 1);
        assert_eq!(segment_iv(key, 7)[15], 1);
        // 未给 IV 时才按媒体序列号推导
        let no_iv = Key { uri: key.uri.clone(), iv: None };
        assert_eq!(segment_iv(&no_iv, 7)[15], 7);
        assert!(list.segments[0].starts_with("https://cdn.example/v/abc/seg-1.ts"));
    }

    #[test]
    fn media_parse_fmp4_init() {
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nseg1.m4s\n";
        let list = parse_media("https://cdn.example/a/list.m3u8", text).expect("parse");
        assert_eq!(list.init.as_deref(), Some("https://cdn.example/a/init.mp4"));
        assert_eq!(list.segments[0], "https://cdn.example/a/seg1.m4s");
    }

    #[test]
    fn sanitize_name_strips_path_chars() {
        assert_eq!(sanitize_name("../a/b:c*?"), "abc");
        assert_eq!(sanitize_name("  "), "video");
        assert_eq!(sanitize_name("正常标题 第3集"), "正常标题 第3集");
    }

    #[test]
    fn aes128_roundtrip_with_explicit_iv() {
        use aes::cipher::BlockEncrypt;
        let key = b"0123456789abcdef";
        let iv = [7u8; 16];
        let plain = b"0123456789abcdef0123456789abcdef";
        let cipher = Aes128::new_from_slice(key).unwrap();
        let mut prev = iv;
        let mut encrypted = Vec::new();
        for chunk in plain.chunks(16) {
            let mut block = [0u8; 16];
            for i in 0..16 {
                block[i] = chunk[i] ^ prev[i];
            }
            cipher.encrypt_block((&mut block).into());
            encrypted.extend_from_slice(&block);
            prev = block;
        }
        let out = aes128_decrypt(key, iv, &encrypted).expect("decrypt");
        assert_eq!(out, plain);
        assert!(aes128_decrypt(key, iv, b"short").is_err());
    }
}
