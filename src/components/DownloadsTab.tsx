import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type { DownloadTask } from "../types";
import { useStore } from "../store";
import { Empty } from "./ui";
import { IChevD, IDownload, ITrash } from "../icons";

const fmtSize = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
      : `${Math.max(1, Math.ceil(n / 1024))} KB`;

const STATUS_TEXT: Record<string, string> = {
  running: "下载中",
  failed: "失败",
  cancelled: "已取消",
};

type LibEpisode = { file: string; size: number; mtime: number; mime: string; local_url: string };
type LibGroup = { group: string; episodes: LibEpisode[] };
type Item = {
  /** 集名（file 去扩展名） */
  label: string;
  file: string;
  size: number;
  localUrl: string;
  /** 进行中任务（无文件） */
  task?: DownloadTask;
};

const labelOf = (file: string) => file.replace(/\.(mp4|ts|m4s)$/i, "");

/* 「我的」页的下载 tab。数据源是磁盘（download_library，断网可用）：
   已完成的集直接列文件、可点播（进 Feed 本地播放）；进行中/失败的任务
   （内存表）叠在同剧分组下显示进度与取消。 */
export function DownloadsTab() {
  const { toast, push } = useStore();
  const [lib, setLib] = useState<LibGroup[]>([]);
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => {
    api.downloadLibrary().then((r) => setLib(r?.groups || [])).catch(() => {});
    api.downloadTasks().then(setTasks).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh, refreshTick]);

  useEffect(() => {
    const un1 = listen<{ id: string; done: number; total: number }>("hg-download-progress", (e) => {
      const p = e.payload;
      setTasks((list) => list.map((t) => (t.id === p.id ? { ...t, done: p.done, total: p.total } : t)));
    });
    const un2 = listen("hg-download-done", () => setRefreshTick((n) => n + 1));
    return () => { un1.then((f) => f()).catch(() => {}); un2.then((f) => f()).catch(() => {}); };
  }, []);

  /* 合并视图：磁盘上的剧 + 只有任务还没落盘的剧 */
  const groups = useMemo(() => {
    type Merged = { name: string; items: Item[] };
    const map = new Map<string, Merged>();
    for (const g of lib) {
      map.set(g.group, {
        name: g.group,
        items: g.episodes.map((e) => ({ label: labelOf(e.file), file: e.file, size: e.size, localUrl: e.local_url })),
      });
    }
    for (const t of tasks) {
      const key = t.group || t.name;
      let g = map.get(key);
      if (!g) { g = { name: key, items: [] }; map.set(key, g); }
      if (t.status === "running" || t.status === "failed" || t.status === "cancelled") {
        g.items.push({ label: labelOf(t.name), file: "", size: 0, localUrl: "", task: t });
      }
    }
    return [...map.values()];
  }, [lib, tasks]);

  useEffect(() => {
    setOpen((prev) => {
      const next = { ...prev };
      for (const g of groups) if (next[g.name] === undefined) next[g.name] = true;
      return next;
    });
  }, [groups]);

  const cancel = (t: DownloadTask) => {
    api.downloadCancel(t.id).then(refresh).catch((e) => toast((e as Error).message || "取消失败", "info"));
  };

  const deleteGroup = (name: string) => {
    api.downloadDeleteGroup(name)
      .then(() => { toast(`已删除《${name}》`, "ok"); refresh(); })
      .catch((e) => toast((e as Error).message || "删除失败", "info"));
  };

  if (!groups.length) {
    return (
      <Empty icon={<IDownload size={24} />} title="还没有下载内容"
        sub="在播放页点下载，多集剧会自动下载整部；断网也能在这里播放" />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button onClick={() => api.downloadOpenDir().catch((e) => toast((e as Error).message || "打开失败", "info"))}
        className="self-end flex items-center gap-1 h-7 px-2.5 rounded-full bg-s3 text-[11px] font-semibold text-on pressable">
        打开下载目录
      </button>
      {groups.map((g) => {
        const expanded = open[g.name] !== false; // 默认展开
        const doneCount = g.items.filter((i) => !i.task).length;
        const runningCount = g.items.filter((i) => i.task?.status === "running").length;
        return (
          <div key={g.name} className="rounded-(--r-md) bg-s2 overflow-hidden">
            <button onClick={() => setOpen((o) => ({ ...o, [g.name]: !expanded }))}
              className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 rounded-(--r-sm) bg-s3 flex items-center justify-center text-primary shrink-0"><IDownload size={15} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] font-semibold text-on truncate">{g.name}</span>
                <span className="block text-[10.5px] text-mut mt-0.5 tabular-nums">
                  {runningCount > 0 ? `下载中 · 已完成 ${doneCount} 集` : `${doneCount} 集 · 本地可播`}
                </span>
              </span>
              <IChevD size={14} className="text-mut shrink-0" style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />
            </button>

            {expanded && (
              <div className="divide-y divide-s3 border-t border-s3">
                {g.items.map((it, i) => {
                  const t = it.task;
                  const pct = t && t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
                  return (
                    <div key={`${it.label}-${i}`} className="flex items-center gap-2 px-3.5 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-[11.5px] text-on truncate">{it.label}</div>
                        <div className="text-[10px] text-mut mt-0.5 tabular-nums">
                          {t
                            ? t.status === "running"
                              ? (t.total > 1 ? `${t.done}/${t.total} 分片 · ` : "") + `${pct}%`
                              : t.status === "failed" ? (t.err || "失败") : STATUS_TEXT[t.status] || t.status
                            : fmtSize(it.size)}
                        </div>
                        {t && t.status === "running" && (
                          <div className="mt-1 h-[3px] rounded-full bg-s3 overflow-hidden">
                            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </div>
                      {!t && (
                        <button
                          onClick={() => {
                            /* 点播：进 Feed 的本地播放模式（videoIds 从 index.json 拿不到，
                               用文件名解析不可靠——直接给 VideoSurface 一个本地地址的播放入口） */
                            push({ kind: "localvideo", title: g.name, url: it.localUrl, name: it.label });
                          }}
                          className="shrink-0 h-6 px-2.5 rounded-full bg-primary text-[10.5px] font-semibold text-on-primary pressable">
                          播放
                        </button>
                      )}
                      {t && t.status === "running" && (
                        <button onClick={() => cancel(t)} className="shrink-0 h-6 px-2 rounded-full bg-s3 text-[10.5px] text-on pressable">取消</button>
                      )}
                      {!t && (
                        <button
                          onClick={() => api.downloadDeleteFile(`${g.name}/${it.file}`)
                            .then(() => { toast("已删除", "ok"); refresh(); })
                            .catch((e) => toast((e as Error).message || "删除失败", "info"))}
                          aria-label={`删除 ${it.label}`}
                          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-mut hover:text-danger hover:bg-s3 pressable">
                          <ITrash size={13} />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button onClick={() => deleteGroup(g.name)}
                  className="w-full flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-[11px] text-mut hover:text-danger pressable">
                  <ITrash size={12} />删除整部剧
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
