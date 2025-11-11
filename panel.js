// panel.js (REEMPLAZO COMPLETO) — Parte 1/4
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const { spawn } = require("child_process");
const { db } = require("./db");

// ===== Config =====
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const NICE = parseInt(process.env.BACKUP_NICE || "19", 10);
const IONICE_CLASS = parseInt(process.env.BACKUP_IONICE_CLASS || "3", 10);
const SCP_LIMIT_KBPS = parseInt(process.env.SCP_LIMIT_KBPS || "0", 10);

// Solo credenciales por defecto; red NO se preserva (se restaura)
const PRESERVE_AUTH_DEFAULT = (process.env.PRESERVE_AUTH || "1") === "1";
const PRESERVE_NET_DEFAULT  = (process.env.PRESERVE_NET  || "0") === "1";
const CLEAN_RESTORE_DEFAULT = (process.env.CLEAN_RESTORE || "1") === "1";

// ===== DB =====
db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS servers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    label        TEXT,
    ip           TEXT NOT NULL,
    ssh_user     TEXT NOT NULL DEFAULT 'root',
    ssh_pass     TEXT NOT NULL,
    schedule_key TEXT NOT NULL DEFAULT 'off',
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
    status      TEXT NOT NULL DEFAULT 'running',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS restores (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    backup_id        INTEGER NOT NULL,
    server_id_from   INTEGER NOT NULL,
    mode             TEXT NOT NULL,  -- same|other
    target_ip        TEXT,
    target_user      TEXT,
    target_server_id INTEGER,
    preserve_auth    INTEGER NOT NULL DEFAULT 1,
    note             TEXT,
    status           TEXT NOT NULL DEFAULT 'running',
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(backup_id)      REFERENCES backups(id) ON DELETE CASCADE,
    FOREIGN KEY(server_id_from) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TRIGGER IF NOT EXISTS trg_restores_updated_at
  AFTER UPDATE ON restores
  FOR EACH ROW BEGIN
    UPDATE restores SET updated_at = datetime('now') WHERE id = OLD.id;
  END;
`);

try { db.prepare("ALTER TABLE restores ADD COLUMN target_server_id INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE restores ADD COLUMN preserve_auth INTEGER NOT NULL DEFAULT 1").run(); } catch {}
try { db.prepare("ALTER TABLE restores ADD COLUMN note TEXT").run(); } catch {}

const timers = new Map();
const jobs = new Map();

const SCHEDULES = {
  off:   0,
  "1h":  1 * 60 * 60 * 1000,
  "6h":  6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d":  24 * 60 * 60 * 1000,
  "1w":  7 * 24 * 60 * 60 * 1000,
  "15d": 15 * 24 * 60 * 60 * 1000,
  "1m":  30 * 24 * 60 * 60 * 1000,
};

// ===== Jobs =====
function newJob(type, server_id) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const job = { id, type, server_id, percent: 0, status: "running", logs: [], started_at: new Date().toISOString(), ended_at: null, extra: {} };
  jobs.set(id, job);
  return job;
}
function logJob(job, line) { job.logs.push(`[${new Date().toLocaleTimeString()}] ${line}`); }
function finishJob(job, ok, add = "") {
  job.status = ok ? "done" : "failed";
  job.percent = ok ? 100 : job.percent;
  job.ended_at = new Date().toISOString();
  if (add) logJob(job, add);
}

// ===== Helpers =====
function msFromKey(key = "off") { return SCHEDULES[key] ?? 0; }
function computeNextRun(intervalMs, from = Date.now()) { return intervalMs ? new Date(from + intervalMs).toISOString() : null; }
function ensureServerDir(serverId) {
  const dir = path.join(BACKUP_DIR, `server_${serverId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function isLocalIP(ip) { return ["127.0.0.1", "localhost", "::1"].includes(String(ip).trim()); }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { const s = d.toString(); stdout += s; opts.onStdout && opts.onStdout(s); });
    child.stderr.on("data", d => { const s = d.toString(); stderr += s; opts.onStderr && opts.onStderr(s); });
    child.on("close", code => (code === 0) ? resolve({ code, stdout, stderr }) : reject(Object.assign(new Error(`Command failed: ${cmd} ${args.join(" ")}`), { code, stdout, stderr })));
  });
}
function parseScpPercent(line) { const m = line.match(/(\d+)%/); return m ? Math.min(100, Math.max(0, parseInt(m[1], 10))) : null; }

// ===== Exclusiones =====
// Auth/SSH solamente
const EXCLUDE_AUTH = [
  "etc/shadow","etc/shadow-","etc/gshadow","etc/gshadow-",
  "etc/passwd","etc/passwd-","etc/group","etc/group-",
  "etc/ssh/*","root/.ssh/*","home/*/.ssh/*"
];
// Red (opcional, por defecto NO se usa)
const EXCLUDE_NET = [
  "etc/netplan/*","etc/network/*","etc/resolv.conf",
  "etc/hostname","etc/hosts","etc/machine-id","etc/fstab"
];
// Fijos mínimos (no son /var): pseudo-FS + snap RO
const EXCLUDE_ALWAYS = [
  "proc/*","sys/*","dev/*","run/*","tmp/*","mnt/*","media/*","lost+found","snap/*"
];

