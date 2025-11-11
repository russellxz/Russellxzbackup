// panel.js
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const { spawn } = require("child_process");
const { db } = require("./db");

// ===== Config =====
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ===== DB: Tablas para VPS / backups =====
db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS servers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    label        TEXT,
    ip           TEXT NOT NULL,
    ssh_user     TEXT NOT NULL DEFAULT 'root',
    ssh_pass     TEXT NOT NULL,
    schedule_key TEXT NOT NULL DEFAULT 'off',   -- off|1h|6h|12h|1d|1w|15d|1m
    interval_ms  INTEGER NOT NULL DEFAULT 0,
    enabled      INTEGER NOT NULL DEFAULT 0,
    last_run     TEXT,
    next_run     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TRIGGER IF NOT EXISTS trg_servers_updated_at
  AFTER UPDATE ON servers
  FOR EACH ROW BEGIN
    UPDATE servers SET updated_at = datetime('now') WHERE id = OLD.id;
  END;

  CREATE TABLE IF NOT EXISTS backups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL,
    filename    TEXT NOT NULL,
    size_bytes  INTEGER,
    status      TEXT NOT NULL DEFAULT 'done', -- done|failed|running
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
  );
`);

// ===== Scheduler (en memoria) =====
const timers = new Map(); // serverId -> setInterval id

const SCHEDULES = {
  off:   0,
  "1h":  1 * 60 * 60 * 1000,
  "6h":  6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d":  24 * 60 * 60 * 1000,
  "1w":  7 * 24 * 60 * 60 * 1000,
  "15d": 15 * 24 * 60 * 60 * 1000,
  "1m":  30 * 24 * 60 * 60 * 1000, // aproximado
};

// ===== Jobs (progreso y logs) =====
const jobs = new Map(); // jobId -> { id, type, server_id, percent, status, logs, started_at, ended_at, extra }

function newJob(type, server_id) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const job = { id, type, server_id, percent: 0, status: "running", logs: [], started_at: new Date().toISOString(), ended_at: null, extra: {} };
  jobs.set(id, job);
  return job;
}
function logJob(job, line) {
  const msg = `[${new Date().toLocaleTimeString()}] ${line}`;
  job.logs.push(msg);
}
function finishJob(job, ok, add = "") {
  job.status = ok ? "done" : "failed";
  job.percent = ok ? 100 : job.percent;
  job.ended_at = new Date().toISOString();
  if (add) logJob(job, add);
}

// ===== Helpers =====
function msFromKey(key = "off") {
  return SCHEDULES[key] ?? 0;
}
function computeNextRun(intervalMs, from = Date.now()) {
  if (!intervalMs) return null;
  return new Date(from + intervalMs).toISOString();
}
function ensureServerDir(serverId) {
  const dir = path.join(BACKUP_DIR, `server_${serverId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); opts.onStdout && opts.onStdout(d.toString()); });
    child.stderr.on("data", d => { stderr += d.toString(); opts.onStderr && opts.onStderr(d.toString()); });
    child.on("close", code => {
      (code === 0) ? resolve({ code, stdout, stderr }) : reject(Object.assign(new Error(`Command failed (${cmd} ${args.join(" ")})`), { code, stdout, stderr }));
    });
  });
}

