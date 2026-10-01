// Приём потока: валидация, дедупликация, отбрасывание запоздавших, EMA-сглаживание координат.
const TYPES = new Set(["clock", "position", "at_signal", "delay", "track_closed", "track_opened", "switch_failure",
  "switch_repaired", "wagon_defect", "resource"]);

export class Normalizer {
  seen = new Set<string>(); order: string[] = []; lastTs = new Map<string, number>(); km = new Map<string, number>();
  stats = { received: 0, accepted: 0, duplicates: 0, invalid: 0, out_of_order: 0 };
  process(raw: any): any | null {
    this.stats.received++;
    if (!raw || typeof raw.id !== "string" || !raw.id || typeof raw.ts !== "number" || raw.ts <= 0 || !TYPES.has(raw.type)
      || (raw.km != null && (raw.km < 0 || raw.km > 500)) || (raw.minutes != null && (raw.minutes < -60 || raw.minutes > 600))) {
      this.stats.invalid++; return null;
    }
    if (this.seen.has(raw.id)) { this.stats.duplicates++; return null; }
    this.seen.add(raw.id); this.order.push(raw.id);
    if (this.order.length > 20000) this.seen.delete(this.order.shift()!);
    const ev = { ...raw };
    if (ev.type === "position" && ev.train) {
      if (ev.ts < (this.lastTs.get(ev.train) ?? 0)) { this.stats.out_of_order++; return null; }
      this.lastTs.set(ev.train, ev.ts);
      const prev = this.km.get(ev.train);
      const sm = prev == null || ev.km > prev + 5 ? ev.km : 0.4 * ev.km + 0.6 * prev;
      this.km.set(ev.train, sm);
      ev.km = Math.round(sm * 100) / 100;
    }
    this.stats.accepted++;
    return ev;
  }
}
