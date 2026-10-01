import { useEffect, useRef, useState } from "react";
import type { T } from "../i18n";

/** Плавный счётчик числа индекса. */
function useTween(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now(), a = from.current;
    let raf = 0;
    const step = (ts: number) => {
      const k = Math.min(1, (ts - start) / ms), e = 1 - Math.pow(1 - k, 3);
      const cur = Math.round(a + (target - a) * e);
      setV(cur); from.current = cur;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
import type { IndexInfo } from "../types";

/** Компактная полоса индекса: число, категория и 5 мини-шкал в одну строку. */
const fmt = (x: number | null | undefined, d = 1) => (x == null ? "—" : x.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d }));

/** 5 факторов индекса — для раздела «Подробнее». */
export function IndexFactors({ index, t }: { index: IndexInfo; t: T }) {
  const order = ["throughput", "adherence", "conflicts", "track_load", "idle"];
  const byId = Object.fromEntries(index.factors.map((f) => [f.id, f]));
  return (
    <div className="factors-mini"><div className="cmp-h">{t("index")}: {t("factors")}</div>
        <div className="minis">
          {order.map((id) => {
            const f = byId[id];
            return (
              <div key={id} className="mini" title={t(`fx_${id}`, f.params)}>
                <div className="mini-n">{t(`fs_${id}`)}</div>
                <div className="bar"><span style={{ width: `${f.score}%` }} className={f.score >= 80 ? "ok" : f.score >= 60 ? "mid" : "bad"} /></div>
                <div className="mini-v">{f.score}</div>
              </div>
            );
          })}
        </div>
    </div>
  );
}

export default function IndexPanel({ index, t, kpi }: { index: IndexInfo; t: T; kpi?: any }) {
  const cat = index.category;
  const shown = useTween(index.value);
  const order = ["throughput", "adherence", "conflicts", "track_load", "idle"];
  const byId = Object.fromEntries(index.factors.map((f) => [f.id, f]));
  const worst = index.factors[0];
  const fx = (id: string, params: any) => (id === "throughput" && params.due === 0 ? t("no_due") : t(`fx_${id}`, params));
  return (
    <section className={`index cat-${cat}`} aria-label={t("index")}>
      <div className="index-value" aria-live="polite">{shown}</div>
      <div className="index-body">
        <div className="index-head">
          <span className="index-title">{t("index")}</span>
          <span className={`chip chip-${cat}`}>{t(cat)}</span>
        </div>
        {kpi && (
          <div className="kpis k3" title={t("kpi_24h")}>
            <div><span>{t("kpi_ontime")}</span><b>{kpi.on_time_pct == null ? "—" : `${fmt(kpi.on_time_pct, 0)} %`}</b></div>
            <div><span>{t("kpi_station")}</span><b>{fmt(kpi.station_delay_train_h)} п-ч</b></div>
            <div><span>{t("kpi_dwell")}</span><b>{fmt(kpi.transit_dwell_h)} ч</b></div>
          </div>
        )}
      </div>
    </section>
  );
}
