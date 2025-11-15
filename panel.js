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
// ===== UI HTML (panel web) =====
function renderPanelPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SkyUltraPlus — Backup Paymenter</title>
<style>
:root {
  --bg: #050816;
  --bg-alt: #090c1a;
  --bg-soft: #0f172a;
  --card: #020617;
  --accent: #38bdf8;
  --accent-soft: rgba(56,189,248,0.15);
  --danger: #f97373;
  --ok: #4ade80;
  --text: #e5e7eb;
  --muted: #9ca3af;
  --border: #1f2937;
  --radius-lg: 18px;
  --radius-md: 12px;
  --shadow-soft: 0 18px 45px rgba(15,23,42,0.85);
  --shadow-sm: 0 10px 25px rgba(15,23,42,0.6);
}

* {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: radial-gradient(circle at top, #172554 0, #020617 60%, #000 100%);
  color: var(--text);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
}

body {
  display: flex;
  flex-direction: column;
}

/* --- Topbar --- */
.app-topbar {
  height: 58px;
  padding: 0 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(90deg, rgba(8,47,73,0.92), rgba(15,23,42,0.96));
  border-bottom: 1px solid rgba(148,163,184,0.25);
  box-shadow: 0 10px 40px rgba(15,23,42,0.9);
  position: sticky;
  top: 0;
  z-index: 50;
}

.app-topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.app-logo {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: conic-gradient(from 160deg, #0ea5e9, #22c55e, #e11d48, #0ea5e9);
  padding: 2px;
  position: relative;
  box-shadow: 0 0 0 1px rgba(15,23,42,0.9), 0 0 24px rgba(56,189,248,0.6);
}
.app-logo-inner {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: radial-gradient(circle at 30% 0, #e5e7eb 0, #0f172a 45%, #000 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e5e7eb;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.03em;
}
.app-logo-pulse {
  position: absolute;
  inset: -6px;
  border-radius: inherit;
  border: 1px solid rgba(56,189,248,0.45);
  opacity: 0.4;
  animation: pulse-ring 2.4s infinite;
}

@keyframes pulse-ring {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  60% {
    transform: scale(1.18);
    opacity: 0;
  }
  100% {
    transform: scale(1.18);
    opacity: 0;
  }
}

.app-title-main {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  display: flex;
  flex-direction: column;
}
.app-title-main span:first-child {
  background: linear-gradient(90deg, #e5e7eb, #38bdf8);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.app-title-main span:last-child {
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
}

.app-topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-pill {
  border-radius: 999px;
  border: 1px solid rgba(148,163,184,0.4);
  background: radial-gradient(circle at 0 0, rgba(56,189,248,0.15) 0, rgba(15,23,42,0.95) 40%, #020617 100%);
  padding: 5px 10px;
  font-size: 11px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.app-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #22c55e;
  box-shadow: 0 0 0 4px rgba(34,197,94,0.28);
}

/* --- Layout --- */
.app-shell {
  flex: 1;
  display: flex;
  height: calc(100vh - 58px);
  overflow: hidden;
}

/* Sidebar */
.app-sidebar {
  width: 310px;
  max-width: 100%;
  border-right: 1px solid rgba(15,23,42,0.95);
  background: radial-gradient(circle at top left, rgba(56,189,248,0.12) 0, rgba(2,6,23,0.98) 40%, #020617 100%);
  padding: 14px 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sidebar-section-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--muted);
  opacity: 0.9;
  margin-bottom: 2px;
}

/* New server card */
.card {
  background: radial-gradient(circle at top, rgba(15,118,110,0.12) 0, rgba(15,23,42,0.96) 45%, rgba(2,6,23,0.98) 100%);
  border-radius: var(--radius-lg);
  border: 1px solid rgba(30,64,175,0.8);
  box-shadow: var(--shadow-soft);
  padding: 12px 12px 10px;
  position: relative;
  overflow: hidden;
}
.card::before {
  content: "";
  position: absolute;
  inset: -40%;
  background: radial-gradient(circle at 0 0, rgba(56,189,248,0.12), transparent 45%);
  opacity: 0.5;
  pointer-events: none;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.card-header h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.card-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(15,23,42,0.9);
  border: 1px solid rgba(56,189,248,0.5);
  color: var(--muted);
}

/* Forms */
.form-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 8px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-row label {
  font-size: 11px;
  color: var(--muted);
}
.form-row input,
.form-row select {
  background: rgba(15,23,42,0.92);
  border-radius: 9px;
  border: 1px solid rgba(30,64,175,0.9);
  padding: 6px 8px;
  color: var(--text);
  font-size: 12px;
  outline: none;
}
.form-row input::placeholder {
  color: #6b7280;
}
.form-row input:focus,
.form-row select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(56,189,248,0.4);
}
.form-row-small {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted);
  gap: 6px;
}

.btn {
  border-radius: 999px;
  border: 1px solid rgba(148,163,184,0.4);
  background: radial-gradient(circle at 0 0, rgba(56,189,248,0.2) 0, rgba(15,23,42,0.95) 40%, #020617 100%);
  color: var(--text);
  padding: 6px 11px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.btn span {
  font-size: 12px;
}
.btn-ghost {
  background: rgba(15,23,42,0.92);
  border-color: rgba(55,65,81,0.9);
}
.btn-danger {
  border-color: rgba(248,113,113,0.8);
  background: radial-gradient(circle at 0 0, rgba(248,113,113,0.26), rgba(15,23,42,0.95));
}
.btn-ok {
  border-color: rgba(74,222,128,0.8);
  background: radial-gradient(circle at 0 0, rgba(34,197,94,0.2), rgba(15,23,42,0.95));
}
.btn-sm {
  padding: 4px 8px;
  font-size: 10px;
}

.btn:active {
  transform: translateY(1px);
  box-shadow: none;
}

/* Server list */
.server-list {
  margin-top: 3px;
  border-radius: var(--radius-lg);
  background: rgba(15,23,42,0.96);
  border: 1px solid rgba(30,64,175,0.9);
  box-shadow: var(--shadow-soft);
  padding: 6px 4px 4px;
  max-height: calc(100vh - 260px);
  overflow-y: auto;
}
.server-item {
  border-radius: 10px;
  padding: 7px 9px;
  margin-bottom: 4px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: linear-gradient(135deg, rgba(15,23,42,0.95), rgba(15,23,42,0.98));
  border: 1px solid transparent;
  position: relative;
}
.server-item::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 1px solid transparent;
  background: radial-gradient(circle at 0 0, rgba(56,189,248,0.28), transparent 55%);
  opacity: 0;
  transition: opacity 0.18s;
  pointer-events: none;
}
.server-item:hover::before {
  opacity: 0.22;
}
.server-item-active {
  border-color: rgba(56,189,248,0.9);
  box-shadow: 0 0 0 1px rgba(56,189,248,0.6);
}
.server-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.server-item-name {
  font-size: 12px;
  font-weight: 500;
}
.server-item-ip {
  font-size: 11px;
  color: var(--muted);
}
.server-item-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: var(--muted);
}
.badge {
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 10px;
  border: 1px solid rgba(75,85,99,0.9);
  background: rgba(15,23,42,0.92);
}
.badge-green {
  border-color: rgba(34,197,94,0.8);
  color: #22c55e;
}
.badge-red {
  border-color: rgba(244,63,94,0.8);
  color: #f97373;
}
.badge-blue {
  border-color: rgba(56,189,248,0.8);
  color: #38bdf8;
}

/* Main content */
.app-main {
  flex: 1;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}

/* Info + actions layout */
.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.15fr);
  gap: 10px;
  height: 100%;
}

.main-card {
  background: radial-gradient(circle at top right, rgba(56,189,248,0.11) 0, rgba(2,6,23,0.98) 50%, #020617 100%);
  border-radius: var(--radius-lg);
  border: 1px solid rgba(30,64,175,0.9);
  box-shadow: var(--shadow-soft);
  padding: 10px 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
  overflow: hidden;
}
.main-card::before {
  content: "";
  position: absolute;
  inset: -50%;
  background: radial-gradient(circle at top right, rgba(56,189,248,0.18), transparent 50%);
  opacity: 0.55;
  pointer-events: none;
}

/* Card headers */
.main-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.main-card-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.main-card-sub {
  font-size: 11px;
  color: var(--muted);
}

/* Key-value list */
.kv-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.2fr);
  gap: 6px 12px;
}
.kv-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kv-label {
  font-size: 11px;
  color: var(--muted);
}
.kv-value {
  font-size: 12px;
  color: var(--text);
  word-break: break-all;
}

