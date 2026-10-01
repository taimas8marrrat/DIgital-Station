import { useState, type ReactNode } from "react";
import { hhmm } from "../api";
import type { Lang, T } from "../i18n";
import type { Conflict, Resources, View } from "../types";

function conflictText(c: Conflict, t: T, lang: Lang, res: Resources) {
  const p: Record<string, unknown> = {
    t0: `№${c.trains[0]}`, t1: c.trains[1] ? `№${c.trains[1]}` : "", track: c.track, minutes: c.minutes,
    throat: c.throat ? t(c.throat) : "", need: c.need, have: c.have,
    resource: c.resource ? res[c.resource]?.[lang] : "",
  };
  return { text: t(`c_${c.type}`, p), rule: t(`r_${c.type}`) };
}

/** Объяснение варианта: что выигрываем, чем жертвуем, какие правила учтены. */
function explain(v: any, all: any[], conflicts: Conflict[], t: T) {
  const out: string[] = [];
  const minDelay = Math.min(...all.map((x) => x.kpi.total_delay_min));
  const fewest = all.reduce((a, b) => (b.kpi.changed_tracks < a.kpi.changed_tracks ? b : a));
  if (v.kpi.total_delay_min === minDelay) out.push(t("why_min_delay", { n: v.kpi.total_delay_min }));
  out.push(v.kpi.passenger_delay_min === 0 ? t("why_pass_ok") : t("why_pass", { n: v.kpi.passenger_delay_min }));
  out.push(t("why_changes", { n: v.kpi.changed_tracks }));
  if (fewest.id !== v.id) {
    const dd = v.kpi.total_delay_min - fewest.kpi.total_delay_min, dc = v.kpi.changed_tracks - fewest.kpi.changed_tracks;
    if (dd < 0 && dc > 0) out.push(t("why_trade", { d: -dd, c: dc }));
  }
  const rules = new Set<string>();
  for (const c of conflicts) {
    if (c.type === "track_closed") rules.add(t("why_r_closed", { k: c.track }));
    if (c.type === "route_blocked") rules.add(t("why_r_switch"));
    if (c.type === "shortage") rules.add(t("why_r_res"));
    if (c.type === "route_crossing") rules.add(t("why_r_throat"));
    if (c.type === "track_occupied") rules.add(t("why_r_one"));
  }
  return { gains: out, rules: [...rules] };
}

