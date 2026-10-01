import { hhmm } from "../api";
import type { Lang, T } from "../i18n";
import { chain, stageNow, trainName } from "../stages";
import type { View } from "../types";

/** «Поезда на станции»: цепочка технологических этапов по каждому пути. */
export default function NowPanel({ view, t, lang }: { view: View; t: T; lang: Lang }) {
  const now = view.now;
  const onTrack = new Map(view.trains.filter((x) => x.status === "on_track" && x.track).map((x) => [x.track!, x]));
  return (
    <section className="now" aria-label={t("trains_now")}>
      <h2>{t("trains_now")}</h2>
      <ul className="chains">
        {[1, 2, 3, 4, 5].map((k) => {
          const tr = onTrack.get(k);
          const closed = view.tracks.find((x) => x.id === k)?.closed_until;
          if (!tr) return (
            <li key={k} className="empty"><span className="tk">{k}</span>
              <span className={closed && closed > now ? "closed-l" : "muted"}>{closed && closed > now ? t("trackwork", { t: hhmm(closed) }) : t("track_free")}</span></li>
          );
          const c = chain(tr), cur = stageNow(tr, now), ci = c.indexOf(cur === "stop" ? "arrival" : cur);
          return (
            <li key={k}>
              <span className="tk">{k}</span>
              <div className="ch-body">
                <div className="ch-name">{trainName(tr, lang, t)}</div>
                <div className="ch-steps">
                  {c.map((s, i) => <span key={s} className={`step ${i < ci ? "done" : i === ci ? "cur" : ""}`} title={t(`sg_${s}`)}>{t(`sg_${s}`)}</span>)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