/* Tabs small */
.tabs {
  display: inline-flex;
  border-radius: 999px;
  padding: 2px;
  background: rgba(15,23,42,0.85);
  border: 1px solid rgba(30,64,175,0.9);
}
.tab {
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  cursor: pointer;
  color: var(--muted);
}
.tab-active {
  background: radial-gradient(circle at 0 0, rgba(56,189,248,0.3) 0, rgba(15,23,42,0.95) 45%);
  color: var(--text);
  border: 1px solid rgba(56,189,248,0.8);
}

/* Backups & Restores table */
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.table th,
.table td {
  padding: 6px 5px;
  text-align: left;
  border-bottom: 1px solid rgba(30,64,175,0.6);
}
.table th {
  font-weight: 500;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.09em;
}
.table tbody tr:hover {
  background: rgba(15,23,42,0.8);
}

/* Scroll containers */
.scroll-y {
  overflow-y: auto;
  padding-right: 2px;
}

/* Pill bullets */
.pill-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

/* Job status bar */
.job-bar {
  position: fixed;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  min-width: 280px;
  max-width: 440px;
  border-radius: 999px;
  background: radial-gradient(circle at 0 0, rgba(56,189,248,0.2), rgba(15,23,42,0.98));
  border: 1px solid rgba(56,189,248,0.7);
  box-shadow: 0 20px 40px rgba(15,23,42,0.95);
  padding: 7px 12px;
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  z-index: 80;
}
.job-bar-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.job-bar-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.job-bar-status {
  font-size: 11px;
  color: var(--muted);
}
.job-bar-progress-wrap {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: rgba(15,23,42,0.95);
  overflow: hidden;
}
.job-bar-progress {
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, #22c55e, #38bdf8);
  transition: width 0.2s ease-out;
}
.job-bar-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid rgba(148,163,184,0.6);
  background: rgba(15,23,42,0.9);
}

/* Toast */
.toast {
  position: fixed;
  right: 12px;
  bottom: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(15,23,42,0.98);
  border: 1px solid rgba(148,163,184,0.7);
  box-shadow: var(--shadow-sm);
  color: var(--text);
  font-size: 12px;
  max-width: 320px;
  z-index: 90;
  display: none;
}

