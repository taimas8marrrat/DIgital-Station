import { useState } from "react";
import effect from "../engine/data/effect.json";
import type { T } from "../i18n";

const fmt = (x: number, d = 0) => x.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d });

/** «Эффект»: годовой выигрыш по результатам пакетного прогона и условной ставке поездо-часа. */
export default function EffectPanel({ t, rate, onRate }: { t: T; rate: number | null; onRate: (r: number | null) => void }) {
  const [growth, setGrowth] = useState(false);
  const e: any = growth ? (effect as any).growth : (effect as any).base;
  const st = (e.station_delay_train_h.manual - e.station_delay_train_h.smart) * 365;
  const wait = ((e.wait_signal_min.manual - e.wait_signal_min.smart) / 60) * 365;
  // в деньги переводим только задержки по вине станции: ожидание у сигнала уже входит в них, суммировать нельзя
  return (
    <section className="effect" aria-label={t("effect")}>
      <div className="eff-head">
        <h2>{t("effect")}</h2>
        <div className="seg light" role="group" aria-label={t("eff_flow")}>
          <button className={!growth ? "on" : ""} onClick={() => setGrowth(false)}>{t("eff_now", { n: e.trains })}</button>
          <button className={growth ? "on" : ""} onClick={() => setGrowth(true)}>{t("eff_growth")}</button>
        </div>
      </div>
      <div className="eff-grid">
        <div><span>{t("eff_wait")}</span><b>−{fmt(wait)} {t("eff_th")}</b></div>
        <div><span>{t("eff_station")}</span><b>−{fmt(st)} {t("eff_th")}</b></div>
        <div className="money"><span>{t("eff_money")}</span>
          <b>{rate ? `${fmt(st * rate / 1e6, 1)} ${t("eff_mln")}` : t("kpi_rate_unset")}</b></div>
      </div>
      <label className="eff-rate">{t("rate_label")}
        <input type="number" min={0} step={5000} value={rate ?? ""} placeholder="—" onChange={(ev) => onRate(ev.target.value === "" ? null : +ev.target.value)} />
      </label>
      <div className="eff-note">{t("eff_note", { n: e.runs })}</div>
    </section>
  );
}
