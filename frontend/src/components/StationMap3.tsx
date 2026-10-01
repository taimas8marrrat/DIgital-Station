import { useEffect, useRef, useState } from "react";
import { hhmm } from "../api";
import type { T } from "../i18n";
import { stageNow, trainName } from "../stages";
import type { Station, Train, View } from "../types";

// Геометрия: стрелочные улицы под постоянным углом 30°, направления сходятся у краёв станции.
const LW = 768, LH = 300;
const TY: Record<number, number> = { 1: 118, 2: 154, 3: 190, 4: 226, 5: 262 };
const DX = 62;                                   // 36 px по вертикали / tan 30°
const PW = 96, PE = LW - 96;                     // точки входа в стрелочную улицу
const MW = 54, ME = LW - 54;                     // концы перегонов (входные сигналы)
const MAINY: Record<string, number> = { south: 174, west: 206, north: 174, east: 206 };
const startW = (k: number): P => [PW + DX * Math.abs(k - 3), TY[k]];
const endE = (k: number): P => [PE - DX * Math.abs(k - 3), TY[k]];
const X0 = PW + 2 * DX, X1 = PE - 2 * DX;         // границы «коротких» путей 1 и 5
const CX = (X0 + X1) / 2;
type P = [number, number];

const C = {
  ground: "#D3C29C", g2: "#CBB890", g3: "#DACBA8", grass: "#A4AE7A", grass2: "#8E9A66", sax: "#7D8A5A", sax2: "#66724A",
  tree: "#6F8F55", tree2: "#5A7A45", tree3: "#86A569", trunk: "#7A5B3E", shadow: "rgba(60,48,30,0.22)",
  ballast: "#BBB1A2", sleeper: "#8A6B50", rail: "#66707A",
  platform: "#CDD0CC", edge: "#E8C24A", roof: "#3E93A8", roofHi: "#62AFC1", wall: "#EFE8D8", wallSh: "#D9CFBB",
  window: "#46677A", door: "#8C6448", pass: "#F2F5F6", passStripe: "#3EA9C2", passLoco: "#2F8299",
  fr1: "#A2604A", fr2: "#8E5442", locoF: "#4A7366", cont: ["#C2574B", "#4A7BB5", "#D9A93A", "#5C9A6E"],
  red: "#D9534A", green: "#48B36F", gold: "#E8C24A", dark: "#23333F", vest: "#F08A24",
};
const KIND: Record<string, string> = { passenger: "#2FA3BF", freight: "#A2604A", container: "#557794" };

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function px(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }

// ---------------------------------------------------------------- рельсовая сеть
function segments(ext = 10): [P, P][] {
  const s: [P, P][] = [];
  for (const d of ["south", "west"]) s.push([[-ext, MAINY[d]], [MW, MAINY[d]]], [[MW, MAINY[d]], [PW, TY[3]]]);
  for (const d of ["north", "east"]) s.push([[ME, MAINY[d]], [LW + ext, MAINY[d]]], [[PE, TY[3]], [ME, MAINY[d]]]);
  s.push([[PW, TY[3]], startW(1)], [[PW, TY[3]], startW(5)], [endE(1), [PE, TY[3]]], [endE(5), [PE, TY[3]]]);
  for (const k of [1, 2, 3, 4, 5]) s.push([startW(k), endE(k)]);
  return s;
}
const SWITCHES: Record<string, P> = { W2: [PW, TY[3]], W1: startW(2), W3: startW(4), E2: [PE, TY[3]], E1: endE(2), E3: endE(4) };

function drawRails(g: CanvasRenderingContext2D, ext = 10) {
  const segs = segments(ext);
  const each = (fn: (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number, L: number) => void) => {
    for (const [[x0, y0], [x1, y1]] of segs) { const L = Math.hypot(x1 - x0, y1 - y0); fn(x0, y0, x1, y1, -(y1 - y0) / L, (x1 - x0) / L, L); }
  };
  g.lineCap = "butt";
  each((x0, y0, x1, y1) => { g.strokeStyle = C.ballast; g.lineWidth = 9; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); });
  each((x0, y0, x1, y1, nx, ny, L) => {
    g.strokeStyle = C.sleeper; g.lineWidth = 2;
    for (let d = 2; d < L; d += 4) { const x = x0 + (x1 - x0) * d / L, y = y0 + (y1 - y0) * d / L; g.beginPath(); g.moveTo(x - nx * 3.5, y - ny * 3.5); g.lineTo(x + nx * 3.5, y + ny * 3.5); g.stroke(); }
  });
  each((x0, y0, x1, y1, nx, ny) => {
    g.strokeStyle = C.rail; g.lineWidth = 1;
    for (const o of [-2, 2]) { g.beginPath(); g.moveTo(x0 + nx * o, y0 + ny * o); g.lineTo(x1 + nx * o, y1 + ny * o); g.stroke(); }
  });
  // крестовины стрелочных переводов
  for (const [x, y] of Object.values(SWITCHES)) { g.fillStyle = "#3F4A54"; g.beginPath(); g.moveTo(x - 4, y - 2); g.lineTo(x + 4, y); g.lineTo(x - 4, y + 2); g.fill(); }
}

function tree(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.fillStyle = C.shadow; g.beginPath(); g.ellipse(x + 4, y + 2, 7 * s, 3 * s, 0, 0, Math.PI * 2); g.fill();
  px(g, x - 1, y - 6 * s, 2, 7 * s, C.trunk);
  [C.tree2, C.tree, C.tree3].forEach((c, i) => { g.fillStyle = c; g.beginPath(); g.ellipse(x - i * 0.6, y - (9 + i * 3) * s, (6 - i * 1.5) * s, (8 - i * 2) * s, 0, 0, Math.PI * 2); g.fill(); });
}

