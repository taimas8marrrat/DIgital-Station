export type Kind = "passenger" | "freight" | "container";
export interface Train {
  id: string; number: string; kind: Kind; from: string; to: string; length: number;
  status: "scheduled" | "approaching" | "waiting_signal" | "on_track" | "departed";
  km: number | null; eta: number; planned_arr: number; planned_dep: number;
  plan_track: number | null; plan_arr: number | null; plan_dep: number | null;
  exp_arr: number | null; exp_dep: number | null; track: number | null;
  actual_arr: number | null; actual_dep: number | null; ready: number | null;
  ops: { stop: number; inspection: boolean; loco_change: boolean; crew_change: boolean };
  dwell: number; delay_min: number; eta_unc?: number;
}
export interface Conflict {
  type: string; severity: "critical" | "warning" | "info"; trains: string[]; track?: number;
  throat?: string; minutes?: number; resource?: string; need?: number; have?: number; key: string;
}
export interface Factor { id: string; score: number; weight: number; contribution: number; loss: number; params: Record<string, number> }
export interface IndexInfo { value: number; category: "norm" | "attention" | "critical"; factors: Factor[]; thresholds: { norm: number; attention: number } }
export interface Change { train: string; kind: Kind; track_from: number | null; track_to: number; arr_from: number | null; arr_to: number; dep_from: number | null; dep_to: number }
export interface Variant {
  id: string; solver: string; status: string; solve_ms: number; fallback: boolean;
  kpi: { total_delay_min: number; passenger_delay_min: number; max_delay_min: number; wait_at_signal_min: number; changed_tracks: number; trains: number };
  index: number; category: string; changes: Change[]; plan: Record<string, { track: number; arr: number; dep: number }>;
}
export interface Proposal { id: string; created: number; conflicts: Conflict[]; variants: Variant[]; recommended: string; total_ms: number }
export interface Compare {
  smart: Variant["kpi"]; manual: Variant["kpi"]; smart_index: number; manual_index: number;
}
export interface View {
  type: "state"; ready: boolean; now: number; speed: number; wall_ms: number; src_wall_ms: number | null;
  sim_connected: boolean; stream_age_s: number | null;
  tracks: { id: number; occupant: string | null; closed_until: number | null }[];
  switches: { id: string; failed_until: number | null }[];
  trains: Train[]; plan_meta: { version: number; method: string; solver: string; status: string; solve_ms: number; by: string };
  conflicts: Conflict[]; proposal: Proposal | null; index: IndexInfo; compare: Compare | null;
  caps: Record<string, number>; log: Record<string, any>[];
  ingest: Record<string, number>;
}
export interface Station {
  name: { ru: string; kk: string }; esr: string;
  tracks: { id: number; kind: string; length: number; platform: boolean }[];
  directions: Record<string, { ru: string; kk: string; throat: string; km: number | null }>;
  switches: { id: string; throat: string; tracks: number[] }[];
}
export interface Resources { [k: string]: { ru: string; kk: string; capacity: number } }
