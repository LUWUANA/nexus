// server.js — NEXUS Backend V2 (Refonte Ultra-Gauche)
require('dotenv').config();
const express  = require('express');
const http     = require('http');
const https    = require('https');
const { Server } = require('socket.io');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const marked   = require('marked');

const {
  db,
  createUser, getUserByUsername, getUserById,
  updateUserStatus, updateUserAvatar,
  getServers, getServerById, getServerBySlug, createServer,
  getChannelsByServer, getChannelById, createChannel,
  getMessages, createMessage,
  joinServer, getServerMembers,
  createInvite, getInviteByCode, getInvitesByServer,
  createPrivateMessage, getPrivateMessages,
  createUserProfile, getUserProfile, updateUserProfile,
  createAttachment, getAttachmentById
} = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT       = process.env.PORT || 4242;
const JWT_SECRET = process.env.JWT_SECRET || 'nexus-dev-secret-CHANGE-ME';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOAD_DIR));

// Multer pour uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Sessions
const sessions = new Map();
const connectedUsers = new Map(); // userId → { username, socketId, status, customStatus, pronouns }

// Helpers
function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function getUserBadges(userId) {
  const user = getUserById.get(userId);
  if (!user) return [];

  const badges = [];
  const createdAt = new Date(user.created_at);
  const now = new Date();
  const daysSinceCreation = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));

  if (daysSinceCreation >= 365) badges.push('Ancien·ne');
  if (user.nitro) badges.push('Nitro');
  if (user.id === 1) badges.push('Fondateur');

  return badges;
}

// REST: Auth
app.post('/api/register', (req, res) => {
  const { username, password, pronouns } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Pseudo et mot de passe requis' });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Pseudo doit faire entre 2 et 32 caractères' });

  const existingUser = getUserByUsername.get(username);
  if (existingUser) return res.status(400).json({ error: 'Pseudo déjà pris' });

  const hashedPassword = bcrypt.hashSync(password, 10);
  const userId = createUser.run(username, hashedPassword, pronouns || 'iel').lastInsertRowid;
  createUserProfile.run(userId, '', '', '', '');

  res.json({ token: signToken(userId) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Pseudo et mot de passe requis' });

  const user = getUserByUsername.get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }

  res.json({ token: signToken(user.id) });
});

// REST: User
app.get('/api/@me', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const user = getUserById.get(payload.sub);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const profile = getUserProfile.get(payload.sub);
  const badges = getUserBadges(payload.sub);

  res.json({
    id: user.id,
    username: user.username,
    pronouns: user.pronouns,
    avatar: user.avatar,
    status: user.status,
    customStatus: profile?.custom_status || '',
    bio: profile?.bio || '',
    banner: profile?.banner || '',
    badges
  });
});

app.patch('/api/@me/status', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const { status, customStatus } = req.body;
  if (status) updateUserStatus.run(status, payload.sub);
  if (customStatus !== undefined) {
    const profile = getUserProfile.get(payload.sub);
    if (profile) {
      updateUserProfile.run(customStatus, profile.bio, profile.banner, profile.pronouns, payload.sub);
    } else {
      createUserProfile.run(payload.sub, customStatus, '', '', '');
    }
  }

  const user = getUserById.get(payload.sub);
  if (connectedUsers.has(payload.sub)) {
    connectedUsers.get(payload.sub).status = status || user.status;
    connectedUsers.get(payload.sub).customStatus = customStatus || '';
    io.emit('user-status', Array.from(connectedUsers.values()));
  }

  res.json({ success: true });
});

app.patch('/api/@me/profile', upload.fields([{ name: 'banner', maxCount: 1 }]), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const { bio, pronouns } = req.body;
  let banner = req.files?.banner?.[0]?.filename || getUserProfile.get(payload.sub)?.banner || '';

  const profile = getUserProfile.get(payload.sub);
  if (profile) {
    updateUserProfile.run(profile.custom_status, bio, banner, pronouns, payload.sub);
  } else {
    createUserProfile.run(payload.sub, '', bio, banner, pronouns);
  }

  res.json({ success: true });
});

// REST: Private Messages
app.get('/api/dm/:userId', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const messages = getPrivateMessages.all(payload.sub, req.params.userId);
  res.json(messages);
});

// Socket.io
io.on('connection', (socket) => {
  const token = socket.handshake.auth.token;
  const payload = verifyToken(token);
  if (!payload) return socket.disconnect();

  const user = getUserById.get(payload.sub);
  if (!user) return socket.disconnect();

  const profile = getUserProfile.get(payload.sub) || {};
  connectedUsers.set(payload.sub, {
    id: payload.sub,
    username: user.username,
    socketId: socket.id,
    status: user.status,
    customStatus: profile.custom_status || '',
    pronouns: user.pronouns,
    avatar: user.avatar
  });

  io.emit('user-status', Array.from(connectedUsers.values()));

  socket.on('disconnect', () => {
    connectedUsers.delete(payload.sub);
    io.emit('user-status', Array.from(connectedUsers.values()));
  });

  socket.on('private-msg', ({ to, content }) => {
    if (!to || !content) return;

    const receiver = connectedUsers.get(to);
    if (!receiver) return;

    const message = {
      id: Date.now(),
      sender_id: payload.sub,
      receiver_id: to,
      content,
      created_at: new Date().toISOString()
    };

    createPrivateMessage.run(payload.sub, to, content);
    io.to(receiver.socketId).emit('private-msg', message);
    socket.emit('private-msg', message);
  });

  socket.on('play-sound', ({ soundUrl }) => {
    socket.broadcast.emit('play-sound', { soundUrl });
  });
});

server.listen(PORT, () => {
  console.log(`NEXUS en écoute sur le port ${PORT}`);
});