function background(g: CanvasRenderingContext2D, Wd: number, Hd: number, XO: number, YO: number) {
  const r = rng(11);
  px(g, 0, 0, Wd, Hd, C.ground);
  for (let i = 0; i < 4200 * (Wd * Hd) / (LW * LH); i++) px(g, r() * Wd, r() * Hd, 1 + (r() < 0.2 ? 1 : 0), 1, r() < 0.5 ? C.g2 : C.g3);
  for (let i = 0; i < 520 * (Wd * Hd) / (LW * LH); i++) { const x = r() * Wd, y = r() * Hd; px(g, x, y, 1, 2, r() < 0.5 ? C.grass : C.grass2); }
  // зелень вне станции: рощи и кусты, плотнее у краёв
  const outside = (x: number, y: number) => !(x > XO - 14 && x < XO + LW + 14 && y > YO + 88 && y < YO + LH - 18);
  for (let i = 0; i < 140 * (Wd * Hd) / (LW * LH); i++) { const x = r() * Wd, y = r() * Hd; if (!outside(x, y)) continue; tree(g, x, y, 0.75 + r() * 0.35); }
  for (let i = 0; i < 260 * (Wd * Hd) / (LW * LH); i++) {
    const x = r() * Wd, y = r() * Hd; if (!outside(x, y)) continue;
    g.fillStyle = r() < 0.5 ? C.sax : C.sax2; g.beginPath(); g.ellipse(x, y, 2.5 + r() * 2.5, 1.8 + r(), 0, 0, Math.PI * 2); g.fill();
  }
  g.save(); g.translate(XO, YO);
  px(g, 360, 0, 50, 26, "#C9B992");
  const bx = 300, by = 30;
  g.fillStyle = C.shadow; g.fillRect(bx + 6, by + 48, 170, 8);
  px(g, bx, by + 14, 170, 40, C.wall); px(g, bx, by + 50, 170, 4, C.wallSh);
  px(g, bx - 4, by + 8, 178, 8, C.roof); px(g, bx - 2, by + 7, 174, 2, C.roofHi);
  px(g, bx + 62, by - 2, 46, 14, C.roof); px(g, bx + 64, by - 3, 42, 2, C.roofHi);
  for (let i = 0; i < 14; i++) px(g, bx + 8 + i * 11.5, by + 22, 7, 12, C.window);
  px(g, bx + 78, by + 38, 14, 16, C.door);
  px(g, bx + 182, by - 10, 2, 40, C.dark); px(g, bx + 184, by - 10, 22, 12, "#26B3CC"); px(g, bx + 193, by - 7, 4, 4, C.gold);
  // привокзальный сквер: газоны, клумбы, аллея тополей вдоль дороги
  g.fillStyle = "#9DB273"; g.fillRect(240, 6, 110, 20); g.fillRect(420, 6, 110, 20);
  for (let i = 0; i < 40; i++) px(g, 242 + r() * 106, 8 + r() * 16, 2, 2, ["#E07A7A", "#F2C94C", "#F4F1EA", "#B57BD6"][i % 4]);
  for (let i = 0; i < 40; i++) px(g, 422 + r() * 106, 8 + r() * 16, 2, 2, ["#E07A7A", "#F2C94C", "#F4F1EA", "#B57BD6"][i % 4]);
  for (let i = 0; i < 7; i++) { tree(g, 236 + i * 6, 30, 0.7); tree(g, 534 - i * 6, 30, 0.7); }
  for (let i = 0; i < 8; i++) tree(g, 170 + i * 16 + r() * 4, 76 + (i % 2) * 5, 1.1);
  for (let i = 0; i < 8; i++) tree(g, 490 + i * 16 + r() * 4, 80 + (i % 2) * 5, 1.1);
  for (let i = 0; i < 7; i++) tree(g, 16 + i * 18, 44 + r() * 30, 0.9);
  for (let i = 0; i < 7; i++) tree(g, 640 + i * 18, 44 + r() * 30, 0.9);
  for (let i = 0; i < 90; i++) {
    const x = r() * LW, y = r() * LH;
    if (y > 100 && y < 280) continue;
    g.fillStyle = r() < 0.5 ? C.sax : C.sax2; g.beginPath(); g.ellipse(x, y, 3 + r() * 2, 2.2, 0, 0, Math.PI * 2); g.fill();
  }
  // платформы: боковая у вокзала и островная между путями 1 и 2
  g.fillStyle = C.shadow; g.fillRect(X0 + 14, 110, X1 - X0 - 28, 3);
  px(g, X0 + 10, 98, X1 - X0 - 20, 12, C.platform); px(g, X0 + 10, 109, X1 - X0 - 20, 1, C.edge);
  px(g, X0 + 10, 126, X1 - X0 - 20, 20, C.platform); px(g, X0 + 10, 126, X1 - X0 - 20, 1, C.edge); px(g, X0 + 10, 145, X1 - X0 - 20, 1, C.edge);
  for (let x = X0 + 30; x < X1 - 20; x += 44) { px(g, x, 131, 8, 4, "#A39580"); px(g, x + 2, 100, 1, 6, C.dark); }
  drawRails(g, XO + 20);
  g.restore();
}

function backgroundTech(g: CanvasRenderingContext2D, dark: boolean, Wd: number, Hd: number, XO: number, YO: number) {
  px(g, 0, 0, Wd, Hd, dark ? "#142231" : "#F3F6F7");
  g.save(); g.translate(XO, YO);
  g.fillStyle = dark ? "#1E3043" : "#E4EAEC";
  g.fillRect(X0 + 10, 98, X1 - X0 - 20, 12); g.fillRect(X0 + 10, 126, X1 - X0 - 20, 20);
  g.strokeStyle = dark ? "#6D8396" : "#7E8C96"; g.lineWidth = 2; g.lineCap = "round";
  for (const [[x0, y0], [x1, y1]] of segments(XO + 20)) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
  for (const [x, y] of Object.values(SWITCHES)) { g.fillStyle = dark ? "#9FB3C2" : "#3F4A54"; g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill(); }
  g.restore();
}

// ---------------------------------------------------------------- движение по маршруту
interface Vis { route: P[]; cum: number[]; s: number; v: number; len: number; kind: string; seed: number; smoke: number; mode: string; track: number; x: number; y: number; face: boolean; fresh: boolean }
function setRoute(vv: Vis, pts: P[], mode: string) {
  const clean: P[] = [];
  for (const p of pts) { const l = clean[clean.length - 1]; if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 0.5) clean.push(p); }
  vv.route = clean; vv.mode = mode; vv.cum = [0];
  for (let i = 1; i < clean.length; i++) vv.cum.push(vv.cum[i - 1] + Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]));
}
function at(vv: Vis, s: number) {
  const r = vv.route, c = vv.cum;
  let i = 1;
  while (i < r.length - 1 && s > c[i]) i++;
  const [x0, y0] = r[i - 1], [x1, y1] = r[i], L = c[i] - c[i - 1] || 1, k = (s - c[i - 1]) / L;
  return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, ang: Math.atan2(y1 - y0, x1 - x0) };
}
function arrivalRoute(fromSide: string, dir: string, k: number): P[] {
  const y = MAINY[dir];
  return fromSide === "west" ? [[-360, y], [MW, y], [PW, TY[3]], startW(k), endE(k)] : [[LW + 360, y], [ME, y], [PE, TY[3]], endE(k), startW(k)];
}
function departRoute(toSide: string, dir: string, k: number, hx: number): P[] {
  const y = MAINY[dir];
  return toSide === "east" ? [[hx, TY[k]], endE(k), [PE, TY[3]], [ME, y], [LW + 360, y]] : [[hx, TY[k]], startW(k), [PW, TY[3]], [MW, y], [-360, y]];
}