// ===== Operación: Hacer backup =====
async function doBackup(serverRow, job) {
  const { id: server_id, ip, ssh_user, ssh_pass } = serverRow;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const remoteFile = `/tmp/sup-backup-${ts}.tgz`;
  const localDir = ensureServerDir(server_id);
  const localFile = path.join(localDir, path.basename(remoteFile));

  logJob(job, `Iniciando backup de ${ip} (usuario ${ssh_user})...`);
  job.percent = 5;

  // 1) Crear tar en remoto
  const tarCmd = [
    "-e", "sshpass", "-e",
    "ssh", "-o", "StrictHostKeyChecking=no", `${ssh_user}@${ip}`,
    `tar --numeric-owner --xattrs --acls --one-file-system -czpf ${remoteFile} \
--exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run --exclude=/tmp --exclude=/mnt --exclude=/media --exclude=/lost+found /`
  ];
  try {
    await run("env", tarCmd, { env: { ...process.env, SSHPASS: ssh_pass }, onStderr: s => { /* tar progress no-op */ } });
    logJob(job, `Archivo remoto creado: ${remoteFile}`);
    job.percent = 40;
  } catch (e) {
    logJob(job, `Fallo creando tar remoto: ${e.stderr || e.message}`);
    throw e;
  }

  // 2) Descargar a local
  try {
    await run("env", ["sshpass","-e","scp","-o","StrictHostKeyChecking=no", `${ssh_user}@${ip}:${remoteFile}`, localFile], {
      env: { ...process.env, SSHPASS: ssh_pass },
      onStderr: s => { /* scp imprime progreso; omitimos parse */ },
    });
    logJob(job, `Descargado a: ${localFile}`);
    job.percent = 75;
  } catch (e) {
    logJob(job, `Fallo al descargar: ${e.stderr || e.message}`);
    throw e;
  }

  // 3) Limpiar remoto
  try {
    await run("env", ["sshpass","-e","ssh","-o","StrictHostKeyChecking=no", `${ssh_user}@${ip}`, `rm -f ${remoteFile}`], {
      env: { ...process.env, SSHPASS: ssh_pass },
    });
    logJob(job, `Limpieza remota ok`);
    job.percent = 85;
  } catch (e) {
    logJob(job, `No se pudo limpiar remoto (continuo): ${e.stderr || e.message}`);
  }

  // 4) Guardar registro
  const size = fs.statSync(localFile).size;
  db.prepare(`INSERT INTO backups (server_id, filename, size_bytes, status) VALUES (?,?,?, 'done')`)
    .run(server_id, path.basename(localFile), size);
  db.prepare(`UPDATE servers SET last_run = datetime('now') WHERE id = ?`).run(server_id);

  job.percent = 100;
  logJob(job, `Backup finalizado (${(size/1e9).toFixed(2)} GB)`);
}

// ===== Operación: Restaurar backup =====
async function doRestore({ backupRow, target }, job) {
  const server_id = backupRow.server_id;
  const srv = db.prepare("SELECT * FROM servers WHERE id = ?").get(server_id);
  if (!srv) throw new Error("Servidor de origen no encontrado");

  // Target: same or other
  const targetIP   = target.mode === "same" ? srv.ip        : target.ip;
  const targetUser = target.mode === "same" ? srv.ssh_user  : (target.ssh_user || "root");
  const targetPass = target.mode === "same" ? srv.ssh_pass  : target.ssh_pass;

  const localDir = ensureServerDir(server_id);
  const localFile = path.join(localDir, backupRow.filename);
  if (!fs.existsSync(localFile)) throw new Error("Archivo local no existe");

  const remoteFile = `/tmp/restore-${Date.now()}.tgz`;

  logJob(job, `Restaurando en ${targetIP} (usuario ${targetUser})...`);
  job.percent = 5;

  // 1) Subir archivo
  try {
    await run("env", ["sshpass","-e","scp","-o","StrictHostKeyChecking=no", localFile, `${targetUser}@${targetIP}:${remoteFile}`], {
      env: { ...process.env, SSHPASS: targetPass },
      onStderr: s => {},
    });
    logJob(job, `Subido ${path.basename(localFile)} a remoto`);
    job.percent = 45;
  } catch (e) {
    logJob(job, `Fallo al subir: ${e.stderr || e.message}`);
    throw e;
  }

  // 2) Extraer en /
  try {
    await run("env", ["sshpass","-e","ssh","-o","StrictHostKeyChecking=no", `${targetUser}@${targetIP}`,
      `tar -xzpf ${remoteFile} -C / --same-owner --numeric-owner --xattrs --acls`], {
      env: { ...process.env, SSHPASS: targetPass },
      onStderr: s => {},
    });
    logJob(job, `Extracción completa en /`);
    job.percent = 85;
  } catch (e) {
    logJob(job, `Fallo al extraer: ${e.stderr || e.message}`);
    throw e;
  }

  // 3) Limpiar remoto
  try {
    await run("env", ["sshpass","-e","ssh","-o","StrictHostKeyChecking=no", `${targetUser}@${targetIP}`, `rm -f ${remoteFile}`], {
      env: { ...process.env, SSHPASS: targetPass },
    });
    logJob(job, `Limpieza remota ok. Considera reiniciar la VPS.`);
    job.percent = 100;
  } catch (e) {
    logJob(job, `No se pudo limpiar remoto (continuo): ${e.stderr || e.message}`);
  }
}

