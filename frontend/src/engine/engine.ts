// Оркестратор браузерной версии: симулятор -> приём -> двойник -> конфликты -> планировщик -> экран.
import { CFG, parseSimStart, setLoad } from "./data";
import { computeIndex } from "./indexCalc";
import { Normalizer } from "./normalizer";
import { planKpi, solve } from "./planner";
import { World } from "./sim";
import { Twin } from "./twin";

const ACTIONABLE = new Set(["track_closed", "route_blocked", "track_occupied", "route_crossing", "shortage", "waiting_signal", "not_ready"]);
const DEMO_START = "2026-10-01T11:20:00";
const sleep = () => new Promise((r) => setTimeout(r, 0));

export class Engine {
  world: World; norm = new Normalizer(); twin = new Twin();
  conflicts: any[] = []; proposal: any = null; compare: any = null;
  dirty = true; solving = false; lastRoll = 0; lastSrcMs: number | null = null; lastEventWall = 0;
  accepted: string | null = null; dismissed = new Set<string>();
  events: any[] = []; history: { wall_ms: number; view: any }[] = [];
  sourceDownUntil = 0; listeners = new Set<(v: any) => void>(); timers: number[] = [];
  // Умная скорость: спокойно — быстро, при сбое — замедление, пока решение не принято
  auto = true; calmSpeed = 288; slowSpeed = 10; manualSpeed = 30; slowHoldUntil = 0; lastRollSim = 0; incidentWindowUntil = 0;
  autopilot = false; autopilotDelayMs = 2500; lastIncidentWall = 0; lastResolve: { sec: number; at: number; conflicts: number } | null = null;

  load = 1;
  constructor() { this.world = new World(parseSimStart(DEMO_START), 30); }

  /** Демо заново: модель возвращается к 11:20; load 1.6 — рост потока. */
  reset(load = 1) {
    this.load = load > 1.01 ? 1.6 : 1; setLoad(this.load);
    this.world = new World(parseSimStart(DEMO_START), 30); this.norm = new Normalizer(); this.twin = new Twin();
    this.conflicts = []; this.proposal = null; this.compare = null; this.dirty = true; this.accepted = null; this.dismissed = new Set();
    this.events = []; this.history = []; this.autopilot = false; this.auto = true; this.lastResolve = null;
    this.lastRoll = 0; this.lastRollSim = 0; this.incidentWindowUntil = 0; this.slowHoldUntil = 0; this.lastSrcMs = null;
  }

  targetSpeed() {
    if (!this.auto) return this.manualSpeed;
    return this.proposal || Date.now() < this.slowHoldUntil ? this.slowSpeed : this.calmSpeed;
  }

