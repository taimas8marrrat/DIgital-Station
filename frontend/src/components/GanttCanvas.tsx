import { useEffect, useRef, useState } from "react";
import { hhmm } from "../api";
import type { T } from "../i18n";
import { trainName } from "../stages";
import type { View } from "../types";

// Диаграмма движения на canvas: 60 кадров/с, ось времени плывёт непрерывно, бары плавно смещаются.
const KIND: Record<string, string> = { passenger: "#2FA3BF", freight: "#A2604A", container: "#557794" };
interface Bar { key: string; row: number; a: number; d: number; label: string; kind: string; state: string; conflict: boolean; preview?: boolean; unc?: number }

export default function GanttCanvas({ view, t, preview, anim, lang = "ru" }: {
  view: View; t: T; preview: Record<string, { track: number; arr: number; dep: number }> | null; anim: boolean; lang?: string;
}) {
  const langRef = useRef(lang); langRef.current = lang;
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const prevRef = useRef(preview); prevRef.current = preview;
  const animRef = useRef(anim); animRef.current = anim;
  const tRef = useRef(t); tRef.current = t;
  const recvAt = useRef(performance.now());
  const shown = useRef(new Map<string, { a: number; d: number; row: number; alpha: number }>());
  const hits = useRef<{ x: number; y: number; w: number; h: number; b: Bar }[]>([]);
  const [size, setSize] = useState({ w: 900, h: 260 });
  const [tip, setTip] = useState<{ x: number; y: number; b: Bar } | null>(null);

  useEffect(() => { recvAt.current = performance.now(); }, [view]);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = cv.current!, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.w * dpr); canvas.height = Math.floor(size.h * dpr);
    canvas.style.width = `${size.w}px`; canvas.style.height = `${size.h}px`;
    let raf = 0, last = performance.now();
    const frame = (ts: number) => {
      const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
      const v = viewRef.current, t = tRef.current, anim = animRef.current;
      const g = canvas.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(document.documentElement);
      const ink = css.getPropertyValue("--ink").trim() || "#13232E", muted = css.getPropertyValue("--muted").trim() || "#4E6170";
      const grid = css.getPropertyValue("--grid").trim() || "#DCE4E7", panel = css.getPropertyValue("--panel").trim() || "#fff";
      const W = size.w, H = size.h, L = 64, R = 12, TOP = 6, BOT = 24;
      const now = v.now + (anim ? ((ts - recvAt.current) / 1000) * (v.speed || 1) * 0.9 : 0);
      const t0 = now - 3600, t1 = now + 3 * 3600;
      const X = (tm: number) => L + ((tm - t0) / (t1 - t0)) * (W - L - R);
      const rowH = (H - TOP - BOT) / 5, Y = (row: number) => TOP + row * rowH;
      g.fillStyle = panel; g.fillRect(0, 0, W, H);
      // сетка и подписи
      g.font = `500 11px "IBM Plex Sans", system-ui`; g.textAlign = "center"; g.textBaseline = "alphabetic";
      const step = 1800;
      for (let tm = Math.ceil(t0 / step) * step; tm <= t1; tm += step) {
        const x = X(tm); g.fillStyle = grid; g.fillRect(Math.round(x), TOP, 1, H - TOP - BOT);
        g.fillStyle = muted; g.fillText(hhmm(tm), x, H - 7);
      }
      g.textAlign = "right"; g.font = `600 12px "IBM Plex Sans", system-ui`;
      for (let r = 0; r < 5; r++) {
        g.fillStyle = grid; g.fillRect(L, Math.round(Y(r + 1)), W - L - R, 1);
        g.fillStyle = ink; g.fillText(`${t("track")} ${r + 1}`, L - 8, Y(r) + rowH / 2 + 4);
      }
      // бары
      const bars: Bar[] = [];
      const conf = new Set(v.conflicts.filter((c) => c.severity !== "info").flatMap((c) => c.trains));
      for (const tr of v.trains) {
        const k = tr.track ?? tr.plan_track; if (!k) continue;
        const a = tr.actual_arr ?? tr.exp_arr ?? tr.plan_arr, d = tr.actual_dep ?? tr.exp_dep ?? tr.plan_dep;
        if (!a || !d) continue;
        bars.push({ key: tr.id, row: k - 1, a, d, label: trainName(tr, langRef.current, t), kind: tr.kind, state: tr.status, conflict: conf.has(tr.number), unc: tr.eta_unc });
      }
      for (const tr of v.tracks) if (tr.closed_until && tr.closed_until > v.now)
        bars.push({ key: `cl${tr.id}`, row: tr.id - 1, a: v.now, d: tr.closed_until, label: "", kind: "closed", state: "closed", conflict: false });
      const pv = prevRef.current;
      if (pv) for (const [id, p] of Object.entries(pv)) {
        const tr = v.trains.find((x) => x.id === id); if (!tr || tr.status === "on_track") continue;
        bars.push({ key: `pv${id}`, row: p.track - 1, a: p.arr, d: p.dep, label: trainName(tr, langRef.current, t), kind: tr.kind, state: "preview", conflict: false, preview: true });
      }
      const seen = new Set<string>(), H_: typeof hits.current = [];
      const ke = anim ? 1 - Math.exp(-dt * 6) : 1;
      for (const b of bars) {
        seen.add(b.key);
        let s = shown.current.get(b.key);
        if (!s) { s = { a: b.a, d: b.d, row: b.row, alpha: anim ? 0 : 1 }; shown.current.set(b.key, s); }
        s.a += (b.a - s.a) * ke; s.d += (b.d - s.d) * ke; s.row += (b.row - s.row) * ke; s.alpha += (1 - s.alpha) * ke;
        const x0 = Math.max(L, X(s.a)), x1 = Math.min(W - R, X(s.d));
        if (x1 <= L || x0 >= W - R || x1 - x0 < 1) continue;
        const bh = rowH * (b.preview ? 0.22 : 0.56), y = Y(s.row) + rowH / 2 - rowH * 0.28 + (b.preview ? rowH * 0.6 : 0);
        g.globalAlpha = s.alpha * (b.state === "departed" ? 0.45 : 1);
        if (b.kind === "closed") {
          g.fillStyle = "rgba(217,83,74,0.16)"; g.fillRect(x0, y, x1 - x0, bh);
          g.strokeStyle = "#D9534A"; g.setLineDash([4, 3]); g.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, bh - 1); g.setLineDash([]);
        } else if (b.preview) {
          g.fillStyle = "rgba(232,194,74,0.35)"; g.fillRect(x0, y, x1 - x0, bh);
        } else {
          if (b.unc && b.unc > 0.5) {   // полоса разброса прибытия
            const u0 = Math.max(L, X(s.a - b.unc * 60)), u1 = Math.min(W - R, X(s.a + b.unc * 60));
            g.fillStyle = "rgba(85,119,148,0.18)"; g.fillRect(u0, y - 3, u1 - u0, bh + 6);
            g.fillStyle = "rgba(85,119,148,0.6)"; g.fillRect(u0, y + bh / 2 - 0.5, u1 - u0, 1);
          }
          g.fillStyle = KIND[b.kind] ?? "#777";
          g.beginPath(); (g as any).roundRect ? (g as any).roundRect(x0, y, x1 - x0, bh, 3) : g.rect(x0, y, x1 - x0, bh); g.fill();
          if (b.conflict) { g.strokeStyle = `rgba(232,194,74,${0.6 + 0.4 * Math.sin(ts / 260)})`; g.lineWidth = 3; g.stroke(); g.lineWidth = 1; }
          if (x1 - x0 > 30) {
            g.fillStyle = "#fff"; g.font = `600 11px "IBM Plex Sans", system-ui`; g.textAlign = "left";
            let txt = b.label; const max = x1 - x0 - 10;
            while (txt.length > 3 && g.measureText(txt).width > max) txt = txt.slice(0, -2);
            if (txt !== b.label) txt = txt.replace(/\s*\S?$/, "") + "…";
            g.save(); g.beginPath(); g.rect(x0, y, x1 - x0, bh); g.clip(); g.fillText(txt, x0 + 6, y + bh / 2 + 4); g.restore();
          }
        }
        g.globalAlpha = 1;
        H_.push({ x: x0, y, w: x1 - x0, h: bh, b });
      }
      for (const k of [...shown.current.keys()]) if (!seen.has(k)) shown.current.delete(k);
      hits.current = H_;
      // линия «сейчас»
      const xn = X(now);
      g.fillStyle = ink; g.fillRect(Math.round(xn) - 1, TOP, 2, H - TOP - BOT);
      g.font = `700 11px "IBM Plex Sans", system-ui`; g.textAlign = "center"; g.fillText(hhmm(now), xn, TOP + 10);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  const onMove = (e: React.MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const h = hits.current.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    setTip(h ? { x, y, b: h.b } : null);
  };
  return (
    <div className="gantt" ref={wrap} style={{ position: "relative" }}>
      <canvas ref={cv} onMouseMove={onMove} onMouseLeave={() => setTip(null)} aria-label={t("gantt")} role="img" />
      {tip && tip.b.kind !== "closed" && (
        <div className="tip" style={{ left: tip.x + 12, top: tip.y - 40 }}>
          <div className="tip-h">{tip.b.label}</div>
          <div className="muted">{t(`k_${tip.b.kind}`)}</div>
          <div>{hhmm(tip.b.a)}{tip.b.unc ? ` ±${Math.round(tip.b.unc)} ${t("min")}` : ""} – {hhmm(tip.b.d)}</div>
        </div>
      )}
    </div>
  );
}
