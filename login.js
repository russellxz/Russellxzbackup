"use strict";

const express = require("express");
const session = require("express-session");
const { authenticate } = require("./db");

// ====== Config visual / marcas ======
const BRAND = {
  title: "Sistema de Backup SkyUltraPlus",
  subtitle: "by Russell xz",
  logo: "https://cdn.russellxz.click/3c8ab72a.png",
};

// ====== Crea router de login con sesión incluida ======
function createLoginRouter(opts = {}) {
  const {
    loginPath = "/login",
    successRedirect = "/panel", // a dónde enviar tras logueo
    sessionName = "sid",
    sessionSecret = process.env.SESSION_SECRET || "skyultraplus__change_me",
    cookieSecure = false, // pon true si usas HTTPS detrás de proxy bien configurado
  } = opts;

  const router = express.Router();

  // Sesión (aplica a todo lo montado en este router)
  router.use(
    session({
      name: sessionName,
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure,
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 días
      },
    })
  );

  // Parser para POST form
  router.use(express.urlencoded({ extended: false }));

  // Si ya está logueado, saltar login
  router.get(loginPath, (req, res) => {
    if (req.session?.user) return res.redirect(successRedirect);
    res.type("html").send(renderLoginPage());
  });

  // Procesar login
  router.post(loginPath, (req, res) => {
    const { email = "", password = "" } = req.body || {};
    const user = authenticate(email, password);
    if (!user) {
      return res
        .status(401)
        .type("html")
        .send(renderLoginPage("Correo o contraseña inválidos.", email));
    }
    req.session.user = { id: user.id, email: user.email };
    res.redirect(successRedirect);
  });

  // Logout
  router.post("/logout", (req, res) => {
    req.session?.destroy?.(() => res.redirect(loginPath));
  });

  // Util: quién soy (opcional)
  router.get("/whoami", (req, res) => {
    res.json({ user: req.session?.user || null });
  });

  return {
    router,
    ensureAuth: (req, res, next) => {
      if (req.session?.user) return next();
      res.redirect(loginPath);
    },
  };
}

// ====== HTML del login (tema blanco, logo, centrado) ======
function renderLoginPage(errorMsg = "", emailPrefill = "") {
  const esc = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${BRAND.title}</title>
<style>
  :root {
    --bg: #ffffff;
    --fg: #0f172a;
    --muted: #64748b;
    --primary: #111827;
    --primary-contrast: #ffffff;
    --ring: #e5e7eb;
    --danger: #ef4444;
  }
  * { box-sizing: border-box; }
  html,body { height:100%; }
  body {
    margin:0; background:var(--bg); color:var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji";
    display:flex; align-items:center; justify-content:center; padding:16px;
  }
  .card {
    width:100%; max-width:420px; background:#fff; border:1px solid var(--ring);
    border-radius:14px; box-shadow: 0 6px 24px rgba(15,23,42,.06); padding:28px;
  }
  .brand { text-align:center; margin-bottom:18px; }
  .brand img { width:92px; height:auto; display:block; margin:0 auto 10px; }
  h1 { margin:0 0 6px; font-size:22px; font-weight:700; text-align:center; }
  .sub { text-align:center; color:var(--muted); font-size:12px; margin-bottom:22px; }
  form { display:grid; gap:12px; }
  label { font-size:12px; color:var(--muted); display:block; margin-bottom:6px; }
  input {
    width:100%; padding:12px 14px; border:1px solid var(--ring); border-radius:10px;
    font-size:14px; outline:none; background:#fff; color:var(--fg);
  }
  input:focus { border-color:#cbd5e1; box-shadow:0 0 0 3px rgba(59,130,246,.12); }
  .btn {
    width:100%; padding:12px 14px; border:none; border-radius:10px; cursor:pointer;
    background:var(--primary); color:var(--primary-contrast); font-weight:600; font-size:14px;
  }
  .btn:active { transform: translateY(1px); }
  .err {
    background: #fee2e2; color:#991b1b; border:1px solid #fecaca;
    padding:10px 12px; border-radius:10px; font-size:13px; margin-bottom:6px;
  }
  .row { display:grid; gap:6px; }
  .foot {
    margin-top:16px; text-align:center; color:var(--muted); font-size:11px;
  }
  .toggle {
    position:absolute; right:12px; top:50%; transform:translateY(-50%);
    font-size:12px; color:#475569; cursor:pointer; user-select:none;
  }
  .input-wrap { position:relative; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <img src="${esc(BRAND.logo)}" alt="logo" />
      <h1>${esc(BRAND.title)}</h1>
      <div class="sub">${esc(BRAND.subtitle)}</div>
    </div>

    ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ""}

    <form method="post" action="/login" autocomplete="on">
      <div class="row">
        <label for="email">Correo</label>
        <input id="email" name="email" type="email" required placeholder="tu@correo.com" value="${esc(emailPrefill)}" />
      </div>

      <div class="row">
        <label for="password">Contraseña</label>
        <div class="input-wrap">
          <input id="password" name="password" type="password" required placeholder="••••••••" />
          <span class="toggle" onclick="(function(t){const i=document.getElementById('password'); if(i.type==='password'){i.type='text'; t.textContent='Ocultar';} else {i.type='password'; t.textContent='Mostrar';}})(this)">Mostrar</span>
        </div>
      </div>

      <button class="btn" type="submit">Iniciar sesión</button>
    </form>

    <div class="foot">
      Acceso exclusivo para socios de SkyUltraPlus.
    </div>
  </div>
</body>
</html>`;
}

module.exports = { createLoginRouter };

// ====== Ejemplo de uso (en tu app principal):
// const express = require("express");
// const { createLoginRouter } = require("./login");
// const app = express();
// const { router, ensureAuth } = createLoginRouter({ successRedirect: "/panel" });
// app.use(router);
// app.get("/panel", ensureAuth, (req,res)=> res.send("Bienvenido al panel ♡"));
// app.listen(3000);
