import { useEffect, useState } from "react";
import type { Source } from "../source";
import type { Lang, T } from "../i18n";
import type { Resources, View } from "../types";

const TYPES = ["delay", "track_closed", "track_opened", "switch_failure", "switch_repaired", "wagon_defect", "resource"] as const;

export function IncidentModal({ view, t, lang, res, onClose, src }: {
  view: View; t: T; lang: Lang; res: Resources; onClose: () => void; src: Source;
}) {
  const [type, setType] = useState<(typeof TYPES)[number]>("delay");
  const upcoming = view.trains.filter((x) => x.status === "scheduled" || x.status === "approaching");
  const onTrack = view.trains.filter((x) => x.status === "on_track");
  const trains = type === "wagon_defect" ? onTrack : upcoming;
  const [train, setTrain] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [track, setTrack] = useState(4);
  const [sw, setSw] = useState("W3");
  const [resource, setResource] = useState("inspectors");
  const [delta, setDelta] = useState(-1);
  const [err, setErr] = useState("");
  useEffect(() => { setTrain(trains[0]?.id ?? ""); }, [type]); // eslint-disable-line

  const send = async () => {
    const body: Record<string, unknown> = { type };
    if (type === "delay" || type === "wagon_defect") Object.assign(body, { train, minutes });
    if (type === "track_closed") Object.assign(body, { track, minutes });
    if (type === "track_opened") Object.assign(body, { track });
    if (type === "switch_failure") Object.assign(body, { switch: sw, minutes });
    if (type === "switch_repaired") Object.assign(body, { switch: sw });
    if (type === "resource") Object.assign(body, { resource, delta });
    try { await src.incident(body); onClose(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t("incident")} onClick={(e) => e.stopPropagation()}>
        <h3>{t("incident")}</h3>
        <div className="form-h">{t("disasters")}</div>
        <div className="disasters">
          {(["derail", "storm", "scb"] as const).map((k) => (
            <button key={k} className="btn danger" onClick={() => { src.disaster(k).catch(() => {}); onClose(); }}>{t(`d_${k}`)}</button>
          ))}
        </div>
        <div className="form-h">{t("single")}</div>
        <div className="seg-group">
          {TYPES.map((x) => <button key={x} className={type === x ? "on" : ""} onClick={() => setType(x)}>{t(`i_${x}`)}</button>)}
        </div>
        <div className="form">
          {(type === "delay" || type === "wagon_defect") && (
            <label>{t("f_train")}
              <select value={train} onChange={(e) => setTrain(e.target.value)}>
                {trains.map((x) => <option key={x.id} value={x.id}>№{x.number} · {t(`k_${x.kind}`)} · {t(`st_${x.status}`)}</option>)}
              </select>
            </label>
          )}
          {(type === "track_closed" || type === "track_opened") && (
            <label>{t("f_track")}
              <select value={track} onChange={(e) => setTrack(+e.target.value)}>{[1, 2, 3, 4, 5].map((k) => <option key={k}>{k}</option>)}</select>
            </label>
          )}
          {(type === "switch_failure" || type === "switch_repaired") && (
            <label>{t("f_switch")}
              <select value={sw} onChange={(e) => setSw(e.target.value)}>{view.switches.map((s) => <option key={s.id}>{s.id}</option>)}</select>
            </label>
          )}
          {type === "resource" && (<>
            <label>{t("f_resource")}
              <select value={resource} onChange={(e) => setResource(e.target.value)}>
                {Object.entries(res).filter(([k]) => !k.startsWith("_")).map(([k, v]) => <option key={k} value={k}>{v[lang]} ({view.caps[k]})</option>)}
              </select>
            </label>
            <label>{t("f_delta")}<input type="number" value={delta} min={-5} max={5} onChange={(e) => setDelta(+e.target.value)} /></label>
          </>)}
          {["delay", "wagon_defect", "track_closed", "switch_failure"].includes(type) && (
            <label>{t("f_minutes")}<input type="number" value={minutes} min={5} max={240} step={5} onChange={(e) => setMinutes(+e.target.value)} /></label>
          )}
        </div>
        {err && <div className="err">{err}</div>}
        <div className="actions">
          <button className="btn primary" onClick={send} disabled={(type === "delay" || type === "wagon_defect") && !train}>{t("send")}</button>
          <button className="btn ghost" onClick={onClose}>{t("close")}</button>
        </div>
      </div>
    </div>
  );
}

const W_KEYS = ["throughput", "adherence", "conflicts", "track_load", "idle"];

export function SettingsModal({ t, onClose, flags, setFlags, src, onTrainer }: { t: T; onClose: () => void; src: Source; onTrainer?: () => void;
  flags: { anim: boolean; dayNight: boolean; npc: boolean }; setFlags: (f: { anim: boolean; dayNight: boolean; npc: boolean }) => void }) {
  const [cfg, setCfg] = useState<any>(null);
  const [auto, setAuto] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => { src.getConfig().then((c) => { setCfg(c.index); setAuto(!!c.planner.auto_apply); }).catch((e) => setMsg(e.message)); }, [src]);
  if (!cfg) return null;
  const sum = W_KEYS.reduce((a, k) => a + Number(cfg.weights[k]), 0);
  const save = async () => {
    try { await src.saveConfig({ weights: cfg.weights, thresholds: cfg.thresholds, params: cfg.params }, auto); setMsg(t("saved")); }
    catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t("settings")} onClick={(e) => e.stopPropagation()}>
        <h3>{t("settings")}</h3>
        <div className="muted">{t("only_admin")}</div>
        <div className="form">
          <div className="form-h">{t("weights")}</div>
          {W_KEYS.map((k) => (
            <label key={k}>{t(`f_${k}`)}
              <input type="number" step={0.05} min={0} max={1} value={cfg.weights[k]}
                onChange={(e) => setCfg({ ...cfg, weights: { ...cfg.weights, [k]: +e.target.value } })} />
            </label>
          ))}
          <div className={Math.abs(sum - 1) > 0.01 ? "err" : "muted"}>Σ = {sum.toFixed(2)}{Math.abs(sum - 1) > 0.01 ? ` · ${t("sum_err")}` : ""}</div>
          <div className="form-h">{t("thresholds")}</div>
          <label>{t("th_norm")}<input type="number" value={cfg.thresholds.norm}
            onChange={(e) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, norm: +e.target.value } })} /></label>
          <label>{t("th_attention")}<input type="number" value={cfg.thresholds.attention}
            onChange={(e) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, attention: +e.target.value } })} /></label>
          <label>{t("rate_label")}<input type="number" min={0} step={1000} value={cfg.params.delay_cost_kzt_per_train_hour ?? ""} placeholder={t("kpi_rate_unset")}
            onChange={(e) => setCfg({ ...cfg, params: { ...cfg.params, delay_cost_kzt_per_train_hour: e.target.value === "" ? null : +e.target.value } })} /></label>
          <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{t("auto_apply")}</label>
          <div className="form-h">{t("visual")}</div>
          <label className="check"><input type="checkbox" checked={flags.anim} onChange={(e) => setFlags({ ...flags, anim: e.target.checked })} />{t("flag_anim")}</label>
          <label className="check"><input type="checkbox" checked={flags.dayNight} onChange={(e) => setFlags({ ...flags, dayNight: e.target.checked })} />{t("flag_daynight")}</label>
          <label className="check"><input type="checkbox" checked={flags.npc} onChange={(e) => setFlags({ ...flags, npc: e.target.checked })} />{t("flag_npc")}</label>
          <div className="form-h">{t("trainer")}</div>
          <div className="actions"><button className="btn primary" onClick={() => onTrainer?.()}>{t("tr_start")}</button></div>
          <div className="muted">{t("tr_about")}</div>
          <div className="form-h">{t("flow")}</div>
          <div className="actions">
            <button className="btn" onClick={() => { src.reset(1); onClose(); }}>{t("flow_now")}</button>
            <button className="btn" onClick={() => { src.reset(1.6); onClose(); }}>{t("flow_growth")}</button>
          </div>
          <div className="muted">{t("flow_note")}</div>
          <div className="form-h">{t("test_tools")}</div>
          <div className="actions">
            <button className="btn" onClick={() => { src.stress(10); onClose(); }}>{t("stress")}</button>
            {src.dropSource && <button className="btn" onClick={() => { src.dropSource!(10); onClose(); }}>{t("drop_source")}</button>}
          </div>
          {src.dropSource && (<>
          </>)}
        </div>
        {msg && <div className="muted">{msg}</div>}
        <div className="actions">
          <button className="btn primary" disabled={Math.abs(sum - 1) > 0.01} onClick={save}>{t("save")}</button>
          <button className="btn ghost" onClick={onClose}>{t("close")}</button>
        </div>
      </div>
    </div>
  );
}
