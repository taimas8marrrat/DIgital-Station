// ИИ-планировщик браузерной версии.
// Тот же набор правил, что у CP-SAT в Python-версии; поиск — построитель расписания по очереди поездов
// + локальный поиск (перестановки очереди и выбора путей) с отжигом. Оптимум не гарантируется.
export const INSPECTION_MIN = 40, LOCO_MIN = 30, CREW_MIN = 15;

export function allowedTracks(t: any, tracks: any[], pen: any): Map<number, number> {
  const out = new Map<number, number>();
  const nonstop = (t.ops.stop ?? 0) <= 2;
  for (const tr of tracks) {
    if (t.length > tr.length) continue;
    if (t.kind === "passenger") {
      if (nonstop && (tr.kind === "passenger" || tr.kind === "main")) out.set(tr.id, 0);
      else if (tr.kind === "passenger" && tr.platform) out.set(tr.id, 0);
    } else {
      if (tr.kind === "passenger") continue;
      if (tr.kind === "main") out.set(tr.id, nonstop ? 0 : pen.freight_on_main ?? 5);
      else out.set(tr.id, (nonstop ? pen.through_on_side ?? 3 : 0) + (t.kind === "container" && !nonstop ? pen.container_on_freight ?? 1 : 0));
    }
  }
  return out;
}

const weight = (t: any, cfg: any) => cfg.priority_weight[t.kind] ?? 2;

interface Opts { manual?: boolean; stab: number; minimal?: boolean; forced?: Map<string, number> }

/** Строит расписание, ставя поезда в заданном порядке. Возвращает план и значение цели. */
function decode(p: any, cfg: any, order: any[], o: Opts) {
  const H = p.horizon + 1500, h = p.headway, clear = p.clear, lag = cfg.manual_reaction_lag_min ?? 5;
  const closed: Record<string, number> = p.closed;
  const blocks = new Map<string, number>(p.blocks.map((b: any) => [`${b.throat}|${b.track}`, b.minutes]));
  const caps = p.caps;
  const free = new Map<number, number>(p.tracks.map((t: any) => [t.id, 0]));
  const moves: Record<string, number[]> = { west: [], east: [] };
  const usage: Record<string, Int16Array> = { inspectors: new Int16Array(H + 2200), locos: new Int16Array(H + 2200), crews: new Int16Array(H + 2200) };
  const capOf = (r: string) => Math.max(1, caps[r] ?? 1);
  const throatOk = (th: string, tm: number) => moves[th].every((x) => Math.abs(tm - x) >= h);
  const resOk = (r: string, s: number, e: number) => { const c = capOf(r), u = usage[r]; for (let i = Math.max(0, s); i < e; i++) if (u[i] >= c) return false; return true; };
  const take = (r: string, s: number, e: number) => { const u = usage[r]; for (let i = Math.max(0, s); i < e; i++) u[i]++; };
  const blk = (th: string, k: number) => blocks.get(`${th}|${k}`) ?? 0;
  const findDep = (t: any, d: number, k: number) => {
    const lim = d + 1500;
    while (d < lim) {
      if (d >= blk(t.to_throat, k) && throatOk(t.to_throat, d) && (!t.ops.loco_change || resOk("locos", d - LOCO_MIN, d))
        && (!t.ops.crew_change || resOk("crews", d - CREW_MIN, d))) return d;
      d++;
    }
    return d;
  };
  const commitDep = (t: any, d: number) => {
    moves[t.to_throat].push(d);
    if (t.ops.loco_change) take("locos", d - LOCO_MIN, d);
    if (t.ops.crew_change) take("crews", d - CREW_MIN, d);
  };
  const plan: Record<string, { track: number; arr_rel: number; dep_rel: number }> = {};
  let cost = 0;
  const lateCost = (t: any, d: number) => weight(t, cfg) * 10 * Math.max(0, d - t.pd_rel);
  for (const t of p.trains.filter((t: any) => t.on_track)) {
    const k = t.on_track;
    let d = Math.max(0, t.ready_rel);
    if (t.kind === "passenger") d = Math.max(d, t.pd_rel);
    d = findDep(t, d, k); commitDep(t, d);
    free.set(k, d + clear);
    plan[t.id] = { track: k, arr_rel: t.arr_rel, dep_rel: d };
    cost += lateCost(t, d);
  }
  for (const t of order) {
    const allowed = allowedTracks(t, p.tracks, cfg.track_penalty);
    if (!allowed.size) continue;
    let cand = [...allowed.keys()].sort((a, b) => a - b);
    const forced = o.forced?.get(t.id);
    if (forced != null && allowed.has(forced)) cand = [forced];
    let best: [number, number, number, number] | null = null;
    for (const k of cand) {
      const eta = t.eta_rel;
      let a = Math.max(eta, free.get(k)! + (t.buf ?? 0), closed[String(k)] ?? 0, blk(t.from_throat, k));  // запас на разброс прибытия
      const lim = a + 1500;
      while (a < lim && !(throatOk(t.from_throat, a) && (!t.ops.inspection || resOk("inspectors", a, a + INSPECTION_MIN)))) a++;
      if (o.manual && a > eta) a += lag;
      let d = a + t.dwell;
      if (t.kind === "passenger") d = Math.max(d, t.pd_rel);
      d = findDep(t, d, k);
      let c = lateCost(t, d) + Math.round(cfg.wait_weight * weight(t, cfg) * 10) * (a - eta) + allowed.get(k)!;
      if (t.prev_track != null && t.prev_track !== k) c += o.stab;
      if (o.minimal && t.prev_dep_rel != null) c += 5 * Math.abs(d - t.prev_dep_rel);
      // ручной режим: первый свободный путь (раньше всех можно принять), при равенстве — специализированный
      if (o.manual) c = a * 1000 + allowed.get(k)! * 10 + (k === t.prev_track ? 0 : 1);
      if (!best || c < best[0]) best = [c, k, a, d];
    }
    const [c, k, a, d] = best!;
    cost += c;
    moves[t.from_throat].push(a);
    if (t.ops.inspection) take("inspectors", a, a + INSPECTION_MIN);
    commitDep(t, d);
    free.set(k, d + clear);
    plan[t.id] = { track: k, arr_rel: a, dep_rel: d };
  }
  return { plan, cost };
}

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Локальный поиск с отжигом по очереди поездов и выбору путей. */
function localSearch(p: any, cfg: any, mode: "optimal" | "minimal") {
  const t0 = performance.now();
  const stab = cfg.stability_weight[mode] ?? 1;
  const o: Opts = { stab, minimal: mode === "minimal" };
  const rest = p.trains.filter((t: any) => !t.on_track);
  const starts = [
    [...rest].sort((a, b) => (weight(b, cfg) - weight(a, cfg)) || (a.eta_rel - b.eta_rel)),
    [...rest].sort((a, b) => a.eta_rel - b.eta_rel),
    [...rest].sort((a, b) => a.pd_rel - b.pd_rel),
  ];
  let bestOrder = starts[0], best = decode(p, cfg, bestOrder, o);
  for (const s of starts.slice(1)) { const r = decode(p, cfg, s, o); if (r.cost < best.cost) { best = r; bestOrder = s; } }
  let curOrder = bestOrder, cur = best, forced = new Map<string, number>(), bestForced = forced;
  const rnd = rng(42);
  const budget = (cfg.time_limit_s ?? 0.15) * 1000 * (mode === "minimal" ? 0.7 : 1);
  let iters = 0, T = Math.max(10, cur.cost * 0.05);
  while (performance.now() - t0 < budget && rest.length > 1) {
    iters++;
    const order = [...curOrder];
    const f = new Map(forced);
    const mv = rnd();
    if (mv < 0.5) { const i = Math.floor(rnd() * order.length), j = Math.floor(rnd() * order.length); [order[i], order[j]] = [order[j], order[i]]; }
    else if (mv < 0.8) { const i = Math.floor(rnd() * order.length), [x] = order.splice(i, 1); order.splice(Math.floor(rnd() * order.length), 0, x); }
    else {
      const t = order[Math.floor(rnd() * order.length)];
      const al = [...allowedTracks(t, p.tracks, cfg.track_penalty).keys()];
      if (rnd() < 0.3) f.delete(t.id); else f.set(t.id, al[Math.floor(rnd() * al.length)]);
    }
    const r = decode(p, cfg, order, { ...o, forced: f });
    if (r.cost < cur.cost || rnd() < Math.exp((cur.cost - r.cost) / T)) {
      curOrder = order; cur = r; forced = f;
      if (r.cost < best.cost) { best = r; bestOrder = order; bestForced = f; }
    }
    T *= 0.995;
  }
  void bestOrder; void bestForced;
  return { method: mode, solver: "LocalSearch", status: `${iters} итер.`, solve_ms: Math.round((performance.now() - t0) * 10) / 10, plan: best.plan, cost: best.cost };
}

