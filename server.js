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
const connectedUsers = new Map(); // userId → { username, socketId, status, customStatus }

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

// REST: Auth
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
    createUserProfile.run({ user_id: result.lastInsertRowid, bio: '', custom_status: '' });
    res.json({ token: signToken(result.lastInsertRowid), userId: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Pseudo et mot de passe requis' });

  const user = getUserByUsername.get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }

  res.json({ token: signToken(user.id), userId: user.id });
});

// REST: User Status
app.post('/api/user/status', (req, res) => {
  const { token, status, customStatus } = req.body;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token invalide' });

  try {
    updateUserStatus.run({ status, id: payload.sub });
    if (customStatus !== undefined) {
      updateUserProfile.run({ custom_status: customStatus, user_id: payload.sub });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Socket.io
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const payload = verifyToken(token);
  if (!payload) return next(new Error('Authentication failed'));

  socket.userId = payload.sub;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  const user = getUserById.get(userId);
  const profile = getUserProfile.get(userId);
  if (!user) return socket.disconnect();

  // Ajouter l'utilisateur à la liste des connectés
  connectedUsers.set(userId, {
    username: user.username,
    socketId: socket.id,
    status: user.status || 'online',
    customStatus: profile?.custom_status || ''
  });

  // Notifier tout le monde du nouveau statut
  io.emit('user-status', Array.from(connectedUsers.values()));

  // Messages privés
  socket.on('private-msg', ({ to, content }) => {
    const receiver = connectedUsers.get(to);
    if (!receiver) return;

    const message = {
      from: userId,
      to,
      content,
      username: user.username,
      avatar: user.avatar,
      created_at: new Date().toISOString()
    };

    // Sauvegarder en base
    createPrivateMessage.run({ sender_id: userId, receiver_id: to, content });

    // Envoyer au destinataire
    io.to(receiver.socketId).emit('private-msg', message);
    // Envoyer à l'expéditeur pour confirmation
    socket.emit('private-msg', message);
  });

  // Mise à jour du statut
  socket.on('update-status', ({ status, customStatus }) => {
    if (status) updateUserStatus.run({ status, id: userId });
    if (customStatus !== undefined) {
      updateUserProfile.run({ custom_status: customStatus, user_id: userId });
    }

    // Mettre à jour la liste locale
    const userData = connectedUsers.get(userId);
    if (userData) {
      if (status) userData.status = status;
      if (customStatus !== undefined) userData.customStatus = customStatus;
      connectedUsers.set(userId, userData);
    }

    // Notifier tout le monde
    io.emit('user-status', Array.from(connectedUsers.values()));
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(userId);
    io.emit('user-status', Array.from(connectedUsers.values()));
  });
});

// Démarrer le serveur
server.listen(PORT, () => {
  console.log(`NEXUS opérationnel sur le port ${PORT}`);
});