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
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Pseudo : 2 à 32 caractères' });

  const existing = getUserByUsername.get(username);
  if (existing) return res.status(409).json({ error: 'Pseudo déjà pris' });

  const hash   = bcrypt.hashSync(password, 10);
  const avatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`;

  let result;
  try {
    result = createUser.run({ username, password: hash, pronouns: pronouns || 'iel', avatar });
    createUserProfile.run({ user_id: result.lastInsertRowid, bio: '', banner_color: '#6a0dad', badges: JSON.stringify([]) });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur' });
  }

  const token = signToken(result.lastInsertRowid);
  res.json({ token, userId: result.lastInsertRowid });
});

// REST: Profile
app.get('/api/profile/:userId', (req, res) => {
  const { userId } = req.params;
  const profile = getUserProfile.get(userId);
  if (!profile) return res.status(404).json({ error: 'Profil non trouvé' });
  
  const user = getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  
  const badges = [...JSON.parse(profile.badges || '[]'), ...getUserBadges(userId)];
  res.json({ ...profile, badges, username: user.username, avatar: user.avatar, pronouns: user.pronouns });
});

app.post('/api/profile', (req, res) => {
  const { token, bio, banner_color, banner_image } = req.body;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token invalide' });
  
  try {
    updateUserProfile.run({ bio, banner_color, banner_image, user_id: payload.sub });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Soundboard
app.get('/api/soundboard', (req, res) => {
  res.json({
    sounds: [
      { name: 'Connexion', url: 'https://assets.mixkit.co/sfx/preview/mixkit-arcade-game-jump-coin-216.mp3' },
      { name: 'Déconnexion', url: 'https://assets.mixkit.co/sfx/preview/mixkit-arcade-game-jump-223.mp3' },
      { name: 'Notification', url: 'https://assets.mixkit.co/sfx/preview/mixkit-positive-notification-951.mp3' },
      { name: 'Applaudissements', url: 'https://assets.mixkit.co/sfx/preview/mixkit-crowd-applause-461.mp3' },
      { name: 'Rire', url: 'https://assets.mixkit.co/sfx/preview/mixkit-laughing-crowd-424.mp3' },
      { name: 'Ambiance', url: 'https://assets.mixkit.co/sfx/preview/mixkit-arcade-game-opener-222.mp3' }
    ]
  });
});

// Socket.io
io.on('connection', (socket) => {
  const token = socket.handshake.auth.token;
  const payload = verifyToken(token);
  if (!payload) return socket.disconnect();
  
  const userId = payload.sub;
  const user = getUserById.get(userId);
  if (!user) return socket.disconnect();
  
  connectedUsers.set(userId, {
    username: user.username,
    socketId: socket.id,
    status: user.status,
    customStatus: user.custom_status
  });
  
  io.emit('user_connected', { userId, username: user.username, status: user.status });
  
  socket.on('disconnect', () => {
    connectedUsers.delete(userId);
    io.emit('user_disconnected', { userId });
  });
  
  socket.on('play_sound', ({ soundUrl }) => {
    socket.broadcast.emit('play_sound', { soundUrl, userId });
  });
});

server.listen(PORT, () => console.log(`NEXUS démarré sur le port ${PORT}`));