import station from "./data/station.json";
import resources from "./data/resources.json";
import timetable from "./data/timetable.json";
import indexCfg from "./data/index.json";
import plannerCfg from "./data/planner.json";

export const STATION: any = station;
export const RESOURCES: any = resources;
export const TIMETABLE: any = timetable;

const load = (k: string, d: any) => {
  try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : structuredClone(d); } catch { return structuredClone(d); }
};
export const CFG = {
  index: load("ds_cfg_index", indexCfg) as any,
  planner: { ...load("ds_cfg_planner", plannerCfg), time_limit_s: 0.15 } as any,
  save(name: "index" | "planner", data: any) {
    (CFG as any)[name] = { ...(CFG as any)[name], ...data };
    try { localStorage.setItem(`ds_cfg_${name}`, JSON.stringify((CFG as any)[name])); } catch { /* */ }
  },
};

const BASE_TRAINS = [...TIMETABLE.trains];
/** Рост потока грузовых: 1.6 добавляет 60 % поездов со сдвигом 15–25 мин (детерминированно). */
export function setLoad(f: number) {
  let s = 5 >>> 0; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const trains = [...BASE_TRAINS];
  if (f > 1) {
    const fr = BASE_TRAINS.filter((t: any) => t.kind !== "passenger").slice().sort(() => r() - 0.5).slice(0, Math.floor(BASE_TRAINS.filter((t: any) => t.kind !== "passenger").length * (f - 1)));
    for (const t of fr) { const sh = 15 + Math.floor(r() * 11), arr = (t.arr + sh) % 1440; trains.push({ ...t, id: t.id + "x", number: String(+t.number + 1000), arr, dep: arr + (t.dep - t.arr) }); }
  }
  TIMETABLE.trains = trains.sort((a: any, b: any) => a.arr - b.arr);
}

export const dwellMin = (ops: any) =>
  Math.max(ops.stop || 0, ops.inspection ? 40 : 0, ops.loco_change ? 30 : 0, ops.crew_change ? 15 : 0);

export const dayStart = (ts: number) => ts - (ts % 86400);

export function instances(tFrom: number, tTo: number) {
  const out: any[] = [];
  let d0 = dayStart(tFrom) - 86400;
  while (d0 < tTo) {
    const d = new Date(d0 * 1000);
    const day = `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    for (const tr of TIMETABLE.trains) {
      const arr = d0 + tr.arr * 60;
      if (arr >= tFrom && arr < tTo) {
        out.push({ ...tr, id: `${tr.id}-${day}`, planned_arr: arr, planned_dep: d0 + tr.dep * 60, dwell: dwellMin(tr.ops) });
      }
    }
    d0 += 86400;
  }
  return out.sort((a, b) => a.planned_arr - b.planned_arr);
}

export const parseSimStart = (s: string) => Date.parse(s + "Z") / 1000;
