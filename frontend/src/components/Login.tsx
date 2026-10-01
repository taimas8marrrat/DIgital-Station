import { useState } from "react";
import { api, type Session } from "../api";
import type { Lang, T } from "../i18n";

export default function Login({ t, lang, setLang, onLogin }: { t: T; lang: Lang; setLang: (l: Lang) => void; onLogin: (s: Session) => void }) {
  const [u, setU] = useState("dsp");
  const [p, setP] = useState("");
  const [err, setErr] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { onLogin(await api<Session>("/api/login", null, { body: { username: u, password: p } })); }
    catch { setErr(true); }
  };
  return (
    <div className="login">
      <form onSubmit={submit} className="login-card">
        <div className="lang"><button type="button" className={lang === "ru" ? "on" : ""} onClick={() => setLang("ru")}>RU</button>
          <button type="button" className={lang === "kk" ? "on" : ""} onClick={() => setLang("kk")}>KZ</button></div>
        <div className="login-brand">{t("app")}</div>
        <div className="login-station">{lang === "kk" ? "Ақтоғай" : "Актогай"}</div>
        <h1>{t("login_title")}</h1>
        <label>{t("login_user")}<input value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" /></label>
        <label>{t("login_pass")}<input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" autoFocus /></label>
        {err && <div className="err">{t("login_err")}</div>}
        <button className="btn primary" type="submit">{t("login_btn")}</button>
        <div className="muted">{t("login_hint")}</div>
      </form>
    </div>
  );
}
