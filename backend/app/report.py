"""Мини-отчёт за последние N минут: CSV и PDF."""
import csv
import io
import json
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .config import FONT_DIR

pdfmetrics.registerFont(TTFont("DejaVu", str(FONT_DIR / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(FONT_DIR / "DejaVuSans-Bold.ttf")))

CAT = {"norm": "Норма", "attention": "Внимание", "critical": "Критично"}
FACT = {"throughput": "Пропускная способность", "adherence": "Соблюдение графика", "conflicts": "Конфликты",
        "track_load": "Загрузка путей", "idle": "Простой ресурсов"}
STATUS = {"scheduled": "по графику", "approaching": "на подходе", "waiting_signal": "у входного сигнала",
          "on_track": "на пути", "departed": "отправлен"}


def hhmm(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M") if ts else "—"


def build_csv(series, view, events) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Раздел", "Время (сим)", "Показатель", "Значение", "Детали"])
    for wall, sim, val, cat in series:
        w.writerow(["Индекс", hhmm(sim), "Индекс эффективности", val, CAT.get(cat, cat)])
    for t in view.get("trains", []):
        w.writerow(["Поезд", hhmm(t.get("exp_arr") or t.get("planned_arr")), t["number"], STATUS.get(t["status"]),
                    f"путь {t.get('track') or t.get('plan_track') or '—'}; отклонение {t.get('delay_min')} мин"])
    for wall, sim, typ, payload in events:
        w.writerow(["Событие", hhmm(sim), typ, "", payload])
    return "\ufeff" + buf.getvalue()


def build_pdf(series, view, events, minutes) -> bytes:
    out = io.BytesIO()
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36)
    h1 = ParagraphStyle("h1", fontName="DejaVu-Bold", fontSize=16, leading=20, spaceAfter=6)
    h2 = ParagraphStyle("h2", fontName="DejaVu-Bold", fontSize=11, leading=14, spaceBefore=10, spaceAfter=4)
    p = ParagraphStyle("p", fontName="DejaVu", fontSize=9, leading=12)
    idx = view.get("index") or {}
    el = [Paragraph("Цифровая станция Актогай — мини-отчёт", h1),
          Paragraph(f"Период: последние {minutes:g} мин. Сим-время: {hhmm(view.get('now'))}. "
                    f"Данные: mock (обезличенные).", p),
          Paragraph(f"Индекс эффективности: <b>{idx.get('value', '—')}</b> — {CAT.get(idx.get('category'), '')}", h2)]
    rows = [["Фактор", "Оценка", "Вес", "Потеря баллов"]]
    for f in idx.get("factors", []):
        rows.append([FACT.get(f["id"], f["id"]), f["score"], f["weight"], f["loss"]])
    el.append(_table(rows))
    if series:
        vals = [r[2] for r in series]
        el.append(Paragraph(f"Динамика индекса: мин {min(vals):.0f}, макс {max(vals):.0f}, "
                            f"последнее {vals[-1]:.0f} (точек: {len(vals)}).", p))
    cmp_ = view.get("compare")
    if cmp_:
        el.append(Paragraph("Сравнение: ручное планирование vs цифровая станция (текущий горизонт)", h2))
        el.append(_table([["Показатель", "Вручную", "Цифровая станция"],
                          ["Суммарная задержка, мин", cmp_["manual"]["total_delay_min"], cmp_["smart"]["total_delay_min"]],
                          ["Задержка пассажирских, мин", cmp_["manual"]["passenger_delay_min"], cmp_["smart"]["passenger_delay_min"]],
                          ["Ожидание у сигнала, мин", cmp_["manual"]["wait_at_signal_min"], cmp_["smart"]["wait_at_signal_min"]],
                          ["Прогноз индекса", cmp_["manual_index"], cmp_["smart_index"]]]))
    el.append(Paragraph("Конфликты", h2))
    cr = [["Тип", "Важность", "Поезда"]] + [[c["type"], c["severity"], ", ".join(c["trains"])] for c in view.get("conflicts", [])]
    el.append(_table(cr if len(cr) > 1 else [["Конфликтов нет"]]))
    el.append(Paragraph("Поезда", h2))
    tr = [["Поезд", "Тип", "Статус", "Путь", "Приб.", "Отпр.", "Откл., мин"]]
    for t in view.get("trains", [])[:40]:
        tr.append([t["number"], t["kind"], STATUS.get(t["status"], t["status"]), t.get("track") or t.get("plan_track") or "—",
                   hhmm(t.get("actual_arr") or t.get("exp_arr")), hhmm(t.get("actual_dep") or t.get("exp_dep")), t["delay_min"]])
    el.append(_table(tr))
    el.append(Paragraph("Нештатные ситуации и действия", h2))
    er = [["Время", "Событие", "Данные"]]
    for wall, sim, typ, payload in events[-40:]:
        d = json.loads(payload)
        er.append([hhmm(sim), typ, ", ".join(f"{k}={v}" for k, v in d.items() if k in ("train", "track", "switch", "minutes", "resource", "delta"))])
    el.append(_table(er if len(er) > 1 else [["Событий нет"]]))
    doc.build(el)
    return out.getvalue()


def _table(rows):
    t = Table(rows, repeatRows=1)
    t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), "DejaVu"), ("FONTNAME", (0, 0), (-1, 0), "DejaVu-Bold"),
                           ("FONTSIZE", (0, 0), (-1, -1), 8), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DCE9EE")),
                           ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#9FB3BC")),
                           ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    return t


