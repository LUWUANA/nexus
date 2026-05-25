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

// ————————— Schéma ———————————————————————————————————————————————————————————————————————————————————————
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

  CREATE TABLE IF NOT EXISTS server_members (
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    color       TEXT    NOT NULL DEFAULT '#99AAB5',
    permissions TEXT    NOT NULL DEFAULT '[]', -- JSON array
    position    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(server_id, name)
  );

  CREATE TABLE IF NOT EXISTS user_roles (
    role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, user_id)
  );
`);

// ————————— Seed : serveur par défaut ————————————————————————————————————————————————————————————————
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

  const serverId = server.lastInsertRowid;
  
  // Create default roles
  const adminRole = db.prepare(`
    INSERT INTO roles (server_id, name, color, permissions, position)
    VALUES (?, 'Admin', '#F1C40F', ?, 0)
  `).run(serverId, JSON.stringify(['manage_roles', 'manage_channels', 'manage_messages', 'kick_members', 'ban_members']));
  
  const modRole = db.prepare(`
    INSERT INTO roles (server_id, name, color, permissions, position)
    VALUES (?, 'Modérateur', '#2ECC71', ?, 1)
  `).run(serverId, JSON.stringify(['manage_messages', 'kick_members']));
  
  const memberRole = db.prepare(`
    INSERT INTO roles (server_id, name, color, permissions, position)
    VALUES (?, 'Membre', '#99AAB5', ?, 2)
  `).run(serverId, JSON.stringify([]));
  
  // Assign admin role to server owner
  db.prepare(`INSERT INTO user_roles (role_id, user_id) VALUES (?, ?)`).run(adminRole.lastInsertRowid, ownerId);
  
  db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'général', 'text', 0)`).run(serverId);
  db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'bienvenue', 'text', 1)`).run(serverId);
  db.prepare(`INSERT INTO channels (server_id, name, type, position) VALUES (?, 'vocal-général', 'voice', 2)`).run(serverId);

  console.log('✅ Serveur par défaut créé avec rôles');
}

// ————————— Requêtes préparées ———————————————————————————————————————————————————————————————————————

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

  // Servers
  getServers: db.prepare(`SELECT * FROM servers`),
  getServerBySlug: db.prepare(`SELECT * FROM servers WHERE slug = ?`),

  // Channels
  getChannelsByServer: db.prepare(`SELECT * FROM channels WHERE server_id = ? ORDER BY position`),
  getChannelById: db.prepare(`SELECT * FROM channels WHERE id = ?`),

  // Messages
  getMessages: db.prepare(`
    SELECT m.id, m.content, m.created_at,
           u.username, u.pronouns, u.avatar,
           (SELECT json_group_array(json_object('id', r.id, 'name', r.name, 'color', r.color))
            FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = u.id AND r.server_id = (SELECT server_id FROM channels WHERE id = m.channel_id))
           as roles
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ?
    ORDER BY m.id DESC
    LIMIT 50
  `),
  createMessage: db.prepare(`
    INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)
  `),

  // Members
  joinServer: db.prepare(`
    INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)
  `),

  // Roles
  getRolesByServer: db.prepare(`SELECT * FROM roles WHERE server_id = ? ORDER BY position`),
  getRoleById: db.prepare(`SELECT * FROM roles WHERE id = ?`),
  createRole: db.prepare(`
    INSERT INTO roles (server_id, name, color, permissions, position)
    VALUES (@server_id, @name, @color, @permissions, @position)
  `),
  updateRole: db.prepare(`
    UPDATE roles SET name = @name, color = @color, permissions = @permissions, position = @position
    WHERE id = @id
  `),
  deleteRole: db.prepare(`DELETE FROM roles WHERE id = ?`),
  
  // User Roles
  getUserRoles: db.prepare(`
    SELECT r.id, r.name, r.color, r.position
    FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = ? AND r.server_id = ?
    ORDER BY r.position
  `),
  assignRole: db.prepare(`INSERT OR IGNORE INTO user_roles (role_id, user_id) VALUES (?, ?)`),
  removeRole: db.prepare(`DELETE FROM user_roles WHERE role_id = ? AND user_id = ?`),
  
  // Server Members with Roles
  getServerMembersWithRoles: db.prepare(`
    SELECT u.id, u.username, u.avatar, u.pronouns,
           json_group_array(json_object('id', r.id, 'name', r.name, 'color', r.color)) as roles
    FROM server_members sm
    JOIN users u ON sm.user_id = u.id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON ur.role_id = r.id AND r.server_id = sm.server_id
    WHERE sm.server_id = ?
    GROUP BY u.id
  `),
  
  // Permissions
  getUserPermissions: db.prepare(`
    SELECT json_group_array(DISTINCT p.value)
    FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    JOIN json_each(r.permissions) p
    WHERE ur.user_id = ? AND r.server_id = ?
  `)
};