// server.js — NEXUS Backend V2
require('dotenv').config();

const express  = require('express');
const http     = require('http');
const https    = require('https');
const { Server } = require('socket.io');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const {
  db,
  createUser, getUserByUsername, getUserById,
  updateUserStatus,
  getServers, getChannelsByServer, getChannelById,
  getMessages, createMessage,
  joinServer,
  // New role-related functions
  getRolesByServer, getUserRoles, createRole, updateRole,
  deleteRole, assignRole, removeRole, getRoleById,
  getServerMembersWithRoles, getUserPermissions
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

// ——— Helper JWT ———————————————————————————————————————————————————————————————————————————————————————
function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ——— Helper: Check permissions ————————————————————————————————————————————————————————————————
function hasPermission(session, serverId, permission) {
  if (!session) return false;
  const permissions = getUserPermissions.get(session.userId, serverId);
  return permissions.includes(permission);
}

// ——— REST : Auth —————————————————————————————————————————————————————————————————————————————————————

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
  if (coreServer) {
    joinServer.run(coreServer.id, result.lastInsertRowid);
    // Assign default member role
    const memberRole = db.prepare(`SELECT id FROM roles WHERE server_id = ? AND name = 'Membre'`).get(coreServer.id);
    if (memberRole) {
      assignRole.run(memberRole.id, result.lastInsertRowid);
    }
  }

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

// ——— REST : Data ———————————————————————————————————————————————————————————————————————————————————————

app.get('/api/servers', (req, res) => {
  const servers = getServers.all();
  const result  = servers.map(srv => ({
    ...srv,
    channels: getChannelsByServer.all(srv.id),
  }));
  res.json(result);
});

app.get('/api/channels/:id/messages', (req, res) => {
  const messages = getMessages.all(req.params.id);
  res.json(messages.reverse());
});

// ——— REST : Roles —————————————————————————————————————————————————————————————————————————————————————

app.get('/api/servers/:serverId/roles', (req, res) => {
  const { serverId } = req.params;
  const session = sessions.get(req.headers['x-socket-id']);
  if (!session) return res.status(401).json({ error: 'Non autorisé' });
  
  if (!hasPermission(session, serverId, 'manage_roles')) {
    return res.status(403).json({ error: 'Permission refusée' });
  }
  
  const roles = getRolesByServer.all(serverId);
  res.json(roles);
});

app.post('/api/servers/:serverId/roles', (req, res) => {
  const { serverId } = req.params;
  const { name, color, permissions } = req.body;
  const session = sessions.get(req.headers['x-socket-id']);
  
  if (!session) return res.status(401).json({ error: 'Non autorisé' });
  if (!hasPermission(session, serverId, 'manage_roles')) {
    return res.status(403).json({ error: 'Permission refusée' });
  }
  
  try {
    const result = createRole.run({
      server_id: serverId,
      name,
      color: color || '#99AAB5',
      permissions: JSON.stringify(permissions || []),
      position: 0
    });
    const role = getRoleById.get(result.lastInsertRowid);
    io.to(`server:${serverId}`).emit('role-created', role);
    res.status(201).json(role);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/roles/:roleId', (req, res) => {
  const { roleId } = req.params;
  const { name, color, permissions, position } = req.body;
  const session = sessions.get(req.headers['x-socket-id']);
  
  if (!session) return res.status(401).json({ error: 'Non autorisé' });
  
  const role = getRoleById.get(roleId);
  if (!role) return res.status(404).json({ error: 'Rôle introuvable' });
  
  if (!hasPermission(session, role.server_id, 'manage_roles')) {
    return res.status(403).json({ error: 'Permission refusée' });
  }
  
  try {
    updateRole.run({
      id: roleId,
      name: name || role.name,
      color: color || role.color,
      permissions: permissions ? JSON.stringify(permissions) : role.permissions,
      position: position !== undefined ? position : role.position
    });
    const updatedRole = getRoleById.get(roleId);
    io.to(`server:${role.server_id}`).emit('role-updated', updatedRole);
    res.json(updatedRole);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/roles/:roleId', (req, res) => {
  const { roleId } = req.params;
  const session = sessions.get(req.headers['x-socket-id']);
  
  if (!session) return res.status(401).json({ error: 'Non autorisé' });
  
  const role = getRoleById.get(roleId);
  if (!role) return res.status(404).json({ error: 'Rôle introuvable' });
  
  if (!hasPermission(session, role.server_id, 'manage_roles')) {
    return res.status(403).json({ error: 'Permission refusée' });
  }
  
  try {
    deleteRole.run(roleId);
    io.to(`server:${role.server_id}`).emit('role-deleted', { id: roleId });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/roles/:roleId/assign', (req, res) => {
  const { roleId } = req.params;
  const { userId } = req.body;
  const session = sessions.get(req.headers['x-socket-id']);
  
  if (!session) return res.status(401).json({ error: 'Non autorisé' });
  
  const role = getRoleById.get(roleId);
  if (!role) return res.status(404).json({ error: 'Rôle introuvable' });
  
  if (!hasPermission(session, role.server_id, 'manage_roles')) {
    return res.status(403).json({ error: 'Permission refusée' });
  }
  
  try {
    assignRole.run(roleId, userId);
    const member = getServerMembersWithRoles.get(role.server_id, userId);
    io.to(`server:${role.server_id}`).emit('member-roles-updated', member);
    res.json(member);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/roles/:roleId/remove', (req, res) => {
  const { roleId } = req.params;
  const { userId } = req.body;
  const session = sessions.get(req.headers['x-socket-id']);
  
  if (!session) return res.status(401).json({ error: 'Non autorisé' });
  
  const role = getRoleById.get(roleId);
  if (!role) return res.status(404).json({ error: 'Rôle introuvable' });
  
  if (!hasPermission(session, role.server_id, 'manage_roles')) {
    return res.status(403).json({ error: 'Permission refusée' });
  }
  
  try {
    removeRole.run(roleId, userId);
    const member = getServerMembersWithRoles.get(role.server_id, userId);
    io.to(`server:${role.server_id}`).emit('member-roles-updated', member);
    res.json(member);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/servers/:serverId/members', (req, res) => {
  const { serverId } = req.params;
  const session = sessions.get(req.headers['x-socket-id']);
  
  if (!session) return res.status(401).json({ error: 'Non autorisé' });
  
  const members = getServerMembersWithRoles.all(serverId);
  res.json(members);
});

// ——— Proxy GitHub for AI Updater ————————————————————————————————————————————————————————————————
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
    updateUserStatus.run('online', user.id);

    socket.emit('auth-success', user);
    io.emit('user-status', { userId: user.id, username: user.username, status: 'online' });
    console.log(`✅ Auth : ${user.username}`);
  });

  socket.on('join-server', ({ serverId }) => {
    const session = sessions.get(socket.id);
    if (!session) return;
    
    socket.join(`server:${serverId}`);
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
    const roles = getUserRoles.all(session.userId, channel.server_id);

    const msg = {
      id:         result.lastInsertRowid,
      channel_id: channelId,
      content:    content.trim(),
      created_at: new Date().toISOString(),
      username:   user.username,
      pronouns:   user.pronouns,
      avatar:     user.avatar,
      roles
    };

    io.to(`channel:${channelId}`).emit('new-msg', msg);
  });

  socket.on('rtc-offer',     (data) => socket.to(data.to).emit('rtc-offer',     { from: socket.id, signal: data.signal }));
  socket.on('rtc-answer',    (data) => socket.to(data.to).emit('rtc-answer',    { from: socket.id, signal: data.signal }));
  socket.on('rtc-candidate', (data) => socket.to(data.to).emit('rtc-candidate', { from: socket.id, candidate: data.candidate }));

  socket.on('disconnect', () => {
    const session = sessions.get(socket.id);
    if (session) {
      updateUserStatus.run('offline', session.userId);
      io.emit('user-status', { userId: session.userId, username: session.username, status: 'offline' });
      sessions.delete(socket.id);
      console.log(`👋 Déco : ${session.username}`);
    }
  });
});

// ——— Startup ———————————————————————————————————————————————————————————————————————————————————————

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NEXUS V2 — port ${PORT}`);
  console.log(`   DB     : ${process.env.DB_PATH || './data/nexus.db'}`);
  console.log(`   Secret : ${JWT_SECRET === 'nexus-dev-secret-CHANGE-ME' ? '⚠️  Dev (changer en prod !)' : '✅ OK'}`);
});