// ===== Scheduler por servidor =====
function clearTimer(serverId) {
  const t = timers.get(serverId);
  if (t) { clearInterval(t); timers.delete(serverId); }
}
function startTimer(serverRow) {
  clearTimer(serverRow.id);
  if (!serverRow.enabled || !serverRow.interval_ms) return;

  const intervalMs = serverRow.interval_ms;
  const next = computeNextRun(intervalMs);
  db.prepare("UPDATE servers SET next_run = ? WHERE id = ?").run(next, serverRow.id);

  const timer = setInterval(async () => {
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(serverRow.id);
    if (!row || !row.enabled) return;

    const job = newJob("backup", row.id);
    try {
      db.prepare(`INSERT INTO backups (server_id, filename, status) VALUES (?,?, 'running')`).run(row.id, `pending-${job.id}.tgz`);
      await doBackup(row, job);
      finishJob(job, true, "Backup automático ok.");
    } catch (e) {
      finishJob(job, false, `Error: ${e.message}`);
      db.prepare(`INSERT INTO backups (server_id, filename, status) VALUES (?,?, 'failed')`).run(row.id, `failed-${job.id}.tgz`);
    } finally {
      const next2 = computeNextRun(intervalMs);
      db.prepare("UPDATE servers SET next_run = ?, last_run = COALESCE(last_run, datetime('now')) WHERE id = ?").run(next2, row.id);
    }
  }, intervalMs);

  timers.set(serverRow.id, timer);
}

// Al iniciar, reprogramar todos
(function bootTimers() {
  const rows = db.prepare("SELECT * FROM servers").all();
  for (const r of rows) startTimer(r);
})();

