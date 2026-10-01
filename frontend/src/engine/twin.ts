// Цифровой двойник станции (порт Python-версии).
import { CFG, RESOURCES, STATION, instances } from "./data";
import { CREW_MIN, INSPECTION_MIN, LOCO_MIN, allowedTracks } from "./planner";

export class Twin {
  tracks = new Map<number, any>(STATION.tracks.map((t: any) => [t.id, t]));
  dirThroat: Record<string, string> = Object.fromEntries(Object.entries<any>(STATION.directions).map(([k, v]) => [k, v.throat]));
  switchTracks = new Map<string, [string, number[]]>(STATION.switches.map((s: any) => [s.id, [s.throat, s.tracks]]));
  caps: Record<string, number> = Object.fromEntries(Object.entries<any>(RESOURCES).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, v.capacity]));
  now: number | null = null; speed = 1;
  trains = new Map<string, any>(); loadedUntil = 0;
  plan: Record<string, { track: number; arr: number; dep: number }> = {};
  planMeta: any = { version: 0, method: null };
  closures = new Map<number, number>(); switchFail = new Map<string, number>();
  departed: any[] = []; log: any[] = [];

  private load() {
    const now = this.now!;
    const start = Math.max(this.loadedUntil, now - 600), end = now + CFG.planner.horizon_min * 60 + 3600;
    if (end <= this.loadedUntil) return;
    for (const inst of instances(start, end)) {
      if (this.trains.has(inst.id)) continue;
      this.trains.set(inst.id, { ...inst, status: "scheduled", km: null, eta: inst.planned_arr, delay_min: 0, track: null,
        actual_arr: null, actual_dep: null, ready: null, extra_min: 0, from_throat: this.dirThroat[inst.from],
        to_throat: this.dirThroat[inst.to], signal_since: null });
    }
    this.loadedUntil = end;
  }
  note(kind: string, params: any = {}) { this.log.unshift({ ts: this.now, kind, ...params }); this.log.length = Math.min(this.log.length, 60); }

  apply(ev: any): boolean {
    if (ev.type === "clock") { this.now = ev.ts; if (ev.speed_factor) this.speed = ev.speed_factor; this.load(); return this.advance(); }
    if (this.now == null) return false;
    const t = ev.train ? this.trains.get(ev.train) : null;
    switch (ev.type) {
      case "position":
        if (t && (t.status === "scheduled" || t.status === "approaching")) {
          t.status = "approaching"; t.km = ev.km; t.eta = ev.ts + (ev.km / (ev.speed || 80)) * 3600;
        }
        return false;
      case "at_signal":
        if (t && (t.status === "scheduled" || t.status === "approaching")) {
          t.status = "waiting_signal"; t.km = 0; t.eta = ev.ts; t.signal_since = ev.ts; this.advance(); return true;
        }
        return false;
      case "delay":
        if (!t) return false;
        t.delay_min += ev.minutes ?? 0;
        if (t.status === "scheduled") t.eta = t.planned_arr + t.delay_min * 60;
        this.note("delay", { train: t.number, minutes: ev.minutes }); return true;
      case "track_closed":
        if (!this.tracks.has(ev.track)) return false;
        this.closures.set(ev.track, this.now + (ev.minutes ?? 60) * 60);
        this.note("track_closed", { track: ev.track, minutes: ev.minutes }); return true;
      case "track_opened":
        this.closures.delete(ev.track); this.note("track_opened", { track: ev.track }); return true;
      case "switch_failure":
        if (!this.switchTracks.has(ev.switch)) return false;
        this.switchFail.set(ev.switch, this.now + (ev.minutes ?? 45) * 60);
        this.note("switch_failure", { switch: ev.switch, minutes: ev.minutes }); return true;
      case "switch_repaired":
        this.switchFail.delete(ev.switch); this.note("switch_repaired", { switch: ev.switch }); return true;
      case "wagon_defect":
        if (!t) return false;
        t.extra_min += ev.minutes ?? 30;
        if (t.ready) t.ready += (ev.minutes ?? 30) * 60;
        this.note("wagon_defect", { train: t.number, minutes: ev.minutes }); return true;
      case "resource":
        if (!(ev.resource in this.caps)) return false;
        this.caps[ev.resource] = Math.max(1, Math.min(20, this.caps[ev.resource] + (ev.delta ?? 0)));
        this.note("resource", { resource: ev.resource, delta: ev.delta, value: this.caps[ev.resource] }); return true;
    }
    return false;
  }

  closedNow(k: number) { return (this.closures.get(k) ?? 0) > this.now!; }
  blocked(th: string, k: number, at = this.now!) {
    for (const [sw, until] of this.switchFail) { const [t, trs] = this.switchTracks.get(sw)!; if (t === th && trs.includes(k) && until > at) return until; }
    return 0;
  }
  occupant(k: number) { for (const t of this.trains.values()) if (t.status === "on_track" && t.track === k) return t; return null; }

  advance(): boolean {
    let changed = false;
    const now = this.now!;
    for (const [k, u] of [...this.closures]) if (u <= now) { this.closures.delete(k); this.note("track_opened", { track: k }); changed = true; }
    for (const [s, u] of [...this.switchFail]) if (u <= now) { this.switchFail.delete(s); this.note("switch_repaired", { switch: s }); changed = true; }
    for (const t of [...this.trains.values()].sort((a, b) => a.eta - b.eta)) {
      const p = this.plan[t.id];
      if (t.status === "on_track" && p) {
        if (now >= t.ready && now >= p.dep - 30 && !this.blocked(t.to_throat, t.track)) {
          if (t.kind === "passenger" && now < t.planned_dep - 30) continue;
          t.status = "departed"; t.actual_dep = now;
          this.departed.push({ id: t.id, kind: t.kind, tt_dep: t.planned_dep, tt_arr: t.planned_arr, dep: now, arr: t.actual_arr, signal_since: t.signal_since });
          if (this.departed.length > 400) this.departed.shift();
          this.note("departed", { train: t.number, track: t.track }); changed = true;
        }
      } else if (t.status === "waiting_signal" && p) {
        const k = p.track;
        if (now >= p.arr - 30 && !this.occupant(k) && !this.closedNow(k) && !this.blocked(t.from_throat, k)) {
          t.status = "on_track"; t.track = k; t.actual_arr = now;
          t.ready = now + (t.dwell + t.extra_min) * 60;
          this.note("arrived", { train: t.number, track: k }); changed = true;
        }
      }
    }
    for (const [id, t] of [...this.trains]) if (t.status === "departed" && t.actual_dep < now - 7200) { this.trains.delete(id); delete this.plan[id]; }
    return changed;
  }

  active() {
    const hz = this.now! + CFG.planner.horizon_min * 60;
    return [...this.trains.values()].filter((t) => t.status !== "departed" && (t.status === "on_track" || t.status === "waiting_signal" || t.eta <= hz));
  }
  expected(t: any, p: any): [number, number] {
    let arr: number, ready: number;
    if (t.status === "on_track") { arr = t.actual_arr; ready = t.ready; }
    else { arr = Math.max(p.arr, t.eta, this.now!); ready = arr + (t.dwell + t.extra_min) * 60; }
    let dep = Math.max(p.dep, ready);
    if (t.kind === "passenger") dep = Math.max(dep, t.planned_dep);
    return [arr, dep];
  }

  conflicts() {
    const out: any[] = [];
    const now = this.now!, clear = STATION.clear_min * 60, hw = STATION.route_headway_min * 60;
    const exp = new Map<string, [any, any, number, number]>();
    for (const t of this.active()) {
      const p = this.plan[t.id];
      if (!p) { if (t.eta - now < 3600) out.push({ type: "unplanned", severity: "warning", trains: [t.number] }); continue; }
      exp.set(t.id, [t, p, ...this.expected(t, p)]);
    }
    for (const [t, p, a, d] of exp.values()) {
      const k = p.track;
      if (t.status !== "on_track") {
        if ((this.closures.get(k) ?? 0) > a + 60) out.push({ type: "track_closed", severity: "critical", trains: [t.number], track: k });
        if (this.blocked(t.from_throat, k, a + 60)) out.push({ type: "route_blocked", severity: "critical", trains: [t.number], track: k, throat: t.from_throat });
      }
      if (this.blocked(t.to_throat, k, d + 60)) out.push({ type: "route_blocked", severity: "critical", trains: [t.number], track: k, throat: t.to_throat });
      if (t.status === "waiting_signal" && now > p.arr + 120) out.push({ type: "waiting_signal", severity: "warning", trains: [t.number], minutes: Math.round((now - t.signal_since) / 60) });
      if (t.status === "on_track" && now > p.dep + 60 && now < t.ready) out.push({ type: "not_ready", severity: "warning", trains: [t.number], track: k, minutes: Math.round((t.ready - now) / 60) });
      const late = (d - t.planned_dep) / 60;
      if (late > (t.kind === "passenger" ? 5 : 20)) out.push({ type: "late", severity: "info", trains: [t.number], minutes: Math.round(late) });
    }
    const byTrack = new Map<number, [number, number, any][]>();
    for (const [t, p, a, d] of exp.values()) { if (!byTrack.has(p.track)) byTrack.set(p.track, []); byTrack.get(p.track)!.push([a, d, t]); }
    for (const [k, lst] of byTrack) {
      lst.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < lst.length; i++) {
        const [, d1, t1] = lst[i - 1], [a2, , t2] = lst[i];
        if (a2 < d1 + clear - 60) out.push({ type: "track_occupied", severity: t1.kind === "passenger" || t2.kind === "passenger" ? "critical" : "warning",
          trains: [t1.number, t2.number], track: k, minutes: Math.round((d1 + clear - a2) / 60) });
      }
    }
    const moves: Record<string, [number, string][]> = { west: [], east: [] };
    for (const [t, , a, d] of exp.values()) { if (t.status !== "on_track") moves[t.from_throat].push([a, t.number]); moves[t.to_throat].push([d, t.number]); }
    for (const [th, lst] of Object.entries(moves)) {
      lst.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < lst.length; i++) if (lst[i][0] - lst[i - 1][0] < hw - 45 && lst[i][1] !== lst[i - 1][1])
        out.push({ type: "route_crossing", severity: "warning", trains: [lst[i - 1][1], lst[i][1]], throat: th });
    }
    const rdefs: [string, (t: any, a: number, d: number) => [number, number] | null][] = [
      ["inspectors", (t, a) => (t.ops.inspection ? [a, a + INSPECTION_MIN * 60] : null)],
      ["locos", (t, _a, d) => (t.ops.loco_change ? [d - LOCO_MIN * 60, d] : null)],
      ["crews", (t, _a, d) => (t.ops.crew_change ? [d - CREW_MIN * 60, d] : null)],
    ];
    for (const [res, mk] of rdefs) {
      const ivs: [number, number, string][] = [];
      for (const [t, , a, d] of exp.values()) { const iv = mk(t, a, d); if (iv && iv[1] > now) ivs.push([iv[0] + 45, iv[1] - 45, t.number]); }
      for (const x of [...new Set(ivs.map((i) => i[0]))].sort((a, b) => a - b)) {
        const cur = ivs.filter((iv) => iv[0] <= x && x < iv[1]);
        if (cur.length > this.caps[res]) { out.push({ type: "shortage", severity: "warning", resource: res, trains: cur.map((c) => c[2]), need: cur.length, have: this.caps[res] }); break; }
      }
    }
    const uniq = new Map<string, any>();
    for (const c of out) { c.key = [c.type, ...[...c.trains].sort(), c.track ?? "", c.resource ?? ""].join("|"); uniq.set(c.key, c); }
    const ord: any = { critical: 0, warning: 1, info: 2 };
    return [...uniq.values()].sort((a, b) => ord[a.severity] - ord[b.severity]);
  }

  problem() {
    const now = this.now!;
    const trains: any[] = [];
    for (const t of this.active()) {
      const p = this.plan[t.id];
      const item: any = { id: t.id, number: t.number, kind: t.kind, length: t.length, ops: t.ops, dwell: t.dwell + t.extra_min,
        from_throat: t.from_throat, to_throat: t.to_throat, pd_rel: Math.round((t.planned_dep - now) / 60),
        tt_dep_rel: Math.round((t.planned_dep - now) / 60), eta_rel: Math.max(0, Math.round((t.eta - now) / 60)),
        prev_track: p ? p.track : null, prev_dep_rel: p ? Math.round((p.dep - now) / 60) : null,
        buf: Math.round(Math.min(5, this.etaUnc(t) / 2)) };
      if (t.status === "on_track") Object.assign(item, { on_track: t.track, arr_rel: Math.round((t.actual_arr - now) / 60), ready_rel: Math.round((t.ready - now) / 60) });
      else {
        if (t.status === "waiting_signal") item.eta_rel = 0;
        if (!allowedTracks(item, STATION.tracks, CFG.planner.track_penalty).size) continue;
      }
      trains.push(item);
    }
    const blocks: any[] = [];
    for (const [sw, until] of this.switchFail) { const [th, trs] = this.switchTracks.get(sw)!; for (const k of trs) blocks.push({ throat: th, track: k, minutes: Math.max(0, Math.round((until - now) / 60)) }); }
    return { now, horizon: CFG.planner.horizon_min, tracks: STATION.tracks,
      closed: Object.fromEntries([...this.closures].map(([k, v]) => [String(k), Math.max(0, Math.round((v - now) / 60))])),
      blocks, caps: { ...this.caps }, trains, headway: STATION.route_headway_min, clear: STATION.clear_min };
  }
  toAbs(p: any, res: any) {
    return Object.fromEntries(Object.entries<any>(res.plan).map(([id, x]) => [id, { track: x.track, arr: p.now + x.arr_rel * 60, dep: p.now + x.dep_rel * 60 }]));
  }

  /** Неопределённость прибытия, мин: растёт с расстоянием до станции. */
  etaUnc(t: any) {
    if (t.status === "on_track" || t.status === "departed" || t.status === "waiting_signal") return 0;
    if (t.status === "scheduled") return 5;
    return Math.round((1 + 0.06 * Math.max(0, (t.eta - this.now!) / 60)) * 10) / 10;
  }

  viewTrains() {
    const now = this.now!, out: any[] = [];
    for (const t of this.trains.values()) {
      if (t.status === "departed" && t.actual_dep < now - 3600) continue;
      if (t.status === "scheduled" && t.eta > now + 4 * 3600) continue;
      const p = this.plan[t.id];
      const exp = p && t.status !== "departed" ? this.expected(t, p) : [null, null];
      out.push({ id: t.id, number: t.number, kind: t.kind, from: t.from, to: t.to, length: t.length, status: t.status, km: t.km, eta: t.eta,
        planned_arr: t.planned_arr, planned_dep: t.planned_dep, plan_track: p?.track ?? null, plan_arr: p?.arr ?? null, plan_dep: p?.dep ?? null,
        exp_arr: exp[0], exp_dep: exp[1], track: t.track, actual_arr: t.actual_arr, actual_dep: t.actual_dep, ready: t.ready, ops: t.ops,
        dwell: t.dwell + t.extra_min, eta_unc: this.etaUnc(t), delay_min: Math.round(((exp[1] ?? t.actual_dep ?? t.planned_dep) - t.planned_dep) / 60) });
    }
    return out;
  }
}
