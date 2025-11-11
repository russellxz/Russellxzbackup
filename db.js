"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const DATA_DIR = process.env.DB_DIR || path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "app.db");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH, { fileMustExist: false });

// --- Schema
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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

// --- Seed: admin por defecto
const DEFAULT_EMAIL = "yemilpty1998@gmail.com";
const DEFAULT_PASS = "Flowpty1998@";

(function seedDefaultAdmin() {
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(DEFAULT_EMAIL);
  if (!exists) {
    const hash = bcrypt.hashSync(DEFAULT_PASS, 12);
    db.prepare(`
      INSERT INTO users (email, password_hash, is_active)
      VALUES (?, ?, 1)
    `).run(DEFAULT_EMAIL, hash);
  }
})();

// --- Helpers
function toUser(row) {
  return row ? {
    id: row.id,
    email: row.email,
    is_active: !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at
  } : null;
}

// --- API
function authenticate(email, password) {
  const row = db.prepare("SELECT * FROM users WHERE email = ? AND is_active = 1").get(String(email || "").trim());
  if (!row) return null;
  const ok = bcrypt.compareSync(String(password || ""), row.password_hash);
  return ok ? toUser(row) : null;
}

function listUsers() {
  const rows = db.prepare("SELECT id, email, is_active, created_at, updated_at FROM users ORDER BY id ASC").all();
  return rows.map(toUser);
}

function createUser(email, password, { active = true } = {}) {
  const em = String(email || "").trim();
  const pw = String(password || "");
  if (!em || !pw) throw new Error("email y password son requeridos");
  const hash = bcrypt.hashSync(pw, 12);
  const stmt = db.prepare(`
    INSERT INTO users (email, password_hash, is_active)
    VALUES (?, ?, ?)
  `);
  try {
    const info = stmt.run(em, hash, active ? 1 : 0);
    return getUserById(info.lastInsertRowid);
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE constraint failed: users.email")) {
      throw new Error("El correo ya existe");
    }
    throw e;
  }
}

function getUserById(id) {
  const row = db.prepare("SELECT id, email, is_active, created_at, updated_at FROM users WHERE id = ?").get(id);
  return toUser(row);
}

function getUserByEmail(email) {
  const row = db.prepare("SELECT id, email, is_active, created_at, updated_at FROM users WHERE email = ?").get(String(email || "").trim());
  return toUser(row);
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

  const sql = `UPDATE users SET ${updates.join(", ")} WHERE id = ?`;
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
  const total = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  if (total <= 1) throw new Error("No puedes eliminar el único usuario restante");
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
