// panel.js — Sistema de backups Paymenter por SSH (DB-only / FULL + restore auto)
// Enfocado a Paymenter: backup DB + .env o carpeta Paymenter completa.

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

// Defaults (por si a futuro quieres preservar auth/net, aunque aquí es Paymenter-only)
const PRESERVE_AUTH_DEFAULT = (process.env.PRESERVE_AUTH || "1") === "1";
const PRESERVE_NET_DEFAULT  = (process.env.PRESERVE_NET  || "1") === "1";
const CLEAN_RESTORE_DEFAULT = (process.env.CLEAN_RESTORE || "1") === "1";

// Barrido de retención periódico
const RETENTION_SWEEP_MS = parseInt(
  process.env.RETENTION_SWEEP_MS || String(6 * 60 * 60 * 1000),
  10
);

// ===== DB (sqlite interna del panel) =====
db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS servers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    label           TEXT,
    ip              TEXT NOT NULL,
    ssh_user        TEXT NOT NULL DEFAULT 'root',
    ssh_pass        TEXT NOT NULL,

    pmtr_path       TEXT NOT NULL DEFAULT '/var/www/paymenter',
    db_host         TEXT NOT NULL DEFAULT '127.0.0.1',
    db_name         TEXT NOT NULL DEFAULT 'paymenter',
    db_user         TEXT NOT NULL DEFAULT 'paymenter',
    db_pass         TEXT NOT NULL DEFAULT '',

    schedule_key    TEXT NOT NULL DEFAULT 'off',
    interval_ms     INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 0,

    retention_key   TEXT NOT NULL DEFAULT 'off',
    retention_ms    INTEGER NOT NULL DEFAULT 0,

    last_run        TEXT,
    next_run        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
    type        TEXT NOT NULL DEFAULT 'full', -- 'db' | 'full'
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS restores (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    backup_id         INTEGER NOT NULL,
    server_id_from    INTEGER NOT NULL,
    mode              TEXT NOT NULL,  -- same|other
    target_ip         TEXT,
    target_user       TEXT,
    target_server_id  INTEGER,
    preserve_auth     INTEGER NOT NULL DEFAULT 1,
    note              TEXT,
    status            TEXT NOT NULL DEFAULT 'running',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(backup_id)      REFERENCES backups(id) ON DELETE CASCADE,
    FOREIGN KEY(server_id_from) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TRIGGER IF NOT EXISTS trg_restores_updated_at
  AFTER UPDATE ON restores
  FOR EACH ROW BEGIN
    UPDATE restores SET updated_at = datetime('now') WHERE id = OLD.id;
  END;
`);

// Migraciones suaves
try { db.prepare("ALTER TABLE servers ADD COLUMN pmtr_path TEXT NOT NULL DEFAULT '/var/www/paymenter'").run(); } catch {}
try { db.prepare("ALTER TABLE servers ADD COLUMN db_host   TEXT NOT NULL DEFAULT '127.0.0.1'").run(); } catch {}
try { db.prepare("ALTER TABLE servers ADD COLUMN db_name   TEXT NOT NULL DEFAULT 'paymenter'").run(); } catch {}
try { db.prepare("ALTER TABLE servers ADD COLUMN db_user   TEXT NOT NULL DEFAULT 'paymenter'").run(); } catch {}
try { db.prepare("ALTER TABLE servers ADD COLUMN db_pass   TEXT NOT NULL DEFAULT ''").run(); } catch {}
try { db.prepare("ALTER TABLE backups ADD COLUMN type TEXT NOT NULL DEFAULT 'full'").run(); } catch {}
try { db.prepare("ALTER TABLE servers ADD COLUMN retention_key TEXT NOT NULL DEFAULT 'off'").run(); } catch {}
try { db.prepare("ALTER TABLE servers ADD COLUMN retention_ms  INTEGER NOT NULL DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE restores ADD COLUMN target_server_id INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE restores ADD COLUMN preserve_auth INTEGER NOT NULL DEFAULT 1").run(); } catch {}
try { db.prepare("ALTER TABLE restores ADD COLUMN note TEXT").run(); } catch {}

// ===== Schedules / Retenciones =====
const timers = new Map(); // serverId -> setInterval
const jobs = new Map();   // jobId -> {id,type,server_id,percent,status,logs,started_at,ended_at,extra}

const SCHEDULES = {
  off: 0,
  "1h":  1 * 60 * 60 * 1000,
  "6h":  6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d":  24 * 60 * 60 * 1000,
  "1w":  7  * 24 * 60 * 60 * 1000,
  "15d": 15 * 24 * 60 * 60 * 1000,
  "1m":  30 * 24 * 60 * 60 * 1000,
};

const RETENTION_KEYS = {
  off: 0,
  "1d":   1  * 24 * 60 * 60 * 1000,
  "3d":   3  * 24 * 60 * 60 * 1000,
  "7d":   7  * 24 * 60 * 60 * 1000,
  "15d":  15 * 24 * 60 * 60 * 1000,
  "30d":  30 * 24 * 60 * 60 * 1000,
  "60d":  60 * 24 * 60 * 60 * 1000,
  "90d":  90 * 24 * 60 * 60 * 1000,
  "180d": 180* 24 * 60 * 60 * 1000,
  "schedx3": -3,
  "schedx7": -7,
};

// ===== Jobs =====
function newJob(type, server_id) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    type,
    server_id,
    percent: 0,
    status: "running",
    logs: [],
    started_at: new Date().toISOString(),
    ended_at: null,
    extra: {}
  };
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
function msFromKey(key = "off") { return SCHEDULES[key] ?? 0; }
function retentionMsFromKey(key = "off", intervalMs = 0) {
  if (!key || key === "off") return 0;
  if (RETENTION_KEYS[key] && RETENTION_KEYS[key] > 0) return RETENTION_KEYS[key];
  if (key.startsWith("schedx")) {
    const n = parseInt(key.replace("schedx", ""), 10);
    return intervalMs > 0 && !Number.isNaN(n) ? n * intervalMs : 0;
  }
  return 0;
}
function computeNextRun(intervalMs, from = Date.now()) {
  return intervalMs ? new Date(from + intervalMs).toISOString() : null;
}
function ensureServerDir(serverId) {
  const dir = path.join(BACKUP_DIR, `server_${serverId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function isLocalIP(ip) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(ip).trim());
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => {
      const s = d.toString();
      stdout += s;
      if (opts.onStdout) opts.onStdout(s);
    });
    child.stderr.on("data", d => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderr) opts.onStderr(s);
    });
    child.on("close", code => {
      if (code === 0) return resolve({ code, stdout, stderr });
      const err = new Error(`Command failed: ${cmd} ${args.join(" ")}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}
function parseScpPercent(line) {
  const m = line.match(/(\d+)%/);
  return m ? Math.min(100, Math.max(0, parseInt(m[1], 10))) : null;
}

// Limpieza de huella SSH (known_hosts)
async function sshPrepareHost(ip) {
  if (!ip || isLocalIP(ip)) return;
  const safeIp = String(ip).trim();
  const cmd = `
    set -e
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    if command -v ssh-keygen >/dev/null 2>&1; then
      ssh-keygen -R ${safeIp} >/dev/null 2>&1 || true
      ssh-keygen -R [${safeIp}]:22 >/dev/null 2>&1 || true
    fi
    sed -i "/${safeIp.replace(/\./g, "\\.")}[[:space:]]/d" ~/.ssh/known_hosts 2>/dev/null || true
  `;
  await run("bash", ["-lc", cmd]);
}

// ===== Exclusiones (root fs, casi no se usan aquí) =====
const EXCLUDE_ALWAYS = [
  "proc/*","sys/*","dev/*","run/*","tmp/*","mnt/*","media/*","lost+found","snap/*"
];
function buildExcludeFlagsAbs(relList) {
  return relList.map(p => `--exclude='/${p}'`).join(" ");
}

// ===== Retención =====
function cleanupBackupsForServer(serverRow, job = null) {
  const { id: server_id, retention_key, interval_ms } = serverRow;
  const effMs = retentionMsFromKey(retention_key, interval_ms);
  if (!effMs || effMs <= 0) return { deleted: 0 };

  const cutoff = Date.now() - effMs;
  const list = db.prepare(
    "SELECT id, filename, created_at FROM backups WHERE server_id = ? AND status = 'done' ORDER BY id ASC"
  ).all(server_id);

  let deleted = 0;
  for (const b of list) {
    const created = Date.parse(b.created_at);
    if (!Number.isFinite(created)) continue;
    if (created < cutoff) {
      const file = path.join(ensureServerDir(server_id), b.filename);
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      db.prepare("DELETE FROM backups WHERE id = ?").run(b.id);
      deleted++;
      if (job) logJob(job, `Retención: eliminado backup viejo #${b.id} (${b.filename}).`);
    }
  }
  if (job && deleted === 0) logJob(job, `Retención: no había backups para eliminar.`);
  return { deleted };
}

// Barrido global de retención
setInterval(() => {
  const servers = db.prepare("SELECT * FROM servers ORDER BY id ASC").all();
  for (const s of servers) cleanupBackupsForServer(s);
}, RETENTION_SWEEP_MS);
// ===== Scripts auxiliares (remotos) =====

