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

type Group = {
  name: string;
  tasks: DownloadTask[];
  running: number;
  done: number;
  failed: number;
};

const groupTasks = (tasks: DownloadTask[]): Group[] => {
  const map = new Map<string, Group>();
  for (const t of tasks) {
    const key = t.group || t.name;
    let g = map.get(key);
    if (!g) { g = { name: key, tasks: [], running: 0, done: 0, failed: 0 }; map.set(key, g); }
    g.tasks.push(t);
    if (t.status === "running") g.running += 1;
    else if (t.status === "done") g.done += 1;
    else if (t.status === "failed") g.failed += 1;
  }
  /* 有进行中任务的剧排前面，其余按最近一次活动 */
  return [...map.values()].sort((a, b) => (b.running > 0 ? 1 : 0) - (a.running > 0 ? 1 : 0));
};

/* 「我的」页的下载 tab：按剧分组。进行中显示每集进度（可取消），
   已完成的剧可整剧删除（删目录）。数据变化由事件驱动。 */
export function DownloadsTab() {
  const { toast } = useStore();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => {
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

  const groups = useMemo(() => groupTasks(tasks), [tasks]);
  /* 新出现下载任务的剧自动展开 */
  useEffect(() => {
    setOpen((prev) => {
      const next = { ...prev };
      for (const g of groups) if (g.running > 0 && next[g.name] === undefined) next[g.name] = true;
      return next;
    });
  }, [groups]);

  const cancel = (t: DownloadTask) => {
    api.downloadCancel(t.id).then(refresh).catch((e) => toast((e as Error).message || "取消失败", "info"));
  };

  const deleteGroup = (g: Group) => {
    api.downloadDeleteGroup(g.name)
      .then(() => toast(`已删除《${g.name}》`, "ok"))
      .catch((e) => toast((e as Error).message || "删除失败", "info"));
  };

  if (!groups.length) {
    return (
      <Empty icon={<IDownload size={24} />} title="还没有下载内容"
        sub="在播放页点下载，多集剧会自动下载整部" />
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
        const totalEps = g.tasks.length;
        const pct = g.running > 0
          ? Math.round((g.tasks.reduce((s, t) => s + Math.min(1, t.total > 0 ? t.done / t.total : 0), 0) / totalEps) * 100)
          : 0;
        return (
          <div key={g.name} className="rounded-(--r-md) bg-s2 overflow-hidden">
            <button onClick={() => setOpen((o) => ({ ...o, [g.name]: !expanded }))}
              className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 rounded-(--r-sm) bg-s3 flex items-center justify-center text-primary shrink-0"><IDownload size={15} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] font-semibold text-on truncate">{g.name}</span>
                <span className="block text-[10.5px] text-mut mt-0.5 tabular-nums">
                  {g.running > 0
                    ? `下载中 ${g.done}/${totalEps} 集 · ${pct}%`
                    : g.failed > 0 ? `${g.done}/${totalEps} 集 · ${g.failed} 集失败`
                      : g.done === totalEps ? `${totalEps} 集 · 已完成` : `${g.done}/${totalEps} 集`}
                </span>
                {g.running > 0 && (
                  <span className="block mt-1.5 h-[3px] rounded-full bg-s3 overflow-hidden">
                    <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                  </span>
                )}
              </span>
              <IChevD size={14} className="text-mut shrink-0" style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />
            </button>

            {expanded && (
              <div className="divide-y divide-s3 border-t border-s3">
                {g.tasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 px-3.5 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[11.5px] text-on truncate">{t.name}</div>
                      <div className="text-[10px] text-mut mt-0.5 tabular-nums">
                        {t.status === "running" && t.total > 1 ? `${t.done}/${t.total} 分片 · ` : ""}
                        {t.status === "failed" ? (t.err || "失败") : STATUS_TEXT[t.status] || t.status}
                      </div>
                    </div>
                    {t.status === "running" && (
                      <button onClick={() => cancel(t)} className="shrink-0 h-6 px-2 rounded-full bg-s3 text-[10.5px] text-on pressable">取消</button>
                    )}
                  </div>
                ))}
                {g.running === 0 && (
                  <button onClick={() => deleteGroup(g)}
                    className="w-full flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-[11px] text-mut hover:text-danger pressable">
                    <ITrash size={12} />删除整部剧（{totalEps} 个文件）
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