function buildExcludeFlags(relList){ return relList.map(p=>`--exclude='${p}'`).join(" "); }
function buildExcludeFlagsAbs(relList){ return relList.map(p=>`--exclude='/${p}'`).join(" "); }
function buildRestoreExcludeFlags(preserveAuth, preserveNet){
  let arr = [...EXCLUDE_ALWAYS];
  if (preserveAuth) arr = arr.concat(EXCLUDE_AUTH);
  if (preserveNet)  arr = arr.concat(EXCLUDE_NET);
  return arr.length ? buildExcludeFlags(arr) : "";
}
function buildBackupExcludeFlagsAbs(){
  const arr = [...EXCLUDE_ALWAYS];
  return arr.length ? buildExcludeFlagsAbs(arr) : "";
}
function buildRsyncExcludeFlags(preserveAuth, preserveNet){
  let arr = [...EXCLUDE_ALWAYS];
  if (preserveAuth) arr = arr.concat(EXCLUDE_AUTH);
  if (preserveNet)  arr = arr.concat(EXCLUDE_NET);
  return arr.map(p=>`--exclude='${p}'`).join(" ");
}
// panel.js — Parte 2/4 (backup + restore + scheduler)

// ===== Backup =====
async function doBackup(serverRow, job, backupRecordId) {
  const { id: server_id, ip, ssh_user, ssh_pass } = serverRow;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const remoteTmp = `/tmp/sup-backup-${ts}.tgz`;
  const localDir = ensureServerDir(server_id);
  const localFile = path.join(localDir, path.basename(remoteTmp));

  db.prepare(`UPDATE backups SET filename = ? WHERE id = ?`).run(path.basename(localFile), backupRecordId);
  logJob(job, `Iniciando backup de ${ip} (${isLocalIP(ip) ? "local" : "remoto"})…`);

  const EX_ALWAYS_ABS = buildBackupExcludeFlagsAbs();
  job.percent = 5;

  try {
    if (isLocalIP(ip)) {
      const excludeSelf = `--exclude='${BACKUP_DIR.replace(/'/g, "'\\''")}'`;
      const tarLocalCmd = `
        if command -v pigz >/dev/null 2>&1; then
          nice -n ${NICE} ionice -c ${IONICE_CLASS} \
          tar --numeric-owner --xattrs --acls --one-file-system -cpf - \
            --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run \
            --exclude=/tmp --exclude=/mnt --exclude=/media --exclude=/lost+found \
            ${EX_ALWAYS_ABS} ${excludeSelf} / | pigz -1 > '${localFile}';
        else
          nice -n ${NICE} ionice -c ${IONICE_CLASS} \
          tar --numeric-owner --xattrs --acls --one-file-system -czpf '${localFile}' \
            --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run \
            --exclude=/tmp --exclude=/mnt --exclude=/media --exclude=/lost+found \
            ${EX_ALWAYS_ABS} ${excludeSelf} /;
        fi
      `;
      await run("bash", ["-lc", tarLocalCmd]);
      logJob(job, `Archivo local creado: ${localFile}`);
      job.percent = 85;
    } else {
      const tarRemoteCmd = `
        if command -v pigz >/dev/null 2>&1; then
          nice -n ${NICE} ionice -c ${IONICE_CLASS} \
          tar --numeric-owner --xattrs --acls --one-file-system -cpf - \
            --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run \
            --exclude=/tmp --exclude=/mnt --exclude=/media --exclude=/lost+found \
            ${EX_ALWAYS_ABS} / | pigz -1 > ${remoteTmp};
        else
          nice -n ${NICE} ionice -c ${IONICE_CLASS} \
          tar --numeric-owner --xattrs --acls --one-file-system -czpf ${remoteTmp} \
            --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run \
            --exclude=/tmp --exclude=/mnt --exclude=/media --exclude=/lost+found \
            ${EX_ALWAYS_ABS} /;
        fi
      `;
      await run("env", ["sshpass","-e","ssh","-o","StrictHostKeyChecking=no", `${ssh_user}@${ip}`, tarRemoteCmd],
        { env: { ...process.env, SSHPASS: ssh_pass }});
      logJob(job, `Archivo remoto creado: ${remoteTmp}`);
      job.percent = 35;

      const scpArgs = ["sshpass","-e","scp","-o","StrictHostKeyChecking=no"];
      if (SCP_LIMIT_KBPS > 0) scpArgs.push("-l", String(SCP_LIMIT_KBPS));
      scpArgs.push(`${ssh_user}@${ip}:${remoteTmp}`, localFile);

      await run("env", scpArgs, {
        env: { ...process.env, SSHPASS: ssh_pass },
        onStderr: s => { const p = parseScpPercent(s); if (p != null) job.percent = 35 + Math.floor(p * 0.5); }
      });
      logJob(job, `Descargado a: ${localFile}`);
      job.percent = Math.max(job.percent, 85);

      await run("env", ["sshpass","-e","ssh","-o","StrictHostKeyChecking=no", `${ssh_user}@${ip}`, `rm -f ${remoteTmp}`],
        { env: { ...process.env, SSHPASS: ssh_pass }});
      logJob(job, `Limpieza remota ok`);
    }
  } catch (e) {
    logJob(job, `Error durante backup: ${e.stderr || e.message}`);
    throw e;
  }

  const size = fs.statSync(localFile).size;
  db.prepare(`UPDATE backups SET size_bytes = ?, status = 'done' WHERE id = ?`).run(size, backupRecordId);
  db.prepare(`UPDATE servers SET last_run = datetime('now') WHERE id = ?`).run(server_id);

  job.percent = 100;
  logJob(job, `Backup finalizado (${(size/1e9).toFixed(2)} GB)`);
}

