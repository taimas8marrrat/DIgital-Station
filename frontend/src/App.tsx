import { useEffect, useMemo, useRef, useState } from "react";
import { hhmm } from "./api";
import Gantt from "./components/GanttCanvas";
import IndexPanel, { IndexFactors } from "./components/IndexPanel";
import EffectPanel from "./components/EffectPanel";
import { IncidentModal, SettingsModal } from "./components/Modals";
import NowPanel from "./components/NowPanel";
import Problems from "./components/Problems";
import StationMap from "./components/StationMap3";
import Login from "./components/Login";
import { localSource, MODE, serverSource, type Conn, type Source } from "./source";
import type { Session } from "./api";
import { makeT, type Lang } from "./i18n";
import type { View } from "./types";

const SPEEDS = [10, 30, 60, 288];
const Ico = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } },
};

/** Корень: сайт работает на браузерном движке; сервис — через вход и Python-сервер (CP-SAT). */
export default function Root() {
  const [lang, setLang] = useState<Lang>(() => (store.get("ds_lang") as Lang) || "ru");
  const [session, setSession] = useState<Session | null>(() => { try { return JSON.parse(store.get("ds_session") || "null"); } catch { return null; } });
  const t = useMemo(() => makeT(lang), [lang]);
  const src = useMemo(() => (MODE === "server" ? (session ? serverSource(session) : null) : localSource), [session]);
  if (!src) return <Login t={t} lang={lang} setLang={setLang} onLogin={(s) => { store.set("ds_session", JSON.stringify(s)); setSession(s); }} />;
  return <App src={src} lang={lang} setLang={setLang} user={session?.user}
    onLogout={session ? () => { try { localStorage.removeItem("ds_session"); } catch { /* */ } setSession(null); } : undefined} />;
}