// Script remoto DB-only (dump lógico + .env)
function buildRemoteDbOnlyBackupScript({ pmtr_path, db_host, db_name, db_user, db_pass }, outTar) {
  return `
    set -e
    TMPD=$(mktemp -d /tmp/pmtrdb.$RANDOM.XXXX)
    mkdir -p "$TMPD"
    ENVF="${pmtr_path}/.env"

    DB_HOST="${db_host}"
    DB_NAME="${db_name}"
    DB_USER="${db_user}"
    DB_PASS="${db_pass}"

    if [ -z "$DB_PASS" ] && [ -f "$ENVF" ]; then
      DB_HOST=$(grep -E '^DB_HOST=' "$ENVF" | head -n1 | cut -d= -f2- || echo "127.0.0.1")
      DB_NAME=$(grep -E '^DB_DATABASE=' "$ENVF" | head -n1 | cut -d= -f2- || echo "paymenter")
      DB_USER=$(grep -E '^DB_USERNAME=' "$ENVF" | head -n1 | cut -d= -f2- || echo "paymenter")
      DB_PASS=$(grep -E '^DB_PASSWORD=' "$ENVF" | head -n1 | cut -d= -f2- || echo "")
    fi

    echo "[DB-Only] Dump → $DB_NAME@$DB_HOST (user=$DB_USER)"
    if command -v mysqldump >/dev/null 2>&1; then
      mysqldump --single-transaction --quick --routines --triggers --events \
        -h"$DB_HOST" -u"$DB_USER" ${db_pass ? '${DB_PASS:+-p"$DB_PASS"}' : '${DB_PASS:+-p"$DB_PASS"}'} "$DB_NAME" | gzip -1 > "$TMPD/pmtr-db.sql.gz"
    else
      echo "mysqldump no encontrado"; exit 1
    fi

    if [ -f "$ENVF" ]; then cp -f "$ENVF" "$TMPD/.env"; fi

    tar -C "$TMPD" -czpf ${outTar} pmtr-db.sql.gz .env 2>/dev/null || \
    tar -C "$TMPD" -czpf ${outTar} pmtr-db.sql.gz || true
    rm -rf "$TMPD"
  `;
}

// Script remoto FULL (carpeta Paymenter completa + dump lógico en .sup-dumps)
function buildRemoteFullBackupScript({ pmtr_path, db_host, db_name, db_user, db_pass }, outTar) {
  return `
    set -e
    ENVF="${pmtr_path}/.env"
    DB_HOST="${db_host}"
    DB_NAME="${db_name}"
    DB_USER="${db_user}"
    DB_PASS="${db_pass}"

    if [ -z "$DB_PASS" ] && [ -f "$ENVF" ]; then
      DB_HOST=$(grep -E '^DB_HOST=' "$ENVF" | head -n1 | cut -d= -f2- || echo "127.0.0.1")
      DB_NAME=$(grep -E '^DB_DATABASE=' "$ENVF" | head -n1 | cut -d= -f2- || echo "paymenter")
      DB_USER=$(grep -E '^DB_USERNAME=' "$ENVF" | head -n1 | cut -d= -f2- || echo "paymenter")
      DB_PASS=$(grep -E '^DB_PASSWORD=' "$ENVF" | head -n1 | cut -d= -f2- || echo "")
    fi

    echo "[FULL] Dump → $DB_NAME@$DB_HOST (user=$DB_USER)"
    if command -v mysqldump >/dev/null 2>&1; then
      mkdir -p "${pmtr_path}/.sup-dumps"
      mysqldump --single-transaction --quick --routines --triggers --events \
        -h"$DB_HOST" -u"$DB_USER" ${db_pass ? '${DB_PASS:+-p"$DBPASS"}' : '${DB_PASS:+-p"$DB_PASS"}'} "$DB_NAME" | gzip -1 > "${pmtr_path}/.sup-dumps/sup-db.sql.gz"
    else
      echo "mysqldump no encontrado"; exit 1
    fi

    PARENT="$(dirname "${pmtr_path}")"
    BASEN="$(basename "${pmtr_path}")"

    if command -v pigz >/dev/null 2>&1; then
      nice -n ${NICE} ionice -c ${IONICE_CLASS} tar -C "$PARENT" -cpf - "$BASEN" | pigz -1 > ${outTar}
    else
      nice -n ${NICE} ionice -c ${IONICE_CLASS} tar -C "$PARENT" -czpf ${outTar} "$BASEN"
    fi
  `;
}

// Script para instalar dependencias de Paymenter en VPS nueva
function buildDepsScript() {
  return `
    set -e
    export DEBIAN_FRONTEND=noninteractive

    sudo apt -y update
    sudo apt -y install software-properties-common curl apt-transport-https ca-certificates gnupg tar unzip git

    if ! php -v 2>/dev/null | grep -q "PHP 8.3"; then
      sudo add-apt-repository -y ppa:ondrej/php || true
      sudo apt update -y
      sudo apt -y install php8.3 php8.3-common php8.3-cli php8.3-gd php8.3-mysql php8.3-mbstring php8.3-bcmath php8.3-xml php8.3-fpm php8.3-curl php8.3-zip php8.3-intl php8.3-redis
    fi

    if ! mysql --version 2>/dev/null | grep -q "MariaDB"; then
      curl -sSL https://downloads.mariadb.com/MariaDB/mariadb_repo_setup | sudo bash -s -- --mariadb-server-version="mariadb-10.11" || true
      sudo apt update -y
      sudo apt -y install mariadb-server
    fi

    sudo apt -y install nginx redis-server || true

    if ! command -v node >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt -y install nodejs
    fi
    if (! command -v npm >/dev/null 2>&1); then
      sudo apt -y install npm || true
    fi

    sudo systemctl enable mariadb || true
    sudo systemctl enable nginx || true
    sudo systemctl enable php8.3-fpm || true
    sudo systemctl enable redis-server || true

    sudo systemctl start mariadb || true
    sudo systemctl start nginx || true
    sudo systemctl start php8.3-fpm || true
    sudo systemctl start redis-server || true
  `;
}

// Script para importar DB y colocar .env en Paymenter
function buildDbImportScript(pmtr_path) {
  return `
    set -e
    ENVF="${pmtr_path}/.env"
    SRC_ENV="/tmp/pmtr-restore/.env"
    SRC_DUMP="/tmp/pmtr-restore/pmtr-db.sql.gz"
    mkdir -p "${pmtr_path}"

    if [ -f "$SRC_ENV" ]; then
      if [ -f "$ENVF" ]; then mv -f "$ENVF" "${pmtr_path}/.env.bak.$(date +%s)"; fi
      cp -f "$SRC_ENV" "$ENVF"
    fi

    if [ ! -f "$ENVF" ]; then
      echo ".env no encontrado; no puedo continuar."
      exit 1
    fi

    DB_HOST=$(grep -E '^DB_HOST=' "$ENVF" | head -n1 | cut -d= -f2-)
    DB_NAME=$(grep -E '^DB_DATABASE=' "$ENVF" | head -n1 | cut -d= -f2-)
    DB_USER=$(grep -E '^DB_USERNAME=' "$ENVF" | head -n1 | cut -d= -f2-)
    DB_PASS=$(grep -E '^DB_PASSWORD=' "$ENVF" | head -n1 | cut -d= -f2-)

    echo "[Restore] Preparando DB: $DB_NAME@$DB_HOST (user=$DB_USER)"

    sudo mysql -uroot -e "CREATE DATABASE IF NOT EXISTS \\\`${DB_NAME}\\\\\`;"
    sudo mysql -uroot -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'${DB_HOST}' IDENTIFIED BY '${DB_PASS}';" || true
    sudo mysql -uroot -e "GRANT ALL PRIVILEGES ON \\\`${DB_NAME}\\\\\`.* TO '${DB_USER}'@'${DB_HOST}' WITH GRANT OPTION;"
    sudo mysql -uroot -e "FLUSH PRIVILEGES;"

    if [ -f "$SRC_DUMP" ]; then
      echo "[Restore] Importando dump lógico…"
      gunzip -c "$SRC_DUMP" | mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME"
      echo "[Restore] Import OK."
    else
      if [ -f "${pmtr_path}/.sup-dumps/sup-db.sql.gz" ]; then
        echo "[Restore] Importando dump lógico desde .sup-dumps…"
        gunzip -c "${pmtr_path}/.sup-dumps/sup-db.sql.gz" | mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME"
        echo "[Restore] Import OK."
      else
        echo "[Restore] No se encontró dump; salto import."
      fi
    fi

    if id www-data >/dev/null 2>&1; then
      chown -R www-data:www-data "${pmtr_path}"
      find "${pmtr_path}" -type d -exec chmod 755 {} \\;
      find "${pmtr_path}" -type f -exec chmod 644 {} \\;
    fi

    if [ -f "${pmtr_path}/artisan" ]; then
      cd "${pmtr_path}"
      php artisan optimize:clear || true
      php artisan view:clear || true
      php artisan route:clear || true
      php artisan config:clear || true
    fi
  `;
}

