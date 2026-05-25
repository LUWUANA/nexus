// server.js — NEXUS Backend V2
require('dotenv').config();

const express  = require('express');
const http     = require('http');
const https    = require('https');
const { Server } = require('socket.io');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');

const {
  db,
  createUser, getUserByUsername, getUserById,
  updateUserStatus, updateUserAvatar,
  getServers, getServerById, getServerBySlug, createServer,
  getChannelsByServer, getChannelById,
  getMessages, createMessage,
  joinServer, getServerMembers,
  createInvite, getInviteByCode, getInvitesByServer,
  createPrivateMessage, getPrivateMessages
} = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT       = process.env.PORT || 4242;
const JWT_SECRET = process.env.JWT_SECRET || 'nexus-dev-secret-CHANGE-ME';

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ——— Map : socketId → userId ————————————————————————————————————————————————————————————————————————
const sessions = new Map();
const connectedUsers = new Map(); // userId → { username, socketId }

// ——— Helper JWT ————————————————————————————————————————————————————————————————————————————————————————
function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ——— Helper Invite Code ———————————————————————————————————————————————————————————————————————————————
function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ——— REST : Auth ———————————————————————————————————————————————————————————————————————————————————————

app.post('/api/register', (req, res) => {
  const { username, password, pronouns } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Pseudo et mot de passe requis' });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Pseudo : 2 à 32 caractères' });

  const existing = getUserByUsername.get(username);
  if (existing) return res.status(409).json({ error: 'Pseudo déjà pris' });

  const hash   = bcrypt.hashSync(password, 10);
  const avatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`;

  let result;
  try {
    result = createUser.run({ username, password: hash, pronouns: pronouns || 'iel', avatar });
  } catch (e) {
    return res.status(500).json({ error: 'Erreur serveur' });
  }

  const coreServer = db.prepare(`SELECT id FROM servers WHERE slug = 'nexus-core'`).get();
  if (coreServer) joinServer.run(coreServer.id, result.lastInsertRowid);

  const token = signToken(result.lastInsertRowid);
  const user  = getUserById.get(result.lastInsertRowid);
  res.status(201).json({ token, user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });

  const row = getUserByUsername.get(username);
  if (!row || !bcrypt.compareSync(password, row.password)) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }

  const token = signToken(row.id);
  const user  = getUserById.get(row.id);
  res.json({ token, user });
});

// ——— REST : Servers —————————————————————————————————————————————————————————————————————————————————————

app.get('/api/servers', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });

  const servers = db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members m ON s.id = m.server_id
    WHERE m.user_id = ?
  `).all(userId);

  const result = servers.map(srv => ({
    ...srv,
    channels: getChannelsByServer.all(srv.id),
  }));
  res.json(result);
});

app.post('/api/servers', (req, res) => {
  const { name, icon } = req.body;
  const userId = req.headers['x-user-id'];
  if (!userId || !name) return res.status(400).json({ error: 'Nom et utilisateur requis' });

  const slug = name.toLowerCase().replace(/\s+/g, '-') + '-' + Math.random().toString(36).substring(2, 6);
  const result = createServer.run({ name, slug, owner_id: userId, icon: icon || null });
  const serverId = result.lastInsertRowid;

  joinServer.run(serverId, userId);

  const defaultChannel = db.prepare(`
    INSERT INTO channels (server_id, name, type, position)
    VALUES (?, 'général', 'text', 0)
  `).run(serverId);

  const inviteCode = generateInviteCode();
  createInvite.run({ code: inviteCode, server_id: serverId, created_by: userId });

  res.status(201).json({
    id: serverId,
    name,
    slug,
    icon,
    inviteCode,
    channels: [{ id: defaultChannel.lastInsertRowid, name: 'général', type: 'text' }]
  });
});