function App({ src, lang, setLang, user, onLogout }: { src: Source; lang: Lang; setLang: (l: Lang) => void; user?: string; onLogout?: () => void }) {
  const t = useMemo(() => makeT(lang), [lang]);
  const [live, setLive] = useState<View | null>(null);
  const [station, setStation] = useState<any>(null);
  const [conn, setConn] = useState<Conn>({ online: false, retryIn: 0 });
  useEffect(() => src.start(setLive, setStation, setConn), [src]);
  const [modal, setModal] = useState<"incident" | "settings" | null>(null);
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const [hl, setHl] = useState<any>(null);
  const liveRef = useRef<View | null>(null); liveRef.current = live;
  // тренажёр ДСП: 3 ситуации, обучаемый выбирает вариант сам, оценка против лучшего
  const [trainer, setTrainer] = useState<{ round: number; shownAt: number | null; results: any[]; last?: any } | null>(null);
  const TRAIN_EVENTS = [
    (v: View) => { const c = v.trains.filter((x) => x.status !== "on_track" && x.plan_track).sort((a, b) => a.plan_arr! - b.plan_arr!)[0]; return src.incident({ type: "track_closed", track: c?.plan_track ?? 4, minutes: 60 }); },
    () => src.disaster("scb"),
    () => src.disaster("derail"),
  ];
  const startTrainer = async () => {
    await src.reset((liveRef.current as any)?.load ?? 1); await src.setAutopilot(false); await src.setSpeed(30);
    setTrainer({ round: 0, shownAt: null, results: [] });
    setTimeout(() => liveRef.current && TRAIN_EVENTS[0](liveRef.current), 6000);
  };
  useEffect(() => {
    if (trainer && live?.proposal && trainer.shownAt == null) setTrainer((tr) => tr && { ...tr, shownAt: Date.now() });
  }, [live?.proposal?.id]);
  const trainerAccept = async (pid: string, vid: string) => {
    const p = liveRef.current?.proposal; if (!p || !trainer) return;
    const best = p.variants.reduce((a, b) => (b.index > a.index || (b.index === a.index && b.kpi.total_delay_min < a.kpi.total_delay_min) ? b : a));
    const ch = p.variants.find((x) => x.id === vid)!;
    const sec = trainer.shownAt ? (Date.now() - trainer.shownAt) / 1000 : 0;
    const gap = Math.max(0, ch.kpi.total_delay_min - best.kpi.total_delay_min);
    const score = Math.max(0, Math.round(100 - Math.min(60, gap) - Math.max(0, sec - 15)));
    const r = { round: trainer.round + 1, chosen: vid, best: best.id, gap, sec: Math.round(sec), score };
    await src.accept(pid, vid);
    const next = trainer.round + 1;
    setTrainer({ round: next, shownAt: null, results: [...trainer.results, r], last: r });
    if (next < TRAIN_EVENTS.length) setTimeout(() => liveRef.current && TRAIN_EVENTS[next](liveRef.current), 7000);
  };
  const [demo, setDemo] = useState<{ step: number; key: string; params?: any; paused: boolean } | null>(null);
  const demoCtl = useRef({ abort: false, paused: false, skip: false });
  const runDemo = async () => {
    const c = demoCtl.current; c.abort = false; c.paused = false; c.skip = false;
    const wait = async (ms: number, until?: () => boolean) => {
      let left = ms;
      while (left > 0) {
        if (c.abort) throw new Error("stop");
        if (c.skip) { c.skip = false; return; }
        await new Promise((r) => setTimeout(r, 100));
        if (!c.paused) left -= 100;
        if (until && until()) return;
      }
    };
    const show = (step: number, key: string, params?: any) => setDemo({ step, key, params, paused: c.paused });
    try {
      await src.reset((liveRef.current as any)?.load ?? 1); await src.setAutopilot(false); await src.setSpeed(30);
      show(1, "d1"); await wait(3000, () => !!liveRef.current?.ready); await wait(7000);
      const v0 = liveRef.current!;
      const cand = v0.trains.filter((x) => x.status !== "on_track" && x.status !== "departed" && x.plan_track && x.plan_arr)
        .sort((a, b) => a.plan_arr! - b.plan_arr!)[0];
      const track = cand?.plan_track ?? 4;
      await src.incident({ type: "track_closed", track, minutes: 60 });
      show(2, "d2", { track }); await wait(12000, () => !!liveRef.current?.proposal);
      const p1 = liveRef.current?.proposal;
      if (p1) setHl(p1.conflicts[0]);
      await wait(9000);
      const p2 = liveRef.current?.proposal;
      show(3, "d3");
      if (p2) { const vr = p2.variants.find((x) => x.id === p2.recommended); if (vr) setPreview(vr.plan); }
      await wait(8000);
      const p3 = liveRef.current?.proposal;
      if (p3) await src.accept(p3.id, p3.recommended);
      setPreview(null); setHl(null);
      show(4, "d4"); await wait(8000);
      show(5, "d5"); await src.setAutopilot(true); await wait(3000);
      await src.disaster("derail");
      await wait(20000, () => !!(liveRef.current as any)?.last_resolve);
      const res = (liveRef.current as any)?.last_resolve;
      show(6, "d6", { s: res ? String(res.sec).replace(".", ",") : "—", n: res?.conflicts ?? "—" }); await wait(10000);
    } catch { /* остановлено */ }
    setPreview(null); setHl(null); setDemo(null);
    src.setAutopilot(false).catch(() => {}); src.setSpeed("auto").catch(() => {});
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!demo) return;
      if (e.code === "Space") { e.preventDefault(); demoCtl.current.paused = !demoCtl.current.paused; setDemo((d) => d && { ...d, paused: demoCtl.current.paused }); }
      if (e.code === "ArrowRight") demoCtl.current.skip = true;
      if (e.code === "Escape") demoCtl.current.abort = true;
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [demo]);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => { src.getConfig().then((c) => setRate(c.index.params?.delay_cost_kzt_per_train_hour ?? null)).catch(() => {}); }, [src]);
  const [history, setHistory] = useState<{ wall_ms: number; view: View }[] | null>(null);
  const [hIdx, setHIdx] = useState(0);
  const [blink, setBlink] = useState(false);
  const [toast, setToast] = useState("");
  const [mode, setMode] = useState<"tech" | "show">(() => (store.get("ds_mode") as any) || "tech");
  useEffect(() => { store.set("ds_mode", mode); }, [mode]);
  const [flags, setFlags] = useState<{ anim: boolean; dayNight: boolean; npc: boolean }>(() => {
    try { return { anim: true, dayNight: true, npc: true, ...JSON.parse(store.get("ds_flags") || "{}") }; } catch { return { anim: true, dayNight: true, npc: true }; }
  });
  useEffect(() => { store.set("ds_flags", JSON.stringify(flags)); }, [flags]);

  useEffect(() => { store.set("ds_lang", lang); document.documentElement.lang = lang === "kk" ? "kk" : "ru"; }, [lang]);
  const act = (p: Promise<unknown>) => p.catch((e: any) => setToast(e?.message ?? String(e)));
  useEffect(() => { const i = setInterval(() => setBlink((b) => !b), 600); return () => clearInterval(i); }, []);
  useEffect(() => { if (toast) { const i = setTimeout(() => setToast(""), 3500); return () => clearTimeout(i); } }, [toast]);

  const inHistory = history !== null && history.length > 0;
  const view: View | null = inHistory ? history![Math.min(hIdx, history!.length - 1)].view : live;
  const noSource = live?.stream_age_s != null && live.stream_age_s > 3;

  const openHistory = async () => {
    const h = await src.history(15).catch(() => []);
    if (!h.length) { setToast("История копится раз в 5 с — подождите немного"); return; }
    setHistory(h as any); setHIdx(h.length - 1);
  };
  const report = async (fmt: "csv" | "pdf" | "exec") => {
    try { await src.report(fmt); } catch (e: any) { if (e?.code !== "declined") setToast(e?.message ?? String(e)); }
  };
  if (!station) return <div className="app"><main className="loading">{conn.online ? "…" : t("offline", { s: conn.retryIn })}</main></div>;

  return (
    <div className="app">
      <header className="top">
        <div className="grp brand-grp">
          <div className="brand">
            <span className="brand-app">{t("app")}</span>
            <span className="brand-st">{station.station.name[lang]}</span>
          </div>
          <div className="clock" aria-label="sim time">{view?.ready ? hhmm(view.now) : "--:--"}</div>
        </div>
        <div className="grp" role="group" aria-label={t("g_speed")}>
          <span className="grp-l">{t("g_speed")}</span>
          <div className="seg">
            <button className={(live as any)?.auto ? "on" : ""} disabled={inHistory} onClick={() => act(src.setSpeed("auto"))}>{t("auto")}</button>
            {SPEEDS.map((s) => (
              <button key={s} className={!(live as any)?.auto && (live as any)?.target_speed === s ? "on" : ""} disabled={inHistory} onClick={() => act(src.setSpeed(s))}>×{s}</button>
            ))}
          </div>
          <span className="cur-speed">×{(live as any)?.target_speed ?? ""}</span>
        </div>
        <div className="grp" role="group" aria-label={t("g_status")}>
          <span className="grp-l">{t("g_status")}</span>
          <div className={`conn ${!noSource ? "ok" : "bad"}`} role="status"><i />{!noSource ? t("online") : t("no_source", { s: live!.stream_age_s })}</div>
          {(live as any)?.auto && live?.proposal && <div className="slowmo">{t("slowmo")}</div>}
        </div>
        <div className="grp" role="group" aria-label={t("g_actions")}>
          <span className="grp-l">{t("g_actions")}</span>
          <div className="row">
            <button className={`btn demo ${demo ? "on" : ""}`} disabled={inHistory} onClick={() => (demo ? (demoCtl.current.abort = true) : runDemo())}>
              <Ico d={demo ? "M6 6h12v12H6z" : "M7 5v14l11-7z"} />{demo ? t("demo_stop") : t("demo")}</button>
            <button className={`btn ap ${(live as any)?.autopilot ? "on" : ""}`} disabled={inHistory} title={t("autopilot_hint")}
              aria-pressed={!!(live as any)?.autopilot} onClick={() => act(src.setAutopilot(!(live as any)?.autopilot))}><i />{t("autopilot")}</button>
            <button className="btn warn" disabled={inHistory} onClick={() => setModal("incident")}><Ico d="M12 3 2 21h20L12 3zm0 6v6m0 3v.5" />{t("incident")}</button>
          </div>
        </div>
        <div className="grp" role="group" aria-label={t("g_view")}>
          <span className="grp-l">{t("g_view")}</span>
          <div className="seg">
            <button className={mode === "tech" ? "on" : ""} onClick={() => setMode("tech")}>{t("mode_tech")}</button>
            <button className={mode === "show" ? "on" : ""} onClick={() => setMode("show")}>{t("mode_show")}</button>
          </div>
        </div>
        <div className="grp end" role="group" aria-label={t("g_service")}>
          <span className="grp-l">{t("g_service")}</span>
          <div className="row">
            <div className="menu">
              <button className="btn"><Ico d="M6 2h9l5 5v15H6zM14 2v6h6" />{t("report")}</button>
              <div className="menu-pop"><button onClick={() => report("exec")}>{t("rep_exec")}</button><button onClick={() => report("pdf")}>{t("rep_full")}</button><button onClick={() => report("csv")}>CSV</button></div>
            </div>
            <button className="btn icon" title={t("settings")} aria-label={t("settings")} onClick={() => setModal("settings")}><Ico d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.5 4-2 .7-.5 1.3 1 1.9-1.4 1.4-1.9-1-1.3.5-.7 2h-2l-.7-2-1.3-.5-1.9 1-1.4-1.4 1-1.9-.5-1.3-2-.7v-2l2-.7.5-1.3-1-1.9 1.4-1.4 1.9 1 1.3-.5.7-2h2l.7 2 1.3.5 1.9-1 1.4 1.4-1 1.9.5 1.3 2 .7z" /></button>
            <div className="lang"><button className={lang === "ru" ? "on" : ""} onClick={() => setLang("ru")}>RU</button>
              <button className={lang === "kk" ? "on" : ""} onClick={() => setLang("kk")}>KZ</button></div>
            <button className="btn icon" title={t("restart")} aria-label={t("restart")} onClick={() => act(src.reset((live as any)?.load ?? 1))}><Ico d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" /></button>
          </div>
        </div>
      </header>

      {!view?.ready ? (
        <main className="loading">…</main>
      ) : (
        <main className="grid">
          <section className="map-area">
            {!conn.online && <div className="banner bad">{t("offline", { s: conn.retryIn })}</div>}
            {conn.online && noSource && !inHistory && <div className="banner bad">{t("no_source", { s: live!.stream_age_s })}</div>}
            {inHistory && <div className="banner hist">{t("history_mode", { t: hhmm(view.now) })}
              <button className="btn small" onClick={() => setHistory(null)}>{t("back_live")}</button></div>}
            {trainer && (
              <div className="trainer-card" role="status">
                <div className="dc-step">{t("trainer")} · {t("tr_round", { n: Math.min(trainer.round + 1, 3), m: 3 })}</div>
                {trainer.round < 3 ? (
                  <div className="tr-main">{trainer.last ? t("tr_result", { s: trainer.last.score, gap: trainer.last.gap, sec: trainer.last.sec }) : t("tr_intro")}</div>
                ) : (
                  <div className="tr-main">{t("tr_final", { s: Math.round(trainer.results.reduce((a, r) => a + r.score, 0) / trainer.results.length) })}</div>
                )}
                <button className="btn small" onClick={() => setTrainer(null)}>{t("close")}</button>
              </div>
            )}
            {demo && (
              <div className="demo-cap" role="status" aria-live="polite">
                <div className="dc-step">{t("demo_step", { n: Math.min(demo.step, 5), m: 5 })}{demo.paused ? ` · ${t("demo_paused")}` : ""}</div>
                <div className="dc-main">{t(demo.key, demo.params)}</div>
                <div className="dc-alt">{makeT(lang === "ru" ? "kk" : "ru")(demo.key, demo.params)}</div>
                <div className="dc-keys">{t("demo_keys")}</div>
              </div>
            )}
            <StationMap view={view} station={station.station} t={t} lang={lang} anim={flags.anim} dayNight={flags.dayNight} npc={flags.npc} tech={mode === "tech"} highlight={hl} />
          </section>
          <aside className="side">
            <IndexPanel index={view.index} t={t} kpi={(view as any).kpi} />
            <EffectPanel t={t} rate={rate} onRate={(r) => { setRate(r); src.getConfig().then((c) => src.saveConfig({ ...c.index, params: { ...c.index.params, delay_cost_kzt_per_train_hour: r } }, !!c.planner.auto_apply)).catch(() => {}); }} />
            <Problems view={view} t={t} lang={lang} res={station.resources} readOnly={inHistory} onHover={setHl} factors={<IndexFactors index={view.index} t={t} />}
              info={[t("mock"), t("ingest", { acc: view.ingest.accepted, dup: view.ingest.duplicates, inv: view.ingest.invalid }),
                t("plan_by", { method: t(`m_${view.plan_meta.by === "rolling" ? "rolling" : view.plan_meta.method}`), solver: view.plan_meta.solver, v: view.plan_meta.version }),
                src.mode === "local" ? t("browser") : t("service")]} now={<NowPanel view={view} t={t} lang={lang} />}
              onPreview={setPreview}
              trainer={!!trainer && trainer.round < 3}
              onAccept={(pid, v) => { if (trainer && trainer.round < 3) { trainerAccept(pid, v); return; } src.accept(pid, v).then((ok) => setToast(ok ? t("accepted") : "Предложение устарело — план обновлён")); }}
              onReject={(pid) => act(src.reject(pid))} />
          </aside>
          <section className="gantt-area">
            <div className="gantt-head">
              <h2>{t("gantt")}</h2>
              <div className="legend">
                <span><i className="lg pass" />{t("k_passenger")}</span><span><i className="lg fr" />{t("k_freight")}</span>
                <span><i className="lg ct" />{t("k_container")}</span><span><i className="lg cl" />{t("i_track_closed")}</span>
              </div>
              <div className="rewind">
                <span className="lbl">{t("rewind")}</span>
                {inHistory ? (
                  <input type="range" min={0} max={history!.length - 1} value={hIdx} onChange={(e) => setHIdx(+e.target.value)} aria-label={t("rewind")} />
                ) : (
                  <button className="btn small" onClick={openHistory}>−15 мин</button>
                )}
                {inHistory && <button className="btn small" onClick={() => setHistory(null)}>{t("live")}</button>}
              </div>
            </div>
            <Gantt view={view} t={t} preview={preview} anim={flags.anim && !inHistory} lang={lang} />
          </section>
        </main>
      )}
      {modal === "incident" && live && <IncidentModal view={live} t={t} lang={lang} res={station.resources} src={src} onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsModal t={t} src={src} flags={flags} setFlags={setFlags} onClose={() => setModal(null)} onTrainer={() => { setModal(null); startTrainer(); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
