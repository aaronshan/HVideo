import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type { DownloadTask } from "../types";
import { useStore } from "../store";
import { Empty, Img } from "./ui";
import { IChevD, IDownload, ITrash } from "../icons";

const fmtSize = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
      : `${Math.max(1, Math.ceil(n / 1024))} KB`;

type LibEpisode = { file: string; size: number; mtime: number; mime: string; local_url: string };
type LibGroup = { group: string; cover?: string | null; episodes: LibEpisode[] };

const labelOf = (file: string) => file.replace(/\.(mp4|ts|m4s)$/i, "");

type Row = {
  name: string;
  epLabel: string;
  file: string;
  cover?: string | null;
  size: number;
  localUrl: string;
  /** 进行中任务（还没落盘） */
  task?: DownloadTask;
};

/* 「我的」页的下载 tab。数据源是磁盘（download_library，断网可用）：
   已下载的剧以封面网格呈现（同收藏/历史样式），点击卡片展开集列表，
   每集可点播（进本地播放页）、可删除；进行中/失败的任务叠在对应剧下。 */
export function DownloadsTab() {
  const { toast, push } = useStore();
  const [lib, setLib] = useState<LibGroup[]>([]);
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [open, setOpen] = useState<string | null>(null);
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

  /* 合并视图：磁盘上的剧 + 只有任务还没落盘的剧（新下载还没出文件的组） */
  const groups = useMemo(() => {
    type Merged = { name: string; cover?: string | null; rows: Row[] };
    const map = new Map<string, Merged>();
    for (const g of lib) {
      map.set(g.group, {
        name: g.group,
        cover: g.cover,
        rows: g.episodes.map((e) => ({ name: g.group, epLabel: labelOf(e.file), file: e.file, cover: g.cover, size: e.size, localUrl: e.local_url })),
      });
    }
    for (const t of tasks) {
      const key = t.group || t.name;
      let g = map.get(key);
      if (!g) { g = { name: key, rows: [] }; map.set(key, g); }
      if (t.status !== "done") {
        g.rows.push({ name: key, epLabel: labelOf(t.name), file: "", size: 0, localUrl: "", task: t });
      }
    }
    return [...map.values()];
  }, [lib, tasks]);

  const play = (r: Row) => push({ kind: "localvideo", title: r.name, url: r.localUrl, name: r.epLabel });

  const cancel = (t: DownloadTask) => {
    api.downloadCancel(t.id).then(refresh).catch((e) => toast((e as Error).message || "取消失败", "info"));
  };

  const deleteGroup = (name: string) => {
    api.downloadDeleteGroup(name)
      .then(() => { toast(`已删除《${name}》`, "ok"); refresh(); })
      .catch((e) => toast((e as Error).message || "删除失败", "info"));
  };

  const deleteFile = (g: string, f: string) => {
    api.downloadDeleteFile(`${g}/${f}`)
      .then(() => { toast("已删除", "ok"); refresh(); })
      .catch((e) => toast((e as Error).message || "删除失败", "info"));
  };

  if (!groups.length) {
    return (
      <Empty icon={<IDownload size={24} />} title="还没有下载内容"
        sub="在播放页点下载（每次下载当前一集）；断网也能在这里播放" />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button onClick={() => api.downloadOpenDir().catch((e) => toast((e as Error).message || "打开失败", "info"))}
        className="self-end flex items-center gap-1 h-7 px-2.5 rounded-full bg-s3 text-[11px] font-semibold text-on pressable">
        打开下载目录
      </button>
      {/* 剧封面网格：同收藏/历史样式，点击卡片展开集列表 */}
      <div className="grid grid-cols-3 gap-2">
        {groups.map((g) => {
          const doneRows = g.rows.filter((r) => !r.task);
          const runningRows = g.rows.filter((r) => r.task?.status === "running");
          const expanded = open === g.name;
          return (
            <div key={g.name} className={expanded ? "col-span-3" : ""}>
              <button onClick={() => setOpen(expanded ? null : g.name)}
                className="w-full relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable"
                style={expanded ? { aspectRatio: "auto", height: 96 } : { paddingTop: "133%" }}>
                {g.cover
                  ? <Img src={g.cover} raw eager />
                  : <span className="absolute inset-0 flex items-center justify-center bg-s3 text-dim"><IDownload size={22} /></span>}
                {!expanded && (
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5 text-left">
                    <span className="block text-[10.5px] text-white clamp-2 leading-tight">{g.name}</span>
                    <span className="block text-[9.5px] text-white/75 mt-0.5 tabular-nums">
                      {runningRows.length > 0 ? `下载中 ${doneRows.length}/${g.rows.length}` : `${doneRows.length} 集 · 本地`}
                    </span>
                  </span>
                )}
                {expanded && (
                  <span className="absolute inset-0 flex items-center gap-2 px-3 text-left">
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12.5px] font-bold text-white truncate">{g.name}</span>
                      <span className="block text-[10px] text-white/75 mt-0.5 tabular-nums">
                        {runningRows.length > 0 ? `下载中 · 已完成 ${doneRows.length} 集` : `${doneRows.length} 集 · 本地可播`}
                      </span>
                    </span>
                    <IChevD size={16} className="text-white/80 shrink-0" />
                  </span>
                )}
              </button>

              {/* 展开的集列表：每集一行，可播放/删除 */}
              {expanded && (
                <div className="mt-2 rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
                  {g.rows.map((r, i) => {
                    const t = r.task;
                    const pct = t && t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
                    return (
                      <div key={`${r.epLabel}-${i}`} className="flex items-center gap-2.5 px-3 py-2.5">
                        <span className="w-10 h-[53px] rounded-(--r-sm) overflow-hidden relative shrink-0 bg-s3">
                          {g.cover
                            ? <Img src={g.cover} raw eager />
                            : <span className="absolute inset-0 flex items-center justify-center text-dim"><IDownload size={14} /></span>}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11.5px] text-on truncate">{r.epLabel}</span>
                          <span className="block text-[10px] text-mut mt-0.5 tabular-nums">
                            {t
                              ? t.status === "running"
                                ? (t.total > 1 ? `${t.done}/${t.total} 分片 · ` : "") + `${pct}%`
                                : t.status === "failed" ? (t.err || "失败") : "已取消"
                              : fmtSize(r.size)}
                          </span>
                          {t && t.status === "running" && (
                            <span className="block mt-1 h-[3px] rounded-full bg-s3 overflow-hidden">
                              <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                            </span>
                          )}
                        </span>
                        {!t && (
                          <button onClick={() => play(r)}
                            className="shrink-0 h-6 px-2.5 rounded-full bg-primary text-[10.5px] font-semibold text-on-primary pressable">
                            播放
                          </button>
                        )}
                        {t && t.status === "running" && (
                          <button onClick={() => cancel(t)} className="shrink-0 h-6 px-2 rounded-full bg-s3 text-[10.5px] text-on pressable">取消</button>
                        )}
                        {!t && (
                          <button onClick={() => deleteFile(g.name, r.file)}
                            aria-label={`删除 ${r.epLabel}`}
                            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-mut hover:text-danger hover:bg-s3 pressable">
                            <ITrash size={13} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  <button onClick={() => deleteGroup(g.name)}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] text-mut hover:text-danger pressable">
                    <ITrash size={12} />删除整部剧
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
