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