  start() {
    this.timers.push(window.setInterval(() => this.tick(), 250));
    this.timers.push(window.setInterval(() => this.planLoop(), 250));
    this.timers.push(window.setInterval(() => this.emit(), 250));
    this.timers.push(window.setInterval(() => this.persist(), 5000));
    this.tick();
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
  subscribe(fn: (v: any) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private tick() {
    const tgt = this.targetSpeed(), cur = this.world.speed;
    // плавный разгон и торможение
    this.world.speed = Math.abs(tgt - cur) < 1 ? tgt : cur + (tgt - cur) * (tgt < cur ? 0.6 : 0.25);
    const batch = this.world.tick(0.25);
    if (Date.now() < this.sourceDownUntil) return; // имитация обрыва связи с источником
    for (const raw of batch) {
      const ev = this.norm.process(raw);
      if (!ev) continue;
      this.lastEventWall = Date.now();
      if (ev.sent_wall_ms) this.lastSrcMs = ev.sent_wall_ms;
      if (this.twin.apply(ev)) this.dirty = true;
      if (ev.type !== "clock" && ev.type !== "position") { this.events.push(ev); if (this.events.length > 5000) this.events.shift(); }
    }
  }

  private async planLoop() {
    if (this.twin.now == null || this.solving) return;
    this.conflicts = this.twin.conflicts();
    // Мелкие отклонения план поправляет сам; карточка ДСП — при критичном конфликте или после нештатной ситуации
    const afterIncident = Date.now() < this.incidentWindowUntil;
    let actionable = this.conflicts.filter((c) => ACTIONABLE.has(c.type) && !this.dismissed.has(c.key)
      && (c.severity === "critical" || afterIncident));
    const sig = actionable.map((c) => c.key).sort().join("|");
    const needRoll = Date.now() - this.lastRoll > CFG.planner.rolling_replan_s * 1000 || (this.twin.now! - this.lastRollSim) > 600
      || this.conflicts.some((c) => c.type === "unplanned");
    if (sig && sig === this.accepted) actionable = [];
    if (this.autopilot && this.proposal && Date.now() - this.proposal.createdWall >= this.autopilotDelayMs) {
      const n = this.proposal.conflicts.length;
      if (this.accept(this.proposal.id, this.proposal.recommended, "auto") && this.lastIncidentWall)
        this.lastResolve = { sec: Math.round((Date.now() - this.lastIncidentWall) / 100) / 10, at: Date.now(), conflicts: n };
      return;
    }
    if (actionable.length && (!this.proposal || this.proposal.signature !== sig) && (this.dirty || !this.proposal)) await this.makeProposal(actionable, sig);
    else if (!actionable.length && (this.dirty || needRoll)) { this.proposal = null; await this.roll(); }
    this.dirty = false;
  }

  private async roll() {
    this.solving = true;
    try {
      const prob = this.twin.problem();
      const smart = solve(prob, CFG.planner, "minimal");
      await sleep();
      const manual = solve(prob, CFG.planner, "manual");
      this.commit(prob, smart, "rolling");
      this.setCompare(prob, smart, manual);
      this.lastRoll = Date.now(); this.lastRollSim = this.twin.now!;
    } finally { this.solving = false; }
  }

  private async makeProposal(actionable: any[], sig: string) {
    this.solving = true;
    try {
      const t0 = performance.now();
      const prob = this.twin.problem();
      const results: any[] = [];
      for (const m of ["optimal", "minimal", "heuristic", "manual"] as const) { results.push(solve(prob, CFG.planner, m)); await sleep(); }
      // «Оптимальный» — лучший по задержке из найденных планов (поиск стохастический)
      const late = (r: any) => planKpi(prob, r).total_delay_min;
      if (late(results[1]) < late(results[0])) results[0] = { ...results[1], method: "optimal", solve_ms: results[0].solve_ms + results[1].solve_ms };
      const variants = results.slice(0, 3).map((res) => {
        const plan = this.twin.toAbs(prob, res);
        const idx = computeIndex(this.twin, [], plan);
        return { id: res.method, solver: res.solver, status: res.status, solve_ms: res.solve_ms, fallback: false,
          kpi: planKpi(prob, res), index: idx.value, category: idx.category, plan, changes: this.changes(plan) };
      });
      const best = [...variants].sort((a, b) => (b.index - a.index) || (a.kpi.total_delay_min - b.kpi.total_delay_min))[0];
      this.proposal = { id: Math.random().toString(36).slice(2, 10), created: this.twin.now, signature: sig, conflicts: actionable,
        variants, recommended: best.id, total_ms: Math.round(performance.now() - t0), createdWall: Date.now() };
      this.setCompare(prob, results[0], results[3]);
      if (CFG.planner.auto_apply) this.accept(this.proposal.id, best.id, "auto");
    } finally { this.solving = false; }
  }

  private changes(plan: Record<string, any>) {
    const out: any[] = [];
    for (const [id, p] of Object.entries<any>(plan)) {
      const old = this.twin.plan[id], t = this.twin.trains.get(id);
      if (!t) continue;
      if (!old || old.track !== p.track || Math.abs(old.dep - p.dep) >= 120 || Math.abs(old.arr - p.arr) >= 120)
        out.push({ train: t.number, kind: t.kind, track_from: old?.track ?? null, track_to: p.track, arr_from: old?.arr ?? null,
          arr_to: p.arr, dep_from: old?.dep ?? null, dep_to: p.dep });
    }
    return out.sort((a, b) => a.arr_to - b.arr_to);
  }

  private setCompare(prob: any, smart: any, manual: any) {
    this.compare = { smart: planKpi(prob, smart), manual: planKpi(prob, manual),
      smart_index: computeIndex(this.twin, [], this.twin.toAbs(prob, smart)).value,
      manual_index: computeIndex(this.twin, [], this.twin.toAbs(prob, manual)).value };
  }

  private commit(prob: any, res: any, by: string) {
    this.twin.plan = this.twin.toAbs(prob, res);
    this.twin.planMeta = { version: (this.twin.planMeta.version ?? 0) + 1, method: res.method, solver: res.solver, status: res.status,
      solve_ms: res.solve_ms, by, sim_ts: this.twin.now };
    this.twin.advance();
  }

  accept(pid: string, variant: string, by = "dsp") {
    if (!this.proposal || this.proposal.id !== pid) return false;
    const v = this.proposal.variants.find((x: any) => x.id === variant);
    if (!v) return false;
    this.twin.plan = v.plan;
    this.twin.planMeta = { version: (this.twin.planMeta.version ?? 0) + 1, method: v.id, solver: v.solver, status: v.status, solve_ms: v.solve_ms, by, sim_ts: this.twin.now };
    this.twin.note("plan_accepted", { variant: v.id, by, changes: v.changes.length });
    this.events.push({ type: "plan_accepted", ts: this.twin.now, variant: v.id, by });
    this.twin.advance();
    this.accepted = this.proposal.signature; this.proposal = null; this.dirty = true;
    return true;
  }
  reject(pid: string, by = "dsp") {
    if (!this.proposal || this.proposal.id !== pid) return false;
    this.proposal.conflicts.forEach((c: any) => this.dismissed.add(c.key));
    this.twin.note("plan_rejected", { by }); this.proposal = null; return true;
  }

  incident(e: any) {
    this.world.incident(e); this.slowHoldUntil = Date.now() + 4000; this.incidentWindowUntil = Date.now() + 30000;
    this.lastIncidentWall = Date.now(); this.lastResolve = null;
  }

  /** Крупные нештатные ситуации: несколько связанных сбоев сразу. */
  disaster(kind: "derail" | "storm" | "scb") {
    const tw = this.twin;
    const upcoming = (dirs: string[]) => [...tw.trains.values()].filter((t) => (t.status === "scheduled" || t.status === "approaching") && dirs.includes(t.from));
    const evs: any[] = [];
    if (kind === "derail") {
      evs.push({ type: "track_closed", track: 3, minutes: 90 }, { type: "switch_failure", switch: "E2", minutes: 90 },
        { type: "switch_failure", switch: "E3", minutes: 90 }, { type: "resource", resource: "inspectors", delta: -1 });
    } else if (kind === "storm") {
      upcoming(["east"]).slice(0, 4).forEach((t) => evs.push({ type: "delay", train: t.id, minutes: 25 + Math.round(Math.random() * 20) }));
      upcoming(["north"]).slice(0, 2).forEach((t) => evs.push({ type: "delay", train: t.id, minutes: 15 }));
      evs.push({ type: "resource", resource: "crews", delta: -1 });
    } else {
      evs.push({ type: "switch_failure", switch: "W1", minutes: 40 }, { type: "switch_failure", switch: "W2", minutes: 40 },
        { type: "switch_failure", switch: "W3", minutes: 40 });
    }
    evs.forEach((e) => this.incident(e));
    this.twin.note("disaster", { dk: kind });
    return evs.length;
  }
  setSpeed(f: number | "auto") {
    if (f === "auto") { this.auto = true; return; }
    this.auto = false; this.manualSpeed = Math.max(1, Math.min(600, f));
  }
  dropSource(sec: number) { this.sourceDownUntil = Date.now() + sec * 1000; }

  stress(n = 10) {
    const up = [...this.twin.trains.values()].filter((t) => t.status === "scheduled" || t.status === "approaching");
    const on = [...this.twin.trains.values()].filter((t) => t.status === "on_track");
    const pick = (a: any[]) => a[Math.floor(Math.random() * a.length)];
    for (let i = 0; i < n; i++) {
      const r = Math.random();
      if (r < 0.45 && up.length) this.incident({ type: "delay", train: pick(up).id, minutes: pick([10, 15, 25, 40]) });
      else if (r < 0.6) this.incident({ type: "track_closed", track: pick([2, 4, 5]), minutes: pick([30, 60]) });
      else if (r < 0.7) this.incident({ type: "switch_failure", switch: pick(["W3", "E3", "E1"]), minutes: 30 });
      else if (r < 0.85 && on.length) this.incident({ type: "wagon_defect", train: pick(on).id, minutes: 30 });
      else this.incident({ type: "resource", resource: pick(["inspectors", "crews"]), delta: -1 });
    }
  }

  /** Отраслевые показатели за последние 24 ч модели. */
  kpi() {
    const tw = this.twin, now = tw.now!;
    const dep = tw.departed.filter((d) => d.dep >= now - 86400);
    const late = dep.map((d) => Math.max(0, d.dep - d.tt_dep) / 60);
    const onTime = dep.length ? (late.filter((x) => x <= 5).length / dep.length) * 100 : null;
    const st = dep.reduce((a, d) => a + Math.max(0, (d.dep - d.tt_dep) - Math.max(0, (d.signal_since ?? d.arr) - d.tt_arr)) / 3600, 0);
    const fr = dep.filter((d) => d.kind !== "passenger");
    const dwell = fr.length ? fr.reduce((a, d) => a + (d.dep - d.arr) / 3600, 0) / fr.length : null;
    const rate = CFG.index.params.delay_cost_kzt_per_train_hour ?? null;
    return { departed: dep.length, on_time_pct: onTime, station_delay_train_h: st, transit_dwell_h: dwell, rate, cost_kzt: rate ? st * rate : null };
  }

  view(withProposal = true) {
    const tw = this.twin;
    if (tw.now == null) return { type: "state", ready: false };
    const index = computeIndex(tw, this.conflicts);
    return { type: "state", ready: true, now: tw.now, speed: this.world.speed, auto: this.auto, target_speed: this.targetSpeed(), wall_ms: Date.now(), src_wall_ms: this.lastSrcMs,
      sim_connected: Date.now() >= this.sourceDownUntil, stream_age_s: this.lastEventWall ? Math.round((Date.now() - this.lastEventWall) / 100) / 10 : null,
      tracks: [...tw.tracks.keys()].map((k) => ({ id: k, occupant: tw.occupant(k)?.number ?? null, closed_until: tw.closures.get(k) ?? null })),
      switches: [...tw.switchTracks.keys()].map((s) => ({ id: s, failed_until: tw.switchFail.get(s) ?? null })),
      trains: tw.viewTrains(), plan_meta: tw.planMeta, conflicts: this.conflicts, proposal: withProposal ? this.proposal : null,
      load: this.load, index, kpi: this.kpi(), compare: this.compare, autopilot: this.autopilot, autopilot_ms: this.autopilotDelayMs, last_resolve: this.lastResolve, caps: { ...tw.caps }, log: tw.log.slice(0, 25), ingest: { ...this.norm.stats } };
  }
  private emit() { const v = this.view(); this.listeners.forEach((fn) => fn(v)); }
  private persist() {
    if (this.twin.now == null) return;
    this.history.push({ wall_ms: Date.now(), view: JSON.parse(JSON.stringify(this.view(false))) });
    const lim = Date.now() - 2 * 3600 * 1000;
    while (this.history.length && this.history[0].wall_ms < lim) this.history.shift();
  }
  historySince(minutes: number) { const lim = Date.now() - minutes * 60000; return this.history.filter((h) => h.wall_ms >= lim); }
}

export const engine = new Engine();