/* Mobile */
@media (max-width: 900px) {
  .app-shell {
    flex-direction: column;
  }
  .app-sidebar {
    width: 100%;
    height: auto;
    max-height: none;
    border-right: none;
    border-bottom: 1px solid rgba(30,64,175,0.9);
  }
  .server-list {
    max-height: 260px;
  }
  .app-main {
    height: auto;
  }
  .main-grid {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
}

/* Subtle neon line */
.neon-line {
  height: 1px;
  margin: 6px 0;
  background: linear-gradient(90deg, transparent, rgba(56,189,248,0.8), transparent);
  opacity: 0.7;
}
</style>
</head>
<body>
  <header class="app-topbar">
    <div class="app-topbar-left">
      <div class="app-logo">
        <div class="app-logo-inner">
          <span>SU</span>
        </div>
        <div class="app-logo-pulse"></div>
      </div>
      <div class="app-title-main">
        <span>SkyUltraPlus · Backup Hub</span>
        <span>Paymenter — DB & Full snapshots</span>
      </div>
    </div>
    <div class="app-topbar-right">
      <div class="app-pill">
        <span class="app-pill-dot"></span>
        <span>Autosnap & Restore · v1.0</span>
      </div>
    </div>
  </header>

  <div class="app-shell">
    <!-- Sidebar -->
    <aside class="app-sidebar">
      <div>
        <div class="sidebar-section-title">Nuevo servidor Paymenter</div>
        <div class="card">
          <div class="card-header">
            <h2>Registrar servidor</h2>
            <span class="card-tag">SSH + DB config</span>
          </div>
          <form id="form-new-server">
            <div class="form-grid-2">
              <div class="form-row">
                <label>Nombre interno</label>
                <input name="label" placeholder="Ej: Hetzner-01 Paymenter"/>
              </div>
              <div class="form-row">
                <label>IP / Host</label>
                <input name="ip" placeholder="127.0.0.1 o 45.90.x.x" required/>
              </div>
              <div class="form-row">
                <label>Usuario SSH</label>
                <input name="ssh_user" placeholder="root" value="root"/>
              </div>
              <div class="form-row">
                <label>Password SSH</label>
                <input name="ssh_pass" placeholder="••••••" type="password"/>
              </div>
              <div class="form-row">
                <label>Ruta Paymenter</label>
                <input name="pmtr_path" placeholder="/var/www/paymenter" value="/var/www/paymenter"/>
              </div>
              <div class="form-row">
                <label>DB Host</label>
                <input name="db_host" placeholder="127.0.0.1" value="127.0.0.1"/>
              </div>
              <div class="form-row">
                <label>DB Nombre</label>
                <input name="db_name" placeholder="paymenter" value="paymenter"/>
              </div>
              <div class="form-row">
                <label>DB Usuario</label>
                <input name="db_user" placeholder="paymenter" value="paymenter"/>
              </div>
              <div class="form-row">
                <label>DB Password</label>
                <input name="db_pass" placeholder="(si aplica)" type="password"/>
              </div>
            </div>
            <div class="form-row-small" style="margin-top:6px;">
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:11px;color:var(--muted);">Programación</span>
                <select name="schedule_key" style="font-size:11px;padding:3px 6px;border-radius:999px;background:#020617;border:1px solid rgba(30,64,175,0.9);color:var(--text);">
                  <option value="off">Manual</option>
                  <option value="1h">Cada 1h</option>
                  <option value="6h">Cada 6h</option>
                  <option value="12h">Cada 12h</option>
                  <option value="1d">Cada 24h</option>
                  <option value="1w">Cada semana</option>
                </select>
              </div>
              <button type="submit" class="btn btn-ok">
                <span>＋</span> Guardar
              </button>
            </div>
          </form>
        </div>
      </div>

      <div>
        <div class="sidebar-section-title" style="margin-top:6px;">Servidores registrados</div>
        <div class="server-list" id="servers-list">
          <!-- items dinámicos -->
        </div>
      </div>
    </aside>

    <!-- Main -->
    <main class="app-main">
      <div class="main-grid">
        <!-- Left: server info & config -->
        <section class="main-card" id="card-server-info">
          <div class="main-card-header">
            <div>
              <div class="main-card-title">Detalles del servidor</div>
              <div class="main-card-sub" id="server-subtitle">Selecciona un servidor de la lista izquierda.</div>
            </div>
            <div id="server-status-chip" class="badge badge-red">Sin selección</div>
          </div>
          <div class="neon-line"></div>

          <div id="server-info-empty" style="font-size:12px;color:var(--muted);margin-top:4px;">
            ➜ Elige un servidor para ver IP, ruta Paymenter, programación, etc.
          </div>

          <div id="server-info-content" style="display:none;flex-direction:column;gap:6px;">
            <div class="kv-grid">
              <div class="kv-row">
                <div class="kv-label">Nombre interno</div>
                <div class="kv-value" id="info-label"></div>
              </div>
              <div class="kv-row">
                <div class="kv-label">Dirección IP</div>
                <div class="kv-value" id="info-ip"></div>
              </div>
              <div class="kv-row">
                <div class="kv-label">Ruta Paymenter</div>
                <div class="kv-value" id="info-path"></div>
              </div>
              <div class="kv-row">
                <div class="kv-label">Base de datos</div>
                <div class="kv-value" id="info-db"></div>
              </div>
              <div class="kv-row">
                <div class="kv-label">Programación backup</div>
                <div class="kv-value" id="info-sched"></div>
              </div>
              <div class="kv-row">
                <div class="kv-label">Retención</div>
                <div class="kv-value" id="info-retention"></div>
              </div>
              <div class="kv-row">
                <div class="kv-label">Último backup</div>
                <div class="kv-value" id="info-last"></div>
              </div>
              <div class="kv-row">
                <div class="kv-label">Próximo backup</div>
                <div class="kv-value" id="info-next"></div>
              </div>
            </div>

            <div class="neon-line"></div>

            <div class="pill-row">
              <button type="button" class="btn btn-sm btn-ghost" id="btn-edit-ssh">Editar SSH / DB</button>
              <button type="button" class="btn btn-sm btn-danger" id="btn-delete-server">Eliminar servidor</button>
            </div>

            <div style="margin-top:4px;">
              <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">Programación & Retención</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                <div style="display:flex;align-items:center;gap:4px;">
                  <span style="font-size:11px;color:var(--muted);">Programa</span>
                  <select id="edit-schedule" style="font-size:11px;padding:3px 6px;border-radius:999px;background:#020617;border:1px solid rgba(30,64,175,0.9);color:var(--text);">
                    <option value="off">Manual</option>
                    <option value="1h">Cada 1h</option>
                    <option value="6h">Cada 6h</option>
                    <option value="12h">Cada 12h</option>
                    <option value="1d">Cada 24h</option>
                    <option value="1w">Cada semana</option>
                    <option value="15d">Cada 15 días</option>
                    <option value="1m">Cada mes</option>
                  </select>
                </div>

                <div style="display:flex;align-items:center;gap:4px;">
                  <span style="font-size:11px;color:var(--muted);">Retención</span>
                  <select id="edit-retention" style="font-size:11px;padding:3px 6px;border-radius:999px;background:#020617;border:1px solid rgba(30,64,175,0.9);color:var(--text);">
                    <option value="off">Sin auto-borrado</option>
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

                <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);">
                  <input type="checkbox" id="edit-enabled" style="accent-color:#22c55e;"/>
                  <span>Autosnap activado</span>
                </label>

                <button type="button" class="btn btn-sm btn-ok" id="btn-save-sched">
                  Guardar cambios
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- Right: backups & restores -->
        <section class="main-card" id="card-backups">
          <div class="main-card-header">
            <div>
              <div class="main-card-title">Backups & Restore</div>
              <div class="main-card-sub">Crea snapshots FULL/DB y restaura en la misma VPS o en una nueva.</div>
            </div>
            <div class="tabs">
              <div class="tab tab-active" id="tab-backups">Backups</div>
              <div class="tab" id="tab-restores">Restores</div>
            </div>
          </div>
          <div class="neon-line"></div>

          <div id="backups-view" style="display:flex;flex-direction:column;gap:8px;height:100%;">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
              <button type="button" class="btn btn-sm btn-ok" id="btn-backup-full">
                FULL Paymenter
              </button>
              <button type="button" class="btn btn-sm btn-ghost" id="btn-backup-db">
                Solo DB + .env
              </button>
              <button type="button" class="btn btn-sm btn-ghost" id="btn-refresh-backups">
                Refrescar
              </button>
              <button type="button" class="btn btn-sm btn-danger" id="btn-retention-clean">
                Limpiar por retención
              </button>
              <span style="font-size:11px;color:var(--muted);margin-left:auto;" id="backups-summary">
                Sin servidor.
              </span>
            </div>

            <div id="backups-empty" style="font-size:12px;color:var(--muted);margin-top:2px;">
              ➜ Selecciona un servidor y crea tu primer snapshot.
            </div>

            <div id="backups-table-wrap" class="scroll-y" style="flex:1;display:none;margin-top:4px;">
              <table class="table" id="backups-table">
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
                <tbody>
                  <!-- filas -->
                </tbody>
              </table>
            </div>
          </div>

          <div id="restores-view" style="display:none;flex-direction:column;gap:8px;height:100%;">
            <div style="font-size:12px;color:var(--muted);">
              Historial de restauraciones realizadas con este panel. Puedes limpiar registros individuales.
            </div>
            <div id="restores-empty" style="font-size:12px;color:var(--muted);">
              ➜ No hay restores registrados todavía.
            </div>
            <div id="restores-table-wrap" class="scroll-y" style="flex:1;display:none;margin-top:4px;">
              <table class="table" id="restores-table">
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
                <tbody>
                  <!-- filas -->
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>

  <!-- Job bar -->
  <div class="job-bar" id="job-bar">
    <div class="job-bar-left">
      <div class="job-bar-title" id="job-title">Job</div>
      <div class="job-bar-status" id="job-status">Preparando…</div>
      <div class="job-bar-progress-wrap">
        <div class="job-bar-progress" id="job-progress"></div>
      </div>
    </div>
    <div class="job-bar-badge" id="job-badge">···</div>
  </div>

  <!-- Toast -->
  <div class="toast" id="toast"></div>

