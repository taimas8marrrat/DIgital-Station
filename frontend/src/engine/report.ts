// Мини-отчёт: CSV и PDF (генерируются в браузере).
import { jsPDF } from "jspdf";
import fontUrl from "./data/DejaVuSans.ttf?inline";
import type { Engine } from "./engine";
import { CFG } from "./data";

const hh = (ts: number | null | undefined) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const CAT: any = { norm: "Норма", attention: "Внимание", critical: "Критично" };
const FACT: any = { throughput: "Пропускная способность", adherence: "Соблюдение графика", conflicts: "Конфликты", track_load: "Загрузка путей", idle: "Простой ресурсов" };
const ST: any = { scheduled: "по графику", approaching: "на подходе", waiting_signal: "у входного сигнала", on_track: "на пути", departed: "отправлен" };

export function buildCsv(e: Engine, minutes = 15) {
  const v: any = e.view(false), rows: string[][] = [["Раздел", "Время (сим)", "Показатель", "Значение", "Детали"]];
  for (const h of e.historySince(minutes)) rows.push(["Индекс", hh(h.view.now), "Индекс эффективности", String(h.view.index.value), CAT[h.view.index.category]]);
  for (const t of v.trains) rows.push(["Поезд", hh(t.exp_arr ?? t.planned_arr), t.number, ST[t.status], `путь ${t.track ?? t.plan_track ?? "—"}; отклонение ${t.delay_min} мин`]);
  const lim = (v.now ?? 0) - minutes * 60 * Math.max(1, v.speed);
  for (const ev of e.events.filter((x) => x.ts >= lim)) rows.push(["Событие", hh(ev.ts), ev.type, "", JSON.stringify(ev)]);
  return "\ufeff" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

export function buildPdf(e: Engine, minutes = 15): Blob {
  const v: any = e.view(false);
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.addFileToVFS("DejaVuSans.ttf", fontUrl.split(",")[1]);
  doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
  doc.setFont("DejaVu");
  let y = 50;
  const line = (txt: string, size = 9, gap = 13) => { if (y > 800) { doc.addPage(); y = 50; } doc.setFontSize(size); doc.text(txt, 40, y); y += gap; };
  line("Цифровая станция Актогай — мини-отчёт", 16, 24);
  line(`Период: последние ${minutes} мин. Сим-время: ${hh(v.now)}. Данные: модель (mock). Планировщик: браузерная версия.`);
  y += 6;
  line(`Индекс эффективности: ${v.index.value} — ${CAT[v.index.category]}`, 12, 18);
  for (const f of v.index.factors) line(`${FACT[f.id]}: ${f.score} × ${f.weight}  (потеря ${f.loss} балла)`);
  const hs = e.historySince(minutes).map((h) => h.view.index.value);
  if (hs.length) line(`Динамика индекса: мин ${Math.min(...hs)}, макс ${Math.max(...hs)}, точек ${hs.length}`);
  if (v.compare) {
    y += 6; line("Вручную / Цифровая станция (текущий горизонт)", 12, 18);
    line(`Суммарная задержка, мин: ${v.compare.manual.total_delay_min} / ${v.compare.smart.total_delay_min}`);
    line(`Ожидание у сигнала, мин: ${v.compare.manual.wait_at_signal_min} / ${v.compare.smart.wait_at_signal_min}`);
    line(`Прогноз индекса: ${v.compare.manual_index} / ${v.compare.smart_index}`);
  }
  y += 6; line("Конфликты", 12, 18);
  if (!v.conflicts.length) line("Конфликтов нет");
  for (const c of v.conflicts) line(`${c.severity} · ${c.type} · поезда ${c.trains.join(", ")}${c.track ? " · путь " + c.track : ""}`);
  y += 6; line("Поезда", 12, 18);
  for (const t of v.trains.slice(0, 40))
    line(`№${t.number} · ${t.kind} · ${ST[t.status]} · путь ${t.track ?? t.plan_track ?? "—"} · приб. ${hh(t.actual_arr ?? t.exp_arr)} · отпр. ${hh(t.actual_dep ?? t.exp_dep)} · откл. ${t.delay_min} мин`);
  y += 6; line("Нештатные ситуации и действия", 12, 18);
  const ev = e.events.slice(-40);
  if (!ev.length) line("Событий нет");
  for (const x of ev) line(`${hh(x.ts)} · ${x.type} · ${["train", "track", "switch", "minutes", "resource", "delta", "variant"].filter((k) => x[k] != null).map((k) => `${k}=${x[k]}`).join(", ")}`);
  return doc.output("blob");
}

export async function saveFile(filename: string, data: string | Blob) {
  const c: any = (window as any).claude;
  const dl = c?.use ? await c.use("downloads").catch(() => null) : null;
  if (dl) { await dl.save({ filename, data }); return; }
  const blob = typeof data === "string" ? new Blob([data], { type: "text/csv;charset=utf-8" }) : data;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Отчёт для руководства: одна страница — показатели, эффект, ЧС и решения за смену. */
export function buildExecPdf(e: Engine, effect: any): Blob {
  const v: any = e.view(false), k = v.kpi ?? {};
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.addFileToVFS("DejaVuSans.ttf", fontUrl.split(",")[1]); doc.addFont("DejaVuSans.ttf", "DejaVu", "normal"); doc.setFont("DejaVu");
  const W = 595;
  doc.setFillColor(19, 35, 46); doc.rect(0, 0, W, 96, "F");
  doc.setTextColor(232, 194, 74); doc.setFontSize(10); doc.text("ЦИФРОВАЯ СТАНЦИЯ АКТОГАЙ · ОТЧЁТ ДЛЯ РУКОВОДСТВА", 40, 36);
  doc.setTextColor(255, 255, 255); doc.setFontSize(22); doc.text(`Смена: модельное время ${hh(v.now)}`, 40, 66);
  doc.setFontSize(9); doc.setTextColor(185, 205, 214); doc.text("Данные — модель (mock). Система поддержки решений: предлагает, решает ДСП.", 40, 84);
  const card = (x: number, y: number, w: number, title: string, val: string, note = "") => {
    doc.setFillColor(242, 244, 241); doc.roundedRect(x, y, w, 74, 6, 6, "F");
    doc.setTextColor(90, 107, 118); doc.setFontSize(9); doc.text(title, x + 12, y + 20);
    doc.setTextColor(19, 35, 46); doc.setFontSize(20); doc.text(val, x + 12, y + 48);
    if (note) { doc.setFontSize(8); doc.setTextColor(90, 107, 118); doc.text(note, x + 12, y + 64); }
  };
  const f1 = (x: number | null | undefined, d = 1) => (x == null ? "—" : x.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d }));
  card(40, 120, 160, "Индекс эффективности", `${v.index.value} · ${CAT[v.index.category]}`);
  card(217, 120, 160, "Выполнение графика", k.on_time_pct == null ? "—" : `${f1(k.on_time_pct, 0)} %`, "за 24 ч модели");
  card(394, 120, 160, "Задержки по вине станции", `${f1(k.station_delay_train_h)} п-ч`, "за 24 ч модели");
  const b = effect.base, g = effect.growth;
  const yr = (x: any) => (x.station_delay_train_h.manual - x.station_delay_train_h.smart) * 365;
  const wt = (x: any) => ((x.wait_signal_min.manual - x.wait_signal_min.smart) / 60) * 365;
  doc.setTextColor(19, 35, 46); doc.setFontSize(13); doc.text("Эффект за год (по 10 сценариям суток модели)", 40, 230);
  const rate = CFG.index.params.delay_cost_kzt_per_train_hour ?? null;
  const rows = [["", "Текущий поток", "Рост потока ×1,6"],
    ["Задержки по вине станции", `−${f1(yr(b), 0)} поездо-ч`, `−${f1(yr(g), 0)} поездо-ч`],
    ["Ожидание у входного сигнала", `−${f1(wt(b), 0)} поездо-ч`, `−${f1(wt(g), 0)} поездо-ч`],
    ["Потери (условная ставка)", rate ? `−${f1(yr(b) * rate / 1e6, 1)} млн ₸` : "ставка не задана", rate ? `−${f1(yr(g) * rate / 1e6, 1)} млн ₸` : "ставка не задана"]];
  let y = 252;
  rows.forEach((r, i) => {
    if (i === 0) { doc.setFillColor(220, 227, 225); doc.rect(40, y - 14, 515, 22, "F"); }
    doc.setFontSize(10); doc.setTextColor(19, 35, 46); doc.text(r[0], 48, y); doc.text(r[1], 270, y); doc.text(r[2], 420, y); y += 24;
  });
  doc.setFontSize(13); doc.text("Нештатные ситуации и решения за смену", 40, y + 20); y += 42;
  const evs = e.events.filter((x: any) => !["clock", "position", "at_signal"].includes(x.type)).slice(-14);
  doc.setFontSize(9.5);
  if (!evs.length) { doc.text("Нештатных ситуаций не было", 48, y); y += 16; }
  for (const x of evs) {
    const what = x.type === "plan_accepted" ? `Принят план «${x.variant}» (${x.by === "auto" ? "автопилот" : x.by})`
      : `${x.type}${x.track ? " · путь " + x.track : ""}${x.switch ? " · стрелка " + x.switch : ""}${x.minutes ? " · " + x.minutes + " мин" : ""}`;
    doc.text(`${hh(x.ts)}   ${what}`, 48, y); y += 15; if (y > 780) break;
  }
  doc.setFontSize(8); doc.setTextColor(90, 107, 118);
  doc.text("Сравнение «вручную»: очередь по прибытию, первый свободный путь, 5 мин на реакцию. Ставка поездо-часа — условная, задаёт заказчик.", 40, 810);
  return doc.output("blob");
}
