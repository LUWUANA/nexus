// db.js — Couche base de données SQLite
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'nexus.db');

// Créer le dossier data si besoin
const fs = require('fs');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Performances SQLite
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ————————————————— Schéma ——————————————————————————————————————————————————————————————————————————————
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT    NOT NULL UNIQUE,
    password  TEXT    NOT NULL,
    pronouns  TEXT    NOT NULL DEFAULT 'iel',
    avatar    TEXT,
    nitro     INTEGER NOT NULL DEFAULT 1,
    status    TEXT    NOT NULL DEFAULT 'online',
    ghost     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT   NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS servers (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    slug      TEXT    NOT NULL UNIQUE,
    name      TEXT    NOT NULL,
    owner_id  INTEGER NOT NULL REFERENCES users(id),
    icon      TEXT,
    created_at TEXT   NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channels (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    type      TEXT    NOT NULL DEFAULT 'text', -- 'text' | 'voice'
    position  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS private_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id   INTEGER NOT NULL REFERENCES users(id),
    receiver_id INTEGER NOT NULL REFERENCES users(id),
    content     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sender_id, receiver_id, created_at)
  );

  CREATE TABLE IF NOT EXISTS server_members (
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS invites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT    NOT NULL UNIQUE,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );
`);

// ————————————————— Seed : serveur par défaut ———————————————————————————————————————————————————————
const seedServer = db.prepare(`SELECT id FROM servers WHERE slug = 'nexus-core'`).get();
if (!seedServer) {
  // Créer un user système pour posséder le serveur par défaut
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('nexus-system-' + Date.now(), 8);
  const sysUser = db.prepare(`
    INSERT OR IGNORE INTO users (username, password, pronouns, avatar)
    VALUES ('Nexus', ?, 'iel', 'https://api.dicebear.com/7.x/bottts/svg?seed=nexus-system')
  `).run(hash);

  const ownerId = sysUser.lastInsertRowid || db.prepare(`SELECT id FROM users WHERE username = 'Nexus'`).get().id;

  const server = db.prepare(`
    INSERT INTO servers (slug, name, owner_id, icon)
    VALUES ('nexus-core', 'Nexus Core', ?, 'N')
  `).run(ownerId);

  db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'général', 'text', 0)`).run(server.lastInsertRowid);
  db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'bienvenue', 'text', 1)`).run(server.lastInsertRowid);
  db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'vocal-général', 'voice', 2)`).run(server.lastInsertRowid);

  console.log('✅ Serveur par défaut créé');
}

// ————————————————— Requêtes préparées —————————————————————————————————————————————————————————————————————
module.exports = {
  db,

  // Users
  createUser: db.prepare(`
    INSERT INTO users (username, password, pronouns, avatar)
    VALUES (@username, @password, @pronouns, @avatar)
  `),
  getUserByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
  getUserById: db.prepare(`SELECT id, username, pronouns, avatar, nitro, status, ghost FROM users WHERE id = ?`),
  updateUserStatus: db.prepare(`UPDATE users SET status = ? WHERE id = ?`),
  updateUserAvatar: db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`),

  // Servers
  getServers: db.prepare(`SELECT * FROM servers`),
  getServerById: db.prepare(`SELECT * FROM servers WHERE id = ?`),
  getServerBySlug: db.prepare(`SELECT * FROM servers WHERE slug = ?`),
  createServer: db.prepare(`
    INSERT INTO servers (name, slug, owner_id, icon)
    VALUES (@name, @slug, @owner_id, @icon)
  `),

  // Channels
  getChannelsByServer: db.prepare(`SELECT * FROM channels WHERE server_id = ? ORDER BY position`),
  getChannelById: db.prepare(`SELECT * FROM channels WHERE id = ?`),

  // Messages
  getMessages: db.prepare(`
    SELECT m.id, m.content, m.created_at,
           u.username, u.pronouns, u.avatar
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ?
    ORDER BY m.id DESC
    LIMIT 50
  `),
  createMessage: db.prepare(`
    INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)
  `),

  // Private Messages
  createPrivateMessage: db.prepare(`
    INSERT INTO private_messages (sender_id, receiver_id, content) VALUES (?, ?, ?)
  `),
  getPrivateMessages: db.prepare(`
    SELECT pm.id, pm.content, pm.created_at,
           s.username as sender_username, s.pronouns as sender_pronouns, s.avatar as sender_avatar,
           r.username as receiver_username, r.pronouns as receiver_pronouns, r.avatar as receiver_avatar
    FROM private_messages pm
    JOIN users s ON s.id = pm.sender_id
    JOIN users r ON r.id = pm.receiver_id
    WHERE (pm.sender_id = ? AND pm.receiver_id = ?) OR (pm.sender_id = ? AND pm.receiver_id = ?)
    ORDER BY pm.id DESC
    LIMIT 50
  `),

  // Members
  joinServer: db.prepare(`
    INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)
  `),
  getServerMembers: db.prepare(`
    SELECT u.id, u.username, u.avatar, u.status
    FROM users u
    JOIN server_members m ON u.id = m.user_id
    WHERE m.server_id = ?
  `),

  // Invites
  createInvite: db.prepare(`
    INSERT INTO invites (code, server_id, created_by)
    VALUES (@code, @server_id, @created_by)
  `),
  getInviteByCode: db.prepare(`SELECT * FROM invites WHERE code = ?`),
  getInvitesByServer: db.prepare(`SELECT * FROM invites WHERE server_id = ?`),
};