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