// ===== Restore (solo excluye auth/red si aplica; limpieza --delete) =====
async function doRestore({ backupRow, target, restoreRecordId, preserveAuth = PRESERVE_AUTH_DEFAULT, preserveNet = PRESERVE_NET_DEFAULT, cleanMode = CLEAN_RESTORE_DEFAULT }, job) {
  const srv = db.prepare("SELECT * FROM servers WHERE id = ?").get(backupRow.server_id);
  if (!srv) throw new Error("Servidor de origen no encontrado");

  const localDir = ensureServerDir(backupRow.server_id);
  const localFile = path.join(localDir, backupRow.filename);
  if (!fs.existsSync(localFile)) throw new Error("Archivo local no existe");

  const mode = target.mode;
  const targetIP   = mode === "same" ? srv.ip       : target.ip;
  const targetUser = mode === "same" ? srv.ssh_user : (target.ssh_user || "root");
  const targetPass = mode === "same" ? srv.ssh_pass : target.ssh_pass;

  const EX_TAR_RESTORE = buildRestoreExcludeFlags(preserveAuth, preserveNet);
  const EX_RSYNC = buildRsyncExcludeFlags(preserveAuth, preserveNet);

  if (preserveAuth) logJob(job, "Preservando SSH/usuarios.");
  if (preserveNet)  logJob(job, "Preservando red/hostname.");
  logJob(job, cleanMode ? "Limpieza activa (rsync --delete)." : "Limpieza desactivada.");

  logJob(job, `Restaurando en ${targetIP} (${isLocalIP(targetIP) ? "local" : "remoto"})…`);
  job.percent = 5;

  // Local
  if (isLocalIP(targetIP)) {
    try {
      if (cleanMode) {
        const script = `
          set -e
          TMPD=$(mktemp -d /tmp/rest.$RANDOM.XXXX)
          tar -xzpf '${localFile}' -C "$TMPD" --same-owner --numeric-owner --xattrs --acls
          if command -v rsync >/dev/null 2>&1; then
            rsync -aHAX --numeric-ids --delete --inplace --info=stats2,progress2 --omit-dir-times ${EX_RSYNC} "$TMPD"/ /
          else
            echo "rsync no disponible; restaurando con tar (sin borrar extras)"
            tar -xzpf '${localFile}' -C / --same-owner --numeric-owner --xattrs --acls ${EX_TAR_RESTORE}
          fi
          rm -rf "$TMPD"
        `;
        await run("bash", ["-lc", script]);
      } else {
        await run("bash", ["-lc", `tar -xzpf '${localFile}' -C / --same-owner --numeric-owner --xattrs --acls ${EX_TAR_RESTORE}`]);
      }
      job.percent = 95;
      logJob(job, `Extracción local completa.`);
    } catch (e) {
      logJob(job, `Fallo al restaurar local: ${e.stderr || e.message}`);
      throw e;
    }
    job.percent = 100;
    logJob(job, `Restauración lista. Recomiendo reiniciar.`);
    if (restoreRecordId) db.prepare(`UPDATE restores SET status='done', note=? WHERE id=?`).run(
      `${cleanMode?'clean+':''}${preserveAuth?'auth_preserved':'auth_overwritten'}`, restoreRecordId
    );
    return;
  }

  // Remoto
  const remoteTmp = `/tmp/restore-${Date.now()}.tgz`;

  try {
    const scpUp = ["sshpass","-e","scp","-o","StrictHostKeyChecking=no"];
    if (SCP_LIMIT_KBPS > 0) scpUp.push("-l", String(SCP_LIMIT_KBPS));
    scpUp.push(localFile, `${targetUser}@${targetIP}:${remoteTmp}`);
    await run("env", scpUp, {
      env: { ...process.env, SSHPASS: targetPass },
      onStderr: s => { const p = parseScpPercent(s); if (p != null) job.percent = 5 + Math.floor(p * 0.5); }
    });
    logJob(job, `Subido ${path.basename(localFile)} a remoto`);
    job.percent = Math.max(job.percent, 55);
  } catch (e) {
    logJob(job, `Fallo al subir: ${e.stderr || e.message}`);
    throw e;
  }

  try {
    const remoteScript = cleanMode ? `
      set -e
      TMPD=$(mktemp -d /tmp/rest.$RANDOM.XXXX)
      tar -xzpf ${remoteTmp} -C "$TMPD" --same-owner --numeric-owner --xattrs --acls
      if command -v rsync >/dev/null 2>&1; then
        rsync -aHAX --numeric-ids --delete --inplace --info=stats2,progress2 --omit-dir-times ${EX_RSYNC} "$TMPD"/ /
      else
        echo "rsync no disponible; restaurando con tar (sin borrar extras)"
        tar -xzpf ${remoteTmp} -C / --same-owner --numeric-owner --xattrs --acls ${EX_TAR_RESTORE}
      fi
      rm -rf "$TMPD" ${remoteTmp}
    ` : `
      set -e
      tar -xzpf ${remoteTmp} -C / --same-owner --numeric-owner --xattrs --acls ${EX_TAR_RESTORE}
      rm -f ${remoteTmp}
    `;
    await run("env", ["sshpass","-e","ssh","-o","StrictHostKeyChecking=no", `${targetUser}@${targetIP}`, remoteScript],
      { env: { ...process.env, SSHPASS: targetPass }});
    job.percent = 95;
    logJob(job, `Extracción completa.`);
  } catch (e) {
    logJob(job, `Fallo al extraer: ${e.stderr || e.message}`);
    throw e;
  }

  job.percent = 100;
  if (restoreRecordId) db.prepare(`UPDATE restores SET status='done', note=? WHERE id=?`).run(
    `${cleanMode?'clean+':''}${preserveAuth?'auth_preserved':'auth_overwritten'}`, restoreRecordId
  );
}