app.post('/api/servers/join', (req, res) => {
  const { inviteCode } = req.body;
  const userId = req.headers['x-user-id'];
  if (!userId || !inviteCode) return res.status(400).json({ error: 'Code d\'invitation requis' });

  const invite = getInviteByCode.get(inviteCode);
  if (!invite) return res.status(404).json({ error: 'Invitation invalide' });

  const existingMember = db.prepare(`
    SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?
  `).get(invite.server_id, userId);

  if (existingMember) return res.status(409).json({ error: 'Déjà membre de ce hub' });

  joinServer.run(invite.server_id, userId);
  res.json({ success: true, serverId: invite.server_id });
});

app.get('/api/servers/:id/invites', (req, res) => {
  const userId = req.headers['x-user-id'];
  const serverId = req.params.id;
  if (!userId || !serverId) return res.status(400).json({ error: 'Paramètres manquants' });

  const isMember = db.prepare(`
    SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?
  `).get(serverId, userId);

  if (!isMember) return res.status(403).json({ error: 'Non autorisé' });

  const invites = getInvitesByServer.all(serverId);
  res.json(invites);
});

app.post('/api/servers/:id/invites', (req, res) => {
  const userId = req.headers['x-user-id'];
  const serverId = req.params.id;
  if (!userId || !serverId) return res.status(400).json({ error: 'Paramètres manquants' });

  const isMember = db.prepare(`
    SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?
  `).get(serverId, userId);

  if (!isMember) return res.status(403).json({ error: 'Non autorisé' });

  const inviteCode = generateInviteCode();
  createInvite.run({ code: inviteCode, server_id: serverId, created_by: userId });
  res.status(201).json({ code: inviteCode });
});

// ——— REST : Channels —————————————————————————————————————————————————————————————————————————————————

app.get('/api/channels/:id/messages', (req, res) => {
  const messages = getMessages.all(req.params.id);
  res.json(messages.reverse());
});

// ——— REST : Private Messages ———————————————————————————————————————————————————————————————————————

app.get('/api/private-messages', (req, res) => {
  const userId = req.headers['x-user-id'];
  const { otherUserId } = req.query;
  if (!userId || !otherUserId) return res.status(400).json({ error: 'Paramètres manquants' });

  const messages = getPrivateMessages.all(userId, otherUserId);
  res.json(messages.reverse());
});

// ——— Proxy GitHub pour l'AI Updater —————————————————————————————————————————————————————————————————————
app.post('/api/github-proxy', (req, res) => {
  const { method, path, body, token } = req.body;
  if (!token || !path) return res.status(400).json({ error: 'token et path requis' });

  const payload = JSON.stringify(body || null);

  const options = {
    hostname: 'api.github.com',
    path,
    method: method || 'GET',
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Accept':         'application/vnd.github+json',
      'User-Agent':     'nexus-ai-updater',
      'Content-Type':   'application/json',
      'Content-Length': body ? Buffer.byteLength(payload) : 0,
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      try {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      } catch {
        res.status(proxyRes.statusCode).send(data);
      }
    });
  });

  proxyReq.on('error', err => res.status(500).json({ error: err.message }));
  if (body) proxyReq.write(payload);
  proxyReq.end();
});

// ——— Socket.io ———————————————————————————————————————————————————————————————————————————————————————

