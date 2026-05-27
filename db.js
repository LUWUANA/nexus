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

// ——————————————————————— Schéma ———————————————————————
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

  CREATE TABLE IF NOT EXISTS attachments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    url        TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bio          TEXT,
    banner_color TEXT    DEFAULT '#6a0dad',
    banner_image TEXT,
    badges       TEXT    DEFAULT '[]'
  );
`);

// ——————————————————————— Requêtes ———————————————————————
const createUser = db.prepare(`
  INSERT INTO users (username, password, pronouns, avatar)
  VALUES (@username, @password, @pronouns, @avatar)
`);

const getUserByUsername = db.prepare(`
  SELECT * FROM users WHERE username = ?
`);

const getUserById = db.prepare(`
  SELECT * FROM users WHERE id = ?
`);

const updateUserStatus = db.prepare(`
  UPDATE users SET status = ? WHERE id = ?
`);

const updateUserAvatar = db.prepare(`
  UPDATE users SET avatar = ? WHERE id = ?
`);

const getServers = db.prepare(`
  SELECT * FROM servers
`);

const getServerById = db.prepare(`
  SELECT * FROM servers WHERE id = ?
`);

const getServerBySlug = db.prepare(`
  SELECT * FROM servers WHERE slug = ?
`);

const createServer = db.prepare(`
  INSERT INTO servers (slug, name, owner_id, icon)
  VALUES (@slug, @name, @owner_id, @icon)
`);

const getChannelsByServer = db.prepare(`
  SELECT * FROM channels WHERE server_id = ? ORDER BY position
`);

const getChannelById = db.prepare(`
  SELECT * FROM channels WHERE id = ?
`);

const createChannel = db.prepare(`
  INSERT INTO channels (server_id, name, type, position)
  VALUES (@server_id, @name, @type, @position)
`);

const getMessages = db.prepare(`
  SELECT m.*, u.username, u.avatar, u.pronouns
  FROM messages m
  JOIN users u ON m.user_id = u.id
  WHERE m.channel_id = ?
  ORDER BY m.created_at
`);

const createMessage = db.prepare(`
  INSERT INTO messages (channel_id, user_id, content)
  VALUES (@channel_id, @user_id, @content)
`);

const joinServer = db.prepare(`
  INSERT INTO server_members (server_id, user_id) VALUES (?, ?)
`);

const getServerMembers = db.prepare(`
  SELECT u.* FROM users u
  JOIN server_members sm ON u.id = sm.user_id
  WHERE sm.server_id = ?
`);

const createInvite = db.prepare(`
  INSERT INTO invites (code, server_id, created_by)
  VALUES (@code, @server_id, @created_by)
`);

const getInviteByCode = db.prepare(`
  SELECT * FROM invites WHERE code = ?
`);

const getInvitesByServer = db.prepare(`
  SELECT * FROM invites WHERE server_id = ?
`);

const createPrivateMessage = db.prepare(`
  INSERT INTO private_messages (sender_id, receiver_id, content)
  VALUES (@sender_id, @receiver_id, @content)
`);

const getPrivateMessages = db.prepare(`
  SELECT pm.*, u.username, u.avatar
  FROM private_messages pm
  JOIN users u ON pm.sender_id = u.id
  WHERE (pm.sender_id = ? AND pm.receiver_id = ?) OR (pm.sender_id = ? AND pm.receiver_id = ?)
  ORDER BY pm.created_at
`);

const createAttachment = db.prepare(`
  INSERT INTO attachments (message_id, url)
  VALUES (@message_id, @url)
`);

const getAttachmentById = db.prepare(`
  SELECT * FROM attachments WHERE id = ?
`);

const createUserProfile = db.prepare(`
  INSERT INTO user_profiles (user_id, bio, banner_color, badges)
  VALUES (@user_id, @bio, @banner_color, @badges)
`);

const getUserProfile = db.prepare(`
  SELECT * FROM user_profiles WHERE user_id = ?
`);

const updateUserProfile = db.prepare(`
  UPDATE user_profiles
  SET bio = @bio, banner_color = @banner_color, banner_image = @banner_image
  WHERE user_id = @user_id
`);

module.exports = {
  db,
  createUser, getUserByUsername, getUserById,
  updateUserStatus, updateUserAvatar,
  getServers, getServerById, getServerBySlug, createServer,
  getChannelsByServer, getChannelById, createChannel,
  getMessages, createMessage,
  joinServer, getServerMembers,
  createInvite, getInviteByCode, getInvitesByServer,
  createPrivateMessage, getPrivateMessages,
  createAttachment, getAttachmentById,
  createUserProfile, getUserProfile, updateUserProfile
};