export default function Problems({ view, t, lang, res, onAccept, onReject, onPreview, readOnly, now, info: infoLines, onHover, factors, trainer }: {
  view: View; t: T; lang: Lang; res: Resources; readOnly: boolean; now?: ReactNode; info?: string[]; onHover?: (c: any) => void; factors?: ReactNode; trainer?: boolean;
  onAccept: (pid: string, v: string) => void; onReject: (pid: string) => void;
  onPreview: (plan: Record<string, any> | null) => void;
}) {
  const p = view.proposal;
  const [sel, setSel] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const ap = (view as any).autopilot && p && (p as any).createdWall;
  const left = ap ? Math.max(0, Math.ceil(((p as any).createdWall + (view as any).autopilot_ms - Date.now()) / 1000)) : 0;
  const res0 = (view as any).last_resolve;
  const info = view.conflicts.filter((c) => c.severity === "info").slice(0, 3);
  const chosen = p ? (p.variants.find((v) => v.id === (sel ?? (trainer ? p.variants[2]?.id : p.recommended))) ?? p.variants[0]) : null;

  return (
    <section className="problems" aria-label={t("problems")}>
      <h2>{t("problems")}</h2>
      {p && chosen ? (
        <div className="card">
          <ul className="conf-list">
            {p.conflicts.slice(0, 4).map((c) => {
              const x = conflictText(c, t, lang, res);
              return (
                <li key={c.key} className={`sev-${c.severity}`} onMouseEnter={() => onHover?.(c)} onMouseLeave={() => onHover?.(null)}>
                  <div className="conf-text">{x.text}</div>
                  <div className="conf-rule">{t("rule")}: {x.rule}</div>
                </li>
              );
            })}
            {p.conflicts.length > 4 && <li className="more">+{p.conflicts.length - 4}</li>}
          </ul>
          <div className="variants" role="radiogroup" aria-label={t("solution")}>
            {p.variants.map((v) => (
              <button key={v.id} role="radio" aria-checked={chosen.id === v.id}
                className={`variant ${chosen.id === v.id ? "on" : ""}`}
                onClick={() => setSel(v.id)} onMouseEnter={() => onPreview(v.plan)} onMouseLeave={() => onPreview(null)}>
                <span className="v-name">{t(`m_${v.id}`)}{v.id === p.recommended && !trainer && <em>{t("recommended")}</em>}</span>
                <span className="v-kpi"><b>{v.index}</b> {t("idx_after")}</span>
                <span className="v-kpi">{v.kpi.total_delay_min} {t("min")} {t("delay_total").toLowerCase()}</span>
                <span className="v-ms">{v.solver} · {Math.round(v.solve_ms)} мс</span>
              </button>
            ))}
          </div>
          <div className="solution">
            <div className="sol-h">{t("solution")} — {t(`m_${chosen.id}`)}</div>
            {chosen.changes.length === 0 ? <div className="muted">{t("no_changes")}</div> : (
              <ul className="changes">
                {chosen.changes.slice(0, 5).map((c) => (
                  <li key={c.train}>{c.track_from && c.track_from !== c.track_to
                    ? t("ch_line", { train: c.train, from: c.track_from, to: c.track_to, dep: hhmm(c.dep_to) })
                    : t("ch_time", { train: c.train, to: c.track_to, dep_from: hhmm(c.dep_from), dep: hhmm(c.dep_to) })}</li>
                ))}
                {chosen.changes.length > 5 && <li className="muted">+{chosen.changes.length - 5}</li>}
              </ul>
            )}
            {!trainer && (() => { const ex = explain(chosen, p.variants, p.conflicts, t); return (
              <div className="why">
                <div className="why-h">{t("why")}</div>
                <ul>{ex.gains.map((g, i) => <li key={i}>{g}</li>)}</ul>
                {ex.rules.length > 0 && <div className="why-rules">{t("why_rules")}: {ex.rules.join(" · ")}</div>}
              </div>); })()}
            <div className="muted">{t("who")}: {t("who_dsp")}</div>
            <div className="dnc">{t("dnc")}</div>
          </div>
          {ap && <div className="autobar">{t("ap_countdown", { s: left })}</div>}
          <div className="actions">
            <button className="btn primary" disabled={readOnly} onClick={() => { onAccept(p.id, chosen.id); setSel(null); onPreview(null); }}>
              {t("accept")}: {t(`m_${chosen.id}`)}
            </button>
            <button className="btn ghost" disabled={readOnly} onClick={() => onReject(p.id)}>{t("reject")}</button>
          </div>
        </div>
      ) : (
        <div className="card calm">
          {res0 && Date.now() - res0.at < 20000 && <div className="resolved">{t("ap_resolved", { s: String(res0.sec).replace(".", ","), n: res0.conflicts })}</div>}
          <div className="calm-h">{t("no_conflicts")}</div>
          <div className="muted">{t("plan_by", {
            method: t(`m_${view.plan_meta.by === "rolling" ? "rolling" : view.plan_meta.method}`),
            solver: view.plan_meta.solver, v: view.plan_meta.version,
          })}</div>
          {info.map((c) => <div key={c.key} className="info-line">{conflictText(c, t, lang, res).text}</div>)}
        </div>
      )}
      {now}
      <details className="more">
        <summary>{t("more")}</summary>
        {factors}
        {infoLines && <ul className="info-list">{infoLines.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      <div className="log">
        <button className="log-h" onClick={() => setLogOpen(!logOpen)} aria-expanded={logOpen}>
          {t("log")} <span className="muted">({view.log.length})</span><span className="chev">{logOpen ? "▴" : "▾"}</span>
        </button>
        <ul>
          {view.log.slice(0, logOpen ? 25 : 3).map((l, i) => (
            <li key={i}><time>{hhmm(l.ts)}</time> {t(`log_${l.kind}`, {
              ...l, resource: l.resource ? res[l.resource]?.[lang] : "", variant: l.variant ? t(`m_${l.variant}`) : "",
              by: l.by === "auto" ? t("by_auto") : l.by, name: l.dk ? t(`d_${l.dk}`) : "",
            })}</li>
          ))}
        </ul>
      </div>
      </details>
    </section>
  );
}