// ===== Router del Panel =====
function createPanelRouter({ ensureAuth } = {}) {
  const router = express.Router();

  // Protección
  router.use((req, res, next) => ensureAuth ? ensureAuth(req, res, next) : next());
  router.use(express.json());

  // Página Panel
  router.get("/panel", (req, res) => {
    res.type("html").send(renderPanelPage());
  });

  // API: listar servidores
  router.get("/api/servers", (req, res) => {
    const rows = db.prepare("SELECT id,label,ip,ssh_user,schedule_key,interval_ms,enabled,last_run,next_run,created_at,updated_at FROM servers ORDER BY id ASC").all();
    res.json({ servers: rows });
  });

  // API: agregar servidor
  router.post("/api/servers", (req, res) => {
    const { label = "", ip = "", ssh_user = "root", ssh_pass = "", schedule_key = "off", enabled = false } = req.body || {};
    if (!ip || !ssh_pass) return res.status(400).json({ error: "ip y ssh_pass son requeridos" });

    const interval_ms = msFromKey(schedule_key);
    const next_run = interval_ms ? computeNextRun(interval_ms) : null;

    const info = db.prepare(`
      INSERT INTO servers (label, ip, ssh_user, ssh_pass, schedule_key, interval_ms, enabled, next_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(label.trim(), ip.trim(), ssh_user.trim() || "root", ssh_pass, schedule_key, interval_ms, enabled ? 1 : 0, next_run);

    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(info.lastInsertRowid);
    startTimer(row);
    res.json({ server: { id: row.id, label: row.label, ip: row.ip, ssh_user: row.ssh_user, schedule_key: row.schedule_key, interval_ms: row.interval_ms, enabled: !!row.enabled, last_run: row.last_run, next_run: row.next_run } });
  });

  // API: actualizar programación/estado
  router.put("/api/servers/:id", (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    const { schedule_key, enabled } = req.body || {};
    const updates = [];
    const params = [];

    if (typeof schedule_key === "string") {
      const interval_ms = msFromKey(schedule_key);
      updates.push("schedule_key = ?", "interval_ms = ?", "next_run = ?");
      params.push(schedule_key, interval_ms, interval_ms ? computeNextRun(interval_ms) : null);
    }
    if (typeof enabled === "boolean") {
      updates.push("enabled = ?");
      params.push(enabled ? 1 : 0);
    }

    if (!updates.length) return res.json({ ok: true });

    const sql = `UPDATE servers SET ${updates.join(", ")} WHERE id = ?`;
    params.push(id);
    db.prepare(sql).run(...params);

    const updated = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    startTimer(updated);
    res.json({ server: { id: updated.id, label: updated.label, ip: updated.ip, ssh_user: updated.ssh_user, schedule_key: updated.schedule_key, interval_ms: updated.interval_ms, enabled: !!updated.enabled, last_run: updated.last_run, next_run: updated.next_run } });
  });

  // API: backup manual ahora
  router.post("/api/servers/:id/backup-now", async (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    const job = newJob("backup", id);
    res.json({ job_id: job.id });

    (async () => {
      try {
        db.prepare(`INSERT INTO backups (server_id, filename, status) VALUES (?,?, 'running')`).run(id, `running-${job.id}.tgz`);
        await doBackup(row, job);
        finishJob(job, true, "Backup manual finalizado.");
      } catch (e) {
        finishJob(job, false, `Error: ${e.message}`);
        db.prepare(`INSERT INTO backups (server_id, filename, status) VALUES (?,?, 'failed')`).run(id, `failed-${job.id}.tgz`);
      }
    })();
  });

  // API: listar backups por servidor
  router.get("/api/backups", (req, res) => {
    const sid = +req.query.server_id;
    const rows = db.prepare("SELECT id, filename, size_bytes, status, created_at FROM backups WHERE server_id = ? ORDER BY id DESC").all(sid);
    res.json({ backups: rows });
  });

  // API: restaurar
  router.post("/api/restore", async (req, res) => {
    const { backup_id, mode, ip, ssh_user = "root", ssh_pass } = req.body || {};
    if (!backup_id) return res.status(400).json({ error: "backup_id requerido" });

    const b = db.prepare("SELECT * FROM backups WHERE id = ?").get(+backup_id);
    if (!b) return res.status(404).json({ error: "Backup no encontrado" });

    if (mode !== "same" && (!ip || !ssh_pass)) {
      return res.status(400).json({ error: "Para restaurar en otra VPS, ip y ssh_pass son requeridos" });
    }

    const job = newJob("restore", b.server_id);
    job.extra.backup_id = b.id;
    res.json({ job_id: job.id });

    (async () => {
      try {
        await doRestore({ backupRow: b, target: mode === "same" ? { mode } : { mode, ip, ssh_user, ssh_pass } }, job);
        finishJob(job, true, "Restauración completada. Se recomienda reiniciar la VPS restaurada.");
      } catch (e) {
        finishJob(job, false, `Error: ${e.message}`);
      }
    })();
  });

  // API: estado de job
  router.get("/api/job/:id", (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: "Job no encontrado" });
    res.json({
      id: j.id, type: j.type, server_id: j.server_id,
      percent: j.percent, status: j.status,
      logs: j.logs.slice(-200), started_at: j.started_at, ended_at: j.ended_at
    });
  });

  return router;
}

// ===== HTML Panel =====
function renderPanelPage() {
  // CDN logo pedido: https://cdn.russellxz.click/3c8ab72a.png
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SkyUltraPlus — Panel de Backups</title>
<style>
  :root {
    --bg:#ffffff; --fg:#0f172a; --muted:#64748b; --ring:#e5e7eb; --primary:#111827; --accent:#2563eb; --danger:#ef4444; --ok:#16a34a;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--ring)}
  header img{width:40px;height:40px}
  h1{font-size:18px;margin:0}
  .sub{font-size:12px;color:var(--muted)}
  main{max-width:1100px;margin:0 auto;padding:20px;display:grid;gap:18px}
  .card{border:1px solid var(--ring);border-radius:12px;padding:16px}
  .row{display:grid;gap:10px}
  .grid{display:grid;gap:12px}
  .grid.cols-2{grid-template-columns:1fr 1fr}
  label{font-size:12px;color:var(--muted)}
  input,select{width:100%;padding:10px 12px;border:1px solid var(--ring);border-radius:10px;font-size:14px}
  button{padding:10px 12px;border:none;border-radius:10px;background:var(--primary);color:#fff;font-weight:600;cursor:pointer}
  button.secondary{background:#334155}
  button.link{background:transparent;color:var(--accent);padding:0}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px;border-bottom:1px solid var(--ring);text-align:left;font-size:14px}
  .small{font-size:12px;color:var(--muted)}
  .chip{display:inline-block;padding:4px 8px;border-radius:999px;font-size:12px;border:1px solid var(--ring)}
  .chip.on{background:#ecfdf5;color:#065f46;border-color:#a7f3d0}
  .chip.off{background:#fef2f2;color:#991b1b;border-color:#fecaca}
  .bar{height:8px;background:#f1f5f9;border-radius:999px;overflow:hidden}
  .bar > span{display:block;height:100%;background:linear-gradient(90deg,#60a5fa,#2563eb)}
  .flex{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .right{justify-content:flex-end}
  .warn{color:#991b1b}
  .ok{color:#065f46}
  .toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between}
</style>
</head>
<body>
<header>
  <img src="https://cdn.russellxz.click/3c8ab72a.png">
  <div>
    <h1>Sistema de Backup SkyUltraPlus</h1>
    <div class="sub">by Russell xz</div>
  </div>
  <div style="flex:1"></div>
  <form method="post" action="/logout"><button class="secondary">Salir</button></form>
  <a href="/usuarios"><button class="secondary">Usuarios</button></a>
</header>

<main>
  <section class="card">
    <div class="toolbar">
      <h2 style="margin:0;font-size:16px">Agregar VPS</h2>
    </div>
    <div class="grid cols-2">
      <div class="row">
        <label>Etiqueta (opcional)</label>
        <input id="label" placeholder="Mi VPS #1">
      </div>
      <div class="row">
        <label>IP</label>
        <input id="ip" placeholder="45.90.99.19">
      </div>
      <div class="row">
        <label>Usuario SSH</label>
        <input id="ssh_user" value="root">
      </div>
      <div class="row">
        <label>Contraseña SSH</label>
        <input id="ssh_pass" type="password" placeholder="••••••••">
      </div>
      <div class="row">
        <label>Programa</label>
        <select id="schedule_key">
          <option value="off">Apagado</option>
          <option value="1h">Cada 1 hora</option>
          <option value="6h">Cada 6 horas</option>
          <option value="12h">Cada 12 horas</option>
          <option value="1d">Cada día</option>
          <option value="1w">Cada semana</option>
          <option value="15d">Cada 15 días</option>
          <option value="1m">Cada mes</option>
        </select>
      </div>
      <div class="row" style="align-self:end">
        <button onclick="addServer()">Agregar</button>
      </div>
    </div>
    <div class="small">Requisitos remotos: <code>tar</code>. En tu servidor central instala <code>sshpass</code> (y recomendable también en remotos).</div>
  </section>

  <section class="card">
    <div class="toolbar">
      <h2 style="margin:0;font-size:16px">Servidores configurados</h2>
      <div class="small">La cuenta regresiva se actualiza en vivo (cliente).</div>
    </div>
    <div class="row" id="servers-wrap"></div>
  </section>

  <section class="card">
    <h2 style="margin:0 0 10px;font-size:16px">Restaurar backup</h2>
    <div class="grid cols-2">
      <div class="row">
        <label>Servidor (origen de backup)</label>
        <select id="restore_server"></select>
      </div>
      <div class="row">
        <label>Backup disponible</label>
        <select id="restore_backup"></select>
      </div>
      <div class="row">
        <label>Destino</label>
        <select id="restore_mode" onchange="toggleRestoreMode()">
          <option value="same">Misma VPS</option>
          <option value="other">Otra VPS</option>
        </select>
      </div>
      <div class="row restore-other" style="display:none">
        <label>IP destino</label>
        <input id="dst_ip" placeholder="1.2.3.4">
      </div>
      <div class="row restore-other" style="display:none">
        <label>Usuario destino</label>
        <input id="dst_user" value="root">
      </div>
      <div class="row restore-other" style="display:none">
        <label>Contraseña destino</label>
        <input id="dst_pass" type="password" placeholder="••••••••">
      </div>
      <div class="row" style="align-self:end">
        <button onclick="restore()">Restaurar</button>
      </div>
    </div>
    <div id="restore_job" class="row" style="margin-top:12px;display:none">
      <div class="bar"><span id="restore_bar" style="width:0%"></span></div>
      <div id="restore_log" class="small"></div>
    </div>
  </section>
</main>

<script>
let servers = [];
let jobs = {};

function fmt(dt){ if(!dt) return "-"; return new Date(dt).toLocaleString(); }
function left(ms){
  if (ms<=0) return "00:00:00";
  const s = Math.floor(ms/1000);
  const hh = String(Math.floor(s/3600)).padStart(2,"0");
  const mm = String(Math.floor((s%3600)/60)).padStart(2,"0");
  const ss = String(s%60).padStart(2,"0");
  return \`\${hh}:\${mm}:\${ss}\`;
}

async function loadServers(){
  const r = await fetch('/api/servers'); const j = await r.json();
  servers = j.servers || [];
  renderServers();
  fillRestoreServers();
}
function renderServers(){
  const wrap = document.getElementById('servers-wrap');
  if (!servers.length){ wrap.innerHTML = '<div class="small">No hay servidores configurados.</div>'; return; }
  wrap.innerHTML = '';
  servers.forEach(s=>{
    const id = 'srv_'+s.id;
    const row = document.createElement('div');
    row.className='row';
    row.innerHTML = \`
      <div class="grid cols-2" style="align-items:end">
        <div class="row">
          <div><strong>\${s.label || '(sin etiqueta)'} — \${s.ip}</strong></div>
          <div class="small">Usuario: \${s.ssh_user}</div>
          <div class="small">Último: \${fmt(s.last_run)} | Próximo: <span data-next="\${s.next_run || ''}" class="countdown"></span></div>
          <div class="small">Programa: \${s.schedule_key} — Estado: <span class="chip \${s.enabled?'on':'off'}">\${s.enabled?'ON':'OFF'}</span></div>
        </div>
        <div class="flex right">
          <select id="sch_\${s.id}">
            <option value="off" \${s.schedule_key==='off'?'selected':''}>Apagado</option>
            <option value="1h" \${s.schedule_key==='1h'?'selected':''}>Cada 1 hora</option>
            <option value="6h" \${s.schedule_key==='6h'?'selected':''}>Cada 6 horas</option>
            <option value="12h" \${s.schedule_key==='12h'?'selected':''}>Cada 12 horas</option>
            <option value="1d" \${s.schedule_key==='1d'?'selected':''}>Cada día</option>
            <option value="1w" \${s.schedule_key==='1w'?'selected':''}>Cada semana</option>
            <option value="15d" \${s.schedule_key==='15d'?'selected':''}>Cada 15 días</option>
            <option value="1m" \${s.schedule_key==='1m'?'selected':''}>Cada mes</option>
          </select>
          <button onclick="saveSched(\${s.id})">Guardar</button>
          <button onclick="toggleServer(\${s.id}, \${!s.enabled})">\${s.enabled?'Desactivar':'Activar'}</button>
          <button onclick="manual(\${s.id})">Backup ahora</button>
          <a class="link" href="#" onclick="loadBackups(\${s.id});return false;">Ver backups</a>
        </div>
      </div>
      <div id="bk_\${s.id}" class="row" style="display:none"></div>
      <div id="job_\${s.id}" class="row" style="display:none">
        <div class="bar"><span id="bar_\${s.id}" style="width:0%"></span></div>
        <div id="log_\${s.id}" class="small"></div>
      </div>
    \`;
    wrap.appendChild(row);
  });
  tickCountdowns();
}
function tickCountdowns(){
  const els = document.querySelectorAll('.countdown');
  els.forEach(el=>{
    const nx = el.getAttribute('data-next'); if (!nx){ el.textContent='-'; return; }
    const ms = new Date(nx) - new Date();
    el.textContent = left(ms);
  });
  setTimeout(tickCountdowns, 1000);
}

async function addServer(){
  const body = {
    label: document.getElementById('label').value,
    ip: document.getElementById('ip').value,
    ssh_user: document.getElementById('ssh_user').value || 'root',
    ssh_pass: document.getElementById('ssh_pass').value,
    schedule_key: document.getElementById('schedule_key').value,
    enabled: true
  };
  const r = await fetch('/api/servers',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  if (!r.ok){ alert('Error al agregar'); return; }
  await loadServers();
}

async function saveSched(id){
  const key = document.getElementById('sch_'+id).value;
  const r = await fetch('/api/servers/'+id,{method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({schedule_key:key})});
  if (r.ok) loadServers();
}
async function toggleServer(id, enabled){
  const r = await fetch('/api/servers/'+id,{method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({enabled})});
  if (r.ok) loadServers();
}

async function manual(id){
  const r = await fetch('/api/servers/'+id+'/backup-now',{method:'POST'});
  const j = await r.json();
  if (!r.ok){ alert(j.error||'Error'); return; }
  jobs[id] = j.job_id;
  document.getElementById('job_'+id).style.display='';
  pollJob(id);
}
async function pollJob(id){
  const jobId = jobs[id];
  if (!jobId) return;
  const r = await fetch('/api/job/'+jobId);
  if (!r.ok) return;
  const j = await r.json();
  const bar = document.getElementById('bar_'+id);
  const log = document.getElementById('log_'+id);
  bar.style.width = (j.percent||0)+'%';
  log.innerHTML = (j.logs||[]).map(l=>l.replace(/</g,'&lt;')).join('<br>');
  if (j.status === 'running') {
    setTimeout(()=>pollJob(id), 1000);
  } else {
    setTimeout(loadServers, 1200);
  }
}

async function loadBackups(server_id){
  const box = document.getElementById('bk_'+server_id);
  box.style.display = '';
  box.innerHTML = '<div class="small">Cargando...</div>';
  const r = await fetch('/api/backups?server_id='+server_id);
  const j = await r.json();
  if (!j.backups || !j.backups.length){ box.innerHTML = '<div class="small">Sin backups aún.</div>'; return; }
  let html = '<table><thead><tr><th>ID</th><th>Archivo</th><th>Tamaño</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>';
  html += j.backups.map(b=>{
    const sz = b.size_bytes!=null ? (b.size_bytes/1e9).toFixed(2)+' GB' : '-';
    return \`<tr><td>\${b.id}</td><td>\${b.filename}</td><td>\${sz}</td><td>\${b.status}</td><td>\${new Date(b.created_at).toLocaleString()}</td></tr>\`;
  }).join('');
  html += '</tbody></table>';
  box.innerHTML = html;
}

function fillRestoreServers(){
  const sel = document.getElementById('restore_server');
  sel.innerHTML = servers.map(s=>\`<option value="\${s.id}">\${s.label||'(sin etiqueta)'} — \${s.ip}</option>\`).join('');
  if (servers.length) loadRestoreBackups();
}
async function loadRestoreBackups(){
  const sid = document.getElementById('restore_server').value;
  const r = await fetch('/api/backups?server_id='+sid);
  const j = await r.json();
  const sel = document.getElementById('restore_backup');
  sel.innerHTML = (j.backups||[]).map(b=>\`<option value="\${b.id}">\${b.id} — \${b.filename}</option>\`).join('');
}

function toggleRestoreMode(){
  const mode = document.getElementById('restore_mode').value;
  const els = document.querySelectorAll('.restore-other');
  els.forEach(e=> e.style.display = (mode==='other')?'':'none');
}

async function restore(){
  const backup_id = document.getElementById('restore_backup').value;
  const mode = document.getElementById('restore_mode').value;
  const body = { backup_id, mode };
  if (mode === 'other') {
    body.ip = document.getElementById('dst_ip').value;
    body.ssh_user = document.getElementById('dst_user').value || 'root';
    body.ssh_pass = document.getElementById('dst_pass').value;
  }
  const r = await fetch('/api/restore',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  const j = await r.json();
  if (!r.ok){ alert(j.error||'Error'); return; }
  document.getElementById('restore_job').style.display='';
  pollRestore(j.job_id);
}
async function pollRestore(jobId){
  const r = await fetch('/api/job/'+jobId);
  if (!r.ok) return;
  const j = await r.json();
  document.getElementById('restore_bar').style.width = (j.percent||0)+'%';
  document.getElementById('restore_log').innerHTML = (j.logs||[]).map(l=>l.replace(/</g,'&lt;')).join('<br>');
  if (j.status === 'running') setTimeout(()=>pollRestore(jobId), 1000);
}

document.addEventListener('change', (e)=>{
  if (e.target && e.target.id==='restore_server') loadRestoreBackups();
});

loadServers();
</script>
</body>
</html>`;
}

// ===== exports =====
module.exports = { createPanelRouter };