// ===== Scheduler =====
function clearTimer(serverId) { const t = timers.get(serverId); if (t) { clearInterval(t); timers.delete(serverId); } }
function startTimer(serverRow) {
  clearTimer(serverRow.id);
  if (!serverRow.enabled || !serverRow.interval_ms) return;

  const intervalMs = serverRow.interval_ms;
  const schedule = setInterval(async () => {
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(serverRow.id);
    if (!row || !row.enabled) return;

    const job = newJob("backup", row.id);
    logJob(job, `Backup automático…`);
    try {
      const filename = `auto-${new Date().toISOString().replace(/[:.]/g,"-")}.tgz`;
      const ins = db.prepare(`INSERT INTO backups (server_id, filename, status) VALUES (?,?, 'running')`).run(row.id, filename);
      await doBackup(row, job, ins.lastInsertRowid);
      finishJob(job, true, "Backup automático ok.");
    } catch (e) {
      finishJob(job, false, `Error: ${e.message}`);
      db.prepare(`UPDATE backups SET status = 'failed' WHERE server_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).run(row.id);
    } finally {
      const next2 = computeNextRun(intervalMs);
      db.prepare("UPDATE servers SET next_run = ?, last_run = COALESCE(last_run, datetime('now')) WHERE id = ?").run(next2, row.id);
    }
  }, intervalMs);

  timers.set(serverRow.id, schedule);
  const next = computeNextRun(intervalMs);
  db.prepare("UPDATE servers SET next_run = ? WHERE id = ?").run(next, serverRow.id);
}
(function bootTimers(){ db.prepare("SELECT * FROM servers").all().forEach(startTimer); })();

// panel.js — Parte 3/4 (API REST)

function createPanelRouter({ ensureAuth } = {}) {
  const router = express.Router();
  router.use((req, res, next) => ensureAuth ? ensureAuth(req, res, next) : next());
  router.use(express.json());

  router.get("/panel", (req, res) => res.type("html").send(renderPanelPage()));

  router.get("/api/servers", (req, res) => {
    const rows = db.prepare("SELECT id,label,ip,ssh_user,schedule_key,interval_ms,enabled,last_run,next_run,created_at,updated_at FROM servers ORDER BY id ASC").all();
    res.json({ servers: rows });
  });

  router.post("/api/servers", (req, res) => {
    const { label = "", ip = "", ssh_user = "root", ssh_pass = "", schedule_key = "off", enabled = false } = req.body || {};
    if (!ip || (!isLocalIP(ip) && !ssh_pass)) return res.status(400).json({ error: "ip y ssh_pass son requeridos (127.0.0.1 no usa ssh_pass)" });
    const interval_ms = msFromKey(schedule_key);
    const next_run = interval_ms ? computeNextRun(interval_ms) : null;
    const info = db.prepare(`
      INSERT INTO servers (label, ip, ssh_user, ssh_pass, schedule_key, interval_ms, enabled, next_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(label.trim(), ip.trim(), (ssh_user || "root").trim(), ssh_pass, schedule_key, interval_ms, enabled ? 1 : 0, next_run);
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(info.lastInsertRowid);
    startTimer(row);
    res.json({ server: {
      id: row.id, label: row.label, ip: row.ip, ssh_user: row.ssh_user,
      schedule_key: row.schedule_key, interval_ms: row.interval_ms, enabled: !!row.enabled,
      last_run: row.last_run, next_run: row.next_run
    }});
  });

  router.put("/api/servers/:id", (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    const { schedule_key, enabled, label } = req.body || {};
    const updates = [], params = [];
    if (typeof label === "string") { updates.push("label = ?"); params.push(label); }
    if (typeof schedule_key === "string") {
      const interval_ms = msFromKey(schedule_key);
      updates.push("schedule_key = ?", "interval_ms = ?", "next_run = ?");
      params.push(schedule_key, interval_ms, interval_ms ? computeNextRun(interval_ms) : null);
    }
    if (typeof enabled === "boolean") { updates.push("enabled = ?"); params.push(enabled ? 1 : 0); }
    if (!updates.length) return res.json({ ok: true });

    db.prepare(`UPDATE servers SET ${updates.join(", ")} WHERE id = ?`).run(...params, id);
    const updated = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    startTimer(updated);
    res.json({ server: {
      id: updated.id, label: updated.label, ip: updated.ip, ssh_user: updated.ssh_user,
      schedule_key: updated.schedule_key, interval_ms: updated.interval_ms, enabled: !!updated.enabled,
      last_run: updated.last_run, next_run: updated.next_run
    }});
  });

  router.delete("/api/servers/:id", (req, res) => {
    const id = +req.params.id;
    const active = Array.from(jobs.values()).some(j => j.server_id === id && j.status === "running");
    if (active) return res.status(409).json({ error: "Hay un proceso en ejecución" });
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });
    clearTimer(id);
    db.prepare("DELETE FROM servers WHERE id = ?").run(id);
    const dir = path.join(BACKUP_DIR, `server_${id}`);
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  });

  router.post("/api/servers/:id/backup-now", async (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });
    const already = Array.from(jobs.values()).find(j => j.server_id === id && j.type === "backup" && j.status === "running");
    if (already) return res.status(409).json({ error: "Ya hay un backup en curso", job_id: already.id });

    const job = newJob("backup", id);
    const filename = `manual-${new Date().toISOString().replace(/[:.]/g,"-")}.tgz`;
    const ins = db.prepare(`INSERT INTO backups (server_id, filename, status) VALUES (?,?, 'running')`).run(id, filename);
    res.json({ job_id: job.id });

    (async () => {
      try { await doBackup(row, job, ins.lastInsertRowid); finishJob(job, true, "Backup manual finalizado."); }
      catch (e) { finishJob(job, false, `Error: ${e.message}`); db.prepare(`UPDATE backups SET status = 'failed' WHERE id = ?`).run(ins.lastInsertRowid); }
    })();
  });

  router.get("/api/backups", (req, res) => {
    const sid = +req.query.server_id;
    const rows = db.prepare("SELECT id, filename, size_bytes, status, created_at FROM backups WHERE server_id = ? ORDER BY id DESC").all(sid);
    res.json({ backups: rows });
  });

  router.get("/api/backups/download/:id", (req, res) => {
    const b = db.prepare("SELECT * FROM backups WHERE id = ?").get(+req.params.id);
    if (!b) return res.status(404).send("Backup no encontrado");
    const file = path.join(ensureServerDir(b.server_id), b.filename);
    if (!fs.existsSync(file)) return res.status(404).send("Archivo no existe");
    res.download(file);
  });

  router.delete("/api/backups/:id", (req, res) => {
    const b = db.prepare("SELECT * FROM backups WHERE id = ?").get(+req.params.id);
    if (!b) return res.status(404).json({ error: "Backup no encontrado" });
    const file = path.join(ensureServerDir(b.server_id), b.filename);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    db.prepare("DELETE FROM backups WHERE id = ?").run(+req.params.id);
    res.json({ ok: true });
  });

  router.post("/api/restore", async (req, res) => {
    const { backup_id, mode, ip, ssh_user = "root", ssh_pass, preserve_auth } = req.body || {};
    if (!backup_id) return res.status(400).json({ error: "backup_id requerido" });

    const b = db.prepare("SELECT * FROM backups WHERE id = ?").get(+backup_id);
    if (!b) return res.status(404).json({ error: "Backup no encontrado" });
    if (mode !== "same" && (!ip || !ssh_pass)) return res.status(400).json({ error: "Para otra VPS: ip y ssh_pass requeridos" });

    const srcSrv = db.prepare("SELECT * FROM servers WHERE id = ?").get(b.server_id);
    let target_server_id = null;
    if (mode === "same") target_server_id = srcSrv?.id || null;
    else if (ip) target_server_id = (db.prepare("SELECT id FROM servers WHERE ip = ?").get(String(ip).trim())?.id) || null;

    const preserveAuthFlag = typeof preserve_auth === "boolean" ? (preserve_auth ? 1 : 0) : (PRESERVE_AUTH_DEFAULT ? 1 : 0);

    const job = newJob("restore", b.server_id);
    job.extra.backup_id = b.id;

    const restIns = db.prepare(`
      INSERT INTO restores (backup_id, server_id_from, mode, target_ip, target_user, target_server_id, preserve_auth, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
    `).run(b.id, b.server_id, mode, mode === "same" ? null : ip, mode === "same" ? null : ssh_user, target_server_id, preserveAuthFlag);
    job.extra.restore_id = restIns.lastInsertRowid;

    res.json({ job_id: job.id });

    (async () => {
      try {
        await doRestore(
          { backupRow: b, target: mode === "same" ? { mode } : { mode, ip, ssh_user, ssh_pass }, restoreRecordId: restIns.lastInsertRowid, preserveAuth: !!preserveAuthFlag },
          job
        );
        finishJob(job, true, "Restauración completada. Recomiendo reiniciar.");
      } catch (e) {
        finishJob(job, false, `Error: ${e.message}`);
        if (restIns?.lastInsertRowid) db.prepare(`UPDATE restores SET status='failed', note=? WHERE id=?`).run(String(e.message || "error"), restIns.lastInsertRowid);
      }
    })();
  });

  router.get("/api/job/:id", (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: "Job no encontrado" });
    res.json({ id: j.id, type: j.type, server_id: j.server_id, percent: j.percent, status: j.status, logs: j.logs.slice(-200), started_at: j.started_at, ended_at: j.ended_at });
  });

  router.get("/api/jobs/active", (req, res) => {
    const all = Array.from(jobs.values()).filter(j => j.status === "running").map(j => ({
      id: j.id, type: j.type, server_id: j.server_id, percent: j.percent
    }));
    res.json({ active: all });
  });

  router.get("/api/restores", (req, res) => {
    const sid = +req.query.server_id;
    const rows = db.prepare(`
      SELECT r.id, r.backup_id, r.mode, r.target_ip, r.target_user, r.status, r.created_at, r.preserve_auth, r.note,
             b.filename,
             sf.label  AS source_label, sf.ip AS source_ip,
             st.label  AS target_label, st.ip AS target_ip2
      FROM restores r
      JOIN backups b ON b.id = r.backup_id
      JOIN servers sf ON sf.id = r.server_id_from
      LEFT JOIN servers st ON st.id = r.target_server_id
      WHERE r.server_id_from = ?
      ORDER BY r.id DESC
    `).all(sid);
    res.json({ restores: rows });
  });

  return router;
}