function drawTrain(g: CanvasRenderingContext2D, vv: Vis, opts: { tech: boolean; noLoco?: boolean; night: number }) {
  const carW = 14, locoW = 20, r = rng(vv.seed);
  if (opts.tech) {
    g.strokeStyle = KIND[vv.kind]; g.lineWidth = 7; g.lineCap = "round"; g.beginPath();
    for (let d = 0; d <= vv.len; d += 4) { const p = at(vv, vv.s - d); d === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y); }
    g.stroke();
    const h = at(vv, vv.s); g.fillStyle = "#13232E"; g.beginPath(); g.arc(h.x, h.y, 3, 0, Math.PI * 2); g.fill();
    const tl = at(vv, vv.s - vv.len); g.fillStyle = C.red; g.beginPath(); g.arc(tl.x, tl.y, 2, 0, Math.PI * 2); g.fill();
    return;
  }
  const cars = Math.max(2, Math.round((vv.len - locoW) / (carW + 1)));
  const piece = (s0: number, w: number, fn: () => void) => { const p = at(vv, s0 - w / 2); g.save(); g.translate(p.x, p.y); g.rotate(p.ang); fn(); g.restore(); };
  for (let i = 0; i < cars; i++) {
    const s0 = vv.s - locoW - 1 - i * (carW + 1), h = carW / 2;
    const col = vv.kind === "container" ? C.cont[Math.floor(r() * 4)] : r() < 0.5 ? C.fr1 : C.fr2;
    piece(s0, carW, () => {
      g.fillStyle = "rgba(40,30,20,0.22)"; g.fillRect(-h + 1, 4, carW, 2);
      if (vv.kind === "passenger") { px(g, -h, -5, carW, 9, C.pass); px(g, -h, -1, carW, 2, C.passStripe); for (let w = 0; w < 3; w++) px(g, -h + 2 + w * 4, -4, 2, 2, C.window); }
      else if (vv.kind === "container") { px(g, -h, 2, carW, 2, C.dark); px(g, -h, -4, carW, 6, col); }
      else { px(g, -h, -5, carW, 9, col); px(g, -h, -5, carW, 1, "#C0806A"); }
      if (i === cars - 1) px(g, -h - 1, -1, 2, 2, C.red);                       // хвостовой сигнал
    });
  }
  if (!opts.noLoco) piece(vv.s, locoW, () => {
    const h = locoW / 2;
    px(g, -h, -6, locoW, 11, vv.kind === "passenger" ? C.passLoco : C.locoF);
    px(g, -h + 2, -6, locoW - 4, 2, "rgba(255,255,255,0.18)"); px(g, h - 7, -4, 5, 3, "#CDEAF2"); px(g, -h, 4, locoW, 1, C.dark);
  });
}
function looseLoco(g: CanvasRenderingContext2D, x: number, y: number, dir: number, alpha = 1) {
  g.globalAlpha = alpha; const lx = dir > 0 ? x : x - 20;
  px(g, lx, y - 6, 20, 11, "#3E6A8A"); px(g, lx + 2, y - 6, 16, 2, "rgba(255,255,255,0.18)"); px(g, lx, y + 4, 20, 1, C.dark);
  px(g, dir > 0 ? lx + 13 : lx + 2, y - 4, 5, 3, "#CDEAF2"); g.globalAlpha = 1;
}

// ---------------------------------------------------------------- люди
const CLOTH = ["#5C7FA8", "#A8605C", "#6E8F62", "#8C6FA0", "#C9A04E", "#4F6070"];
function person(g: CanvasRenderingContext2D, x: number, y: number, body: string, step: number, o: { cap?: string; vest?: boolean; arm?: string; lamp?: boolean } = {}) {
  g.save(); g.translate(Math.round(x), Math.round(y)); g.scale(1.5, 1.5);
  g.fillStyle = "rgba(40,30,20,0.25)"; g.fillRect(-1, 3, 4, 1);
  const leg = Math.floor(step) % 2;
  px(g, 0, 1, 1, 2 + leg, "#2E3640"); px(g, 1, 1, 1, 3 - leg, "#2E3640");
  px(g, -0.5, -3, 3, 4, o.vest ? C.vest : body); if (o.vest) px(g, -0.5, -1, 3, 1, "#F5E35A");
  px(g, 0, -5, 2, 2, "#E2BC98"); if (o.cap) px(g, -0.5, -6, 3, 1, o.cap);
  if (o.arm) { px(g, 2, -5, 1, 3, o.vest ? C.vest : body); px(g, 2, -7, 2, 2, o.arm); }
  if (o.lamp) { px(g, 2, -2, 2, 2, Math.floor(step * 2) % 2 ? "#FFF4C2" : "#FFFFFF"); }
  g.restore();
}
const shield = (g: CanvasRenderingContext2D, x: number, y: number) => { px(g, x, y - 7, 1, 7, "#2E3640"); px(g, x - 2, y - 10, 5, 4, C.red); px(g, x - 1, y - 9, 3, 1, "#fff"); };
const tri = (u: number) => 1 - Math.abs((((u % 2) + 2) % 2) - 1);

// ---------------------------------------------------------------- освещение
function daylight(now: number) {
  const h = (now % 86400) / 3600, ramp = (a: number, b: number, v: number) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  const d = h < 12 ? ramp(5.5, 7.5, h) : 1 - ramp(18.5, 20.5, h);
  const dusk = Math.max(0, 1 - Math.abs(h - 19.5) / 1.2) + Math.max(0, 1 - Math.abs(h - 6.5) / 1.2) * 0.7;
  return { d, dusk: Math.min(1, dusk) };
}
interface Puff { x: number; y: number; a: number; r: number }

