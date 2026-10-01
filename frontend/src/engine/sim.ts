// Симулятор движения: поток событий 2 Гц с шумом, дублями и битыми сообщениями.
import { instances } from "./data";

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
let uid = 0;
const newId = () => `${Date.now().toString(36)}${(uid++).toString(36)}`;

export class World {
  now: number; speed: number; rnd: () => number; trains = new Map<string, any>(); loadedUntil: number;
  pending: any[] = []; noise = true; randomIncidents = false;
  constructor(start: number, speed: number, seed = 7) {
    this.now = start; this.speed = speed; this.rnd = rng(seed); this.loadedUntil = start; this.load();
  }
  load() {
    const end = this.now + 6 * 3600;
    for (const t of instances(this.loadedUntil, end)) {
      const r = this.rnd();
      const dev = r < 0.7 ? (this.rnd() * 4 - 2) : r < 0.9 ? 5 + this.rnd() * 10 : -5;
      this.trains.set(t.id, { ...t, true_arr: t.planned_arr + dev * 60, signaled: false });
    }
    this.loadedUntil = end;
  }
  ev(type: string, kw: any = {}) { return { id: newId(), ts: this.now, type, sent_wall_ms: Date.now(), ...kw }; }
  incident(e: any) {
    if (e.type === "delay") {
      const t = this.trains.get(e.train);
      if (!t || t.signaled) return;
      t.true_arr += (e.minutes || 0) * 60;
    }
    this.pending.push({ id: newId(), ...e, ts: this.now, sent_wall_ms: Date.now() });
  }
  tick(dt: number) {
    this.now += this.speed * dt;
    if (this.now > this.loadedUntil - 5 * 3600) this.load();
    const out: any[] = [this.ev("clock", { speed_factor: this.speed }), ...this.pending];
    this.pending = [];
    for (const t of [...this.trains.values()]) {
      const left = (t.true_arr - this.now) / 60;
      if (t.signaled) { if (t.true_arr < this.now - 6 * 3600) this.trains.delete(t.id); continue; }
      if (left <= 0) { t.signaled = true; out.push(this.ev("at_signal", { train: t.id })); }
      else if (left <= 40) {
        let km = (left * 80) / 60;
        if (this.noise) km = Math.max(0.1, km + (this.rnd() - 0.5) * 0.8);
        out.push(this.ev("position", { train: t.id, km: Math.round(km * 100) / 100, speed: 80 }));
      }
    }
    if (this.randomIncidents && this.rnd() < 0.004 * this.speed * dt) {
      const far = [...this.trains.values()].filter((t) => !t.signaled && t.true_arr - this.now > 1800);
      if (far.length) {
        const t = far[Math.floor(this.rnd() * far.length)];
        const m = [10, 15, 20][Math.floor(this.rnd() * 3)];
        t.true_arr += m * 60;
        out.push(this.ev("delay", { train: t.id, minutes: m, reason: "random" }));
      }
    }
    if (this.noise) {
      if (this.rnd() < 0.03 && out.length > 1) out.push({ ...out[Math.floor(this.rnd() * out.length)] });
      if (this.rnd() < 0.01) out.push({ id: "bad", type: "position" });
    }
    return out;
  }
}