export function solve(p: any, cfg: any, mode: "optimal" | "minimal" | "heuristic" | "manual") {
  if (mode === "optimal" || mode === "minimal") return localSearch(p, cfg, mode);
  const t0 = performance.now();
  const rest = p.trains.filter((t: any) => !t.on_track);
  const order = mode === "manual" ? [...rest].sort((a, b) => a.eta_rel - b.eta_rel)
    : [...rest].sort((a, b) => (weight(b, cfg) - weight(a, cfg)) || (a.eta_rel - b.eta_rel));
  const r = decode(p, cfg, order, { manual: mode === "manual", stab: 0 });
  return { method: mode, solver: "greedy", status: "FEASIBLE", solve_ms: Math.round((performance.now() - t0) * 10) / 10, plan: r.plan, cost: r.cost };
}

export function planKpi(p: any, res: any) {
  const by = new Map(p.trains.map((t: any) => [t.id, t]));
  let total = 0, pas = 0, mx = 0, wait = 0, changed = 0;
  for (const [id, pl] of Object.entries<any>(res.plan)) {
    const t: any = by.get(id);
    const late = Math.max(0, pl.dep_rel - t.tt_dep_rel);
    total += late; mx = Math.max(mx, late);
    if (t.kind === "passenger") pas += late;
    if (!t.on_track) {
      wait += Math.max(0, pl.arr_rel - t.eta_rel);
      if (t.prev_track != null && t.prev_track !== pl.track) changed++;
    }
  }
  const n = Math.max(1, Object.keys(res.plan).length);
  return { total_delay_min: Math.round(total), passenger_delay_min: Math.round(pas), max_delay_min: Math.round(mx),
    avg_delay_min: Math.round((total / n) * 10) / 10, wait_at_signal_min: Math.round(wait), changed_tracks: changed, trains: n };
}