def build_exec_pdf(view, events, effect, rate) -> bytes:
    """Отчёт для руководства: одна страница — показатели, эффект за год, ЧС и решения за смену."""
    out = io.BytesIO()
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=40, rightMargin=40, topMargin=36, bottomMargin=36)
    h1 = ParagraphStyle("h1", fontName="DejaVu-Bold", fontSize=18, leading=22, spaceAfter=4)
    h2 = ParagraphStyle("h2", fontName="DejaVu-Bold", fontSize=12, leading=15, spaceBefore=12, spaceAfter=6)
    p = ParagraphStyle("p", fontName="DejaVu", fontSize=9, leading=12, textColor=colors.HexColor("#4E6170"))
    k = view.get("kpi") or {}
    idx = view.get("index") or {}

    def f1(x, d=1):
        return "—" if x is None else f"{x:,.{d}f}".replace(",", " ").replace(".", ",")
    el = [Paragraph("Цифровая станция Актогай — отчёт для руководства", h1),
          Paragraph(f"Модельное время {hhmm(view.get('now'))}. Данные — модель (mock). Система предлагает, решает ДСП.", p),
          Paragraph("Показатели", h2),
          _table([["Индекс эффективности", "Выполнение графика", "Задержки по вине станции"],
                  [f"{idx.get('value', '—')} · {CAT.get(idx.get('category'), '')}",
                   "—" if k.get("on_time_pct") is None else f"{f1(k['on_time_pct'], 0)} %",
                   f"{f1(k.get('station_delay_train_h'))} поездо-ч"]])]
    b, g = effect["base"], effect["growth"]

    def yr(x):
        return (x["station_delay_train_h"]["manual"] - x["station_delay_train_h"]["smart"]) * 365

    def wt(x):
        return (x["wait_signal_min"]["manual"] - x["wait_signal_min"]["smart"]) / 60 * 365
    money = (lambda x: f"−{f1(yr(x) * rate / 1e6)} млн ₸") if rate else (lambda x: "ставка не задана")
    el += [Paragraph("Эффект за год (по 10 сценариям суток модели)", h2),
           _table([["", "Текущий поток", "Рост потока ×1,6"],
                   ["Задержки по вине станции", f"−{f1(yr(b), 0)} поездо-ч", f"−{f1(yr(g), 0)} поездо-ч"],
                   ["Ожидание у входного сигнала", f"−{f1(wt(b), 0)} поездо-ч", f"−{f1(wt(g), 0)} поездо-ч"],
                   ["Потери (условная ставка)", money(b), money(g)]]),
           Paragraph("Нештатные ситуации и решения за смену", h2)]
    rows = [["Время", "Событие"]]
    for wall, sim, typ, payload in events[-14:]:
        d = json.loads(payload)
        rows.append([hhmm(sim), ", ".join([typ] + [f"{kk}={vv}" for kk, vv in d.items() if kk in ("train", "track", "switch", "minutes", "variant", "by")])])
    el.append(_table(rows if len(rows) > 1 else [["Нештатных ситуаций не было"]]))
    el.append(Spacer(1, 10))
    el.append(Paragraph("Сравнение «вручную»: очередь по прибытию, первый свободный путь, 5 мин на реакцию. Ставка поездо-часа — условная, задаёт заказчик.", p))
    doc.build(el)
    return out.getvalue()