io.on('connection', (socket) => {
  console.log(`🔌 Connexion : ${socket.id}`);

  socket.on('auth', ({ token }) => {
    const payload = verifyToken(token);
    if (!payload) return socket.emit('auth-error', 'Token invalide');

    const user = getUserById.get(payload.sub);
    if (!user) return socket.emit('auth-error', 'Utilisateur introuvable');

    sessions.set(socket.id, { userId: user.id, username: user.username, currentChannel: null });
    connectedUsers.set(user.id, { username: user.username, socketId: socket.id });
    updateUserStatus.run('online', user.id);

    socket.emit('auth-success', user);
    io.emit('user-status', { userId: user.id, username: user.username, status: 'online' });
    io.emit('user-list-update', Array.from(connectedUsers.values()).map(u => ({ id: payload.sub, username: u.username })));
    console.log(`✅ Auth : ${user.username}`);
  });

  socket.on('join-channel', ({ channelId }) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    const channel = getChannelById.get(channelId);
    if (!channel) return;

    if (session.currentChannel) socket.leave(`channel:${session.currentChannel}`);

    session.currentChannel = channelId;
    socket.join(`channel:${channelId}`);

    const history = getMessages.all(channelId).reverse();
    socket.emit('channel-history', { channelId, messages: history });
  });

  socket.on('typing-start', ({ channelId }) => {
    const session = sessions.get(socket.id);
    if (!session || !session.currentChannel || session.currentChannel !== channelId) return;
    const user = getUserById.get(session.userId);
    socket.to(`channel:${channelId}`).emit('user-typing', {
      userId: session.userId,
      username: user.username,
      pronouns: user.pronouns,
      channelId
    });
  });

  socket.on('typing-stop', ({ channelId }) => {
    const session = sessions.get(socket.id);
    if (!session || !session.currentChannel || session.currentChannel !== channelId) return;
    socket.to(`channel:${channelId}`).emit('user-stop-typing', {
      userId: session.userId,
      channelId
    });
  });

  socket.on('send-msg', ({ channelId, content }) => {
    const session = sessions.get(socket.id);
    if (!session) return;
    if (!content || !content.trim()) return;
    if (content.length > 2000) return;

    const channel = getChannelById.get(channelId);
    if (!channel) return;

    const result = createMessage.run(channelId, session.userId, content.trim());
    const user   = getUserById.get(session.userId);

    const msg = {
      id:         result.lastInsertRowid,
      channel_id: channelId,
      content:    content.trim(),
      created_at: new Date().toISOString(),
      username:   user.username,
      pronouns:   user.pronouns,
      avatar:     user.avatar,
    };

    io.to(`channel:${channelId}`).emit('new-msg', msg);
  });

  socket.on('private_message', ({ receiverId, content }) => {
    const session = sessions.get(socket.id);
    if (!session) return;
    if (!content || !content.trim()) return;
    if (content.length > 2000) return;

    const receiver = getUserById.get(receiverId);
    if (!receiver) return socket.emit('private_message_error', { error: 'Destinataire introuvable' });

    const result = createPrivateMessage.run(session.userId, receiverId, content.trim());
    const sender = getUserById.get(session.userId);

    const msg = {
      id: result.lastInsertRowid,
      sender_id: session.userId,
      receiver_id: receiverId,
      content: content.trim(),
      created_at: new Date().toISOString(),
      sender_username: sender.username,
      sender_pronouns: sender.pronouns,
      sender_avatar: sender.avatar,
    };

    // Envoyer au destinataire
    const receiverSocketId = connectedUsers.get(receiverId)?.socketId;
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('private_message', msg);
    }
    // Envoyer à l'expéditeur
    socket.emit('private_message', msg);
  });

  socket.on('rtc-offer',     (data) => socket.to(data.to).emit('rtc-offer',     { from: socket.id, signal: data.signal }));
  socket.on('rtc-answer',    (data) => socket.to(data.to).emit('rtc-answer',    { from: socket.id, signal: data.signal }));
  socket.on('rtc-candidate', (data) => socket.to(data.to).emit('rtc-candidate', { from: socket.id, candidate: data.candidate }));

  socket.on('disconnect', () => {
    const session = sessions.get(socket.id);
    if (session) {
      updateUserStatus.run('offline', session.userId);
      connectedUsers.delete(session.userId);
      io.emit('user-status', { userId: session.userId, username: session.username, status: 'offline' });
      io.emit('user-list-update', Array.from(connectedUsers.values()).map(u => ({ id: u.userId, username: u.username })));
      sessions.delete(socket.id);
      console.log(`👋 Déco : ${session.username}`);
    }
  });
});

// ——— Démarrage ———————————————————————————————————————————————————————————————————————————————————————

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NEXUS V2 — port ${PORT}`);
  console.log(`   DB     : ${process.env.DB_PATH || './data/nexus.db'}`);
  console.log(`   Secret : ${JWT_SECRET === 'nexus-dev-secret-CHANGE-ME' ? '⚠️  Dev (changer en prod !)' : '✅ OK'}`);
});