<script>
(function() {
  var currentServerId = null;
  var serversCache = [];
  var activeJobId = null;
  var jobPollTimer = null;

  function $(sel) {
    return document.querySelector(sel);
  }
  function createEl(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function(k) {
        if (k === "text") el.textContent = props[k];
        else if (k === "html") el.innerHTML = props[k];
        else el.setAttribute(k, props[k]);
      });
    }
    return el;
  }

  function showToast(msg, isError) {
    var t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.style.display = "block";
    t.style.borderColor = isError ? "rgba(248,113,113,0.9)" : "rgba(148,163,184,0.8)";
    setTimeout(function() {
      t.style.display = "none";
    }, 4500);
  }

  function formatBytes(size) {
    if (!size || size <= 0) return "—";
    var kb = size / 1024;
    var mb = kb / 1024;
    var gb = mb / 1024;
    if (gb >= 1) return gb.toFixed(2) + " GB";
    if (mb >= 1) return mb.toFixed(1) + " MB";
    if (kb >= 1) return kb.toFixed(0) + " KB";
    return size + " B";
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function scheduleLabel(key) {
    var map = {
      "off": "Manual",
      "1h": "Cada 1h",
      "6h": "Cada 6h",
      "12h": "Cada 12h",
      "1d": "Cada 24h",
      "1w": "Cada semana",
      "15d": "Cada 15 días",
      "1m": "Cada mes"
    };
    return map[key] || key;
  }

  function retentionLabel(key) {
    var map = {
      "off": "Sin auto-borrado",
      "1d": "1 día",
      "3d": "3 días",
      "7d": "7 días",
      "15d": "15 días",
      "30d": "30 días",
      "60d": "60 días",
      "90d": "90 días",
      "180d": "180 días",
      "schedx3": "3× intervalo",
      "schedx7": "7× intervalo"
    };
    return map[key] || key;
  }

  function setJobBarVisible(v) {
    var bar = $("#job-bar");
    if (!bar) return;
    bar.style.display = v ? "flex" : "none";
  }

  function updateJobBar(data) {
    var title = $("#job-title");
    var status = $("#job-status");
    var badge = $("#job-badge");
    var prog = $("#job-progress");
    if (!title || !status || !badge || !prog) return;

    title.textContent = (data.type === "backup" ? "Backup Paymenter" : "Restore Paymenter") + " · Job " + data.id.substring(0, 6);
    status.textContent = data.status.toUpperCase() + " · " + data.percent + "%";
    badge.textContent = data.type === "backup" ? "SNAPSHOT" : "RESTORE";
    prog.style.width = (data.percent || 0) + "%";

    if (data.status === "done") {
      badge.style.borderColor = "rgba(74,222,128,0.9)";
      status.style.color = "#4ade80";
    } else if (data.status === "failed") {
      badge.style.borderColor = "rgba(248,113,113,0.9)";
      status.style.color = "#f97373";
    } else {
      badge.style.borderColor = "rgba(148,163,184,0.7)";
      status.style.color = "var(--muted)";
    }
  }

  function startJobPolling(jobId) {
    activeJobId = jobId;
    setJobBarVisible(true);
    if (jobPollTimer) clearInterval(jobPollTimer);

    function poll() {
      fetch("/api/job/" + encodeURIComponent(jobId))
        .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function(data) {
          updateJobBar(data);
          if (data.status !== "running") {
            clearInterval(jobPollTimer);
            jobPollTimer = null;
            setTimeout(function() {
              setJobBarVisible(false);
            }, 2500);
            if (currentServerId) {
              loadBackups(currentServerId);
              loadServerDetails(currentServerId);
              loadRestores(currentServerId);
            }
          }
        })
        .catch(function() {});
    }

    poll();
    jobPollTimer = setInterval(poll, 2000);
  }

  function loadServers() {
    var list = $("#servers-list");
    if (!list) return;
    list.innerHTML = "<div style='font-size:12px;color:var(--muted);padding:4px 4px;'>Cargando servidores…</div>";
    fetch("/api/servers")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        serversCache = data.servers || [];
        if (!serversCache.length) {
          list.innerHTML = "<div style='font-size:12px;color:var(--muted);padding:6px 4px;'>Aún no hay servidores registrados.</div>";
          return;
        }
        list.innerHTML = "";
        serversCache.forEach(function(srv) {
          var item = createEl("div", { "class": "server-item", "data-id": srv.id });
          if (srv.id === currentServerId) item.classList.add("server-item-active");

          var header = createEl("div", { "class": "server-item-header" });
          var name = createEl("div", { "class": "server-item-name", text: srv.label || ("Server " + srv.id) });
          var ip = createEl("div", { "class": "server-item-ip", text: srv.ip });
          header.appendChild(name);
          header.appendChild(ip);

          var meta = createEl("div", { "class": "server-item-meta" });
          var left = createEl("div");
          var enabled = !!srv.enabled;
          var badgeStatus = createEl("span", { "class": "badge " + (enabled ? "badge-green" : "badge-red") });
          badgeStatus.textContent = enabled ? "Autosnap ON" : "Manual";
          left.appendChild(badgeStatus);

          var sched = createEl("span", { "class": "badge badge-blue" });
          sched.textContent = scheduleLabel(srv.schedule_key || "off");
          meta.appendChild(left);
          meta.appendChild(sched);

          item.appendChild(header);
          item.appendChild(meta);

          item.addEventListener("click", function() {
            currentServerId = srv.id;
            document.querySelectorAll(".server-item").forEach(function(el) {
              el.classList.remove("server-item-active");
            });
            item.classList.add("server-item-active");
            loadServerDetails(srv.id);
            loadBackups(srv.id);
            loadRestores(srv.id);
          });

          list.appendChild(item);
        });
      })
      .catch(function() {
        list.innerHTML = "<div style='font-size:12px;color:#f97373;padding:6px 4px;'>Error al cargar servidores.</div>";
      });
  }

  function loadServerDetails(id) {
    var infoEmpty = $("#server-info-empty");
    var infoContent = $("#server-info-content");
    var subtitle = $("#server-subtitle");
    var statusChip = $("#server-status-chip");

    var labelEl = $("#info-label");
    var ipEl = $("#info-ip");
    var pathEl = $("#info-path");
    var dbEl = $("#info-db");
    var schedEl = $("#info-sched");
    var retEl = $("#info-retention");
    var lastEl = $("#info-last");
    var nextEl = $("#info-next");

    var selSched = $("#edit-schedule");
    var selRet = $("#edit-retention");
    var chkEnabled = $("#edit-enabled");

    if (!serversCache.length) return;
    var srv = serversCache.find(function(s) { return s.id === id; });
    if (!srv) return;

    infoEmpty.style.display = "none";
    infoContent.style.display = "flex";

    subtitle.textContent = "Gestión de backups para " + (srv.label || ("Server " + srv.id));
    statusChip.textContent = srv.enabled ? "Autosnap ON" : "Manual";
    statusChip.className = "badge " + (srv.enabled ? "badge-green" : "badge-red");

    labelEl.textContent = srv.label || "—";
    ipEl.textContent = srv.ip || "—";
    pathEl.textContent = srv.pmtr_path || "/var/www/paymenter";
    dbEl.textContent = (srv.db_name || "paymenter") + " @" + (srv.db_host || "127.0.0.1") + " (user " + (srv.db_user || "paymenter") + ")";
    schedEl.textContent = scheduleLabel(srv.schedule_key || "off");
    retEl.textContent = retentionLabel(srv.retention_key || "off");
    lastEl.textContent = fmtDate(srv.last_run);
    nextEl.textContent = fmtDate(srv.next_run);

    if (selSched) selSched.value = srv.schedule_key || "off";
    if (selRet) selRet.value = srv.retention_key || "off";
    if (chkEnabled) chkEnabled.checked = !!srv.enabled;
  }

  function loadBackups(serverId) {
    var empty = $("#backups-empty");
    var wrap = $("#backups-table-wrap");
    var tbody = $("#backups-table tbody");
    var summary = $("#backups-summary");

    if (!serverId) {
      empty.style.display = "block";
      wrap.style.display = "none";
      summary.textContent = "Sin servidor.";
      return;
    }

    empty.style.display = "block";
    empty.textContent = "Cargando backups…";
    wrap.style.display = "none";
    summary.textContent = "Cargando…";

    fetch("/api/backups?server_id=" + encodeURIComponent(serverId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var backups = data.backups || [];
        if (!backups.length) {
          empty.style.display = "block";
          empty.textContent = "No hay backups todavía.";
          wrap.style.display = "none";
          summary.textContent = "0 backups.";
          tbody.innerHTML = "";
          return;
        }

        empty.style.display = "none";
        wrap.style.display = "block";
        tbody.innerHTML = "";
        summary.textContent = backups.length + " snapshots.";

        backups.forEach(function(b) {
          var tr = createEl("tr");
          var tdId = createEl("td", { text: b.id });
          var tdFile = createEl("td", { text: b.filename });
          var tdType = createEl("td", { text: (b.type || "full").toUpperCase() });
          var tdSize = createEl("td", { text: formatBytes(b.size_bytes) });
          var tdDate = createEl("td", { text: fmtDate(b.created_at) });
          var tdStatus = createEl("td", { text: (b.status || "").toUpperCase() });

          var tdActions = createEl("td");
          tdActions.style.whiteSpace = "nowrap";

          var btnDl = createEl("button");
          btnDl.className = "btn btn-sm btn-ghost";
          btnDl.textContent = "Descargar";
          btnDl.addEventListener("click", function() {
            window.open("/api/backups/download/" + b.id, "_blank");
          });
          tdActions.appendChild(btnDl);

          var btnRestSame = createEl("button");
          btnRestSame.className = "btn btn-sm btn-ok";
          btnRestSame.style.marginLeft = "4px";
          btnRestSame.textContent = "Restore aquí";
          btnRestSame.addEventListener("click", function() {
            if (!confirm("Restaurar este backup sobre la misma VPS? Esto sobreescribirá Paymenter y su base de datos.")) return;
            doRestore(b.id, "same");
          });
          tdActions.appendChild(btnRestSame);

          var btnRestOther = createEl("button");
          btnRestOther.className = "btn btn-sm btn-ghost";
          btnRestOther.style.marginLeft = "4px";
          btnRestOther.textContent = "→ Otra VPS";
          btnRestOther.addEventListener("click", function() {
            var ip = prompt("IP/host de la nueva VPS donde restaurar Paymenter:");
            if (!ip) return;
            var user = prompt("Usuario SSH (por defecto root):") || "root";
            var pass = prompt("Password SSH del servidor destino:");
            if (!pass) return;
            doRestore(b.id, "other", { ip: ip, ssh_user: user, ssh_pass: pass });
          });
          tdActions.appendChild(btnRestOther);

          var btnDel = createEl("button");
          btnDel.className = "btn btn-sm btn-danger";
          btnDel.style.marginLeft = "4px";
          btnDel.textContent = "Eliminar";
          btnDel.addEventListener("click", function() {
            if (!confirm("Eliminar este archivo de backup?")) return;
            fetch("/api/backups/" + b.id, { method: "DELETE" })
              .then(function(r) { return r.json(); })
              .then(function() {
                showToast("Backup eliminado.");
                loadBackups(serverId);
              })
              .catch(function() {
                showToast("Error al eliminar backup.", true);
              });
          });
          tdActions.appendChild(btnDel);

          tr.appendChild(tdId);
          tr.appendChild(tdFile);
          tr.appendChild(tdType);
          tr.appendChild(tdSize);
          tr.appendChild(tdDate);
          tr.appendChild(tdStatus);
          tr.appendChild(tdActions);

          tbody.appendChild(tr);
        });
      })
      .catch(function() {
        empty.style.display = "block";
        empty.textContent = "Error al cargar backups.";
        wrap.style.display = "none";
        summary.textContent = "Error.";
      });
  }

  function loadRestores(serverId) {
    var empty = $("#restores-empty");
    var wrap = $("#restores-table-wrap");
    var tbody = $("#restores-table tbody");

    if (!serverId) {
      empty.style.display = "block";
      empty.textContent = "Selecciona un servidor.";
      wrap.style.display = "none";
      tbody.innerHTML = "";
      return;
    }

    empty.style.display = "block";
    empty.textContent = "Cargando historial…";
    wrap.style.display = "none";
    tbody.innerHTML = "";

    fetch("/api/restores?server_id=" + encodeURIComponent(serverId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var rows = data.restores || [];
        if (!rows.length) {
          empty.style.display = "block";
          empty.textContent = "No hay restores registrados todavía.";
          wrap.style.display = "none";
          return;
        }

        empty.style.display = "none";
        wrap.style.display = "block";
        tbody.innerHTML = "";

        rows.forEach(function(r) {
          var tr = createEl("tr");

          var tdId = createEl("td", { text: r.id });
          var tdBackup = createEl("td", { text: "#" + r.backup_id + " · " + (r.filename || "") });
          var tdMode = createEl("td", { text: (r.mode === "same" ? "Misma VPS" : "Otra VPS") });
          var tdOriginDest = createEl("td");

          var origin = (r.source_label || "Origen") + " (" + (r.source_ip || "") + ")";
          var dest = "";
          if (r.mode === "same") {
            dest = origin + " (self)";
          } else {
            dest = (r.target_label || "Destino") + " (" + (r.target_ip || r.target_ip2 || "") + ")";
          }
          tdOriginDest.textContent = origin + " → " + dest;

          var tdAuth = createEl("td", { text: r.preserve_auth ? "Auth preservada" : "Auth sobreescrita" });
          var tdStatus = createEl("td", { text: (r.status || "").toUpperCase() });

          var noteText = r.note || "";
          var tdNote = createEl("td", { text: noteText.length > 60 ? noteText.substring(0, 57) + "…" : noteText });

          var tdActions = createEl("td");
          var btnDel = createEl("button");
          btnDel.className = "btn btn-sm btn-ghost";
          btnDel.textContent = "Quitar";
          btnDel.addEventListener("click", function() {
            if (!confirm("Eliminar registro de restore #" + r.id + "?")) return;
            fetch("/api/restores/" + r.id, { method: "DELETE" })
              .then(function(resp) { return resp.json(); })
              .then(function() {
                showToast("Registro eliminado.");
                loadRestores(serverId);
              })
              .catch(function() {
                showToast("Error al eliminar registro.", true);
              });
          });
          tdActions.appendChild(btnDel);

          tr.appendChild(tdId);
          tr.appendChild(tdBackup);
          tr.appendChild(tdMode);
          tr.appendChild(tdOriginDest);
          tr.appendChild(tdAuth);
          tr.appendChild(tdStatus);
          tr.appendChild(tdNote);
          tr.appendChild(tdActions);

          tbody.appendChild(tr);
        });
      })
      .catch(function() {
        empty.style.display = "block";
        empty.textContent = "Error al cargar historial.";
        wrap.style.display = "none";
      });
  }

  function doBackup(kind) {
    if (!currentServerId) {
      showToast("Primero selecciona un servidor.", true);
      return;
    }
    fetch("/api/servers/" + currentServerId + "/backup-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: kind })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          showToast(data.error, true);
          if (data.job_id) startJobPolling(data.job_id);
          return;
        }
        if (!data.job_id) {
          showToast("No se recibió job_id del servidor.", true);
          return;
        }
        showToast("Backup " + (kind === "db" ? "DB" : "FULL") + " iniciado.");
        startJobPolling(data.job_id);
      })
      .catch(function() {
        showToast("Error al iniciar backup.", true);
      });
  }

  function doRestore(backupId, mode, other) {
    var payload = { backup_id: backupId, mode: mode };
    if (mode === "other" && other) {
      payload.ip = other.ip;
      payload.ssh_user = other.ssh_user;
      payload.ssh_pass = other.ssh_pass;
    }
    fetch("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          showToast(data.error, true);
          return;
        }
        if (data.job_id) {
          showToast("Restore iniciado (" + mode + ").");
          startJobPolling(data.job_id);
        } else {
          showToast("Restore enviado, sin job_id.", false);
        }
      })
      .catch(function() {
        showToast("Error al iniciar restore.", true);
      });
  }

  function updateSchedAndRetention() {
    if (!currentServerId) {
      showToast("Selecciona un servidor primero.", true);
      return;
    }
    var selSched = $("#edit-schedule");
    var selRet = $("#edit-retention");
    var chkEnabled = $("#edit-enabled");
    var srv = serversCache.find(function(s) { return s.id === currentServerId; });
    if (!srv) return;

    var payload = {};
    if (selSched) payload.schedule_key = selSched.value;
    if (selRet) payload.retention_key = selRet.value;
    if (chkEnabled) payload.enabled = chkEnabled.checked;

    fetch("/api/servers/" + currentServerId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          showToast(data.error, true);
          return;
        }
        showToast("Programación y retención actualizadas.");
        loadServers();
      })
      .catch(function() {
        showToast("Error al actualizar programación.", true);
      });
  }

  function initEvents() {
    var formNew = $("#form-new-server");
    if (formNew) {
      formNew.addEventListener("submit", function(ev) {
        ev.preventDefault();
        var fd = new FormData(formNew);
        var body = {
          label: fd.get("label") || "",
          ip: (fd.get("ip") || "").trim(),
          ssh_user: (fd.get("ssh_user") || "root").trim(),
          ssh_pass: fd.get("ssh_pass") || "",
          pmtr_path: (fd.get("pmtr_path") || "/var/www/paymenter").trim(),
          db_host: (fd.get("db_host") || "127.0.0.1").trim(),
          db_name: (fd.get("db_name") || "paymenter").trim(),
          db_user: (fd.get("db_user") || "paymenter").trim(),
          db_pass: fd.get("db_pass") || "",
          schedule_key: fd.get("schedule_key") || "off",
          enabled: fd.get("schedule_key") !== "off"
        };
        if (!body.ip) {
          showToast("IP/host es obligatorio.", true);
          return;
        }
        if (body.ip !== "127.0.0.1" && !body.ssh_pass) {
          showToast("Para IP remota debes indicar password SSH.", true);
          return;
        }
        fetch("/api/servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.error) {
              showToast(data.error, true);
              return;
            }
            showToast("Servidor registrado.");
            formNew.reset();
            loadServers();
          })
          .catch(function() {
            showToast("Error al guardar servidor.", true);
          });
      });
    }

    var btnFull = $("#btn-backup-full");
    var btnDb = $("#btn-backup-db");
    var btnRefresh = $("#btn-refresh-backups");
    var btnClean = $("#btn-retention-clean");
    var btnSaveSched = $("#btn-save-sched");
    var btnDeleteServer = $("#btn-delete-server");
    var btnEditSSH = $("#btn-edit-ssh");

    if (btnFull) btnFull.addEventListener("click", function() { doBackup("full"); });
    if (btnDb) btnDb.addEventListener("click", function() { doBackup("db"); });
    if (btnRefresh) btnRefresh.addEventListener("click", function() {
      if (!currentServerId) {
        showToast("Selecciona un servidor.", true);
        return;
      }
      loadBackups(currentServerId);
    });
    if (btnClean) btnClean.addEventListener("click", function() {
      if (!currentServerId) {
        showToast("Selecciona un servidor.", true);
        return;
      }
      if (!confirm("Aplicar retención y borrar backups antiguos?")) return;
      fetch("/api/servers/" + currentServerId + "/cleanup", { method: "POST" })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          showToast("Retención aplicada. Borrados: " + (data.deleted || 0));
          loadBackups(currentServerId);
        })
        .catch(function() {
          showToast("Error al aplicar retención.", true);
        });
    });
    if (btnSaveSched) btnSaveSched.addEventListener("click", updateSchedAndRetention);

    if (btnDeleteServer) {
      btnDeleteServer.addEventListener("click", function() {
        if (!currentServerId) {
          showToast("Primero selecciona un servidor.", true);
          return;
        }
        if (!confirm("Eliminar este servidor y todos sus backups locales del panel?")) return;
        fetch("/api/servers/" + currentServerId, { method: "DELETE" })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.error) {
              showToast(data.error, true);
              return;
            }
            showToast("Servidor eliminado del panel.");
            currentServerId = null;
            loadServers();
            loadBackups(null);
            loadRestores(null);
            var infoEmpty = $("#server-info-empty");
            var infoContent = $("#server-info-content");
            var statusChip = $("#server-status-chip");
            var subtitle = $("#server-subtitle");
            if (infoEmpty) infoEmpty.style.display = "block";
            if (infoContent) infoContent.style.display = "none";
            if (statusChip) {
              statusChip.textContent = "Sin selección";
              statusChip.className = "badge badge-red";
            }
            if (subtitle) subtitle.textContent = "Selecciona un servidor de la lista izquierda.";
          })
          .catch(function() {
            showToast("Error al eliminar servidor.", true);
          });
      });
    }

    if (btnEditSSH) {
      btnEditSSH.addEventListener("click", function() {
        if (!currentServerId) {
          showToast("Selecciona un servidor primero.", true);
          return;
        }
        var srv = serversCache.find(function(s) { return s.id === currentServerId; });
        if (!srv) return;

        var newUser = prompt("Usuario SSH:", srv.ssh_user || "root");
        if (!newUser) newUser = srv.ssh_user || "root";
        var newPass = prompt("Password SSH (deja vacío para no cambiar):", "");
        var body = {};
        if (newUser && newUser.trim()) body.ssh_user = newUser.trim();
        if (newPass !== null && newPass !== "") body.ssh_pass = newPass;

        if (!Object.keys(body).length) return;

        fetch("/api/servers/" + currentServerId + "/creds", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.error) {
              showToast(data.error, true);
              return;
            }
            showToast("Credenciales SSH actualizadas.");
            loadServers();
          })
          .catch(function() {
            showToast("Error al actualizar SSH.", true);
          });
      });
    }

    var tabBackups = $("#tab-backups");
    var tabRestores = $("#tab-restores");
    var viewBackups = $("#backups-view");
    var viewRestores = $("#restores-view");

    if (tabBackups && tabRestores && viewBackups && viewRestores) {
      tabBackups.addEventListener("click", function() {
        tabBackups.classList.add("tab-active");
        tabRestores.classList.remove("tab-active");
        viewBackups.style.display = "flex";
        viewRestores.style.display = "none";
      });
      tabRestores.addEventListener("click", function() {
        tabRestores.classList.add("tab-active");
        tabBackups.classList.remove("tab-active");
        viewBackups.style.display = "none";
        viewRestores.style.display = "flex";
        if (currentServerId) loadRestores(currentServerId);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function() {
    initEvents();
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
