// server.js — NEXUS Backend V2 + AI Updater intégré
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
} = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT         = process.env.PORT || 4242;
const JWT_SECRET   = process.env.JWT_SECRET || 'nexus-dev-secret-CHANGE-ME';
const MISTRAL_KEY  = process.env.MISTRAL_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = process.env.GITHUB_REPO || 'LUWUANA/nexus';

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── Sessions Socket ──────────────────────────────────────────────────────────
const sessions = new Map();

// ─── Helper JWT ───────────────────────────────────────────────────────────────
function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ─── Helper HTTPS request ────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── REST : Auth ──────────────────────────────────────────────────────────────
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

// ─── REST : Données ───────────────────────────────────────────────────────────
app.get('/api/servers', (req, res) => {
  const servers = getServers.all();
  const result  = servers.map(srv => ({ ...srv, channels: getChannelsByServer.all(srv.id) }));
  res.json(result);
});

app.get('/api/channels/:id/messages', (req, res) => {
  const messages = getMessages.all(req.params.id);
  res.json(messages.reverse());
});

// ─── AI Updater : Lire un fichier GitHub ─────────────────────────────────────
app.get('/api/ai/file', async (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path requis' });

  const token = GITHUB_TOKEN;
  const repo  = GITHUB_REPO;

  try {
    const result = await httpsRequest({
      hostname: 'api.github.com',
      path:     `/repos/${repo}/contents/${path}`,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.github+json',
        'User-Agent':    'nexus-ai-updater',
      },
    });

    if (result.status !== 200) {
      return res.status(result.status).json({ error: `GitHub: ${result.status}` });
    }

    const data    = JSON.parse(result.body);
    const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    res.json({ content, sha: data.sha });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI Updater : Générer le code via Mistral ────────────────────────────────
app.post('/api/ai/generate', async (req, res) => {
  const { request, codeContext } = req.body;
  if (!request) return res.status(400).json({ error: 'request requis' });
  if (!MISTRAL_KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY non configurée dans .env' });

  const systemPrompt = `Tu es un expert Node.js/Express/Socket.io qui maintient NEXUS, un clone Discord open-source inclusif.
Tu reçois une demande et un extrait du code source.
Tu réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni backticks.
Format exact :
{"branch_name":"feature/nom-kebab","pr_title":"feat: titre court","pr_body":"## Description\\nExplication.","files":{"public/index.html":"contenu complet"},"commit_message":"feat: description courte"}
RÈGLES ABSOLUES :
- Ne modifier QUE public/index.html sauf demande explicite
- Ne JAMAIS modifier server.js, db.js, package.json
- Le contenu du fichier doit être COMPLET et valide
- Pas de redirection vers des pages externes
- Garder toute la logique Socket.io existante`;

  const payload = JSON.stringify({
    model: 'mistral-large-latest',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Code source actuel :\n\n${codeContext}\n\n---\n\nDemande : ${request}` }
    ],
    max_tokens: 16000,
    temperature: 0.05,
    response_format: { type: 'json_object' },
  });

  try {
    const result = await httpsRequest({
      hostname: 'api.mistral.ai',
      path:     '/v1/chat/completions',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${MISTRAL_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, payload);

    if (result.status !== 200) {
      return res.status(result.status).json({ error: `Mistral: ${result.status} — ${result.body}` });
    }

    const data = JSON.parse(result.body);

    if (data.choices[0].finish_reason === 'length') {
      return res.status(422).json({ error: 'Réponse tronquée — simplifie la demande' });
    }

    const changes = JSON.parse(data.choices[0].message.content);
    res.json(changes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI Updater : Créer la branche + commit + PR ─────────────────────────────
app.post('/api/ai/pull-request', async (req, res) => {
  const { changes } = req.body;
  if (!changes) return res.status(400).json({ error: 'changes requis' });

  const token = GITHUB_TOKEN;
  const repo  = GITHUB_REPO;

  try {
    // Récupérer SHA de main
    const refResult = await httpsRequest({
      hostname: 'api.github.com',
      path:     `/repos/${repo}/git/ref/heads/main`,
      method:   'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'nexus-ai-updater' },
    });
    if (refResult.status !== 200) throw new Error(`Lecture main: ${refResult.status}`);
    const baseSha = JSON.parse(refResult.body).object.sha;

    // Créer la branche
    const branchPayload = JSON.stringify({ ref: `refs/heads/${changes.branch_name}`, sha: baseSha });
    const branchResult = await httpsRequest({
      hostname: 'api.github.com',
      path:     `/repos/${repo}/git/refs`,
      method:   'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'nexus-ai-updater', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(branchPayload) },
    }, branchPayload);
    if (branchResult.status !== 201) throw new Error(`Branche: ${JSON.parse(branchResult.body).message}`);

    // Commiter chaque fichier
    for (const [filePath, content] of Object.entries(changes.files)) {
      // Récupérer SHA du fichier si existant
      const fileResult = await httpsRequest({
        hostname: 'api.github.com',
        path:     `/repos/${repo}/contents/${filePath}?ref=${changes.branch_name}`,
        method:   'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'nexus-ai-updater' },
      });
      const fileSha = fileResult.status === 200 ? JSON.parse(fileResult.body).sha : undefined;

      const encoded       = Buffer.from(content).toString('base64');
      const commitPayload = JSON.stringify({
        message: changes.commit_message,
        content: encoded,
        branch:  changes.branch_name,
        ...(fileSha ? { sha: fileSha } : {}),
      });

      const commitResult = await httpsRequest({
        hostname: 'api.github.com',
        path:     `/repos/${repo}/contents/${filePath}`,
        method:   'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'nexus-ai-updater', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(commitPayload) },
      }, commitPayload);

      if (commitResult.status !== 200 && commitResult.status !== 201) {
        throw new Error(`Commit ${filePath}: ${JSON.parse(commitResult.body).message}`);
      }
    }

    // Créer la PR
    const prPayload = JSON.stringify({
      title: changes.pr_title,
      body:  changes.pr_body + `\n\n---\n*🤖 Généré par NEXUS AI Updater*`,
      head:  changes.branch_name,
      base:  'main',
    });
    const prResult = await httpsRequest({
      hostname: 'api.github.com',
      path:     `/repos/${repo}/pulls`,
      method:   'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'nexus-ai-updater', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(prPayload) },
    }, prPayload);

    if (prResult.status !== 201) throw new Error(`PR: ${JSON.parse(prResult.body).message}`);

    const pr = JSON.parse(prResult.body);
    res.json({ url: pr.html_url, title: pr.title, branch: changes.branch_name, files: Object.keys(changes.files) });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
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

  socket.on('send-msg', ({ channelId, content }) => {
    const session = sessions.get(socket.id);
    if (!session || !content || !content.trim() || content.length > 2000) return;
    const channel = getChannelById.get(channelId);
    if (!channel) return;
    const result = createMessage.run({ channel_id: channelId, user_id: session.userId, content: content.trim() });
    const user   = getUserById.get(session.userId);
    const msg = {
      id: result.lastInsertRowid, channel_id: channelId,
      content: content.trim(), created_at: new Date().toISOString(),
      username: user.username, pronouns: user.pronouns, avatar: user.avatar,
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

// ─── Démarrage ────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NEXUS V2 — port ${PORT}`);
  console.log(`   DB      : ${process.env.DB_PATH || './data/nexus.db'}`);
  console.log(`   Mistral : ${MISTRAL_KEY ? '✅ configuré' : '⚠️  manquant dans .env'}`);
  console.log(`   GitHub  : ${GITHUB_TOKEN ? '✅ configuré' : '⚠️  manquant dans .env'}`);
  console.log(`   Repo    : ${GITHUB_REPO}`);
});
