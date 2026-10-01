// Технологические этапы обработки поезда на станции (общие для схемы и панели).
import type { Train } from "./types";
import type { T } from "./i18n";

export type Stage = "arrival" | "inspection" | "loco" | "crew" | "brakes" | "boarding" | "ready" | "stop";

export function chain(tr: Train): Stage[] {
  const out: Stage[] = ["arrival"];
  if (tr.kind === "passenger") out.push("boarding");
  if (tr.ops.inspection) out.push("inspection");
  if (tr.ops.loco_change) out.push("loco");
  if (tr.ops.crew_change) out.push("crew");
  if (tr.kind !== "passenger" || tr.ops.loco_change) out.push("brakes");
  out.push("ready");
  return out;
}

/** Текущий этап по сим-времени. */
export function stageNow(tr: Train, now: number): Stage {
  if (!tr.actual_arr || !tr.ready) return "arrival";
  if (now >= tr.ready) return "ready";
  const el = (now - tr.actual_arr) / 60, left = (tr.ready - now) / 60;
  const c = chain(tr);
  if (el < 1.5) return "arrival";
  if (c.includes("brakes") && left < 8) return "brakes";
  if (c.includes("loco") && left < 30) return "loco";
  if (c.includes("crew") && left < 15) return "crew";
  if (c.includes("inspection") && el < 40) return "inspection";
  if (tr.kind === "passenger") return "boarding";
  return "stop";
}

const SHORT: Record<string, Record<string, string>> = {
  ru: { south: "Алматы", west: "Мойынты", north: "Семей", east: "Достык" },
  kk: { south: "Алматы", west: "Мойынты", north: "Семей", east: "Достық" },
};
export function trainName(tr: { kind: string; from: string; to: string }, lang: string, t: T) {
  const d = SHORT[lang] ?? SHORT.ru;
  if (tr.kind === "passenger") return `${d[tr.from]} — ${d[tr.to]}`;
  return `${t(`ks_${tr.kind}`)} · ${d[tr.from]} → ${d[tr.to]}`;
}
