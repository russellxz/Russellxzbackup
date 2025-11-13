// db.js — DB central (users + servers/backups/restores) para SkyUltraPlus Backup
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

// Carpeta y ruta de la base de datos
const DATA_DIR = process.env.DB_DIR || path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "app.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Abrir base de datos
const db = new Database(DB_PATH, { fileMustExist: false });

// PRAGMAS básicos
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// =======================
//  SCHEMA: USERS
// =======================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TRIGGER IF NOT EXISTS trg_users_updated_at
  AFTER UPDATE ON users
  FOR EACH ROW BEGIN
    UPDATE users SET updated_at = datetime('now') WHERE id = OLD.id;
  END;
`);

// =======================
//  SCHEMA: SERVERS / BACKUPS / RESTORES
//  Enfocado a Paymenter: guarda IP, SSH y credenciales de la DB Paymenter
// =======================
db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    label           TEXT,
    ip              TEXT NOT NULL,
    ssh_user        TEXT NOT NULL DEFAULT 'root',
    ssh_pass        TEXT NOT NULL,

    -- Campos Paymenter
    pmtr_path       TEXT NOT NULL DEFAULT '/var/www/paymenter',
    db_host         TEXT NOT NULL DEFAULT '127.0.0.1',
    db_name         TEXT NOT NULL DEFAULT 'paymenter',
    db_user         TEXT NOT NULL DEFAULT 'paymenter',
    db_pass         TEXT NOT NULL DEFAULT '',

    -- Programación de backups
    schedule_key    TEXT NOT NULL DEFAULT 'off',    -- off, 1h, 6h, 12h, 1d, 1w, 15d, 1m
    interval_ms     INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 0,

    -- Retención automática
    retention_key   TEXT NOT NULL DEFAULT 'off',    -- off, 1d, 3d, 7d, 15d, 30d, 60d, 90d, 180d, schedx3, schedx7
    retention_ms    INTEGER NOT NULL DEFAULT 0,

    -- Último / próximo backup
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
    status      TEXT NOT NULL DEFAULT 'running', -- running|done|failed
    type        TEXT NOT NULL DEFAULT 'full',    -- full|db (por si en el futuro usas solo DB)
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
    status            TEXT NOT NULL DEFAULT 'running', -- running|done|failed
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

// Índices útiles
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_backups_server_id ON backups(server_id);
  CREATE INDEX IF NOT EXISTS idx_restores_backup_id ON restores(backup_id);
  CREATE INDEX IF NOT EXISTS idx_restores_server_from ON restores(server_id_from);
`);

// =======================
//  SEED ADMIN POR DEFECTO
// =======================

const DEFAULT_EMAIL = "yemilpty1998@gmail.com";
const DEFAULT_PASS = "Flowpty1998@";

(function seedDefaultAdmin() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  const total = row?.c || 0;
  if (total > 0) return; // ya hay usuarios, no tocamos nada

  const hash = bcrypt.hashSync(DEFAULT_PASS, 12);
  db.prepare(`
    INSERT INTO users (email, password_hash, is_active)
    VALUES (?, ?, 1)
  `).run(DEFAULT_EMAIL, hash);
})();

// =======================
//  HELPERS / API USUARIOS
// =======================

function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    is_active: !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function authenticate(email, password) {
  const em = String(email || "").trim();
  const pw = String(password || "");

  const row = db
    .prepare("SELECT * FROM users WHERE email = ? AND is_active = 1")
    .get(em);

  if (!row) return null;

  const ok = bcrypt.compareSync(pw, row.password_hash);
  return ok ? toUser(row) : null;
}

function listUsers() {
  const rows = db
    .prepare("SELECT id, email, is_active, created_at, updated_at FROM users ORDER BY id ASC")
    .all();
  return rows.map(toUser);
}

function getUserById(id) {
  const row = db
    .prepare("SELECT id, email, is_active, created_at, updated_at FROM users WHERE id = ?")
    .get(id);
  return toUser(row);
}

function getUserByEmail(email) {
  const em = String(email || "").trim();
  const row = db
    .prepare("SELECT id, email, is_active, created_at, updated_at FROM users WHERE email = ?")
    .get(em);
  return toUser(row);
}

function createUser(email, password, { active = true } = {}) {
  const em = String(email || "").trim();
  const pw = String(password || "");

  if (!em || !pw) throw new Error("email y password son requeridos");

  const hash = bcrypt.hashSync(pw, 12);

  try {
    const info = db
      .prepare("INSERT INTO users (email, password_hash, is_active) VALUES (?, ?, ?)")
      .run(em, hash, active ? 1 : 0);

    return getUserById(info.lastInsertRowid);
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE constraint failed: users.email")) {
      throw new Error("El correo ya existe");
    }
    throw e;
  }
}

function updateUser(id, { email, password, active } = {}) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) throw new Error("Usuario no encontrado");

  const updates = [];
  const params = [];

  if (typeof email === "string" && email.trim()) {
    updates.push("email = ?");
    params.push(email.trim());
  }
  if (typeof password === "string" && password.length) {
    updates.push("password_hash = ?");
    params.push(bcrypt.hashSync(password, 12));
  }
  if (typeof active === "boolean") {
    updates.push("is_active = ?");
    params.push(active ? 1 : 0);
  }

  if (!updates.length) return getUserById(id);

  const sql =
    "UPDATE users SET " + updates.join(", ") + ", updated_at = datetime('now') WHERE id = ?";
  params.push(id);

  try {
    db.prepare(sql).run(...params);
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE constraint failed: users.email")) {
      throw new Error("El correo ya existe");
    }
    throw e;
  }

  return getUserById(id);
}

function deleteUser(id) {
  const total = db.prepare("SELECT COUNT(*) AS c FROM users").get().c || 0;
  if (total <= 1) {
    throw new Error("No puedes eliminar el único usuario restante");
  }

  const info = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  if (info.changes === 0) throw new Error("Usuario no encontrado");
  return true;
}

module.exports = {
  db,
  authenticate,
  listUsers,
  createUser,
  getUserById,
  getUserByEmail,
  updateUser,
  deleteUser
};