// ===== BACKUP =====
async function doBackup(serverRow, job, backupRecordId, kind = "full") {
  const {
    id: server_id,
    ip,
    ssh_user,
    ssh_pass,
    pmtr_path,
    db_host,
    db_name,
    db_user,
    db_pass
  } = serverRow;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const remoteTmp = `/tmp/pmtr-backup-${kind}-${ts}.tgz`;
  const localDir = ensureServerDir(server_id);
  const localFile = path.join(localDir, path.basename(remoteTmp));

  db.prepare(`UPDATE backups SET filename = ?, type = ? WHERE id = ?`)
    .run(path.basename(localFile), kind, backupRecordId);

  logJob(job, `Iniciando backup ${kind.toUpperCase()} de ${ip} (${isLocalIP(ip) ? "local" : "remoto"})…`);
  job.percent = 5;

  try {
    if (isLocalIP(ip)) {
      const script =
        kind === "db"
          ? buildRemoteDbOnlyBackupScript({ pmtr_path, db_host, db_name, db_user, db_pass }, `'${localFile}'`)
          : buildRemoteFullBackupScript({ pmtr_path, db_host, db_name, db_user, db_pass }, `'${localFile}'`);
      await run("bash", ["-lc", script]);
      logJob(job, `Archivo local creado: ${localFile}`);
      job.percent = 90;
    } else {
      await sshPrepareHost(ip);
      const remoteScript =
        kind === "db"
          ? buildRemoteDbOnlyBackupScript({ pmtr_path, db_host, db_name, db_user, db_pass }, remoteTmp)
          : buildRemoteFullBackupScript({ pmtr_path, db_host, db_name, db_user, db_pass }, remoteTmp);

      await run(
        "env",
        ["sshpass", "-e", "ssh", "-o", "StrictHostKeyChecking=no", `${ssh_user}@${ip}`, remoteScript],
        { env: { ...process.env, SSHPASS: ssh_pass } }
      );

      logJob(job, `Archivo remoto creado: ${remoteTmp}`);
      job.percent = 35;

      await sshPrepareHost(ip);
      const scpArgs = ["sshpass", "-e", "scp", "-o", "StrictHostKeyChecking=no"];
      if (SCP_LIMIT_KBPS > 0) scpArgs.push("-l", String(SCP_LIMIT_KBPS));
      scpArgs.push(`${ssh_user}@${ip}:${remoteTmp}`, localFile);

      await run("env", scpArgs, {
        env: { ...process.env, SSHPASS: ssh_pass },
        onStderr: s => {
          const p = parseScpPercent(s);
          if (p != null) job.percent = 35 + Math.floor(p * 0.5);
        }
      });

      logJob(job, `Descargado a: ${localFile}`);
      job.percent = Math.max(job.percent, 90);

      await sshPrepareHost(ip);
      await run(
        "env",
        ["sshpass", "-e", "ssh", "-o", "StrictHostKeyChecking=no", `${ssh_user}@${ip}`, `rm -f ${remoteTmp}`],
        { env: { ...process.env, SSHPASS: ssh_pass } }
      );
      logJob(job, `Limpieza remota ok`);
    }
  } catch (e) {
    logJob(job, `Error durante backup: ${e.stderr || e.message}`);
    throw e;
  }

  const size = fs.existsSync(localFile) ? fs.statSync(localFile).size : 0;
  db.prepare(`UPDATE backups SET size_bytes = ?, status = 'done' WHERE id = ?`).run(size, backupRecordId);
  db.prepare(`UPDATE servers SET last_run = datetime('now') WHERE id = ?`).run(server_id);

  try {
    const rowNow = db.prepare("SELECT * FROM servers WHERE id = ?").get(server_id);
    const { deleted } = cleanupBackupsForServer(rowNow, job);
    if (deleted > 0) logJob(job, `Retención post-backup: ${deleted} eliminados.`);
  } catch (e) {
    logJob(job, `Retención post-backup falló: ${e.message || e}`);
  }

  job.percent = 100;
  logJob(job, `Backup ${kind.toUpperCase()} finalizado (${(size / 1e9).toFixed(2)} GB)`);
}

// ===== RESTORE =====
async function doRestore(
  {
    backupRow,
    target,
    restoreRecordId,
    preserveAuth = PRESERVE_AUTH_DEFAULT,
    preserveNet = PRESERVE_NET_DEFAULT,
    cleanMode = CLEAN_RESTORE_DEFAULT
  },
  job
) {
  const srv = db.prepare("SELECT * FROM servers WHERE id = ?").get(backupRow.server_id);
  if (!srv) throw new Error("Servidor de origen no encontrado");

  const localDir = ensureServerDir(backupRow.server_id);
  const localFile = path.join(localDir, backupRow.filename);
  if (!fs.existsSync(localFile)) throw new Error("Archivo local no existe");

  const mode = target.mode;
  const targetIP   = mode === "same" ? srv.ip       : target.ip;
  const targetUser = mode === "same" ? srv.ssh_user : (target.ssh_user || "root");
  const targetPass = mode === "same" ? srv.ssh_pass : target.ssh_pass;

  const kind = backupRow.type || "full";
  logJob(job, `Restaurando ${kind.toUpperCase()} en ${targetIP} (${isLocalIP(targetIP) ? "local" : "remoto"})…`);
  job.percent = 5;

  const remoteTmp  = `/tmp/restore-${Date.now()}.tgz`;
  const remoteWork = `/tmp/pmtr-restore`;

  const depsScript      = buildDepsScript();
  const importDbScript  = buildDbImportScript(srv.pmtr_path);

  // Restaurar en la misma VPS (local)
  if (isLocalIP(targetIP)) {
    try {
      await run("bash", ["-lc", depsScript]);
      await run("bash", ["-lc", `rm -rf '${remoteWork}' && mkdir -p '${remoteWork}'`]);
      await run("bash", ["-lc", `tar -xzpf '${localFile}' -C '${remoteWork}' --same-owner --numeric-owner --xattrs --acls || true`]);

      if (kind === "full") {
        const detect = await run("bash", ["-lc", `ls -1 '${remoteWork}' | head -n1`]);
        const extracted = detect.stdout.trim() || "paymenter";
        const src = path.posix.join(remoteWork, extracted);
        const dst = srv.pmtr_path;
        await run("bash", ["-lc", `mkdir -p "$(dirname '${dst}')" && rm -rf '${dst}' && mv '${src}' '${dst}'`]);
      }

      await run("bash", ["-lc", importDbScript]);

      job.percent = 100;
      logJob(job, `Restauración local OK.`);
      if (restoreRecordId) {
        db.prepare(`UPDATE restores SET status='done', note=? WHERE id=?`).run(
          `${kind}+${cleanMode ? "clean+" : ""}${preserveAuth ? "auth_preserved" : "auth_overwritten"}`,
          restoreRecordId
        );
      }
      return;
    } catch (e) {
      logJob(job, `Fallo al restaurar local: ${e.stderr || e.message}`);
      throw e;
    }
  }

  // Restaurar en VPS remota
  try {
    await sshPrepareHost(targetIP);
    const scpUp = ["sshpass", "-e", "scp", "-o", "StrictHostKeyChecking=no"];
    if (SCP_LIMIT_KBPS > 0) scpUp.push("-l", String(SCP_LIMIT_KBPS));
    scpUp.push(localFile, `${targetUser}@${targetIP}:${remoteTmp}`);

    await run("env", scpUp, {
      env: { ...process.env, SSHPASS: targetPass },
      onStderr: s => {
        const p = parseScpPercent(s);
        if (p != null) job.percent = 5 + Math.floor(p * 0.4);
      }
    });

    logJob(job, `Subido ${path.basename(localFile)} a remoto`);
    job.percent = Math.max(job.percent, 45);
  } catch (e) {
    logJob(job, `Fallo al subir: ${e.stderr || e.message}`);
    throw e;
  }

  try {
    await sshPrepareHost(targetIP);

    const remoteScript = `
      set -e
      ${depsScript}

      rm -rf '${remoteWork}'
      mkdir -p '${remoteWork}'
      tar -xzpf ${remoteTmp} -C '${remoteWork}' --same-owner --numeric-owner --xattrs --acls || true
      rm -f ${remoteTmp}

      ${kind === "full" ? `
        EXTR="$(ls -1 '${remoteWork}' | head -n1 || echo 'paymenter')"
        SRC="${remoteWork}/$EXTR"
        DST="${srv.pmtr_path}"
        sudo mkdir -p "$(dirname "$DST")"
        sudo rm -rf "$DST"
        sudo mv "$SRC" "$DST"
      ` : `
        # DB-only: solo .env + dump
      `}

      sudo rm -rf /tmp/pmtr-restore
      sudo mkdir -p /tmp/pmtr-restore
      if [ -f '${remoteWork}/pmtr-db.sql.gz' ]; then sudo mv '${remoteWork}/pmtr-db.sql.gz' /tmp/pmtr-restore/; fi
      if [ -f '${remoteWork}/.env' ]; then sudo mv '${remoteWork}/.env' /tmp/pmtr-restore/; fi

      ${importDbScript}

      sudo rm -rf '${remoteWork}'
    `;

    await run(
      "env",
      ["sshpass", "-e", "ssh", "-o", "StrictHostKeyChecking=no", `${targetUser}@${targetIP}`, remoteScript],
      { env: { ...process.env, SSHPASS: targetPass } }
    );

    job.percent = 98;
    logJob(job, `Extracción/instalación/import remotos OK.`);
  } catch (e) {
    logJob(job, `Fallo al extraer/importar: ${e.stderr || e.message}`);
    throw e;
  }

  job.percent = 100;
  if (restoreRecordId) {
    db.prepare(`UPDATE restores SET status='done', note=? WHERE id=?`).run(
      `${kind}+${cleanMode ? "clean+" : ""}${preserveAuth ? "auth_preserved" : "auth_overwritten"}`,
      restoreRecordId
    );
  }
}
// ===== Scheduler =====
function clearTimer(serverId) {
  const t = timers.get(serverId);
  if (t) {
    clearInterval(t);
    timers.delete(serverId);
  }
}

function startTimer(serverRow) {
  clearTimer(serverRow.id);
  if (!serverRow.enabled || !serverRow.interval_ms) return;

  const intervalMs = serverRow.interval_ms;

  const schedule = setInterval(async () => {
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(serverRow.id);
    if (!row || !row.enabled) return;

    const job = newJob("backup", row.id);
    logJob(job, `Backup automático (FULL Paymenter)…`);

    try {
      const filename = `auto-${new Date().toISOString().replace(/[:.]/g, "-")}.tgz`;
      const ins = db.prepare(
        `INSERT INTO backups (server_id, filename, status, type) VALUES (?,?, 'running','full')`
      ).run(row.id, filename);
      await doBackup(row, job, ins.lastInsertRowid, "full");
      finishJob(job, true, "Backup automático ok.");
    } catch (e) {
      finishJob(job, false, `Error: ${e.message}`);
      db.prepare(
        `UPDATE backups SET status = 'failed' WHERE server_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`
      ).run(row.id);
    } finally {
      try { cleanupBackupsForServer(row, null); } catch {}
      const next2 = computeNextRun(intervalMs);
      db.prepare(
        "UPDATE servers SET next_run = ?, last_run = COALESCE(last_run, datetime('now')) WHERE id = ?"
      ).run(next2, row.id);
    }
  }, intervalMs);

  timers.set(serverRow.id, schedule);
  const next = computeNextRun(intervalMs);
  db.prepare("UPDATE servers SET next_run = ? WHERE id = ?").run(next, serverRow.id);
}

