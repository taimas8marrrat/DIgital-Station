// Источник данных интерфейса: браузерный движок (сайт) или Python-сервер (сервис с CP-SAT).
import { api, type Session } from "./api";
import { CFG, RESOURCES, STATION } from "./engine/data";
import { engine } from "./engine/engine";
import { buildCsv, buildExecPdf, buildPdf, saveFile } from "./engine/report";
import effect from "./engine/data/effect.json";

export const MODE: "local" | "server" = (import.meta as any).env?.VITE_SOURCE === "server" ? "server" : "local";

export interface Conn { online: boolean; retryIn: number }
export interface Source {
  mode: "local" | "server";
  start(onView: (v: any) => void, onStation: (s: any) => void, onConn: (c: Conn) => void): () => void;
  incident(e: any): Promise<void>;
  disaster(k: string): Promise<void>;
  stress(n: number): Promise<void>;
  setSpeed(f: number | "auto"): Promise<void>;
  setAutopilot(on: boolean): Promise<void>;
  accept(pid: string, v: string): Promise<boolean>;
  reject(pid: string): Promise<void>;
  history(min: number): Promise<{ wall_ms: number; view: any }[]>;
  report(fmt: "csv" | "pdf" | "exec"): Promise<void>;
  getConfig(): Promise<{ index: any; planner: any }>;
  saveConfig(index: any, auto: boolean): Promise<void>;
  dropSource?(sec: number): void;
  reset(load?: number): Promise<void>;
  restart?(): void;
}

export const localSource: Source = {
  mode: "local",
  start(onView, onStation, onConn) {
    onStation({ station: STATION, resources: RESOURCES });
    onConn({ online: true, retryIn: 0 });
    engine.start();
    const un = engine.subscribe(onView);
    return () => { un(); engine.stop(); };
  },
  async incident(e) { engine.incident(e); },
  async disaster(k) { engine.disaster(k as any); },
  async stress(n) { engine.stress(n); },
  async setSpeed(f) { engine.setSpeed(f); },
  async setAutopilot(on) { engine.autopilot = on; },
  async accept(pid, v) { return engine.accept(pid, v); },
  async reject(pid) { engine.reject(pid); },
  async history(min) { return engine.historySince(min) as any; },
  async report(fmt) {
    if (fmt === "csv") await saveFile("aktogay_report.csv", buildCsv(engine));
    else if (fmt === "exec") await saveFile("aktogay_summary.pdf", buildExecPdf(engine, effect));
    else await saveFile("aktogay_report.pdf", buildPdf(engine));
  },
  async getConfig() { return { index: structuredClone(CFG.index), planner: structuredClone(CFG.planner) }; },
  async saveConfig(index, auto) { CFG.save("index", index); CFG.save("planner", { auto_apply: auto }); engine.dirty = true; },
  dropSource(sec) { engine.dropSource(sec); },
  async reset(load = 1) { engine.reset(load); },
  restart() { engine.reset(engine.load); },
};

export function serverSource(session: Session): Source {
  return {
    mode: "server",
    start(onView, onStation, onConn) {
      let stop = false, backoff = 500, timer: number | undefined, countdown: number | undefined, ping: number | undefined;
      let ws: WebSocket | null = null;
      const connect = () => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/ws/ui?token=${encodeURIComponent(session.token)}`);
        ws.onopen = () => { backoff = 500; onConn({ online: true, retryIn: 0 }); ping = window.setInterval(() => ws?.readyState === 1 && ws.send("ping"), 15000); };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === "station") onStation({ station: m.station, resources: m.resources });
          else if (m.type === "state") onView(m);
        };
        ws.onclose = (ev) => {
          clearInterval(ping);
          if (stop) return;
          if (ev.code === 4401) { try { localStorage.removeItem("ds_session"); } catch { /* */ } location.reload(); return; }
          let left = Math.round(backoff / 1000);
          onConn({ online: false, retryIn: left });
          clearInterval(countdown);
          countdown = window.setInterval(() => { left = Math.max(0, left - 1); onConn({ online: false, retryIn: left }); }, 1000);
          timer = window.setTimeout(() => { clearInterval(countdown); connect(); }, backoff);
          backoff = Math.min(backoff * 2, 8000);
        };
      };
      connect();
      return () => { stop = true; clearTimeout(timer); clearInterval(countdown); clearInterval(ping); ws?.close(); };
    },
    async incident(e) { await api("/api/incidents", session, { body: e }); },
    async disaster(k) { await api("/api/scenario/disaster", session, { body: { kind: k } }); },
    async reset(load = 1) { await api("/api/demo/reset", session, { body: { load } }); },
    async stress(n) { await api(`/api/scenario/stress?n=${n}`, session, { body: {} }); },
    async setSpeed(f) { await api("/api/sim/speed", session, { body: f === "auto" ? { auto: true } : { factor: f } }); },
    async setAutopilot(on) { await api("/api/planner/autopilot", session, { body: { enabled: on } }); },
    async accept(pid, v) { try { await api(`/api/proposals/${pid}/accept`, session, { body: { variant: v } }); return true; } catch { return false; } },
    async reject(pid) { await api(`/api/proposals/${pid}/reject`, session, { body: {} }); },
    async history(min) { return api(`/api/history?minutes=${min}`, session); },
    async report(fmt) { window.open(fmt === "exec" ? `/api/report_exec.pdf?token=${encodeURIComponent(session.token)}` : `/api/report.${fmt}?minutes=15&token=${encodeURIComponent(session.token)}`, "_blank"); },
    async getConfig() { return { index: await api("/api/config/index", session), planner: await api("/api/config/planner", session) }; },
    async saveConfig(index, auto) {
      await api("/api/config/index", session, { method: "PUT", body: { weights: index.weights, thresholds: index.thresholds, params: index.params } });
      await api("/api/planner/auto", session, { body: { enabled: auto } });
    },
  };
}
