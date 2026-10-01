// Индекс эффективности 0–100 (порт Python-версии).
import { CFG } from "./data";
import type { Twin } from "./twin";

const F = ["throughput", "adherence", "conflicts", "track_load", "idle"];
const clamp = (x: number) => Math.max(0, Math.min(100, x));
export const category = (v: number, thr: any) => (v >= thr.norm ? "norm" : v >= thr.attention ? "attention" : "critical");

export function computeIndex(tw: Twin, conflicts: any[], plan?: Record<string, any>) {
  const P = CFG.index.params, W = CFG.index.weights, now = tw.now!;
  plan = plan ?? tw.plan;
  const det: Record<string, [number, any]> = {};
  const depLast = tw.departed.filter((d) => d.dep >= now - 3600);
  const due = tw.departed.filter((d) => d.tt_dep >= now - 3600 && d.tt_dep <= now).length
    + [...tw.trains.values()].filter((t) => t.status !== "departed" && t.planned_dep >= now - 3600 && t.planned_dep <= now).length;
  det.throughput = [clamp(100 * (due === 0 ? 1 : Math.min(1, depLast.length / due))), { done: depLast.length, due }];
  const devs: number[] = [];
  for (const t of tw.active()) { const p = plan[t.id]; if (p) devs.push(Math.max(0, (tw.expected(t, p)[1] - t.planned_dep) / 60)); }
  for (const d of depLast) devs.push(Math.max(0, (d.dep - d.tt_dep) / 60));
  const avg = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : 0;
  det.adherence = [clamp(100 - P.adherence_penalty_per_min * avg), { avg_min: Math.round(avg * 10) / 10 }];
  const crit = conflicts.filter((c) => c.severity === "critical").length, warn = conflicts.filter((c) => c.severity === "warning").length;
  det.conflicts = [clamp(100 - P.conflict_penalty_critical * crit - P.conflict_penalty_warning * warn), { critical: crit, warning: warn }];
  const n = tw.tracks.size, samples: number[] = [];
  for (let s = 0; s < 3600; s += 600) {
    const tm = now + s, busy = new Set<number>();
    for (const [k, u] of tw.closures) if (u > tm) busy.add(k);
    for (const t of tw.active()) { const p = plan[t.id]; if (p) { const [a, d] = tw.expected(t, p); if (a <= tm && tm < d) busy.add(p.track); } }
    samples.push(busy.size / n);
  }
  const u = samples.reduce((a, b) => a + b, 0) / samples.length, ideal = P.track_load_ideal;
  det.track_load = [clamp(u <= ideal ? 100 : 100 - ((u - ideal) / (1 - ideal)) * 100), { load_pct: Math.round(u * 100) }];
  const idle: number[] = [];
  for (const t of tw.active()) {
    const p = plan[t.id];
    if (t.status === "waiting_signal") idle.push(Math.max(0, (Math.max(now, p ? p.arr : now + 1800) - t.signal_since) / 60));
    else if (t.status === "on_track" && p) idle.push(now > t.ready ? Math.max(0, (Math.max(p.dep, now) - Math.max(t.ready, t.kind === "passenger" ? t.planned_dep : 0)) / 60) : 0);
    else if (p) idle.push(Math.max(0, (p.arr - t.eta) / 60));
  }
  const ai = idle.length ? idle.reduce((a, b) => a + b, 0) / idle.length : 0;
  det.idle = [clamp(100 - P.idle_penalty_per_min * ai), { avg_min: Math.round(ai * 10) / 10 }];
  const value = F.reduce((a, f) => a + W[f] * det[f][0], 0);
  const factors = F.map((f) => ({ id: f, score: Math.round(det[f][0]), weight: W[f], contribution: Math.round(W[f] * det[f][0] * 10) / 10,
    loss: Math.round(W[f] * (100 - det[f][0]) * 10) / 10, params: det[f][1] })).sort((a, b) => b.loss - a.loss);
  return { value: Math.round(value), category: category(value, CFG.index.thresholds), factors, thresholds: CFG.index.thresholds };
}