(function bootTimers() {
  db.prepare("SELECT * FROM servers").all().forEach(startTimer);
})();

// ===== API + UI (backend JSON + HTML Panel) =====
function createPanelRouter({ ensureAuth } = {}) {
  const router = express.Router();

  router.use((req, res, next) => (ensureAuth ? ensureAuth(req, res, next) : next()));
  router.use(express.json());

  // Página principal del panel (HTML)
  router.get("/panel", (req, res) => {
    res.type("html").send(renderPanelPage());
  });

  // --- Servidores ---
  router.get("/api/servers", (req, res) => {
    const rows = db.prepare(`
      SELECT id,label,ip,ssh_user,pmtr_path,db_host,db_name,db_user,
             schedule_key,interval_ms,enabled,retention_key,retention_ms,
             last_run,next_run,created_at,updated_at
      FROM servers ORDER BY id ASC
    `).all();
    res.json({ servers: rows });
  });

  router.post("/api/servers", (req, res) => {
    const {
      label = "",
      ip = "",
      ssh_user = "root",
      ssh_pass = "",
      pmtr_path = "/var/www/paymenter",
      db_host = "127.0.0.1",
      db_name = "paymenter",
      db_user = "paymenter",
      db_pass = "",
      schedule_key = "off",
      enabled = false,
      retention_key = "off"
    } = req.body || {};

    if (!ip || (!isLocalIP(ip) && !ssh_pass)) {
      return res
        .status(400)
        .json({ error: "ip y ssh_pass son requeridos (127.0.0.1 no usa ssh_pass)" });
    }

    const interval_ms = msFromKey(schedule_key);
    const retention_ms = retentionMsFromKey(retention_key, interval_ms);
    const next_run = interval_ms ? computeNextRun(interval_ms) : null;

    const info = db.prepare(
      `INSERT INTO servers
       (label, ip, ssh_user, ssh_pass, pmtr_path, db_host, db_name, db_user, db_pass,
        schedule_key, interval_ms, enabled, retention_key, retention_ms, next_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      label.trim(),
      ip.trim(),
      (ssh_user || "root").trim(),
      ssh_pass,
      pmtr_path.trim(),
      db_host.trim(),
      db_name.trim(),
      db_user.trim(),
      db_pass,
      schedule_key,
      interval_ms,
      enabled ? 1 : 0,
      retention_key,
      retention_ms,
      next_run
    );

    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(info.lastInsertRowid);
    startTimer(row);

    res.json({
      server: {
        id: row.id,
        label: row.label,
        ip: row.ip,
        ssh_user: row.ssh_user,
        pmtr_path: row.pmtr_path,
        db_host: row.db_host,
        db_name: row.db_name,
        db_user: row.db_user,
        schedule_key: row.schedule_key,
        interval_ms: row.interval_ms,
        enabled: !!row.enabled,
        retention_key: row.retention_key,
        retention_ms: row.retention_ms,
        last_run: row.last_run,
        next_run: row.next_run
      }
    });
  });

  // Actualizar programa / retención / label / enabled + (opcionalmente) IP y datos Paymenter
  router.put("/api/servers/:id", (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    const {
      schedule_key,
      enabled,
      label,
      retention_key,
      ip,
      ssh_user,
      ssh_pass,
      pmtr_path,
      db_host,
      db_name,
      db_user,
      db_pass
    } = req.body || {};

    const updates = [];
    const params = [];

    if (typeof label === "string") {
      updates.push("label = ?");
      params.push(label);
    }

    if (typeof ip === "string" && ip.trim()) {
      updates.push("ip = ?");
      params.push(ip.trim());
    }

    if (typeof ssh_user === "string" && ssh_user.trim()) {
      updates.push("ssh_user = ?");
      params.push(ssh_user.trim());
    }
    if (typeof ssh_pass === "string") {
      updates.push("ssh_pass = ?");
      params.push(ssh_pass);
    }

    if (typeof pmtr_path === "string" && pmtr_path.trim()) {
      updates.push("pmtr_path = ?");
      params.push(pmtr_path.trim());
    }
    if (typeof db_host === "string" && db_host.trim()) {
      updates.push("db_host = ?");
      params.push(db_host.trim());
    }
    if (typeof db_name === "string" && db_name.trim()) {
      updates.push("db_name = ?");
      params.push(db_name.trim());
    }
    if (typeof db_user === "string" && db_user.trim()) {
      updates.push("db_user = ?");
      params.push(db_user.trim());
    }
    if (typeof db_pass === "string") {
      updates.push("db_pass = ?");
      params.push(db_pass);
    }

    let interval_ms = row.interval_ms;
    if (typeof schedule_key === "string") {
      interval_ms = msFromKey(schedule_key);
      updates.push("schedule_key = ?", "interval_ms = ?", "next_run = ?");
      params.push(schedule_key, interval_ms, interval_ms ? computeNextRun(interval_ms) : null);
    }

    if (typeof retention_key === "string") {
      const retention_ms = retentionMsFromKey(retention_key, interval_ms);
      updates.push("retention_key = ?", "retention_ms = ?");
      params.push(retention_key, retention_ms);
    }

    if (typeof enabled === "boolean") {
      updates.push("enabled = ?");
      params.push(enabled ? 1 : 0);
    }

    if (!updates.length) return res.json({ ok: true });

    db.prepare(`UPDATE servers SET ${updates.join(", ")} WHERE id = ?`).run(...params, id);
    const updated = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    startTimer(updated);

    res.json({
      server: {
        id: updated.id,
        label: updated.label,
        ip: updated.ip,
        ssh_user: updated.ssh_user,
        pmtr_path: updated.pmtr_path,
        db_host: updated.db_host,
        db_name: updated.db_name,
        db_user: updated.db_user,
        schedule_key: updated.schedule_key,
        interval_ms: updated.interval_ms,
        enabled: !!updated.enabled,
        retention_key: updated.retention_key,
        retention_ms: updated.retention_ms,
        last_run: updated.last_run,
        next_run: updated.next_run
      }
    });
  });

  // Actualizar credenciales SSH (atajo)
  router.put("/api/servers/:id/creds", (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    const { ssh_user, ssh_pass } = req.body || {};
    const updates = [];
    const params = [];

    if (typeof ssh_user === "string" && ssh_user.trim()) {
      updates.push("ssh_user = ?");
      params.push(ssh_user.trim());
    }
    if (typeof ssh_pass === "string") {
      updates.push("ssh_pass = ?");
      params.push(ssh_pass);
    }

    if (!updates.length) return res.status(400).json({ error: "Nada para actualizar" });

    db.prepare(`UPDATE servers SET ${updates.join(", ")} WHERE id = ?`).run(...params, id);
    const updated = db.prepare(`
      SELECT id,label,ip,ssh_user,pmtr_path,db_host,db_name,db_user,
             schedule_key,interval_ms,enabled,retention_key,retention_ms,
             last_run,next_run
      FROM servers WHERE id = ?
    `).get(id);
    res.json({ server: updated });
  });

  // Actualizar configuración Paymenter (ruta + DB creds) (atajo)
  router.put("/api/servers/:id/paymenter", (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    const { pmtr_path, db_host, db_name, db_user, db_pass } = req.body || {};
    const updates = [];
    const params = [];

    if (typeof pmtr_path === "string" && pmtr_path.trim()) {
      updates.push("pmtr_path = ?");
      params.push(pmtr_path.trim());
    }
    if (typeof db_host === "string" && db_host.trim()) {
      updates.push("db_host = ?");
      params.push(db_host.trim());
    }
    if (typeof db_name === "string" && db_name.trim()) {
      updates.push("db_name = ?");
      params.push(db_name.trim());
    }
    if (typeof db_user === "string" && db_user.trim()) {
      updates.push("db_user = ?");
      params.push(db_user.trim());
    }
    if (typeof db_pass === "string") {
      updates.push("db_pass = ?");
      params.push(db_pass);
    }

    if (!updates.length) return res.status(400).json({ error: "Nada para actualizar" });

    db.prepare(`UPDATE servers SET ${updates.join(", ")} WHERE id = ?`).run(...params, id);
    const updated = db.prepare(`
      SELECT id,label,ip,ssh_user,pmtr_path,db_host,db_name,db_user,
             schedule_key,interval_ms,enabled,retention_key,retention_ms,
             last_run,next_run
      FROM servers WHERE id = ?
    `).get(id);
    res.json({ server: updated });
  });

  router.delete("/api/servers/:id", (req, res) => {
    const id = +req.params.id;
    const active = Array.from(jobs.values()).some(
      j => j.server_id === id && j.status === "running"
    );
    if (active) return res.status(409).json({ error: "Hay un proceso en ejecución" });

    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    clearTimer(id);
    db.prepare("DELETE FROM servers WHERE id = ?").run(id);
    const dir = path.join(BACKUP_DIR, `server_${id}`);
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  });

  // --- Backups ---
  router.post("/api/servers/:id/backup-now", (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    const { kind = "full" } = req.body || {};
    if (!["db", "full"].includes(kind)) {
      return res.status(400).json({ error: "kind inválido (db|full)" });
    }

    const already = Array.from(jobs.values()).find(
      j => j.server_id === id && j.type === "backup" && j.status === "running"
    );
    if (already) return res.status(409).json({ error: "Ya hay un backup en curso", job_id: already.id });

    const job = newJob("backup", id);
    job.extra.kind = kind;
    const filename = `manual-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.tgz`;
    const ins = db.prepare(
      `INSERT INTO backups (server_id, filename, status, type) VALUES (?,?, 'running', ?)`
    ).run(id, filename, kind);

    res.json({ job_id: job.id });

    (async () => {
      try {
        await doBackup(row, job, ins.lastInsertRowid, kind);
        finishJob(job, true, "Backup manual finalizado.");
      } catch (e) {
        finishJob(job, false, `Error: ${e.message}`);
        db.prepare(`UPDATE backups SET status = 'failed' WHERE id = ?`).run(ins.lastInsertRowid);
      }
    })();
  });

  router.post("/api/servers/:id/cleanup", (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });
    const { deleted } = cleanupBackupsForServer(row);
    res.json({ ok: true, deleted });
  });

  router.get("/api/backups", (req, res) => {
    const sid = +req.query.server_id;
    const rows = db.prepare(`
      SELECT id, filename, size_bytes, status, type, created_at
      FROM backups WHERE server_id = ? ORDER BY id DESC
    `).all(sid);
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

  // --- Restore ---
  router.post("/api/restore", (req, res) => {
    const { backup_id, mode, ip, ssh_user = "root", ssh_pass, preserve_auth } = req.body || {};
    if (!backup_id) return res.status(400).json({ error: "backup_id requerido" });

    const b = db.prepare("SELECT * FROM backups WHERE id = ?").get(+backup_id);
    if (!b) return res.status(404).json({ error: "Backup no encontrado" });

    if (mode !== "same" && (!ip || !ssh_pass)) {
      return res.status(400).json({ error: "Para otra VPS: ip y ssh_pass requeridos" });
    }

    const srcSrv = db.prepare("SELECT * FROM servers WHERE id = ?").get(b.server_id);
    let target_server_id = null;
    if (mode === "same") target_server_id = srcSrv?.id || null;
    else if (ip) {
      const r = db.prepare("SELECT id FROM servers WHERE ip = ?").get(String(ip).trim());
      target_server_id = r ? r.id : null;
    }

    const preserveAuthFlag =
      typeof preserve_auth === "boolean"
        ? preserve_auth ? 1 : 0
        : PRESERVE_AUTH_DEFAULT ? 1 : 0;

    const job = newJob("restore", b.server_id);
    job.extra.backup_id = b.id;

    const restIns = db.prepare(
      `INSERT INTO restores
       (backup_id, server_id_from, mode, target_ip, target_user, target_server_id, preserve_auth, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`
    ).run(
      b.id,
      b.server_id,
      mode,
      mode === "same" ? null : ip,
      mode === "same" ? null : ssh_user,
      target_server_id,
      preserveAuthFlag
    );

    job.extra.restore_id = restIns.lastInsertRowid;
    res.json({ job_id: job.id });

    (async () => {
      try {
        await doRestore(
          {
            backupRow: b,
            target: mode === "same" ? { mode } : { mode, ip, ssh_user, ssh_pass },
            restoreRecordId: restIns.lastInsertRowid,
            preserveAuth: !!preserveAuthFlag
          },
          job
        );
        finishJob(job, true, "Restauración completada.");
      } catch (e) {
        finishJob(job, false, `Error: ${e.message}`);
        if (restIns?.lastInsertRowid) {
          db.prepare(`UPDATE restores SET status='failed', note=? WHERE id=?`).run(
            String(e.message || "error"),
            restIns.lastInsertRowid
          );
        }
      }
    })();
  });

  // Estado de job
  router.get("/api/job/:id", (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: "Job no encontrado" });
    res.json({
      id: j.id,
      type: j.type,
      server_id: j.server_id,
      percent: j.percent,
      status: j.status,
      logs: j.logs.slice(-200),
      started_at: j.started_at,
      ended_at: j.ended_at
    });
  });

  // Jobs activos
  router.get("/api/jobs/active", (req, res) => {
    const all = Array.from(jobs.values())
      .filter(j => j.status === "running")
      .map(j => ({
        id: j.id,
        type: j.type,
        server_id: j.server_id,
        percent: j.percent
      }));
    res.json({ active: all });
  });

  // Historial de restauraciones
  router.get("/api/restores", (req, res) => {
    const sid = +req.query.server_id;
    const rows = db.prepare(`
      SELECT r.id, r.backup_id, r.mode, r.target_ip, r.target_user, r.status,
             r.created_at, r.preserve_auth, r.note,
             b.filename, b.type,
             sf.label AS source_label, sf.ip AS source_ip,
             st.label AS target_label, st.ip AS target_ip2
      FROM restores r
      JOIN backups b ON b.id = r.backup_id
      JOIN servers sf ON sf.id = r.server_id_from
      LEFT JOIN servers st ON st.id = r.target_server_id
      WHERE r.server_id_from = ?
      ORDER BY r.id DESC
    `).all(sid);
    res.json({ restores: rows });
  });

  router.delete("/api/restores/:id", (req, res) => {
    const id = +req.params.id;
    const r = db.prepare("SELECT * FROM restores WHERE id = ?").get(id);
    if (!r) return res.status(404).json({ error: "Restore no encontrado" });
    db.prepare("DELETE FROM restores WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  return router;
}
// ===== UI HTML (panel web) =====
function renderPanelPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Backup Paymenter — SkyUltraPlus</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#0f172a;
    color:#e5e7eb;
  }
  .layout{
    display:flex;
    min-height:100vh;
  }
  .sidebar{
    width:320px;
    max-width:100%;
    background:#020617;
    border-right:1px solid #1f2937;
    padding:12px;
    display:flex;
    flex-direction:column;
    gap:10px;
  }
  .main{
    flex:1;
    padding:12px;
    display:flex;
    flex-direction:column;
    gap:10px;
  }
  h1{
    font-size:18px;
    margin-bottom:6px;
  }
  h2{
    font-size:14px;
    margin-bottom:4px;
  }
  .card{
    background:#020617;
    border:1px solid #111827;
    border-radius:10px;
    padding:10px;
  }
  .label-small{
    font-size:11px;
    color:#9ca3af;
  }
  .form-grid{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:6px 8px;
  }
  .field{
    display:flex;
    flex-direction:column;
    gap:3px;
  }
  .field input,.field select{
    background:#020617;
    border:1px solid #1f2937;
    border-radius:8px;
    padding:6px 7px;
    font-size:12px;
    color:#e5e7eb;
    outline:none;
  }
  .field input::placeholder{color:#6b7280}
  .field small{
    font-size:10px;
    color:#9ca3af;
  }
  .field input:focus,.field select:focus{
    border-color:#38bdf8;
  }
  .btn{
    border-radius:999px;
    border:1px solid #4b5563;
    background:#111827;
    color:#e5e7eb;
    padding:5px 10px;
    font-size:11px;
    cursor:pointer;
    display:inline-flex;
    align-items:center;
    gap:4px;
  }
  .btn-primary{
    border-color:#22c55e;
    background:#065f46;
  }
  .btn-danger{
    border-color:#f97373;
    background:#7f1d1d;
  }
  .btn-sm{
    padding:4px 8px;
    font-size:10px;
  }
  .servers-list{
    max-height:260px;
    overflow-y:auto;
    margin-top:4px;
  }
  .srv-item{
    border-radius:8px;
    padding:6px 8px;
    margin-bottom:4px;
    border:1px solid transparent;
    cursor:pointer;
    font-size:12px;
  }
  .srv-item:hover{
    background:#020617;
    border-color:#1f2937;
  }
  .srv-item.active{
    border-color:#38bdf8;
    background:#020617;
  }
  .srv-ip{
    font-size:11px;
    color:#9ca3af;
  }
  .badge{
    display:inline-block;
    border-radius:999px;
    padding:1px 7px;
    font-size:10px;
    border:1px solid #4b5563;
    color:#9ca3af;
    margin-left:4px;
  }
  .badge.green{
    border-color:#22c55e;
    color:#22c55e;
  }
  .badge.red{
    border-color:#f97373;
    color:#f97373;
  }
  .grid-main{
    display:grid;
    grid-template-columns:1.1fr 1.2fr;
    gap:10px;
    height:calc(100vh - 24px);
  }
  .scroll{
    overflow-y:auto;
  }
  .kv{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:6px 10px;
    font-size:12px;
  }
  .kv-label{
    font-size:11px;
    color:#9ca3af;
  }
  .kv-val{
    font-size:12px;
    word-break:break-all;
  }
  table{
    width:100%;
    border-collapse:collapse;
    font-size:11px;
  }
  th,td{
    padding:6px 5px;
    border-bottom:1px solid #111827;
    text-align:left;
  }
  th{
    color:#9ca3af;
    text-transform:uppercase;
    font-weight:500;
    letter-spacing:.06em;
  }
  tr:hover{
    background:#020617;
  }
  .toast{
    position:fixed;
    right:12px;
    bottom:12px;
    background:#020617;
    border:1px solid #4b5563;
    border-radius:10px;
    padding:8px 10px;
    font-size:12px;
    display:none;
    max-width:320px;
    z-index:50;
  }
  .jobbar{
    position:fixed;
    left:50%;
    bottom:8px;
    transform:translateX(-50%);
    background:#020617;
    border:1px solid #38bdf8;
    border-radius:999px;
    padding:6px 12px;
    font-size:11px;
    display:none;
    align-items:center;
    gap:8px;
    max-width:420px;
    z-index:40;
  }
  .jobbar-line{
    flex:1;
    height:5px;
    border-radius:999px;
    background:#111827;
    overflow:hidden;
  }
  .jobbar-progress{
    height:100%;
    width:0;
    background:#22c55e;
    transition:width .2s;
  }
  @media (max-width:900px){
    .layout{flex-direction:column;}
    .grid-main{grid-template-columns:1fr;height:auto;}
    .servers-list{max-height:180px;}
  }
</style>
</head>
<body>
<div class="layout">

  <aside class="sidebar">
    <div class="card">
      <h2>Nuevo servidor Paymenter</h2>
      <p class="label-small" style="margin-bottom:6px;">
        Aquí registras la VPS donde está instalado Paymenter para poder hacer backups por SSH.
      </p>
      <form id="form-new-server">
        <div class="form-grid">
          <div class="field">
            <label class="label-small">Nombre interno</label>
            <input name="label" placeholder="Ej: Paymenter Principal"/>
            <small>Solo para identificarlo en la lista.</small>
          </div>
          <div class="field">
            <label class="label-small">IP / Host</label>
            <input name="ip" placeholder="127.0.0.1 o 45.x.x.x" required/>
            <small>Dirección de la VPS donde corre Paymenter.</small>
          </div>
          <div class="field">
            <label class="label-small">Usuario SSH</label>
            <input name="ssh_user" value="root" placeholder="root"/>
            <small>Usuario con permisos para hacer backup (normalmente root).</small>
          </div>
          <div class="field">
            <label class="label-small">Password SSH</label>
            <input name="ssh_pass" type="password" placeholder="••••••"/>
            <small>Solo se usa si la IP no es 127.0.0.1.</small>
          </div>
          <div class="field">
            <label class="label-small">Ruta Paymenter</label>
            <input name="pmtr_path" value="/var/www/paymenter" placeholder="/var/www/paymenter"/>
            <small>Carpeta donde está el código de Paymenter.</small>
          </div>
          <div class="field">
            <label class="label-small">DB host</label>
            <input name="db_host" value="127.0.0.1" placeholder="127.0.0.1"/>
            <small>Servidor de base de datos. Normalmente 127.0.0.1.</small>
          </div>
          <div class="field">
            <label class="label-small">DB nombre</label>
            <input name="db_name" value="paymenter" placeholder="paymenter"/>
            <small>Nombre de la base de datos de Paymenter.</small>
          </div>
          <div class="field">
            <label class="label-small">DB usuario</label>
            <input name="db_user" value="paymenter" placeholder="paymenter"/>
            <small>Usuario MySQL/MariaDB con permisos sobre esa DB.</small>
          </div>
          <div class="field">
            <label class="label-small">DB password</label>
            <input name="db_pass" type="password" placeholder="(si aplica)"/>
            <small>Password del usuario de la base de datos.</small>
          </div>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;gap:6px;">
          <div class="field" style="flex-direction:row;align-items:center;gap:4px;">
            <span class="label-small">Programación:</span>
            <select name="schedule_key" style="font-size:11px;border-radius:999px;padding:3px 6px;background:#020617;border:1px solid #1f2937;color:#e5e7eb;">
              <option value="off">Solo manual</option>
              <option value="1h">Cada 1 hora</option>
              <option value="6h">Cada 6 horas</option>
              <option value="12h">Cada 12 horas</option>
              <option value="1d">Cada 24 horas</option>
              <option value="1w">Cada semana</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary">
            Guardar servidor
          </button>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Servidores registrados</h2>
      <p class="label-small">Selecciona uno para ver detalles y administrar backups.</p>
      <div class="servers-list" id="servers-list"></div>
    </div>
  </aside>

  <main class="main">
    <div class="grid-main">
      <section class="card scroll">
        <h2>Detalles del servidor</h2>
        <p class="label-small" id="server-subtitle">Selecciona un servidor de la izquierda.</p>
        <div id="server-status" style="margin-top:6px;font-size:11px;">
          Estado: <span class="badge red" id="server-status-badge">Sin selección</span>
        </div>

        <div id="server-info-empty" style="font-size:12px;color:#9ca3af;margin-top:10px;">
          ➜ No hay servidor seleccionado.
        </div>

        <div id="server-info" style="display:none;margin-top:10px;display:flex;flex-direction:column;gap:8px;">
          <div class="kv">
            <div>
              <div class="kv-label">Nombre interno</div>
              <div class="kv-val" id="info-label"></div>
            </div>
            <div>
              <div class="kv-label">IP / Host</div>
              <div class="kv-val" id="info-ip"></div>
            </div>
            <div>
              <div class="kv-label">Ruta Paymenter</div>
              <div class="kv-val" id="info-path"></div>
            </div>
            <div>
              <div class="kv-label">Base de datos</div>
              <div class="kv-val" id="info-db"></div>
            </div>
            <div>
              <div class="kv-label">Programación</div>
              <div class="kv-val" id="info-sched"></div>
            </div>
            <div>
              <div class="kv-label">Retención</div>
              <div class="kv-val" id="info-ret"></div>
            </div>
            <div>
              <div class="kv-label">Último backup</div>
              <div class="kv-val" id="info-last"></div>
            </div>
            <div>
              <div class="kv-label">Próximo backup</div>
              <div class="kv-val" id="info-next"></div>
            </div>
          </div>

          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">
            <button class="btn btn-sm" id="btn-edit-ssh">Editar SSH</button>
            <button class="btn btn-sm" id="btn-edit-pmtr">Editar ruta / DB</button>
            <button class="btn btn-sm btn-danger" id="btn-delete-server">Eliminar servidor</button>
          </div>

          <div style="margin-top:8px;">
            <p class="label-small" style="margin-bottom:4px;">Programación y retención</p>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
              <div class="field" style="flex-direction:row;align-items:center;gap:4px;">
                <span class="label-small">Programa:</span>
                <select id="edit-schedule" style="font-size:11px;border-radius:999px;padding:3px 6px;background:#020617;border:1px solid #1f2937;color:#e5e7eb;">
                  <option value="off">Solo manual</option>
                  <option value="1h">Cada 1h</option>
                  <option value="6h">Cada 6h</option>
                  <option value="12h">Cada 12h</option>
                  <option value="1d">Cada 24h</option>
                  <option value="1w">Cada semana</option>
                  <option value="15d">Cada 15 días</option>
                  <option value="1m">Cada mes</option>
                </select>
              </div>
              <div class="field" style="flex-direction:row;align-items:center;gap:4px;">
                <span class="label-small">Retención:</span>
                <select id="edit-retention" style="font-size:11px;border-radius:999px;padding:3px 6px;background:#020617;border:1px solid #1f2937;color:#e5e7eb;">
                  <option value="off">No borrar automático</option>
                  <option value="1d">1 día</option>
                  <option value="3d">3 días</option>
                  <option value="7d">7 días</option>
                  <option value="15d">15 días</option>
                  <option value="30d">30 días</option>
                  <option value="60d">60 días</option>
                  <option value="90d">90 días</option>
                  <option value="180d">180 días</option>
                  <option value="schedx3">3× intervalo</option>
                  <option value="schedx7">7× intervalo</option>
                </select>
              </div>
              <label class="label-small" style="display:flex;align-items:center;gap:4px;">
                <input type="checkbox" id="edit-enabled" style="accent-color:#22c55e;"/>
                Autosnap activado
              </label>
              <button class="btn btn-sm btn-primary" id="btn-save-sched">Guardar cambios</button>
            </div>
          </div>
        </div>
      </section>

      <section class="card scroll">
        <h2>Backups & Restore</h2>
        <p class="label-small">Crea snapshots FULL/DB y restaura en la misma VPS o en otra.</p>

        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
          <button class="btn btn-sm btn-primary" id="btn-backup-full">Backup FULL Paymenter</button>
          <button class="btn btn-sm" id="btn-backup-db">Solo DB + .env</button>
          <button class="btn btn-sm" id="btn-refresh-backups">Refrescar lista</button>
          <button class="btn btn-sm btn-danger" id="btn-retention-clean">Aplicar retención ahora</button>
          <span class="label-small" style="margin-left:auto;" id="backups-summary">Sin servidor.</span>
        </div>

        <div id="backups-empty" style="font-size:12px;color:#9ca3af;margin-top:8px;">
          ➜ Selecciona un servidor para ver sus backups.
        </div>

        <div id="backups-table-wrap" class="scroll" style="display:none;margin-top:6px;max-height:45vh;">
          <table id="backups-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Archivo</th>
                <th>Tipo</th>
                <th>Tamaño</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>

        <hr style="border-color:#111827;margin:10px 0;"/>

        <h2>Historial de restores</h2>
        <p class="label-small">Solo registros; no afecta archivos.</p>

        <div id="restores-empty" style="font-size:12px;color:#9ca3af;margin-top:6px;">
          ➜ No hay restores todavía.
        </div>

        <div id="restores-table-wrap" class="scroll" style="display:none;margin-top:6px;max-height:30vh;">
          <table id="restores-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Backup</th>
                <th>Modo</th>
                <th>Origen → Destino</th>
                <th>Auth</th>
                <th>Estado</th>
                <th>Notas</th>
                <th></th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
</div>

<div class="toast" id="toast"></div>
<div class="jobbar" id="jobbar">
  <div style="min-width:140px;">
    <div id="jobbar-title">Job</div>
    <div id="jobbar-status" style="font-size:10px;color:#9ca3af;">Preparando…</div>
  </div>
  <div class="jobbar-line"><div class="jobbar-progress" id="jobbar-progress"></div></div>
</div>

<script>
(function(){
  var currentServerId = null;
  var serversCache = [];
  var jobTimer = null;
  var activeJobId = null;

  function $(sel){return document.querySelector(sel);}
  function createEl(tag){return document.createElement(tag);}

  function toast(msg,isErr){
    var t=$("#toast"); if(!t) return;
    t.textContent=msg;
    t.style.borderColor=isErr?"#f97373":"#4b5563";
    t.style.display="block";
    setTimeout(function(){t.style.display="none";},4000);
  }

  function fmtBytes(size){
    if(!size||size<=0)return "—";
    var kb=size/1024,mb=kb/1024,gb=mb/1024;
    if(gb>=1)return gb.toFixed(2)+" GB";
    if(mb>=1)return mb.toFixed(1)+" MB";
    if(kb>=1)return kb.toFixed(0)+" KB";
    return size+" B";
  }
  function fmtDate(iso){
    if(!iso)return "—";
    var d=new Date(iso); if(isNaN(d.getTime()))return iso;
    return d.toLocaleString();
  }
  function schedLabel(key){
    var m={off:"Solo manual","1h":"Cada 1h","6h":"Cada 6h","12h":"Cada 12h","1d":"Cada 24h","1w":"Cada semana","15d":"Cada 15 días","1m":"Cada mes"};
    return m[key]||key;
  }
  function retLabel(key){
    var m={off:"No borrar automático","1d":"1 día","3d":"3 días","7d":"7 días","15d":"15 días","30d":"30 días","60d":"60 días","90d":"90 días","180d":"180 días","schedx3":"3× intervalo","schedx7":"7× intervalo"};
    return m[key]||key;
  }

  function setJobVisible(v){
    var bar=$("#jobbar"); if(!bar)return;
    bar.style.display=v?"flex":"none";
  }
  function updateJobBar(data){
    var t=$("#jobbar-title"), s=$("#jobbar-status"), p=$("#jobbar-progress");
    if(!t||!s||!p)return;
    t.textContent=(data.type==="backup"?"Backup":"Restore")+" · "+data.id.substring(0,6);
    s.textContent=data.status.toUpperCase()+" · "+(data.percent||0)+"%";
    p.style.width=(data.percent||0)+"%";
  }
  function startJobPoll(id){
    activeJobId=id;
    setJobVisible(true);
    if(jobTimer)clearInterval(jobTimer);
    function poll(){
      fetch("/api/job/"+encodeURIComponent(id))
        .then(function(r){return r.ok?r.json():Promise.reject();})
        .then(function(d){
          updateJobBar(d);
          if(d.status!=="running"){
            clearInterval(jobTimer); jobTimer=null;
            setTimeout(function(){setJobVisible(false);},2500);
            if(currentServerId){
              loadServer(currentServerId);
              loadBackups(currentServerId);
              loadRestores(currentServerId);
            }
          }
        })
        .catch(function(){});
    }
    poll();
    jobTimer=setInterval(poll,2000);
  }

  function loadServers(){
    var list=$("#servers-list");
    if(!list)return;
    list.innerHTML='<div class="label-small" style="margin-top:4px;">Cargando servidores…</div>';
    fetch("/api/servers")
      .then(function(r){return r.json();})
      .then(function(data){
        serversCache=data.servers||[];
        if(!serversCache.length){
          list.innerHTML='<div class="label-small" style="margin-top:4px;">Aún no hay servidores.</div>';
          return;
        }
        list.innerHTML="";
        serversCache.forEach(function(srv){
          var item=createEl("div");
          item.className="srv-item";
          item.dataset.id=srv.id;
          if(srv.id===currentServerId)item.classList.add("active");
          var title=document.createElement("div");
          title.textContent=srv.label||("Server "+srv.id);
          var ip=document.createElement("div");
          ip.className="srv-ip";
          ip.textContent=srv.ip;
          var status=document.createElement("div");
          var b=document.createElement("span");
          b.className="badge "+(srv.enabled?"green":"red");
          b.textContent=srv.enabled?"Autosnap ON":"Manual";
          status.appendChild(b);
          item.appendChild(title);
          item.appendChild(ip);
          item.appendChild(status);
          item.addEventListener("click",function(){
            currentServerId=srv.id;
            document.querySelectorAll(".srv-item").forEach(function(el){el.classList.remove("active");});
            item.classList.add("active");
            loadServer(srv.id);
            loadBackups(srv.id);
            loadRestores(srv.id);
          });
          list.appendChild(item);
        });
      })
      .catch(function(){
        list.innerHTML='<div class="label-small" style="margin-top:4px;color:#f97373;">Error al cargar servidores.</div>';
      });
  }

  function loadServer(id){
    var srv=serversCache.find(function(s){return s.id===id;});
    var empty=$("#server-info-empty");
    var info=$("#server-info");
    var sub=$("#server-subtitle");
    var badge=$("#server-status-badge");
    if(!srv){
      empty.style.display="block";
      info.style.display="none";
      sub.textContent="Selecciona un servidor de la izquierda.";
      badge.textContent="Sin selección";
      badge.className="badge red";
      return;
    }
    empty.style.display="none";
    info.style.display="flex";
    sub.textContent="Gestionando backups para "+(srv.label||("Server "+srv.id));
    badge.textContent=srv.enabled?"Autosnap ON":"Manual";
    badge.className="badge "+(srv.enabled?"green":"red");

    $("#info-label").textContent=srv.label||"—";
    $("#info-ip").textContent=srv.ip||"—";
    $("#info-path").textContent=srv.pmtr_path||"/var/www/paymenter";
    $("#info-db").textContent=(srv.db_name||"paymenter")+" @ "+(srv.db_host||"127.0.0.1")+" (user "+(srv.db_user||"paymenter")+")";
    $("#info-sched").textContent=schedLabel(srv.schedule_key||"off");
    $("#info-ret").textContent=retLabel(srv.retention_key||"off");
    $("#info-last").textContent=fmtDate(srv.last_run);
    $("#info-next").textContent=fmtDate(srv.next_run);

    $("#edit-schedule").value=srv.schedule_key||"off";
    $("#edit-retention").value=srv.retention_key||"off";
    $("#edit-enabled").checked=!!srv.enabled;
  }

  function loadBackups(serverId){
    var empty=$("#backups-empty");
    var wrap=$("#backups-table-wrap");
    var tbody=$("#backups-table tbody");
    var summary=$("#backups-summary");
    if(!serverId){
      empty.style.display="block";
      empty.textContent="➜ Selecciona un servidor para ver sus backups.";
      wrap.style.display="none";
      summary.textContent="Sin servidor.";
      return;
    }
    empty.style.display="block";
    empty.textContent="Cargando backups…";
    wrap.style.display="none";
    summary.textContent="Cargando…";
    fetch("/api/backups?server_id="+encodeURIComponent(serverId))
      .then(function(r){return r.json();})
      .then(function(data){
        var list=data.backups||[];
        if(!list.length){
          empty.style.display="block";
          empty.textContent="No hay backups aún.";
          wrap.style.display="none";
          summary.textContent="0 backups.";
          tbody.innerHTML="";
          return;
        }
        empty.style.display="none";
        wrap.style.display="block";
        tbody.innerHTML="";
        summary.textContent=list.length+" backups.";
        list.forEach(function(b){
          var tr=createEl("tr");
          function td(text){var c=createEl("td");c.textContent=text;return c;}
          tr.appendChild(td(b.id));
          tr.appendChild(td(b.filename));
          tr.appendChild(td((b.type||"full").toUpperCase()));
          tr.appendChild(td(fmtBytes(b.size_bytes)));
          tr.appendChild(td(fmtDate(b.created_at)));
          tr.appendChild(td((b.status||"").toUpperCase()));

          var actions=createEl("td");
          actions.style.whiteSpace="nowrap";

          var btnDl=createEl("button");
          btnDl.className="btn btn-sm";
          btnDl.textContent="Descargar";
          btnDl.onclick=function(){window.open("/api/backups/download/"+b.id,"_blank");};
          actions.appendChild(btnDl);

          var btnSame=createEl("button");
          btnSame.className="btn btn-sm btn-primary";
          btnSame.style.marginLeft="4px";
          btnSame.textContent="Restore aquí";
          btnSame.onclick=function(){
            if(!confirm("Restaurar este backup sobre la misma VPS?"))return;
            doRestore(b.id,"same");
          };
          actions.appendChild(btnSame);

          var btnOther=createEl("button");
          btnOther.className="btn btn-sm";
          btnOther.style.marginLeft="4px";
          btnOther.textContent="→ Otra VPS";
          btnOther.onclick=function(){
            var ip=prompt("IP/host de la nueva VPS:");
            if(!ip)return;
            var user=prompt("Usuario SSH (root por defecto):")||"root";
            var pass=prompt("Password SSH de la VPS destino:");
            if(!pass)return;
            doRestore(b.id,"other",{ip:ip,ssh_user:user,ssh_pass:pass});
          };
          actions.appendChild(btnOther);

          var btnDel=createEl("button");
          btnDel.className="btn btn-sm btn-danger";
          btnDel.style.marginLeft="4px";
          btnDel.textContent="Eliminar";
          btnDel.onclick=function(){
            if(!confirm("Eliminar este backup?"))return;
            fetch("/api/backups/"+b.id,{method:"DELETE"})
              .then(function(r){return r.json();})
              .then(function(){toast("Backup eliminado.");loadBackups(serverId);})
              .catch(function(){toast("Error al eliminar backup.",true);});
          };
          actions.appendChild(btnDel);

          tr.appendChild(actions);
          tbody.appendChild(tr);
        });
      })
      .catch(function(){
        empty.style.display="block";
        empty.textContent="Error al cargar backups.";
        wrap.style.display="none";
        summary.textContent="Error.";
      });
  }

  function loadRestores(serverId){
    var empty=$("#restores-empty");
    var wrap=$("#restores-table-wrap");
    var tbody=$("#restores-table tbody");
    if(!serverId){
      empty.style.display="block";
      empty.textContent="Selecciona un servidor.";
      wrap.style.display="none";
      tbody.innerHTML="";
      return;
    }
    empty.style.display="block";
    empty.textContent="Cargando historial…";
    wrap.style.display="none";
    tbody.innerHTML="";
    fetch("/api/restores?server_id="+encodeURIComponent(serverId))
      .then(function(r){return r.json();})
      .then(function(data){
        var list=data.restores||[];
        if(!list.length){
          empty.style.display="block";
          empty.textContent="No hay restores todavía.";
          wrap.style.display="none";
          return;
        }
        empty.style.display="none";
        wrap.style.display="block";
        list.forEach(function(rw){
          var tr=createEl("tr");
          function td(text){var c=createEl("td");c.textContent=text;return c;}
          tr.appendChild(td(rw.id));
          tr.appendChild(td("#"+rw.backup_id+" · "+(rw.filename||"")));
          tr.appendChild(td(rw.mode==="same"?"Misma VPS":"Otra VPS"));
          var origin=(rw.source_label||"Origen")+" ("+(rw.source_ip||"")+")";
          var dest = rw.mode==="same"
            ? origin+" (self)"
            : (rw.target_label||"Destino")+" ("+(rw.target_ip||rw.target_ip2||"")+")";
          tr.appendChild(td(origin+" → "+dest));
          tr.appendChild(td(rw.preserve_auth?"Auth preservada":"Auth sobreescrita"));
          tr.appendChild(td((rw.status||"").toUpperCase()));
          tr.appendChild(td((rw.note||"").slice(0,60)));

          var actions=createEl("td");
          var btnDel=createEl("button");
          btnDel.className="btn btn-sm";
          btnDel.textContent="Quitar";
          btnDel.onclick=function(){
            if(!confirm("Eliminar registro de restore #"+rw.id+"?"))return;
            fetch("/api/restores/"+rw.id,{method:"DELETE"})
              .then(function(r){return r.json();})
              .then(function(){toast("Registro eliminado.");loadRestores(serverId);})
              .catch(function(){toast("Error al eliminar registro.",true);});
          };
          actions.appendChild(btnDel);
          tr.appendChild(actions);
          tbody.appendChild(tr);
        });
      })
      .catch(function(){
        empty.style.display="block";
        empty.textContent="Error al cargar historial.";
        wrap.style.display="none";
      });
  }

  function doBackup(kind){
    if(!currentServerId){toast("Selecciona un servidor primero.",true);return;}
    fetch("/api/servers/"+currentServerId+"/backup-now",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({kind:kind})
    })
      .then(function(r){return r.json();})
      .then(function(data){
        if(data.error){
          toast(data.error,true);
          if(data.job_id)startJobPoll(data.job_id);
          return;
        }
        if(!data.job_id){toast("No se recibió job_id.",true);return;}
        toast("Backup iniciado.");
        startJobPoll(data.job_id);
      })
      .catch(function(){toast("Error al iniciar backup.",true);});
  }

  function doRestore(backupId,mode,other){
    var payload={backup_id:backupId,mode:mode};
    if(mode==="other"&&other){
      payload.ip=other.ip;
      payload.ssh_user=other.ssh_user;
      payload.ssh_pass=other.ssh_pass;
    }
    fetch("/api/restore",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    })
      .then(function(r){return r.json();})
      .then(function(data){
        if(data.error){toast(data.error,true);return;}
        if(data.job_id){toast("Restore iniciado.");startJobPoll(data.job_id);}
      })
      .catch(function(){toast("Error al iniciar restore.",true);});
  }

  function saveSched(){
    if(!currentServerId){toast("Selecciona un servidor.",true);return;}
    var srv=serversCache.find(function(s){return s.id===currentServerId;});
    if(!srv)return;
    var payload={
      schedule_key:$("#edit-schedule").value,
      retention_key:$("#edit-retention").value,
      enabled:$("#edit-enabled").checked
    };
    fetch("/api/servers/"+currentServerId,{
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    })
      .then(function(r){return r.json();})
      .then(function(data){
        if(data.error){toast(data.error,true);return;}
        toast("Programación y retención actualizadas.");
        loadServers();
      })
      .catch(function(){toast("Error al guardar cambios.",true);});
  }

  function initForm(){
    var form=$("#form-new-server");
    if(form){
      form.addEventListener("submit",function(ev){
        ev.preventDefault();
        var fd=new FormData(form);
        var body={
          label:fd.get("label")||"",
          ip:(fd.get("ip")||"").trim(),
          ssh_user:(fd.get("ssh_user")||"root").trim(),
          ssh_pass:fd.get("ssh_pass")||"",
          pmtr_path:(fd.get("pmtr_path")||"/var/www/paymenter").trim(),
          db_host:(fd.get("db_host")||"127.0.0.1").trim(),
          db_name:(fd.get("db_name")||"paymenter").trim(),
          db_user:(fd.get("db_user")||"paymenter").trim(),
          db_pass:fd.get("db_pass")||"",
          schedule_key:fd.get("schedule_key")||"off",
          enabled:(fd.get("schedule_key")||"off")!=="off"
        };
        if(!body.ip){toast("IP/host es obligatorio.",true);return;}
        if(body.ip!=="127.0.0.1"&&!body.ssh_pass){
          toast("Para IP remota debes indicar password SSH.",true);return;
        }
        fetch("/api/servers",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify(body)
        })
          .then(function(r){return r.json();})
          .then(function(data){
            if(data.error){toast(data.error,true);return;}
            toast("Servidor registrado.");
            form.reset();
            loadServers();
          })
          .catch(function(){toast("Error al guardar servidor.",true);});
      });
    }

    $("#btn-backup-full").onclick=function(){doBackup("full");};
    $("#btn-backup-db").onclick=function(){doBackup("db");};
    $("#btn-refresh-backups").onclick=function(){
      if(!currentServerId){toast("Selecciona un servidor.",true);return;}
      loadBackups(currentServerId);
    };
    $("#btn-retention-clean").onclick=function(){
      if(!currentServerId){toast("Selecciona un servidor.",true);return;}
      if(!confirm("Aplicar retención y borrar backups antiguos?"))return;
      fetch("/api/servers/"+currentServerId+"/cleanup",{method:"POST"})
        .then(function(r){return r.json();})
        .then(function(data){
          toast("Retención aplicada. Eliminados: "+(data.deleted||0));
          loadBackups(currentServerId);
        })
        .catch(function(){toast("Error al aplicar retención.",true);});
    };
    $("#btn-save-sched").onclick=saveSched;

    $("#btn-delete-server").onclick=function(){
      if(!currentServerId){toast("Selecciona un servidor.",true);return;}
      if(!confirm("Eliminar este servidor del panel y sus backups locales?"))return;
      fetch("/api/servers/"+currentServerId,{method:"DELETE"})
        .then(function(r){return r.json();})
        .then(function(data){
          if(data.error){toast(data.error,true);return;}
          toast("Servidor eliminado.");
          currentServerId=null;
          loadServers();
          loadBackups(null);
          loadRestores(null);
          loadServer(null);
        })
        .catch(function(){toast("Error al eliminar servidor.",true);});
    };

    $("#btn-edit-ssh").onclick=function(){
      if(!currentServerId){toast("Selecciona un servidor.",true);return;}
      var srv=serversCache.find(function(s){return s.id===currentServerId;});
      if(!srv)return;
      var user=prompt("Usuario SSH:",srv.ssh_user||"root")||srv.ssh_user||"root";
      var pass=prompt("Password SSH (deja vacío para no cambiar):","");
      var body={};
      if(user&&user.trim())body.ssh_user=user.trim();
      if(pass!==null && pass!=="")body.ssh_pass=pass;
      if(!Object.keys(body).length)return;
      fetch("/api/servers/"+currentServerId+"/creds",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body)
      })
        .then(function(r){return r.json();})
        .then(function(data){
          if(data.error){toast(data.error,true);return;}
          toast("Credenciales SSH actualizadas.");
          loadServers();
        })
        .catch(function(){toast("Error al actualizar SSH.",true);});
    };

    $("#btn-edit-pmtr").onclick=function(){
      if(!currentServerId){toast("Selecciona un servidor.",true);return;}
      var srv=serversCache.find(function(s){return s.id===currentServerId;});
      if(!srv)return;
      var path=prompt("Ruta Paymenter:",srv.pmtr_path||"/var/www/paymenter")||srv.pmtr_path||"/var/www/paymenter";
      var dbhost=prompt("DB host:",srv.db_host||"127.0.0.1")||srv.db_host||"127.0.0.1";
      var dbname=prompt("DB nombre:",srv.db_name||"paymenter")||srv.db_name||"paymenter";
      var dbuser=prompt("DB usuario:",srv.db_user||"paymenter")||srv.db_user||"paymenter";
      var dbpass=prompt("DB password (deja vacío para no cambiar):","");
      var body={pmtr_path:path.trim(),db_host:dbhost.trim(),db_name:dbname.trim(),db_user:dbuser.trim()};
      if(dbpass!==null && dbpass!=="")body.db_pass=dbpass;
      fetch("/api/servers/"+currentServerId+"/paymenter",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body)
      })
        .then(function(r){return r.json();})
        .then(function(data){
          if(data.error){toast(data.error,true);return;}
          toast("Datos de Paymenter actualizados.");
          loadServers();
        })
        .catch(function(){toast("Error al actualizar Paymenter.",true);});
    };
  }

  document.addEventListener("DOMContentLoaded",function(){
    initForm();
    loadServers();
    loadBackups(null);
    loadRestores(null);
  });
})();
</script>
</body>
</html>`;
}
// ===== Export =====
module.exports = { createPanelRouter };