export default function StationMap({ view, station, t, lang, anim, dayNight, npc, tech, highlight }: {
  view: View; station: Station; t: T; lang: "ru" | "kk"; anim: boolean; dayNight: boolean; npc: boolean; tech: boolean; highlight?: any;
}) {
  const [follow, setFollow] = useState<{ id: string; name: string } | null>(null);
  const [autoCam, setAutoCam] = useState(true);
  const camTgt = useRef<{ z: number; cx: number; cy: number } | null>(null);
  const lastManual = useRef(0), lastPid = useRef<string | null>(null), autoFocused = useRef(false);
  const mini = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const extra = useRef({ highlight, follow, autoCam }); extra.current = { highlight, follow, autoCam };
  const wrap = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const bg = useRef<Record<string, HTMLCanvasElement>>({}), off = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const recvAt = useRef(performance.now());
  const vis = useRef(new Map<string, Vis>()), puffs = useRef<Puff[]>([]);
  const hits = useRef<{ x: number; y: number; w: number; h: number; t: Train }[]>([]);
  const [labels, setLabels] = useState(true);
  const opts = useRef({ anim, dayNight, lang, t, station, npc, tech, labels: true }); opts.current = { anim, dayNight, lang, t, station, npc, tech, labels };
  const [size, setSize] = useState({ w: 1000, h: 400 });
  const [tip, setTip] = useState<{ x: number; y: number; t: Train } | null>(null);
  const [max, setMax] = useState(false);
  const cam = useRef({ z: 1, cx: 0, cy: 0 });
  const geo = useRef({ Wd: LW, Hd: LH, XO: 0, YO: 0 });
  const viewRect = useRef({ sx: 0, sy: 0, sw: LW, sh: LH, XO: 0, YO: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { recvAt.current = performance.now(); }, [view]);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // мир станции 768×300 по центру холста, поле вокруг дорисовывается под пропорции окна
    const W = Math.max(200, Math.floor(size.w)), H = Math.max(120, Math.floor(size.h));
    const Wd = Math.max(LW, Math.round(LH * W / H)), Hd = Math.max(LH, Math.round(LW * H / W));
    const XO = Math.round((Wd - LW) / 2), YO = Math.round((Hd - LH) / 2);
    const mk = (key: string, fn: (g: CanvasRenderingContext2D) => void) => {
      const k = `${key}${Wd}x${Hd}`;
      if (!bg.current[k]) { const c = document.createElement("canvas"); c.width = Wd; c.height = Hd; fn(c.getContext("2d")!); bg.current = { [k]: c }; }
      return bg.current[k];
    };
    const offC = document.createElement("canvas"); offC.width = Wd; offC.height = Hd; off.current = offC;
    const canvas = cv.current!, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    geo.current = { Wd, Hd, XO, YO };
    if (cam.current.z === 1) { cam.current.cx = Wd / 2; cam.current.cy = Hd / 2; }
    let raf = 0, last = performance.now();
    const seedOf = (id: string) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

    const frame = (ts: number) => {
      const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
      const v = viewRef.current, { anim, dayNight, lang, t, station, npc, tech } = opts.current;
      const darkUi = document.documentElement.matches?.(":root") && getComputedStyle(document.documentElement).getPropertyValue("--panel").trim().toLowerCase() !== "#ffffff";
      const now = v.now + (anim ? ((ts - recvAt.current) / 1000) * (v.speed || 1) * 0.9 : 0);
      const sec = ts / 1000, pulse = 0.5 + 0.5 * Math.sin(ts / 260);
      const night = !tech && dayNight ? 1 - daylight(now).d : 0;
      const o = off.current!.getContext("2d")!;
      o.setTransform(1, 0, 0, 1, 0, 0); o.imageSmoothingEnabled = false;
      o.drawImage(tech ? mk(darkUi ? "techD" : "techL", (g) => backgroundTech(g, darkUi, Wd, Hd, XO, YO)) : mk("px", (g) => background(g, Wd, Hd, XO, YO)), 0, 0);
      o.translate(XO, YO);
      const throatOf = (d: string) => station.directions[d]?.throat;
      // закрытые пути и путевые работы
      for (const tr of v.tracks) if (tr.closed_until && tr.closed_until > v.now) {
        const [xa, y] = startW(tr.id), [xb] = endE(tr.id);
        for (let x = xa; x < xb; x += 8) { px(o, x, y - 4, 4, 9, "rgba(217,83,74,0.8)"); px(o, x + 4, y - 4, 4, 9, "rgba(255,255,255,0.7)"); }
        shield(o, xa + 6, y - 2); shield(o, xb - 6, y - 2);
        if (npc && !tech) for (let j = 0; j < 3; j++) person(o, xa + 60 + j * 70 + tri(sec * 0.05 + j) * 30, y + 3, C.vest, sec * 2 + j, { vest: true });
      }
      // подсветка маршрутов: приём — для поезда у сигнала, отправление — для готового
      const routes: { pts: P[]; dir: string }[] = [];
      for (const tr of v.trains) {
        const k = tr.plan_track;
        if ((tr.status === "waiting_signal" || (tr.status === "approaching" && (tr.km ?? 99) < 5)) && k && tr.plan_arr && tr.plan_arr <= v.now + 240
          && !v.tracks.find((x) => x.id === k)?.closed_until) routes.push({ pts: arrivalRoute(throatOf(tr.from)!, tr.from, k).slice(1), dir: tr.from });
        if (tr.status === "on_track" && tr.track && tr.ready && v.now >= tr.ready && tr.exp_dep && tr.exp_dep <= v.now + 180) {
          const hx = throatOf(tr.to) === "east" ? endE(tr.track)[0] - 30 : startW(tr.track)[0] + 30;
          routes.push({ pts: departRoute(throatOf(tr.to)!, tr.to, tr.track, hx).slice(0, -1), dir: tr.to });
        }
      }
      for (const rt of routes) {
        o.strokeStyle = `rgba(72,179,111,${0.35 + 0.25 * pulse})`; o.lineWidth = 6; o.lineCap = "round"; o.lineJoin = "round";
        o.beginPath(); rt.pts.forEach(([x, y], i) => (i ? o.lineTo(x, y) : o.moveTo(x, y))); o.stroke();
      }
      // конфликты
      const confTracks = new Set<number>(), confTrains = new Set<string>();
      for (const c of v.conflicts) { if (c.severity === "info") continue; if (c.track) confTracks.add(c.track); c.trains.forEach((n) => confTrains.add(n)); }
      for (const k of confTracks) { const [xa, y] = startW(k), [xb] = endE(k); o.fillStyle = `rgba(232,194,74,${0.35 + 0.45 * pulse})`; o.fillRect(xa, y - 8, xb - xa, 2); o.fillRect(xa, y + 7, xb - xa, 2); }
      // стрелки: отказ + электромеханик СЦБ
      const repairs: { x: number; y: number; m: number }[] = [];
      for (const sw of v.switches) {
        const [x, y] = SWITCHES[sw.id]; const failed = sw.failed_until && sw.failed_until > v.now;
        if (failed) {
          o.fillStyle = `rgba(217,83,74,${0.5 + 0.5 * pulse})`; o.beginPath(); o.arc(x, y, 4, 0, Math.PI * 2); o.fill();
          if (npc && !tech) person(o, x + 6, y + 11, "#2F4A6E", sec * 1.5, { cap: "#E8C24A", lamp: true });
          repairs.push({ x, y, m: Math.ceil((sw.failed_until! - v.now) / 60) });
        }
      }
      // поезда
      const seen = new Set<string>(), H_: typeof hits.current = [];
      const labels: { x: number; y: number; text: string; warn: boolean; small?: boolean; color?: string }[] = [];
      const stopped: { tr: Train; head: any; tail: any; dir: number; vv: Vis }[] = [];
      for (const tr of v.trains) {
        const from = throatOf(tr.from), to = throatOf(tr.to);
        if (!from || !to) continue;
        let vv = vis.current.get(tr.id);
        const lenPx = Math.min(X1 - X0 - 20, (tr.length / 1050) * 300);
        if (!vv) {
          if (tr.status === "departed" || tr.status === "scheduled") continue;
          vv = { route: [], cum: [], s: 0, v: 0, len: lenPx, kind: tr.kind, seed: seedOf(tr.id), smoke: 0, mode: "", track: 0, x: 0, y: 0, face: true, fresh: true };
          vis.current.set(tr.id, vv);
        }
        seen.add(tr.id);
        let sT = vv.s;
        if (tr.status === "approaching" || tr.status === "waiting_signal") {
          if (vv.mode !== "app") setRoute(vv, from === "west" ? [[-360, MAINY[tr.from]], [MW, MAINY[tr.from]]] : [[LW + 360, MAINY[tr.from]], [ME, MAINY[tr.from]]], "app");
          const km = tr.status === "waiting_signal" ? 0 : Math.min(55, tr.km ?? 55);
          const xT = from === "west" ? MW - 8 - (km / 55) * (MW + 340) : ME + 8 + (km / 55) * (MW + 340);
          sT = Math.abs(xT - vv.route[0][0]);
        } else if (tr.status === "on_track" && tr.track) {
          const k = tr.track;
          if (vv.mode !== "arr" || vv.track !== k) {
            const keep = vv.mode === "app" ? vv.s : null;
            setRoute(vv, arrivalRoute(from, tr.from, k), "arr"); vv.track = k;
            if (keep != null) vv.s = keep;
          }
          const headX = from === "west" ? CX + lenPx / 2 : CX - lenPx / 2;
          const iTrack = vv.route.length - 2;
          sT = vv.cum[iTrack] + Math.abs(headX - vv.route[iTrack][0]);
        } else if (tr.status === "departed") {
          if (vv.mode !== "dep") {
            const hp = at(vv, vv.s), same = (from === "west") === (to === "east"), k = vv.track || 3;
            const headX = same ? hp.x : from === "west" ? hp.x - vv.len : hp.x + vv.len;
            setRoute(vv, departRoute(to, tr.to, k, headX), "dep"); vv.s = 0; vv.v = 0;
          }
          sT = vv.cum[vv.cum.length - 1];
        } else continue;
        if (vv.fresh) vv.s = sT;
        vv.fresh = false;
        vv.len += (lenPx - vv.len) * Math.min(1, dt * 2);
        const dist = sT - vv.s;
        if (!anim) vv.s = sT;
        else if (dist > 0) {
          const boost = Math.max(1, Math.min(8, (v.speed || 1) / 25));
          const vmax = Math.max((vv.mode === "dep" ? 95 : 75) * boost, dist * 1.1), acc = 45 * boost + dist * 0.8;
          vv.v = Math.min(vmax, vv.v + acc * dt, Math.sqrt(2 * acc * dist) + 2);
          vv.s = Math.min(sT, vv.s + vv.v * dt);
        } else { vv.v = 0; vv.s += dist * Math.min(1, dt * 1.5); }
        if (vv.mode === "dep" && vv.s >= sT - 1) { vis.current.delete(tr.id); continue; }
        const head = at(vv, vv.s), mid = at(vv, vv.s - vv.len / 2), tail = at(vv, vv.s - vv.len);
        vv.x = head.x; vv.y = head.y; vv.face = Math.cos(head.ang) > 0;
        const isStopped = tr.status === "on_track" && Math.abs(dist) < 2;
        const stg = isStopped ? stageNow(tr, now) : null;
        const left = tr.ready ? (tr.ready - now) / 60 : 0;
        const detached = !tech && stg === "loco" && left > 20;
        drawTrain(o, vv, { tech, noLoco: detached || (!tech && stg === "loco" && left > 6), night });
        if (isStopped) stopped.push({ tr, head, tail, dir: Math.sign(head.x - tail.x) || 1, vv });
        if (anim && !tech && vv.v > 10 && vv.kind !== "passenger") {
          vv.smoke += dt;
          if (vv.smoke > 0.12) { vv.smoke = 0; puffs.current.push({ x: head.x - Math.cos(head.ang) * 6, y: head.y - 9, a: 0.45, r: 2 }); }
        }
        const minX = Math.min(head.x, tail.x), maxX = Math.max(head.x, tail.x);
        H_.push({ x: minX, y: Math.min(head.y, tail.y) - 8, w: maxX - minX, h: Math.abs(head.y - tail.y) + 16, t: tr });
        if (tr.status === "on_track") labels.push({ x: mid.x, y: mid.y - 10, text: trainName(tr, lang, t), warn: confTrains.has(tr.number) });
        if (isStopped && tr.actual_arr && now - tr.actual_arr < 300) labels.push({ x: mid.x, y: mid.y + 16, text: `✓ ${t("full_train")}`, warn: false, small: true, color: "#2E7D4F" });
        if (isStopped && tr.actual_arr && tr.ready) {
          const p = Math.max(0, Math.min(1, (now - tr.actual_arr) / Math.max(60, tr.ready - tr.actual_arr)));
          px(o, minX, head.y + 7, maxX - minX, 2, "rgba(60,48,30,0.35)"); px(o, minX, head.y + 7, (maxX - minX) * p, 2, p >= 1 ? C.green : C.gold);
        }
      }
      for (const id of [...vis.current.keys()]) if (!seen.has(id)) vis.current.delete(id);
      // операции у стоящих поездов: люди и техника
      for (const st of stopped) {
        const tr = st.tr, k = tr.track!, ty = TY[k], stg = stageNow(tr, now);
        const x0 = Math.min(st.head.x, st.tail.x), x1 = Math.max(st.head.x, st.tail.x), left = tr.ready ? (tr.ready - now) / 60 : 0;
        const side = k === 1 ? -12 : 12, r = rng(st.vv.seed);
        if (!tech && stg === "loco") {
          if (left > 20) looseLoco(o, st.head.x + st.dir * (2 + (30 - left) * 7), ty, st.dir, Math.max(0, (left - 20) / 10));
          else if (left > 6) looseLoco(o, st.head.x + st.dir * (2 + ((left - 6) / 14) * 70), ty, -st.dir);
        }
        if (!npc || tech) continue;
        if (tr.kind === "passenger" && (stg === "boarding" || stg === "arrival" || stg === "crew" || stg === "loco")) {
          const ys = k === 1 ? [104, 130] : k === 2 ? [141] : [];
          for (let i = 0; i < 12 && ys.length; i++) {
            const y = ys[i % ys.length], door = x0 + 6 + Math.floor(r() * ((x1 - x0 - 12) / 15)) * 15, s0 = door + (r() - 0.5) * 90;
            person(o, s0 + (door - s0) * tri(sec * (0.12 + r() * 0.1) + r() * 2), y, CLOTH[i % 6], sec * 4 + i);
          }
        }
        if (stg === "inspection") {
          shield(o, x0 - 5, ty); shield(o, x1 + 5, ty);
          for (let j = 0; j < 2; j++) person(o, x0 + 4 + (x1 - x0 - 8) * tri(sec * 0.08 + j * 0.5), ty + (j ? -side : side) + (j ? -1 : 3), C.vest, sec * 2.5 + j, { vest: true, lamp: night > 0.3 });
        }
        if (stg === "loco") person(o, st.head.x + st.dir * 1, ty + side + 2, C.vest, sec, { vest: true, arm: left < 8 ? "#FFFFFF" : undefined });
        if (stg === "crew") for (let j = 0; j < 2; j++) person(o, st.head.x - st.dir * (6 + j * 7 + tri(sec * 0.3 + j) * 4), ty + side, "#2F4A6E", sec * 3 + j, { cap: "#2F4A6E" });
        if (stg === "brakes") { person(o, st.tail.x - st.dir * 3, ty + side + 2, C.vest, sec * 0.5, { vest: true, lamp: true }); labels.push({ x: (x0 + x1) / 2, y: ty + 16, text: t("sg_brakes"), warn: false, small: true, color: "#8A5A00" }); }
      }
      if (npc && !tech) {
        const dep = v.trains.some((tr) => tr.kind === "passenger" && tr.status === "on_track" && tr.ready && now >= tr.ready);
        person(o, CX + Math.sin(sec * 0.4) * 6, 104, "#23333F", sec * 2, { cap: "#C8352B", arm: dep ? C.green : undefined });
        for (let i = 0; i < 7; i++) { const r = rng(100 + i), x0 = 330 + r() * 110; person(o, x0 + (tri(sec * (0.05 + r() * 0.08) + r() * 2) - 0.5) * 50, i < 4 ? 16 + r() * 6 : 90 + r() * 3, CLOTH[i % 6], sec * 3 + i); }
      }
      // дым
      for (const p of puffs.current) { p.y -= dt * 8; p.x += dt * 4; p.r += dt * 4; p.a -= dt * 0.5; }
      puffs.current = puffs.current.filter((p) => p.a > 0);
      if (!tech) for (const p of puffs.current) { o.fillStyle = `rgba(235,235,230,${p.a})`; o.beginPath(); o.arc(p.x, p.y, p.r, 0, Math.PI * 2); o.fill(); }
      // сигналы: выходные на концах путей, входные у перегонов
      const sigs: { x: number; y: number; on: boolean }[] = [];
      const ready: Record<number, Train> = {};
      v.trains.forEach((tr) => { if (tr.status === "on_track" && tr.track) ready[tr.track] = tr; });
      for (const k of [1, 2, 3, 4, 5]) {
        const tr = ready[k], go = (s: string) => !!(tr && tr.ready && v.now >= tr.ready && throatOf(tr.to) === s);
        sigs.push({ x: startW(k)[0] + 6, y: TY[k] - 11, on: go("west") }, { x: endE(k)[0] - 7, y: TY[k] - 11, on: go("east") });
      }
      for (const [dir, y] of Object.entries(MAINY)) {
        const west = throatOf(dir) === "west";
        sigs.push({ x: west ? MW - 4 : ME + 3, y: y - 11, on: routes.some((r) => r.dir === dir && v.trains.some((tr) => tr.from === dir && tr.status !== "on_track")) });
      }
      for (const s of sigs) { px(o, s.x, s.y + 2, 1, 6, C.dark); px(o, s.x - 1, s.y - 1, 3, 4, C.dark); px(o, s.x, s.y, 1, 2, s.on ? C.green : C.red); }
      hits.current = H_;

      // на экран
      const g = canvas.getContext("2d")!;
      o.setTransform(1, 0, 0, 1, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0); g.imageSmoothingEnabled = false;
      // камера: полёт к месту сбоя, слежение за поездом, плавные переходы
      const ex = extra.current;
      const numToVis = (num: string) => { const tr = v.trains.find((x) => x.number === num); return tr ? vis.current.get(tr.id) : undefined; };
      const locate = (c: any): P => {
        if (!c) return [CX, TY[3]];
        if (c.track) return [CX, TY[c.track]];
        const vv = c.trains?.length ? numToVis(c.trains[0]) : undefined;
        if (vv) return [vv.x, vv.y];
        if (c.throat) return c.throat === "west" ? [PW + 40, TY[3]] : [PE - 40, TY[3]];
        return [CX, TY[3]];
      };
      const pid = v.proposal?.id ?? null;
      if (pid !== lastPid.current) {
        if (pid && ex.autoCam && !ex.follow && Date.now() - lastManual.current > 6000) {
          const [fx, fy] = locate(v.proposal!.conflicts[0]);
          camTgt.current = { z: 2.2, cx: fx + XO, cy: fy + YO }; autoFocused.current = true;
        }
        if (!pid && autoFocused.current) { autoFocused.current = false; setTimeout(() => { if (!extra.current.follow) camTgt.current = { z: 1, cx: Wd / 2, cy: Hd / 2 }; }, 1500); }
        lastPid.current = pid;
      }
      if (ex.follow) {
        const vv = vis.current.get(ex.follow.id);
        if (vv) { const m2 = at(vv, vv.s - vv.len / 2); camTgt.current = { z: Math.max(2.2, camTgt.current?.z ?? cam.current.z), cx: m2.x + XO, cy: m2.y + YO }; }
        else setTimeout(() => setFollow(null), 0);
      }
      if (camTgt.current) {
        const c0 = cam.current, tg = camTgt.current, k = anim ? 1 - Math.exp(-dt * 3) : 1;
        c0.z += (tg.z - c0.z) * k; c0.cx += (tg.cx - c0.cx) * k; c0.cy += (tg.cy - c0.cy) * k;
        if (!ex.follow && Math.abs(tg.z - c0.z) < 0.01 && Math.abs(tg.cx - c0.cx) < 0.5) camTgt.current = null;
      }
      // подсветка места конфликта при наведении на карточку
      if (ex.highlight) {
        o.setTransform(1, 0, 0, 1, XO, YO);
        const [hx, hy] = locate(ex.highlight), rr = 14 + 6 * pulse;
        o.strokeStyle = "rgba(232,194,74,0.95)"; o.lineWidth = 3; o.beginPath(); o.arc(hx, hy, rr, 0, Math.PI * 2); o.stroke();
        o.strokeStyle = "rgba(232,194,74,0.4)"; o.lineWidth = 8; o.beginPath(); o.arc(hx, hy, rr + 6, 0, Math.PI * 2); o.stroke();
        o.setTransform(1, 0, 0, 1, 0, 0);
      }
      const cm = cam.current, sw = Wd / cm.z, sh = Hd / cm.z;
      const sx = Math.max(0, Math.min(Wd - sw, cm.cx - sw / 2)), sy = Math.max(0, Math.min(Hd - sh, cm.cy - sh / 2));
      cm.cx = sx + sw / 2; cm.cy = sy + sh / 2;
      viewRect.current = { sx, sy, sw, sh, XO, YO };
      g.drawImage(off.current!, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const K = canvas.width / sw, Kb = (canvas.width / Wd) * Math.min(1.8, Math.sqrt(cm.z));
      const X = (x: number) => (x + XO - sx) * K, Y = (y: number) => (y + YO - sy) * K;
      const showLabels = opts.current.labels;
      if (!tech && dayNight) {
        const { dusk } = daylight(now);
        if (dusk > 0.01) { g.fillStyle = `rgba(255,150,80,${0.16 * dusk})`; g.fillRect(0, 0, canvas.width, canvas.height); }
        if (night > 0.01) {
          g.fillStyle = `rgba(14,24,58,${0.58 * night})`; g.fillRect(0, 0, canvas.width, canvas.height);
          g.globalCompositeOperation = "lighter";
          const glow = (x: number, y: number, rr: number, c: string, a: number) => {
            const gr = g.createRadialGradient(X(x), Y(y), 0, X(x), Y(y), rr * K);
            gr.addColorStop(0, c.replace("A", String(a))); gr.addColorStop(1, c.replace("A", "0"));
            g.fillStyle = gr; g.fillRect(X(x - rr), Y(y - rr), 2 * rr * K, 2 * rr * K);
          };
          for (let x = X0 + 32; x < X1 - 20; x += 44) { glow(x, 102, 26, "rgba(255,214,140,A)", 0.35 * night); glow(x, 134, 26, "rgba(255,214,140,A)", 0.3 * night); }
          for (const s of sigs) glow(s.x + 0.5, s.y + 1, 6, s.on ? "rgba(90,230,140,A)" : "rgba(255,90,80,A)", 0.7 * night);
          for (const vv of vis.current.values()) glow(vv.x, vv.y - 2, 16, "rgba(255,240,190,A)", 0.45 * night);
          g.globalCompositeOperation = "source-over";
        }
      }
      const label = (text: string, x: number, y: number, op: { size?: number; align?: CanvasTextAlign; color?: string; bg?: string; weight?: number } = {}) => {
        if (!showLabels) return;
        const fs = Math.max(10 * dpr, (op.size ?? 5) * Kb * 2);
        g.font = `${op.weight ?? 600} ${fs}px "IBM Plex Sans", system-ui, sans-serif`; g.textAlign = op.align ?? "center";
        const w = g.measureText(text).width, X0s = X(x), Y0s = Y(y);
        if (op.bg) {
          const pad = fs * 0.3, lx = op.align === "left" ? X0s : op.align === "right" ? X0s - w : X0s - w / 2;
          g.fillStyle = op.bg; g.beginPath(); (g as any).roundRect ? (g as any).roundRect(lx - pad, Y0s - fs * 0.86, w + pad * 2, fs * 1.14, fs * 0.25) : g.rect(lx - pad, Y0s - fs * 0.86, w + pad * 2, fs * 1.14); g.fill();
        }
        g.fillStyle = op.color ?? C.dark; g.fillText(text, X0s, Y0s);
      };
      // табло на вокзале: ближайшие пассажирские
      const pas = v.trains.filter((x) => x.kind === "passenger" && x.status !== "departed").sort((a, b) => (a.exp_dep ?? a.planned_dep) - (b.exp_dep ?? b.planned_dep)).slice(0, 2);
      const bx = 310, by = 52;
      if (showLabels) { g.fillStyle = "rgba(30,42,51,0.94)"; g.beginPath(); (g as any).roundRect ? (g as any).roundRect(X(bx), Y(by - 6), 150 * K, 30 * K, 3 * K) : g.rect(X(bx), Y(by - 6), 150 * K, 30 * K); g.fill(); }
      label(t("board"), bx + 5, by + 1, { size: 2.8, weight: 700, color: "#FFD98A", align: "left" });
      pas.forEach((x, i) => label(`${hhmm(x.exp_dep ?? x.planned_dep)}  ${trainName(x, lang, t)}  · ${t("track").toLowerCase()} ${x.plan_track ?? x.track ?? "—"}`, bx + 5, by + 8 + i * 7, { size: 2.7, weight: 600, color: "#CFE9F2", align: "left" }));
      const kindName: Record<string, string> = { passenger: t("t_passenger"), main: t("t_main"), freight: t("t_freight") };
      for (const tr of station.tracks) {
        const [xa] = startW(tr.id);
        label(`${tr.id}`, xa - 8, TY[tr.id] + 3, { size: 4.4, weight: 700, color: "#fff", bg: "rgba(35,51,63,0.92)" });
        label(`${kindName[tr.kind]} · ${tr.length} м`, xa + 14, TY[tr.id] - 7, { size: 3.2, weight: 600, align: "left", bg: "rgba(247,249,249,0.72)" });
        const vt = v.tracks.find((x) => x.id === tr.id);
        if (vt?.closed_until && vt.closed_until > v.now) label(t("trackwork", { t: hhmm(vt.closed_until) }), endE(tr.id)[0] - 60, TY[tr.id] + 15, { size: 3.4, color: "#fff", bg: "rgba(217,83,74,0.95)" });
      }
      for (const rp of repairs) label(t("repair", { m: rp.m }), rp.x, rp.y + 24, { size: 3.1, color: "#fff", bg: "rgba(47,74,110,0.95)" });
      const dirLabel = (d: string) => { const i = station.directions[d]; return i.km ? `${i[lang]} · ${i.km} км` : i[lang]; };
      const m = (6 * dpr) / K, vl = sx - XO + m, vrr = sx - XO + sw - m;
      const wide = cm.z < 1.6;
      if (wide) label(`← ${dirLabel("south")}`, vl, MAINY.south - 12, { size: 3.6, align: "left", bg: "rgba(247,249,249,0.85)" });
      if (wide) label(`← ${dirLabel("west")}`, vl, MAINY.west + 20, { size: 3.6, align: "left", bg: "rgba(247,249,249,0.85)" });
      if (wide) label(`${dirLabel("north")} →`, vrr, MAINY.north - 12, { size: 3.6, align: "right", bg: "rgba(247,249,249,0.85)" });
      if (wide) label(`${dirLabel("east")} →`, vrr, MAINY.east + 20, { size: 3.6, align: "right", bg: "rgba(247,249,249,0.85)" });
      for (const [id, [x, y]] of Object.entries(SWITCHES)) label(id, x, y + (id.endsWith("1") ? -6 : 12), { size: 2.8, weight: 600, color: tech && darkUi ? "#9FB3C2" : "#3B4A55" });
      // поезда на подходе и у входного сигнала — плашки столбиком в верхних углах
      const appr = v.trains.filter((x) => x.status === "approaching" || x.status === "waiting_signal").sort((a, b) => a.eta - b.eta);
      let wy = 34, ey = 34;
      for (const tr of wide ? appr.slice(0, 8) : []) {
        const west = throatOf(tr.from) === "west";
        const st = tr.status === "waiting_signal" ? t("st_waiting_signal") : `${Math.round(tr.km ?? 0)} км · ${hhmm(tr.eta)} ±${Math.round(tr.eta_unc ?? 0)} ${t("min")}`;
        label(`${west ? "→" : "←"} ${trainName(tr, lang, t)} · ${st}`, west ? vl : vrr, (west ? wy : ey) + (sy - YO),
          { size: 3.1, align: west ? "left" : "right", bg: tr.status === "waiting_signal" ? "rgba(232,194,74,0.95)" : "rgba(35,51,63,0.85)", color: tr.status === "waiting_signal" ? "#13232E" : "#fff" });
        if (west) wy += 9; else ey += 9;
      }
      // мини-карта при увеличении
      if (cm.z > 1.05) {
        const mw = 190 * dpr, mh = mw * Hd / Wd, mx = 12 * dpr, my = canvas.height - mh - 12 * dpr;
        g.save(); g.globalAlpha = 0.92; g.imageSmoothingEnabled = true;
        g.fillStyle = "#13232E"; g.fillRect(mx - 3 * dpr, my - 3 * dpr, mw + 6 * dpr, mh + 6 * dpr);
        g.drawImage(off.current!, 0, 0, Wd, Hd, mx, my, mw, mh);
        g.globalAlpha = 1; g.strokeStyle = "#E8C24A"; g.lineWidth = 2 * dpr;
        g.strokeRect(mx + (sx / Wd) * mw, my + (sy / Hd) * mh, (sw / Wd) * mw, (sh / Hd) * mh); g.restore();
        mini.current = { x: mx / dpr, y: my / dpr, w: mw / dpr, h: mh / dpr };
      } else mini.current = null;
      for (const l of labels) label(l.text, Math.max(vl + 24, Math.min(vrr - 24, l.x)), l.y, { size: l.small ? 3 : 3.6, weight: 700, color: l.color, bg: l.small ? "rgba(247,249,249,0.85)" : l.warn ? "rgba(232,194,74,0.95)" : "rgba(247,249,249,0.92)" });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  const toWorld = (cx: number, cy: number) => {
    const r = cv.current!.getBoundingClientRect(), vr = viewRect.current;
    return { x: vr.sx + ((cx - r.left) / r.width) * vr.sw - vr.XO, y: vr.sy + ((cy - r.top) / r.height) * vr.sh - vr.YO, r };
  };
  const zoomAt = (f: number, cx?: number, cy?: number) => {
    const c = cam.current, vr = viewRect.current, r = cv.current!.getBoundingClientRect();
    const fx = cx == null ? 0.5 : (cx - r.left) / r.width, fy = cy == null ? 0.5 : (cy - r.top) / r.height;
    const wx = vr.sx + fx * vr.sw, wy = vr.sy + fy * vr.sh;
    const z = Math.max(1, Math.min(6, c.z * f)); c.z = z; camTgt.current = null; lastManual.current = Date.now();
    const sw = geo.current.Wd / z, sh = geo.current.Hd / z;
    c.cx = wx - fx * sw + sw / 2; c.cy = wy - fy * sh + sh / 2;
  };
  useEffect(() => {
    const el = cv.current!;
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); };
    el.addEventListener("wheel", wheel, { passive: false });
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setMax(false); setFollow(null); } };
    window.addEventListener("keydown", key);
    return () => { el.removeEventListener("wheel", wheel); window.removeEventListener("keydown", key); };
  }, []);
  const fullscreen = async () => {
    const el = wrap.current!;
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); setMax(false); return; }
    try { await el.requestFullscreen(); } catch { setMax((m) => !m); }
  };
  const onDown = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect(), m = mini.current, lx = e.clientX - r.left, ly = e.clientY - r.top;
    if (m && lx >= m.x && lx <= m.x + m.w && ly >= m.y && ly <= m.y + m.h) {   // щелчок по мини-карте — перейти
      cam.current.cx = ((lx - m.x) / m.w) * geo.current.Wd; cam.current.cy = ((ly - m.y) / m.h) * geo.current.Hd;
      camTgt.current = null; lastManual.current = Date.now(); setFollow(null); return;
    }
    drag.current = { x: e.clientX, y: e.clientY }; downAt.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = downAt.current; drag.current = null; downAt.current = null;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) {           // щелчок по поезду — следить за ним
      const { x, y } = toWorld(e.clientX, e.clientY);
      const h = hits.current.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
      if (h) setFollow({ id: h.t.id, name: trainName(h.t, lang, t) });
    }
  };
  const onMove = (e: React.MouseEvent) => {
    if (drag.current) {
      const r = cv.current!.getBoundingClientRect(), vr = viewRect.current;
      if (downAt.current && Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) < 4) return;
      camTgt.current = null; lastManual.current = Date.now(); if (follow) setFollow(null);
      cam.current.cx -= ((e.clientX - drag.current.x) / r.width) * vr.sw; cam.current.cy -= ((e.clientY - drag.current.y) / r.height) * vr.sh;
      drag.current = { x: e.clientX, y: e.clientY }; setTip(null); return;
    }
    const { x: lx, y: ly, r } = toWorld(e.clientX, e.clientY);
    const h = hits.current.find((h) => lx >= h.x && lx <= h.x + h.w && ly >= h.y && ly <= h.y + h.h);
    setTip(h ? { x: e.clientX - r.left, y: e.clientY - r.top, t: h.t } : null);
  };
  const tt = tip ? view.trains.find((x) => x.id === tip.t.id) ?? tip.t : null;
  return (
    <div className={`map-wrap ${max ? "maxed" : ""}`} ref={wrap}>
      <canvas ref={cv} onMouseMove={onMove} onMouseLeave={() => { setTip(null); drag.current = null; }} onPointerDown={onDown} onPointerUp={onUp}
        onDoubleClick={(e) => zoomAt(1.6, e.clientX, e.clientY)} aria-label="Схема станции" role="img" />
      <div className="map-tools" role="toolbar" aria-label={t("map_tools")}>
        <button onClick={() => zoomAt(1.4)} title={t("zoom_in")} aria-label={t("zoom_in")}>+</button>
        <button onClick={() => zoomAt(1 / 1.4)} title={t("zoom_out")} aria-label={t("zoom_out")}>−</button>
        <button onClick={() => { setFollow(null); lastManual.current = Date.now(); camTgt.current = { z: 1, cx: geo.current.Wd / 2, cy: geo.current.Hd / 2 }; }} title={t("zoom_fit")} aria-label={t("zoom_fit")}>⤢</button>
        <button className={autoCam ? "on" : ""} onClick={() => setAutoCam(!autoCam)} title={t("auto_cam")} aria-pressed={autoCam} aria-label={t("auto_cam")}>◎</button>
        <button className={labels ? "on" : ""} onClick={() => setLabels(!labels)} title={t("labels")} aria-pressed={labels} aria-label={t("labels")}>Aa</button>
        <button onClick={fullscreen} title={t("fullscreen")} aria-label={t("fullscreen")}>⛶</button>
      </div>
      {follow && (
        <div className="follow-badge" role="status">{t("following")}: <b>{follow.name}</b>
          <button onClick={() => { setFollow(null); camTgt.current = { z: 1, cx: geo.current.Wd / 2, cy: geo.current.Hd / 2 }; }} aria-label={t("close")}>✕</button></div>
      )}
      {tt && (
        <div className="tip" style={{ left: tip!.x + 14, top: tip!.y + 10 }}>
          <div className="tip-h">{trainName(tt, lang, t)}</div>
          <div className="muted">№{tt.number} · {t(`k_${tt.kind}`)} · {tt.length} м</div>
          <div>{t(`st_${tt.status}`)}{tt.km != null && tt.status === "approaching" ? ` · ${tt.km.toFixed(1)} км` : ""}</div>
          <div>{t("track")}: {tt.track ?? tt.plan_track ?? "—"} · {t("eta")}: {hhmm(tt.actual_arr ?? tt.exp_arr ?? tt.eta)}{tt.eta_unc ? ` ±${Math.round(tt.eta_unc)} ${t("min")}` : ""} · {t("dep")}: {hhmm(tt.exp_dep ?? tt.planned_dep)}</div>
          {tt.status === "on_track" && <div>{t(`sg_${stageNow(tt, view.now)}`)}</div>}
          <div className={tt.delay_min > 5 ? "warn" : ""}>{t("delay_short", { m: tt.delay_min })}</div>
        </div>
      )}
    </div>
  );
}
