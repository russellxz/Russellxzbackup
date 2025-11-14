// index.js
"use strict";

const express = require("express");
const { createLoginRouter } = require("./login");
const { createPanelRouter } = require("./panel");
const { createUsersRouter } = require("./usuarios");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === "1" || NODE_ENV === "production";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "skyultraplus__change_me";

const app = express();

// Si estás detrás de Nginx/Cloudflare para HTTPS
app.set("trust proxy", 1);

// ===== Login + sesión =====
const { router: loginRouter, ensureAuth } = createLoginRouter({
  successRedirect: "/panel",
  sessionName: "sup.sid",
  sessionSecret: SESSION_SECRET,
  cookieSecure: COOKIE_SECURE,
});
app.use(loginRouter);

// ===== Rutas protegidas =====

// Panel de backups Paymenter
app.use(createPanelRouter({ ensureAuth }));

// Gestión de usuarios + monitor de CPU/RAM/Disco
app.use(createUsersRouter({ ensureAuth }));

// ===== Home: redirige según sesión =====
app.get("/", (req, res) => {
  if (req.session?.user) return res.redirect("/panel");
  return res.redirect("/login");
});

// ===== Healthcheck simple =====
app.get("/healthz", (_req, res) =>
  res.json({ ok: true, env: NODE_ENV })
);

// ===== 404 amable =====
app.use((req, res) => {
  if (req.session?.user) return res.redirect("/panel");
  return res.redirect("/login");
});

// ===== Arrancar servidor =====
app.listen(PORT, () => {
  console.log(
    `SkyUltraPlus Backup corriendo en http://localhost:${PORT}`
  );
  console.log(
    `Entorno: ${NODE_ENV} | Cookie secure: ${
      COOKIE_SECURE ? "ON" : "OFF"
    }`
  );
});