// panel.js — Parte 4/4 (UI)

function renderPanelPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SkyUltraPlus — Panel de Backups</title>
<style>
  :root { --bg:#fff; --fg:#0f172a; --muted:#64748b; --ring:#e5e7eb; --primary:#111827; --accent:#2563eb; --ok:#16a34a; --bad:#ef4444; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--ring)}
  header img{width:40px;height:40px} h1{font-size:18px;margin:0} .sub{font-size:12px;color:var(--muted)}
  main{max-width:1100px;margin:0 auto;padding:20px;display:grid;gap:18px}
  .card{border:1px solid var(--ring);border-radius:12px;padding:16px}
  .row{display:grid;gap:10px} .grid{display:grid;gap:12px} .grid.cols-2{grid-template-columns:1fr 1fr}
  label{font-size:12px;color:var(--muted)} input,select{width:100%;padding:10px 12px;border:1px solid var(--ring);border-radius:10px;font-size:14px}
  button{padding:10px 12px;border:none;border-radius:10px;background:var(--primary);color:#fff;font-weight:600;cursor:pointer}
  button.secondary{background:#334155} button.link{background:transparent;color:var(--accent);padding:0}
  table{width:100%;border-collapse:collapse} th,td{padding:10px;border-bottom:1px solid var(--ring);text-align:left;font-size:14px}
  .small{font-size:12px;color:var(--muted)} .chip{display:inline-block;padding:4px 8px;border-radius:999px;font-size:12px;border:1px solid var(--ring)}
  .on{background:#ecfdf5;color:#065f46;border-color:#a7f3d0} .off{background:#fef2f2;color:#991b1b;border-color:#fecaca}
  .bar{height:8px;background:#f1f5f9;border-radius:999px;overflow:hidden} .bar>span{display:block;height:100%;background:linear-gradient(90deg,#60a5fa,#2563eb)}
  .flex{display:flex;gap:10px;align-items:center;flex-wrap:wrap} .right{justify-content:flex-end}
  .state{font-weight:700}
  .ok{color:var(--ok)} .bad{color:var(--bad)}
</style>
</head>
<body>
<header>
  <img src="https://cdn.russellxz.click/3c8ab72a.png" alt="logo">
  <div><h1>Sistema de Backup SkyUltraPlus</h1><div class="sub">by Russell xz</div></div>
  <div style="flex:1"></div>
  <form method="post" action="/logout"><button class="secondary">Salir</button></form>
  <a href="/usuarios"><button class="secondary">Usuarios</button></a>
</header>

<main>
  <section class="card">
    <h2 style="margin:0 0 10px;font-size:16px">Agregar VPS</h2>
    <div class="grid cols-2">
      <div class="row"><label>Etiqueta (opcional)</label><input id="label" placeholder="Mi VPS #1"></div>
      <div class="row"><label>IP (usa 127.0.0.1 para self-backup)</label><input id="ip" placeholder="45.90.99.19"></div>
      <div class="row"><label>Usuario SSH</label><input id="ssh_user" value="root"></div>
      <div class="row"><label>Contraseña SSH</label><input id="ssh_pass" type="password" placeholder="••••••••"></div>
      <div class="row">
        <label>Programa</label>
        <select id="schedule_key">
          <option value="off">Apagado</option><option value="1h">Cada 1 hora</option><option value="6h">Cada 6 horas</option>
          <option value="12h">Cada 12 horas</option><option value="1d">Cada día</option><option value="1w">Cada semana</option>
          <option value="15d">Cada 15 días</option><option value="1m">Cada mes</option>
        </select>
      </div>
      <div class="row" style="align-self:end"><button onclick="addServer()">Agregar</button></div>
    </div>
    <div class="small">Requisitos: en este servidor <code>sshpass</code>. En remotos <code>tar</code> y (si quieres limpieza) <code>rsync</code>. Para self-backup usa IP <strong>127.0.0.1</strong> y deja la contraseña vacía.</div>
  </section>

  <section class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0;font-size:16px">Servidores</h2>
      <div class="small">Cuenta regresiva al próximo backup.</div>
    </div>
    <div id="servers-wrap" class="row"></div>
  </section>

  <section class="card">
    <h2 style="margin:0 0 10px;font-size:16px">Restaurar backup</h2>
    <div class="grid cols-2">
      <div class="row"><label>Servidor (origen)</label><select id="restore_server"></select></div>
      <div class="row"><label>Backup</label><select id="restore_backup"></select></div>
      <div class="row">
        <label>Destino</label>
        <select id="restore_mode" onchange="toggleRestoreMode()">
          <option value="same">Misma VPS</option>
          <option value="other">Otra VPS</option>
        </select>
      </div>
      <div class="row restore-other" style="display:none"><label>IP destino</label><input id="dst_ip" placeholder="1.2.3.4"></div>
      <div class="row restore-other" style="display:none"><label>Usuario destino</label><input id="dst_user" value="root"></div>
      <div class="row restore-other" style="display:none"><label>Contraseña destino</label><input id="dst_pass" type="password" placeholder="••••••••"></div>
      <div class="row" style="align-self:end"><button onclick="restore()">Restaurar</button></div>
    </div>
    <div id="restore_job" class="row" style="margin-top:12px;display:none">
      <div style="display:flex;gap:10px;align-items:center">
        <div class="bar" style="flex:1"><span id="restore_bar" style="width:0%"></span></div>
        <div id="restore_state" class="state small"></div>
      </div>
      <div id="restore_log" class="small"></div>
    </div>
  </section>
</main>

<script>
let servers = []; 
let jobsByServer = {};
let restoreJobId = null;

function fmt(dt){ if(!dt) return "-"; return new Date(dt).toLocaleString(); }
function left(ms){ if(ms<=0) return "00:00:00"; const s=Math.floor(ms/1000); const h=String(Math.floor(s/3600)).padStart(2,"0"); const m=String(Math.floor((s%3600)/60)).padStart(2,"0"); const ss=String(s%60).padStart(2,"0"); return \`\${h}:\${m}:\${ss}\`; }

async function loadServers(){ 
  const r=await fetch('/api/servers'); const j=await r.json(); 
  servers=j.servers||[]; 
  renderServers(); 
  fillRestoreServers(); 
  reattachActiveJobs();
}

function renderServers(){
  const wrap=document.getElementById('servers-wrap');
  if(!servers.length){ wrap.innerHTML='<div class="small">No hay servidores configurados.</div>'; return; }
  wrap.innerHTML='';
  servers.forEach(s=>{
    const row=document.createElement('div'); row.className='row';
    row.innerHTML=\`
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
          &nbsp;|&nbsp;
          <a class="link" href="#" onclick="loadRestores(\${s.id});return false;">Ver restauraciones</a>
          &nbsp;|&nbsp;
          <button class="secondary" onclick="delServer(\${s.id})" style="background:#b91c1c">Eliminar VPS</button>
        </div>
      </div>
      <div id="bk_\${s.id}" class="row" style="display:none"></div>
      <div id="rst_\${s.id}" class="row" style="display:none"></div>
      <div id="job_\${s.id}" class="row" style="display:none">
        <div style="display:flex;gap:10px;align-items:center">
          <div class="bar" style="flex:1"><span id="bar_\${s.id}" style="width:0%"></span></div>
          <div id="state_\${s.id}" class="state small"></div>
        </div>
        <div id="log_\${s.id}" class="small"></div>
      </div>\`;
    wrap.appendChild(row);
  });
  tickCountdowns();
}

function tickCountdowns(){
  const els=document.querySelectorAll('.countdown');
  els.forEach(el=>{ const nx=el.getAttribute('data-next'); if(!nx){ el.textContent='-'; return; } const ms=new Date(nx)-new Date(); el.textContent=left(ms); });
  setTimeout(tickCountdowns,1000);
}

async function addServer(){
  const body={
    label:document.getElementById('label').value,
    ip:document.getElementById('ip').value,
    ssh_user:document.getElementById('ssh_user').value||'root',
    ssh_pass:document.getElementById('ssh_pass').value,
    schedule_key:document.getElementById('schedule_key').value,
    enabled:true
  };
  const r=await fetch('/api/servers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json(); if(!r.ok){ alert(j.error||'Error al agregar'); return; }
  loadServers();
}
async function saveSched(id){
  const key=document.getElementById('sch_'+id).value;
  const r=await fetch('/api/servers/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({schedule_key:key})});
  if(r.ok) loadServers();
}
async function toggleServer(id, enabled){
  const r=await fetch('/api/servers/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
  if(r.ok) loadServers();
}
async function delServer(id){
  if(!confirm('¿Eliminar esta VPS? Se borrarán configuraciones y backups locales.')) return;
  const r=await fetch('/api/servers/'+id,{method:'DELETE'});
  const j=await r.json();
  if(!r.ok){ alert(j.error||'No se pudo eliminar'); return; }
  loadServers();
}

async function manual(id){
  const r=await fetch('/api/servers/'+id+'/backup-now',{method:'POST'});
  const j=await r.json(); if(!r.ok){ alert(j.error||'Error'); 
    if (j.job_id){ localStorage.setItem('job_server_'+id, j.job_id); document.getElementById('job_'+id).style.display=''; pollJob(id); }
    return; 
  }
  jobsByServer[id]=j.job_id; 
  localStorage.setItem('job_server_'+id, j.job_id);
  document.getElementById('job_'+id).style.display='';
  pollJob(id);
}
async function pollJob(id){
  const jobId=jobsByServer[id] || localStorage.getItem('job_server_'+id);
  if(!jobId) return;
  const r=await fetch('/api/job/'+jobId); 
  if(!r.ok){ return; }
  const j=await r.json();
  document.getElementById('bar_'+id).style.width=(j.percent||0)+'%';
  document.getElementById('log_'+id).innerHTML=(j.logs||[]).map(l=>l.replace(/</g,'&lt;')).join('<br>');
  document.getElementById('job_'+id).style.display='';
  const stEl=document.getElementById('state_'+id);
  if (j.status==='done'){ stEl.textContent='OK'; stEl.classList.add('ok'); stEl.classList.remove('bad'); localStorage.removeItem('job_server_'+id); }
  else if (j.status==='failed'){ stEl.textContent='Fallo'; stEl.classList.add('bad'); stEl.classList.remove('ok'); localStorage.removeItem('job_server_'+id); }
  else { stEl.textContent='En curso…'; stEl.classList.remove('ok','bad'); }
  if(j.status==='running') setTimeout(()=>pollJob(id),700); else setTimeout(loadServers,800);
}

async function reattachActiveJobs(){
  servers.forEach(s=>{
    const saved = localStorage.getItem('job_server_'+s.id);
    if (saved){ jobsByServer[s.id]=saved; document.getElementById('job_'+s.id).style.display=''; pollJob(s.id); }
  });
  const r=await fetch('/api/jobs/active'); const j=await r.json();
  (j.active||[]).forEach(jb=>{
    if (jb.type==='backup'){
      jobsByServer[jb.server_id]=jb.id;
      localStorage.setItem('job_server_'+jb.server_id, jb.id);
      document.getElementById('job_'+jb.server_id).style.display='';
      pollJob(jb.server_id);
    } else if (jb.type==='restore'){
      restoreJobId = jb.id;
      localStorage.setItem('restore_job', jb.id);
      document.getElementById('restore_job').style.display='';
      pollRestore(jb.id);
    }
  });
  const rj = localStorage.getItem('restore_job');
  if (rj){ restoreJobId = rj; document.getElementById('restore_job').style.display=''; pollRestore(rj); }
}

async function loadBackups(server_id){
  const box=document.getElementById('bk_'+server_id); box.style.display='';
  box.innerHTML='<div class="small">Cargando...</div>';
  const r=await fetch('/api/backups?server_id='+server_id); const j=await r.json();
  if(!j.backups || !j.backups.length){ box.innerHTML='<div class="small">Sin backups aún.</div>'; return; }
  let html='<table><thead><tr><th>ID</th><th>Archivo</th><th>Tamaño</th><th>Estado</th><th>Fecha</th><th>Acciones</th></tr></thead><tbody>';
  html+=j.backups.map(b=>{
    const sz=b.size_bytes!=null ? (b.size_bytes/1e9).toFixed(2)+' GB' : '-';
    const st = b.status === 'done' ? '<span class="ok state">OK</span>' : (b.status === 'failed' ? '<span class="bad state">Fallo</span>' : b.status);
    return \`<tr>
      <td>\${b.id}</td><td>\${b.filename}</td><td>\${sz}</td><td>\${st}</td><td>\${new Date(b.created_at).toLocaleString()}</td>
      <td>
        <a class="link" href="/api/backups/download/\${b.id}">Descargar</a>
        &nbsp;|&nbsp;<a class="link" href="#" onclick="delBackup(\${b.id}, \${server_id});return false;">Borrar</a>
      </td>
    </tr>\`;
  }).join('');
  html+='</tbody></table>';
  box.innerHTML=html;
}

async function loadRestores(server_id){
  const box=document.getElementById('rst_'+server_id); box.style.display='';
  box.innerHTML='<div class="small">Cargando...</div>';
  const r=await fetch('/api/restores?server_id='+server_id); const j=await r.json();
  if(!j.restores || !j.restores.length){ box.innerHTML='<div class="small">Aún no hay restauraciones.</div>'; return; }
  let html='<table><thead><tr><th>ID</th><th>Backup</th><th>Origen → Destino</th><th>Modo</th><th>SSH</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>';
  html+=j.restores.map(x=>{
    const dest = x.mode==='same'
      ? (x.target_label || x.source_label || 'Misma VPS')
      : (x.target_label ? (x.target_label + (x.target_ip2? ' ('+x.target_ip2+')':'')) : (x.target_ip || '-'));
    const origin = (x.source_label || '-') + (x.source_ip ? (' ('+x.source_ip+')') : '');
    const ssh = x.preserve_auth ? '<span class="chip on">Preservado</span>' : '<span class="chip off">Sobrescrito</span>';
    const st = x.status === 'done' ? '<span class="ok state">OK</span>' : (x.status === 'failed' ? '<span class="bad state">Fallo</span>' : x.status);
    return \`<tr>
      <td>\${x.id}</td>
      <td>\${x.backup_id} — \${x.filename}</td>
      <td>\${origin} → \${dest}</td>
      <td>\${x.mode}</td>
      <td>\${ssh}</td>
      <td>\${st}</td>
      <td>\${new Date(x.created_at).toLocaleString()}</td>
    </tr>\`;
  }).join('');
  html+='</tbody></table>';
  box.innerHTML=html;
}

async function delBackup(id, server_id){
  if(!confirm('¿Borrar este backup?')) return;
  const r=await fetch('/api/backups/'+id,{method:'DELETE'}); if(r.ok) loadBackups(server_id);
}

function fillRestoreServers(){
  const sel=document.getElementById('restore_server');
  sel.innerHTML=servers.map(s=>\`<option value="\${s.id}">\${s.label||'(sin etiqueta)'} — \${s.ip}</option>\`).join('');
  if(servers.length) loadRestoreBackups();
}
async function loadRestoreBackups(){
  const sid=document.getElementById('restore_server').value;
  const r=await fetch('/api/backups?server_id='+sid); const j=await r.json();
  const sel=document.getElementById('restore_backup');
  sel.innerHTML=(j.backups||[]).map(b=>\`<option value="\${b.id}">\${b.id} — \${b.filename}</option>\`).join('');
}

function toggleRestoreMode(){
  const mode=document.getElementById('restore_mode').value;
  document.querySelectorAll('.restore-other').forEach(e=> e.style.display=(mode==='other')?'':'none');
}

async function restore(){
  const backup_id=document.getElementById('restore_backup').value;
  const mode=document.getElementById('restore_mode').value;
  const body={ backup_id, mode }; // preserve_auth = true por backend; red no preservada por default
  if(mode==='other'){
    body.ip=document.getElementById('dst_ip').value;
    body.ssh_user=document.getElementById('dst_user').value || 'root';
    body.ssh_pass=document.getElementById('dst_pass').value;
  }
  const r=await fetch('/api/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json(); if(!r.ok){ alert(j.error||'Error'); return; }
  restoreJobId = j.job_id;
  localStorage.setItem('restore_job', j.job_id);
  document.getElementById('restore_job').style.display='';
  pollRestore(j.job_id);
}
async function pollRestore(jobId){
  const r=await fetch('/api/job/'+jobId); if(!r.ok) return;
  const j=await r.json();
  document.getElementById('restore_bar').style.width=(j.percent||0)+'%';
  document.getElementById('restore_log').innerHTML=(j.logs||[]).map(l=>l.replace(/</g,'&lt;')).join('<br>');
  const stEl=document.getElementById('restore_state');
  if (j.status==='done'){ stEl.textContent='OK'; stEl.classList.add('ok'); stEl.classList.remove('bad'); localStorage.removeItem('restore_job'); }
  else if (j.status==='failed'){ stEl.textContent='Fallo'; stEl.classList.add('bad'); stEl.classList.remove('ok'); localStorage.removeItem('restore_job'); }
  else { stEl.textContent='En curso…'; stEl.classList.remove('ok','bad'); }
  if(j.status==='running') setTimeout(()=>pollRestore(jobId),700);
}

document.addEventListener('change', (e)=>{ if(e.target && e.target.id==='restore_server') loadRestoreBackups(); });
loadServers();
</script>
</body>
</html>`;
}

module.exports = { createPanelRouter };
