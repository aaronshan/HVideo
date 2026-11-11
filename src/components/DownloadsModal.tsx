import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type { DownloadFile, DownloadTask } from "../types";
import { useStore } from "../store";
import { Modal } from "./ui";
import { IDownload, IFolder, ITrash } from "../icons";

const fmtSize = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
      : `${Math.max(1, Math.ceil(n / 1024))} KB`;

const fmtDate = (sec: number) => {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const STATUS_TEXT: Record<string, string> = {
  running: "下载中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/* 下载管理：进行中的任务（可取消）+ 已下载文件（可删除），数据变化由事件驱动 */
export default function DownloadsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useStore();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [files, setFiles] = useState<DownloadFile[]>([]);

  const refresh = useCallback(() => {
    api.downloadTasks().then(setTasks).catch(() => {});
    api.downloadFiles().then(setFiles).catch(() => {});
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  useEffect(() => {
    if (!open) return undefined;
    const un1 = listen<{ id: string; done: number; total: number }>("hg-download-progress", (e) => {
      const p = e.payload;
      setTasks((list) => list.map((t) => (t.id === p.id ? { ...t, done: p.done, total: p.total } : t)));
    });
    const un2 = listen("hg-download-done", () => refresh());
    return () => { un1.then((f) => f()).catch(() => {}); un2.then((f) => f()).catch(() => {}); };
  }, [open, refresh]);

  const cancel = (t: DownloadTask) => {
    api.downloadCancel(t.id)
      .then(() => refresh())
      .catch((e) => toast((e as Error).message || "取消失败", "info"));
  };

  const remove = (f: DownloadFile) => {
    api.downloadDeleteFile(f.name)
      .then(() => { setFiles((list) => list.filter((x) => x.name !== f.name)); toast("已删除", "ok"); })
      .catch((e) => toast((e as Error).message || "删除失败", "info"));
  };

  const running = tasks.filter((t) => t.status === "running");
  const finished = tasks.filter((t) => t.status !== "running");

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <div className="p-5">
        <div className="flex items-center gap-2">
          <span className="w-9 h-9 rounded-(--r-sm) bg-s3 flex items-center justify-center text-primary"><IDownload size={17} /></span>
          <div className="text-[15px] font-bold text-on">下载管理</div>
          <button onClick={() => api.downloadOpenDir().catch((e) => toast((e as Error).message || "打开失败", "info"))}
            className="ml-auto flex items-center gap-1 h-7 px-2.5 rounded-full bg-s3 text-[11px] font-semibold text-on pressable">
            <IFolder size={13} />打开目录
          </button>
        </div>

        {/* 任务列表 */}
        <div className="text-[10.5px] font-semibold text-dim tracking-wide mt-4 mb-1.5">任务（{running.length} 个进行中）</div>
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 max-h-[180px] scroll-y">
          {tasks.length === 0 ? (
            <div className="px-3.5 py-3 text-[11.5px] text-mut">本次启动还没有下载任务</div>
          ) : (
            [...running, ...finished].map((t) => {
              const pct = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
              return (
                <div key={t.id} className="px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 text-[12px] text-on truncate">{t.name}</div>
                    <span className={`shrink-0 text-[10px] ${t.status === "failed" ? "text-danger" : "text-mut"}`}>
                      {t.status === "failed" ? (t.err || "失败") : STATUS_TEXT[t.status] || t.status}
                    </span>
                    {t.status === "running" && (
                      <button onClick={() => cancel(t)} className="shrink-0 h-6 px-2 rounded-full bg-s3 text-[10.5px] text-on pressable">取消</button>
                    )}
                  </div>
                  {t.status === "running" && (
                    <div className="mt-1.5 h-[3px] rounded-full bg-s3 overflow-hidden">
                      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  {t.status === "running" && t.total > 1 && (
                    <div className="mt-1 text-[10px] text-mut tabular-nums">{t.done} / {t.total} 分片</div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* 已下载文件 */}
        <div className="text-[10.5px] font-semibold text-dim tracking-wide mt-4 mb-1.5">已下载（{files.length}）</div>
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 max-h-[220px] scroll-y">
          {files.length === 0 ? (
            <div className="px-3.5 py-3 text-[11.5px] text-mut">下载目录是空的</div>
          ) : (
            files.map((f) => (
              <div key={f.name} className="flex items-center gap-2 px-3.5 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-on truncate">{f.name}</div>
                  <div className="text-[10px] text-mut mt-0.5 tabular-nums">{fmtSize(f.size)} · {fmtDate(f.mtime)}</div>
                </div>
                <button onClick={() => remove(f)} aria-label={`删除 ${f.name}`}
                  className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-mut hover:text-danger hover:bg-s3 pressable">
                  <ITrash size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        <button onClick={onClose} className="mt-4 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on pressable">关闭</button>
      </div>
    </Modal>
  );
}
