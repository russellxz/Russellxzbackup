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
  const id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
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

// Barrido global
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
        -h"$DB_HOST" -u"$DB_USER" ${db_pass ? '${DB_PASS:+-p"$DB_PASS"}' : '${DB_PASS:+-p"$DB_PASS"}'} "$DB_NAME" | gzip -1 > "${pmtr_path}/.sup-dumps/sup-db.sql.gz"
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
    if ! command -v npm >/dev/null 2>&1; then
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

  // REMOTO
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

  // Actualizar programa/retención/label/enabled
  router.put("/api/servers/:id", (req, res) => {
    const id = +req.params.id;
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });

    const { schedule_key, enabled, label, retention_key } = req.body || {};
    const updates = [];
    const params = [];

    if (typeof label === "string") {
      updates.push("label = ?");
      params.push(label);
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

  // Actualizar credenciales SSH
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
    if (typeof ssh_pass === "string" && ssh_pass.length) {
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

  // Actualizar configuración Paymenter (ruta + DB creds)
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
<title>SkyUltraPlus — Backup Paymenter</title>
<style>
:root{
  --bg:#020617;
  --bg-soft:#020617;
  --panel:#020617;
  --panel2:#0b1120;
  --border:#1e293b;
  --fg:#e5e7eb;
  --fg-soft:#94a3b8;
  --accent:#38bdf8;
  --accent-soft:rgba(56,189,248,.16);
  --danger:#f97373;
  --ok:#22c55e;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  background:radial-gradient(circle at top,#0f172a,#020617 50%);
  color:var(--fg);
  min-height:100vh;
}
.layout{
  display:grid;
  grid-template-columns:260px minmax(0,1fr);
  min-height:100vh;
}
aside{
  border-right:1px solid var(--border);
  padding:20px 18px;
  background:linear-gradient(180deg,#020617,#020617 45%,#020617 100%);
}
.brand{
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:20px;
}
.brand img{
  width:52px;
  height:52px;
  border-radius:16px;
  box-shadow:0 0 20px rgba(56,189,248,.6);
}
.brand-title{font-size:15px;font-weight:700}
.brand-sub{font-size:11px;color:var(--fg-soft)}
.nav-btn{
  width:100%;
  padding:10px 12px;
  border-radius:10px;
  border:1px solid var(--border);
  background:#020617;
  color:var(--fg-soft);
  font-size:13px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  cursor:pointer;
  margin-bottom:8px;
}
.nav-btn span{font-size:12px}
.nav-btn.primary{
  border-color:var(--accent);
  background:var(--accent-soft);
  color:var(--fg);
}
main{
  padding:20px 20px 24px;
}
h1{
  font-size:20px;
  font-weight:700;
  margin-bottom:4px;
}
h2{
  font-size:15px;
  margin-bottom:6px;
}
.page-sub{
  font-size:12px;
  color:var(--fg-soft);
  margin-bottom:18px;
}
.grid{
  display:grid;
  grid-template-columns:minmax(0,0.9fr) minmax(0,1.1fr);
  gap:16px;
}
.card{
  background:var(--panel2);
  border-radius:14px;
  border:1px solid var(--border);
  padding:14px 14px 12px;
}
.card-header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:10px;
}
.card-header h2{font-size:14px}
.card-header small{font-size:11px;color:var(--fg-soft)}
.servers-list{
  max-height:310px;
  overflow:auto;
}
.server-row{
  border-radius:10px;
  border:1px solid var(--border);
  padding:8px 10px;
  margin-bottom:6px;
  font-size:12px;
  cursor:pointer;
  display:grid;
  grid-template-columns:minmax(0,1.2fr) minmax(0,0.9fr);
  gap:4px 10px;
}
.server-row.active{
  border-color:var(--accent);
  background:var(--accent-soft);
}
.server-row strong{font-size:12px}
.badge{
  display:inline-flex;
  align-items:center;
  padding:2px 7px;
  border-radius:999px;
  font-size:10px;
  border:1px solid var(--border);
  background:#020617;
  color:var(--fg-soft);
}
.badge.ok{border-color:var(--ok);color:var(--ok);}
.badge.off{border-color:#4b5563;color:#6b7280;}
.badge.dot::before{
  content:"●";
  font-size:8px;
  margin-right:5px;
}
small.muted{color:var(--fg-soft);font-size:11px}
.form-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:8px 10px;
  margin-bottom:10px;
}
.field{display:flex;flex-direction:column;gap:3px}
label{
  font-size:11px;
  color:var(--fg-soft);
}
input,select{
  border-radius:9px;
  border:1px solid var(--border);
  background:#020617;
  color:var(--fg);
  font-size:12px;
  padding:7px 9px;
  outline:none;
}
input:focus,select:focus{
  border-color:var(--accent);
}
.btn-row{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  margin-top:6px;
}
.btn{
  border-radius:8px;
  border:1px solid var(--border);
  background:#020617;
  color:var(--fg);
  font-size:12px;
  padding:7px 10px;
  cursor:pointer;
}
.btn.primary{
  border-color:var(--accent);
  background:var(--accent-soft);
}
.btn.danger{
  border-color:var(--danger);
  color:var(--danger);
}
.btn.sm{font-size:11px;padding:5px 8px;}
.section{
  margin-bottom:10px;
}
.progress-wrap{
  margin-top:8px;
}
.progress-bar{
  height:6px;
  border-radius:999px;
  background:#020617;
  overflow:hidden;
  border:1px solid #0f172a;
}
.progress-bar-inner{
  height:100%;
  width:0%;
  background:linear-gradient(90deg,#22c55e,#38bdf8);
  transition:width .3s ease;
}
.progress-label{
  display:flex;
  justify-content:space-between;
  font-size:11px;
  margin-top:2px;
  color:var(--fg-soft);
}
.tag{
  display:inline-flex;
  padding:1px 6px;
  border-radius:999px;
  border:1px solid var(--border);
  font-size:10px;
  margin-left:4px;
}
.tag.db{border-color:#38bdf8;color:#38bdf8;}
.tag.full{border-color:#f97316;color:#fdba74;}
.list-small{
  max-height:140px;
  overflow:auto;
  font-size:11px;
}
.list-small-item{
  border-radius:8px;
  border:1px solid var(--border);
  padding:6px 8px;
  margin-bottom:5px;
}
.list-small-item header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:2px;
}
.list-small-item footer{
  display:flex;
  justify-content:space-between;
  margin-top:3px;
}
kbd{
  font-size:10px;
  background:#020617;
  border-radius:4px;
  border:1px solid var(--border);
  padding:2px 4px;
}
.logs{
  background:#020617;
  border-radius:8px;
  border:1px solid var(--border);
  padding:6px 8px;
  font-size:10px;
  height:110px;
  overflow:auto;
  font-family:ui-monospace,Menlo,monospace;
  white-space:pre-wrap;
}
.pill-countdown{
  display:inline-flex;
  align-items:center;
  gap:4px;
  padding:4px 8px;
  border-radius:999px;
  border:1px solid var(--border);
  font-size:11px;
  margin-top:4px;
}
.pill-countdown span:first-child{color:var(--fg-soft);}
.toast{
  position:fixed;
  right:16px;
  bottom:16px;
  background:#020617;
  border-radius:10px;
  border:1px solid var(--border);
  padding:8px 10px;
  font-size:11px;
  color:var(--fg);
  box-shadow:0 12px 30px rgba(0,0,0,.45);
  opacity:0;
  transform:translateY(6px);
  pointer-events:none;
  transition:all .25s ease;
}
.toast.show{
  opacity:1;
  transform:translateY(0);
  pointer-events:auto;
}
@media (max-width:960px){
  .layout{grid-template-columns:1fr;grid-template-rows:auto auto;}
  aside{border-right:none;border-bottom:1px solid var(--border);}
  .grid{grid-template-columns:1fr;}
}
</style>
</head>
<body>
<div class="layout">
  <aside>
    <div class="brand">
      <img src="https://cdn.russellxz.click/3c8ab72a.png" alt="SkyUltraPlus">
      <div>
        <div class="brand-title">SkyUltraPlus Backup</div>
        <div class="brand-sub">Paymenter DB &amp; Files</div>
      </div>
    </div>
    <button class="nav-btn primary" type="button" onclick="location.href='/panel'">
      <span>Panel de backups</span>
      <span>●</span>
    </button>
    <button class="nav-btn" type="button" onclick="location.href='/usuarios'">
      <span>Usuarios / Socios</span>
      <span>⤴</span>
    </button>
    <div style="margin-top:18px;font-size:11px;color:var(--fg-soft);line-height:1.4;">
      Gestiona múltiples VPS con Paymenter, programa backups automáticos y restaura en otra VPS limpia con dependencias listas.
    </div>
  </aside>
  <main>
    <h1>Panel de backups Paymenter</h1>
    <div class="page-sub">
      Agrega tus VPS con Paymenter, programa backups de <strong>DB</strong> o <strong>FULL</strong>, y restaura en la misma VPS o en otra.
    </div>

    <div class="grid">
      <section class="card">
        <div class="card-header">
          <h2>Servidores Paymenter</h2>
          <small id="srvCount">0 configurados</small>
        </div>
        <div class="section">
          <form id="formAddServer">
            <div class="form-grid">
              <div class="field">
                <label>Nombre / etiqueta</label>
                <input name="label" placeholder="Paymenter Principal"/>
              </div>
              <div class="field">
                <label>IP / host</label>
                <input name="ip" placeholder="45.90.99.19" required/>
              </div>
              <div class="field">
                <label>Usuario SSH</label>
                <input name="ssh_user" value="root"/>
              </div>
              <div class="field">
                <label>Contraseña SSH</label>
                <input name="ssh_pass" type="password" placeholder="••••••••" required/>
              </div>
              <div class="field">
                <label>Ruta Paymenter</label>
                <input name="pmtr_path" value="/var/www/paymenter"/>
              </div>
              <div class="field">
                <label>DB host</label>
                <input name="db_host" value="127.0.0.1"/>
              </div>
              <div class="field">
                <label>DB nombre</label>
                <input name="db_name" value="paymenter"/>
              </div>
              <div class="field">
                <label>DB usuario</label>
                <input name="db_user" value="paymenter"/>
              </div>
              <div class="field">
                <label>DB password (opcional)</label>
                <input name="db_pass" type="password" placeholder="••••••"/>
              </div>
              <div class="field">
                <label>Frecuencia auto-backup</label>
                <select name="schedule_key">
                  <option value="off">Sin auto-backup</option>
                  <option value="1h">Cada 1 hora</option>
                  <option value="6h">Cada 6 horas</option>
                  <option value="12h">Cada 12 horas</option>
                  <option value="1d">Cada día</option>
                  <option value="1w">Cada semana</option>
                  <option value="15d">Cada 15 días</option>
                  <option value="1m">Cada mes</option>
                </select>
              </div>
              <div class="field">
                <label>Retención</label>
                <select name="retention_key">
                  <option value="off">Sin borrar</option>
                  <option value="3d">3 días</option>
                  <option value="7d">7 días</option>
                  <option value="15d">15 días</option>
                  <option value="30d">30 días</option>
                  <option value="60d">60 días</option>
                  <option value="90d">90 días</option>
                </select>
              </div>
            </div>
            <div class="btn-row">
              <button class="btn primary" type="submit">Agregar servidor</button>
            </div>
          </form>
        </div>
        <div class="section">
          <h2>Lista de servidores</h2>
          <div class="servers-list" id="serversList"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Detalles / Backups / Restore</h2>
          <small id="currentServerLabel">Selecciona un servidor</small>
        </div>

        <div class="section">
          <div id="serverMeta" style="font-size:12px;color:var(--fg-soft);min-height:28px;"></div>
          <div class="pill-countdown">
            <span>Próximo backup:</span>
            <span id="countdownText">—</span>
          </div>
        </div>

        <div class="section">
          <h2>Acciones rápidas</h2>
          <div class="btn-row">
            <button class="btn primary" type="button" id="btnBackupDb">Backup DB + .env</button>
            <button class="btn primary" type="button" id="btnBackupFull">Backup FULL Paymenter</button>
            <button class="btn" type="button" id="btnCleanup">Aplicar retención ahora</button>
            <button class="btn danger" type="button" id="btnDeleteServer">Eliminar servidor</button>
          </div>
          <div class="progress-wrap">
            <div class="progress-bar">
              <div class="progress-bar-inner" id="jobBar"></div>
            </div>
            <div class="progress-label">
              <span id="jobStatusLabel">Sin procesos activos</span>
              <span id="jobPercentLabel">0%</span>
            </div>
          </div>
        </div>

        <div class="section">
          <h2>Backups guardados</h2>
          <div class="list-small" id="backupList"></div>
        </div>

        <div class="section">
          <h2>Restaurar backup</h2>
          <form id="formRestore" style="font-size:11px;">
            <div class="field" style="margin-bottom:6px;">
              <label>Backup seleccionado</label>
              <select name="backup_id" id="restoreBackupSelect">
                <option value="">Selecciona un backup…</option>
              </select>
            </div>
            <div class="field" style="margin-bottom:6px;">
              <label>Modo de restauración</label>
              <select name="mode" id="restoreMode">
                <option value="same">Misma VPS (overwrite)</option>
                <option value="other">Otra VPS (IP distinta)</option>
              </select>
            </div>
            <div id="restoreOtherFields" style="display:none;">
              <div class="form-grid">
                <div class="field">
                  <label>IP destino</label>
                  <input name="target_ip" placeholder="45.90.99.19"/>
                </div>
                <div class="field">
                  <label>Usuario SSH destino</label>
                  <input name="target_user" value="root"/>
                </div>
                <div class="field">
                  <label>Contraseña SSH destino</label>
                  <input name="target_pass" type="password" placeholder="••••••••"/>
                </div>
              </div>
            </div>
            <div class="btn-row">
              <button class="btn primary sm" type="submit">Iniciar restore</button>
            </div>
          </form>
        </div>

        <div class="section">
          <h2>Historial de restores</h2>
          <div class="list-small" id="restoreList"></div>
        </div>

        <div class="section">
          <h2>Consola de job actual</h2>
          <div class="logs" id="jobLogs">Sin logs.</div>
        </div>
      </section>
    </div>
  </main>

  <div class="toast" id="toast"></div>
</div>

<script>
(function(){
  let servers = [];
  let currentId = null;
  let countdownTimer = null;
  let activeJobId = null;

  const elServersList = document.getElementById('serversList');
  const elSrvCount   = document.getElementById('srvCount');
  const elCurrentLbl = document.getElementById('currentServerLabel');
  const elServerMeta = document.getElementById('serverMeta');
  const elCountdown  = document.getElementById('countdownText');
  const elBackupList = document.getElementById('backupList');
  const elRestoreList= document.getElementById('restoreList');
  const elJobBar     = document.getElementById('jobBar');
  const elJobStatus  = document.getElementById('jobStatusLabel');
  const elJobPct     = document.getElementById('jobPercentLabel');
  const elJobLogs    = document.getElementById('jobLogs');
  const elToast      = document.getElementById('toast');
  const elRestoreSel = document.getElementById('restoreBackupSelect');
  const elRestoreMode= document.getElementById('restoreMode');
  const elRestoreOther = document.getElementById('restoreOtherFields');

  function toast(msg){
    elToast.textContent = msg;
    elToast.classList.add('show');
    setTimeout(()=>elToast.classList.remove('show'), 2600);
  }

  async function api(path, opts){
    const res = await fetch(path, Object.assign({
      headers:{'Content-Type':'application/json'}
    }, opts || {}));
    if(!res.ok){
      let txt = await res.text().catch(()=>String(res.status));
      throw new Error(txt || ('HTTP '+res.status));
    }
    const ct = res.headers.get('content-type') || '';
    if(ct.includes('application/json')) return res.json();
    return res.text();
  }

  function formatDate(s){
    if(!s) return '—';
    try{
      const d = new Date(s);
      return d.toLocaleString();
    }catch{return s;}
  }
  function formatBytes(b){
    if(!b) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    let i = 0, v = b;
    while(v>=1024 && i<u.length-1){v/=1024;i++;}
    return v.toFixed(1)+' '+u[i];
  }
  function formatCountdown(iso){
    if(!iso) return 'No programado';
    const t = new Date(iso).getTime();
    const n = Date.now();
    const diff = t - n;
    if(diff <= 0) return 'Pendiente / en cola';
    let s = Math.floor(diff/1000);
    const d = Math.floor(s/86400); s-=d*86400;
    const h = Math.floor(s/3600);  s-=h*3600;
    const m = Math.floor(s/60);    s-=m*60;
    const parts = [];
    if(d) parts.push(d+'d');
    if(h) parts.push(h+'h');
    if(m) parts.push(m+'m');
    parts.push(s+'s');
    return parts.join(' ');
  }

  function renderServers(){
    elServersList.innerHTML = '';
    elSrvCount.textContent = servers.length + ' configurados';
    servers.forEach(s=>{
      const div = document.createElement('div');
      div.className = 'server-row'+(s.id===currentId?' active':'');
      div.dataset.id = s.id;
      div.innerHTML =
        '<div><strong>'+ (s.label || ('Server #'+s.id)) +'</strong><br/>'+
        '<small class="muted">'+s.ip+' · '+s.pmtr_path+'</small></div>'+
        '<div style="text-align:right;">'+
        '<span class="badge '+(s.enabled?'ok':'off')+'">'+(s.enabled?'Auto ON':'Auto OFF')+'</span><br/>'+
        '<small class="muted">'+(s.schedule_key || 'off')+'</small>'+
        '</div>';
      div.onclick = ()=>selectServer(s.id);
      elServersList.appendChild(div);
    });
  }

  function selectServer(id){
    currentId = id;
    const srv = servers.find(x=>x.id===id);
    document.querySelectorAll('.server-row').forEach(e=>{
      e.classList.toggle('active', +e.dataset.id === id);
    });
    if(!srv){
      elCurrentLbl.textContent = 'Selecciona un servidor';
      elServerMeta.textContent = '';
      elCountdown.textContent = '—';
      return;
    }
    elCurrentLbl.textContent = (srv.label || 'Server #'+srv.id)+' · '+srv.ip;
    elServerMeta.innerHTML =
      '<div>Ruta Paymenter: <kbd>'+srv.pmtr_path+'</kbd></div>'+
      '<div>DB: <kbd>'+srv.db_name+'@'+srv.db_host+'</kbd> · Usuario: <kbd>'+srv.db_user+'</kbd></div>'+
      '<div>Último backup: '+formatDate(srv.last_run)+'</div>';
    if(countdownTimer) clearInterval(countdownTimer);
    function tick(){
      elCountdown.textContent = formatCountdown(srv.next_run);
    }
    tick();
    countdownTimer = setInterval(tick,1000);
    loadBackups();
    loadRestores();
    resetJobView();
  }

  function resetJobView(){
    elJobBar.style.width = '0%';
    elJobPct.textContent = '0%';
    elJobStatus.textContent = 'Sin procesos activos';
    elJobLogs.textContent = 'Sin logs.';
    activeJobId = null;
  }

  async function loadServers(){
    try{
      const data = await api('/api/servers');
      servers = data.servers || [];
      renderServers();
      if(!currentId && servers[0]) selectServer(servers[0].id);
    }catch(e){
      toast('Error cargando servidores');
      console.error(e);
    }
  }

  async function loadBackups(){
    if(!currentId){ elBackupList.innerHTML=''; elRestoreSel.innerHTML='<option value="">Selecciona un backup…</option>'; return;}
    try{
      const data = await api('/api/backups?server_id='+currentId);
      const list = data.backups || [];
      elBackupList.innerHTML = '';
      elRestoreSel.innerHTML = '<option value="">Selecciona un backup…</option>';
      list.forEach(b=>{
        const div = document.createElement('div');
        div.className='list-small-item';
        div.innerHTML =
          '<header><span>'+b.filename+'</span>'+
          '<span><span class="tag '+(b.type==='db'?'db':'full')+'">'+(b.type==='db'?'DB':'FULL')+'</span></span></header>'+
          '<div>'+formatDate(b.created_at)+'</div>'+
          '<footer>'+
            '<span>'+formatBytes(b.size_bytes || 0)+' · '+(b.status || '—')+'</span>'+
            '<span>'+
              '<button data-id="'+b.id+'" class="btn sm" data-act="dl">Descargar</button> '+
              '<button data-id="'+b.id+'" class="btn sm danger" data-act="del">Eliminar</button>'+
            '</span>'+
          '</footer>';
        elBackupList.appendChild(div);
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = '#'+b.id+' · '+b.type.toUpperCase()+' · '+formatDate(b.created_at);
        elRestoreSel.appendChild(opt);
      });

      elBackupList.onclick = async (ev)=>{
        const btn = ev.target.closest('button');
        if(!btn) return;
        const id = btn.getAttribute('data-id');
        const act= btn.getAttribute('data-act');
        if(act==='del'){
          if(!confirm('¿Eliminar este backup?')) return;
          try{
            await api('/api/backups/'+id,{method:'DELETE'});
            toast('Backup eliminado');
            loadBackups();
          }catch(e){toast('Error eliminando backup');}
        }else if(act==='dl'){
          window.location = '/api/backups/download/'+id;
        }
      };
    }catch(e){
      elBackupList.innerHTML='<div class="list-small-item">Error cargando backups.</div>';
    }
  }

  async function loadRestores(){
    if(!currentId){ elRestoreList.innerHTML=''; return;}
    try{
      const data = await api('/api/restores?server_id='+currentId);
      const list = data.restores || [];
      elRestoreList.innerHTML='';
      list.forEach(r=>{
        const div=document.createElement('div');
        div.className='list-small-item';
        div.innerHTML=
          '<header><span>#'+r.id+' → '+(r.target_ip || r.target_ip2 || 'same')+'</span>'+
          '<span>'+ (r.status || '—') +'</span></header>'+
          '<div>'+formatDate(r.created_at)+' · Backup '+r.filename+' ('+r.type+')</div>'+
          '<footer>'+
            '<span>'+(r.note || '')+'</span>'+
            '<span><button data-id="'+r.id+'" class="btn sm danger">Borrar</button></span>'+
          '</footer>';
        elRestoreList.appendChild(div);
      });
      elRestoreList.onclick = async ev=>{
        const btn = ev.target.closest('button');
        if(!btn) return;
        const id = btn.getAttribute('data-id');
        if(!confirm('¿Borrar registro de restore?')) return;
        try{
          await api('/api/restores/'+id,{method:'DELETE'});
          toast('Registro eliminado');
          loadRestores();
        }catch(e){toast('Error borrando registro');}
      };
    }catch(e){
      elRestoreList.innerHTML='<div class="list-small-item">Error cargando restores.</div>';
    }
  }

  async function refreshActiveJob(){
    if(!currentId) return;
    try{
      const data = await api('/api/jobs/active');
      const list = (data && data.active) || [];
      const job = list.find(j=>j.server_id===currentId) || null;
      if(!job){
        resetJobView();
        return;
      }
      activeJobId = job.id;
      const full = await api('/api/job/'+job.id);
      const pct = full.percent || 0;
      elJobBar.style.width = pct+'%';
      elJobPct.textContent = pct.toFixed ? pct.toFixed(0)+'%' : pct+'%';
      elJobStatus.textContent = full.type.toUpperCase()+' · '+(full.status || 'running');
      elJobLogs.textContent = (full.logs || []).join('\\n') || 'Sin logs.';
    }catch(e){
      // silencio
    }
  }

  // Poll jobs cada 3s
  setInterval(refreshActiveJob, 3000);

  // Form agregar server
  document.getElementById('formAddServer').addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    const f = ev.target;
    const body = {
      label: f.label.value,
      ip: f.ip.value,
      ssh_user: f.ssh_user.value || 'root',
      ssh_pass: f.ssh_pass.value,
      pmtr_path: f.pmtr_path.value || '/var/www/paymenter',
      db_host: f.db_host.value || '127.0.0.1',
      db_name: f.db_name.value || 'paymenter',
      db_user: f.db_user.value || 'paymenter',
      db_pass: f.db_pass.value,
      schedule_key: f.schedule_key.value,
      retention_key: f.retention_key.value,
      enabled: f.schedule_key.value !== 'off'
    };
    try{
      await api('/api/servers',{
        method:'POST',
        body:JSON.stringify(body)
      });
      toast('Servidor agregado');
      f.reset();
      f.ssh_user.value='root';
      f.pmtr_path.value='/var/www/paymenter';
      f.db_host.value='127.0.0.1';
      f.db_name.value='paymenter';
      f.db_user.value='paymenter';
      loadServers();
    }catch(e){
      toast('Error agregando servidor');
    }
  });

  // Botones acciones rápidas
  document.getElementById('btnBackupDb').onclick = async ()=>{
    if(!currentId){toast('Selecciona un servidor primero');return;}
    try{
      await api('/api/servers/'+currentId+'/backup-now',{
        method:'POST',
        body:JSON.stringify({kind:'db'})
      });
      toast('Backup DB iniciado');
      refreshActiveJob();
      loadBackups();
    }catch(e){toast('Error iniciando backup DB');}
  };
  document.getElementById('btnBackupFull').onclick = async ()=>{
    if(!currentId){toast('Selecciona un servidor primero');return;}
    try{
      await api('/api/servers/'+currentId+'/backup-now',{
        method:'POST',
        body:JSON.stringify({kind:'full'})
      });
      toast('Backup FULL iniciado');
      refreshActiveJob();
      loadBackups();
    }catch(e){toast('Error iniciando backup FULL');}
  };
  document.getElementById('btnCleanup').onclick = async ()=>{
    if(!currentId){toast('Selecciona un servidor');return;}
    try{
      const data = await api('/api/servers/'+currentId+'/cleanup',{method:'POST'});
      toast('Limpieza por retención: '+(data.deleted||0)+' borrados');
      loadBackups();
    }catch(e){toast('Error en limpieza');}
  };
  document.getElementById('btnDeleteServer').onclick = async ()=>{
    if(!currentId){toast('Selecciona un servidor');return;}
    if(!confirm('¿Eliminar servidor y todos sus backups locales?'))return;
    try{
      await api('/api/servers/'+currentId,{method:'DELETE'});
      toast('Servidor eliminado');
      currentId=null;
      loadServers();
      elBackupList.innerHTML='';
      elRestoreList.innerHTML='';
      resetJobView();
    }catch(e){toast('Error eliminando servidor');}
  };

  // Restore
  elRestoreMode.addEventListener('change',()=>{
    elRestoreOther.style.display = elRestoreMode.value==='other' ? 'block':'none';
  });

  document.getElementById('formRestore').addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    if(!currentId){toast('Selecciona un servidor');return;}
    const backupId = elRestoreSel.value;
    if(!backupId){toast('Selecciona un backup');return;}
    const mode = elRestoreMode.value;
    const body = { backup_id: +backupId, mode };
    if(mode==='other'){
      const f = ev.target;
      const ip = f.target_ip.value.trim();
      const user = f.target_user.value.trim() || 'root';
      const pass = f.target_pass.value;
      if(!ip || !pass){toast('Falta IP o contraseña destino');return;}
      body.ip = ip;
      body.ssh_user = user;
      body.ssh_pass = pass;
    }
    try{
      await api('/api/restore',{
        method:'POST',
        body:JSON.stringify(body)
      });
      toast('Restore iniciado');
      refreshActiveJob();
      loadRestores();
    }catch(e){
      toast('Error iniciando restore');
    }
  });

  // Carga inicial
  loadServers();
})();
</script>
</body>
</html>`;
}

// ===== Export =====
module.exports = { createPanelRouter };
