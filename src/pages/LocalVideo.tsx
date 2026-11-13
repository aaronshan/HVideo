import Player from "../components/Player";
import { IBack, IDownload } from "../icons";
import { isMobile } from "../api";

/* 已下载视频的本地播放页：数据全部来自本地（下载库），断网可用。
   入口：我的 → 我的下载 → 某一集的「播放」。加载失败由 Player 内部错误浮层呈现。 */
export function LocalVideoPage({ title, url, name, onBack }: {
  title: string; url: string; name: string; onBack: () => void;
}) {
  return (
    <div className="absolute inset-0 bg-black flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 bg-black/80" style={{ paddingTop: isMobile ? "var(--sat, 0px)" : 0, height: isMobile ? "calc(44px + var(--sat, 0px))" : 44 }}>
        <button onClick={onBack} aria-label="返回" className="w-9 h-9 rounded-full flex items-center justify-center text-white hover:bg-white/10 pressable"><IBack size={19} /></button>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-white truncate">{name}</div>
          <div className="text-[10px] text-white/60 truncate">{title} · 本地已下载</div>
        </div>
        <span className="shrink-0 flex items-center gap-1 px-2 h-6 rounded-full bg-white/10 text-[10.5px] font-semibold text-white/85">
          <IDownload size={12} />离线
        </span>
      </div>
      <div className="flex-1 relative min-h-0">
        <Player src={url} autoPlay active controls className="w-full h-full"
          diagnosticContext={{ view: "local_video", resource: name }} />
      </div>
    </div>
  );
}
