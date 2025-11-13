// login.js
"use strict";

const express = require("express");
const session = require("express-session");
const { authenticate } = require("./db");

// ====== Marca ======
const BRAND = {
  title: "Sistema de Backup SkyUltraPlus",
  subtitle: "by Russell xz",
  logo: "https://cdn.russellxz.click/3c8ab72a.png",
};

function createLoginRouter(opts = {}) {
  const {
    successRedirect = "/panel",
    sessionName = "sup.sid",
    sessionSecret = "skyultraplus__change_me",
    cookieSecure = false,
  } = opts;

  const router = express.Router();

  router.use(express.urlencoded({ extended: true }));
  router.use(
    session({
      name: sessionName,
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: cookieSecure ? "none" : "lax",
        secure: cookieSecure,
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 días
      },
    })
  );

  // Middleware auth
  function ensureAuth(req, res, next) {
    if (req.session?.user) return next();
    return res.redirect("/login");
  }

  router.get("/login", (req, res) => {
    if (req.session?.user) return res.redirect(successRedirect);
    const msg = req.query.msg ? String(req.query.msg) : "";
    res.type("html").send(renderLogin(msg));
  });

  router.post("/login", (req, res) => {
    const email = String(req.body.email || "").trim();
    const password = String(req.body.password || "");
    const user = authenticate(email, password);
    if (!user) return res.redirect("/login?msg=Credenciales%20inv%C3%A1lidas");
    req.session.user = { id: user.id, email: user.email };
    return res.redirect(successRedirect);
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login?msg=Sesi%C3%B3n%20cerrada"));
  });

  return { router, ensureAuth };
}

function renderLogin(msg = "") {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Iniciar sesión — SkyUltraPlus</title>
<style>
  :root{--bg:#0b1220;--panel:#0f172a;--ring:#1f2937;--fg:#e5e7eb;--muted:#94a3b8;--accent:#2563eb}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial}
  .wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
  .card{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--ring);border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:28px}
  .brand{text-align:center;margin-bottom:18px} .brand img{width:88px;height:auto;margin:0 auto 10px;display:block}
  h1{margin:0 0 6px;font-size:22px;font-weight:700;text-align:center}
  .sub{text-align:center;color:var(--muted);font-size:12px;margin-bottom:22px}
  form{display:grid;gap:12px}
  label{font-size:12px;color:var(--muted);display:block;margin-bottom:6px}
  input{width:100%;padding:12px 14px;border:1px solid var(--ring);border-radius:10px;background:#0b1220;color:var(--fg);outline:none}
  input:focus{border-color:#334155}
  button{padding:12px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}
  .msg{margin:6px 0 0;font-size:12px;color:#fca5a5;text-align:center;min-height:18px}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="brand">
      <img src="${BRAND.logo}" alt="logo"/>
      <h1>${BRAND.title}</h1>
      <div class="sub">${BRAND.subtitle}</div>
    </div>
    <form method="post" action="/login">
      <div>
        <label>Correo</label>
        <input name="email" type="email" required placeholder="tu@correo.com"/>
      </div>
      <div>
        <label>Contraseña</label>
        <input name="password" type="password" required placeholder="••••••••"/>
      </div>
      <button>Entrar</button>
    </form>
    <div class="msg">${msg}</div>
  </div>
</div>
</body>
</html>`;
}

module.exports = { createLoginRouter };
