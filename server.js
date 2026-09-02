// goygbiv — Spotify Musical Roulette Game Server

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const GameManager = require('./src/gameManager');
const spotifyApi = require('./src/spotifyApi');

const fs = require('fs');

const app = express();

// Optional HTTPS support if certs are present
const sslKeyPath = process.env.SSL_KEY_PATH || path.join(__dirname, 'key.pem');
const sslCertPath = process.env.SSL_CERT_PATH || path.join(__dirname, 'cert.pem');
const useHttps = fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath);

let server;
if (useHttps) {
  const https = require('https');
  server = https.createServer({
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath),
  }, app);
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const gameManager = new GameManager();

// ─── Config ───

const PORT = parseInt(process.env.PORT, 10) || 3000;
const protocol = useHttps ? 'https' : 'http';
const BASE_URL = process.env.BASE_URL || `${protocol}://127.0.0.1:${PORT}`;

// Client ID pool to work around the 5-user Development Mode limit
// Register multiple apps at developer.spotify.com/dashboard
const CLIENT_IDS = (process.env.SPOTIFY_CLIENT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Track how many users are authorized per Client ID
const clientIdUsage = new Map(); // clientId → Set<spotifyUserId>
CLIENT_IDS.forEach(id => clientIdUsage.set(id, new Set()));

// ─── Middleware ───

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ───

// Get an available Client ID from the pool
app.get('/api/client-id', (req, res) => {
  if (CLIENT_IDS.length === 0) {
    return res.status(500).json({ error: 'No Spotify Client IDs configured' });
  }

  // Find the Client ID with the fewest users
  let bestId = CLIENT_IDS[0];
  let bestCount = Infinity;

  for (const [id, users] of clientIdUsage) {
    if (users.size < bestCount) {
      bestCount = users.size;
      bestId = id;
    }
  }

  res.json({ clientId: bestId });
});

// Register a user against a Client ID (called after successful auth)
app.post('/api/register-user', (req, res) => {
  const { clientId, spotifyUserId } = req.body;
  if (clientIdUsage.has(clientId)) {
    clientIdUsage.get(clientId).add(spotifyUserId);
  }
  res.json({ ok: true });
});

// Get game info
app.get('/api/game/:gameId', (req, res) => {
  const game = gameManager.getGameInfo(req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(game);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    games: gameManager.games.size,
    clientIds: CLIENT_IDS.length,
    uptime: process.uptime(),
  });
});

// Config for frontend
app.get('/api/config', (req, res) => {
  res.json({
    baseUrl: BASE_URL,
    hasClientIds: CLIENT_IDS.length > 0,
  });
});

// ─── Socket.IO ───

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);
  let currentGameId = null;
  let currentPlayerId = null;

  // ── Create Game ──
  socket.on('create-game', (data, callback) => {
    try {
      const game = gameManager.createGame(data.playerId, {
        songStart: data.songStart,
        categories: data.categories,
        pointsToWin: data.pointsToWin,
      });

      // Host auto-joins
      const player = gameManager.joinGame(game.id, {
        id: data.playerId,
        displayName: data.displayName,
        spotifyId: data.spotifyId,
        avatarUrl: data.avatarUrl,
        token: data.token,
        deviceId: data.deviceId,
        isPremium: data.isPremium,
        socketId: socket.id,
      });

      currentGameId = game.id;
      currentPlayerId = data.playerId;
      socket.join(game.id);

      callback({
        success: true,
        gameId: game.id,
        inviteUrl: `${BASE_URL}/lobby.html?game=${game.id}`,
      });

      console.log(`[Socket] Game ${game.id} created, host joined`);
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── Join Game ──
  socket.on('join-game', (data, callback) => {
    try {
      const player = gameManager.joinGame(data.gameId, {
        id: data.playerId,
        displayName: data.displayName,
        spotifyId: data.spotifyId,
        avatarUrl: data.avatarUrl,
        token: data.token,
        deviceId: data.deviceId,
        isPremium: data.isPremium,
        socketId: socket.id,
      });

      currentGameId = data.gameId;
      currentPlayerId = data.playerId;
      socket.join(data.gameId);

      // Broadcast to room
      io.to(data.gameId).emit('player-joined', {
        player: {
          id: player.id,
          displayName: player.displayName,
          avatarUrl: player.avatarUrl,
          isPremium: player.isPremium,
        },
        gameInfo: gameManager.getGameInfo(data.gameId),
      });

      callback({ success: true, gameInfo: gameManager.getGameInfo(data.gameId) });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── Update Device ──
  socket.on('update-device', (data) => {
    if (currentGameId && currentPlayerId) {
      gameManager.updatePlayerDevice(currentGameId, currentPlayerId, data.deviceId);
    }
  });

  // ── Update Token ──
  socket.on('update-token', (data) => {
    if (currentGameId && currentPlayerId) {
      gameManager.updatePlayerToken(currentGameId, currentPlayerId, data.token);
    }
  });

  // ── Start Game ──
  socket.on('start-game', async (data, callback) => {
    try {
      const game = gameManager.getGame(data.gameId);
      if (!game) throw new Error('Game not found');
      if (game.hostId !== currentPlayerId) throw new Error('Only the host can start the game');

      // Notify players that libraries are loading
      io.to(data.gameId).emit('game-loading', { message: 'Loading everyone\'s music libraries...' });

      await gameManager.startGame(data.gameId);

      io.to(data.gameId).emit('game-started', {
        gameId: data.gameId,
        gameInfo: gameManager.getGameInfo(data.gameId),
      });

      callback({ success: true });

      // Start first round after a brief delay
      setTimeout(() => startNewRound(data.gameId), 2000);
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── Submit Votes ──
  socket.on('submit-votes', (data, callback) => {
    const success = gameManager.submitVotes(data.gameId, currentPlayerId, data.votes);
    if (callback) callback({ success });

    // Check if all votes are in
    if (gameManager.allVotesIn(data.gameId)) {
      doReveal(data.gameId);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    if (currentGameId && currentPlayerId) {
      const gid = currentGameId;
      const pid = currentPlayerId;
      gameManager.handleDisconnect(gid, pid);

      // Debounce notifying the room — prevents flashing "player left" during page navigation
      setTimeout(() => {
        const game = gameManager.getGame(gid);
        if (game) {
          const p = game.players.get(pid);
          if (p && !p.online) {
            io.to(gid).emit('player-left', {
              playerId: pid,
              gameInfo: gameManager.getGameInfo(gid),
            });
          }
        }
      }, 5000);
    }
  });
});

// ─── Round Flow ───

function startNewRound(gameId) {
  const round = gameManager.nextRound(gameId);
  if (!round) {
    // No more songs or game finished
    const game = gameManager.getGame(gameId);
    if (game) {
      const scoreboard = gameManager.getScoreboard(gameId);
      io.to(gameId).emit('game-over', {
        reason: 'no_more_songs',
        scoreboard,
        winner: scoreboard.length > 0 ? scoreboard[0] : null,
      });
    }
    return;
  }

  // Emit round info (without revealing who has the song)
  io.to(gameId).emit('new-round', {
    roundNumber: round.roundNumber,
    track: {
      uri: round.track.uri,
      name: round.track.name,
      artists: round.track.artists,
      album: round.track.album,
      albumArt: round.track.albumArt,
      durationMs: round.track.durationMs,
    },
    positionMs: round.positionMs,
  });

  // Tell each premium player to start playback on their device
  const game = gameManager.getGame(gameId);
  if (game) {
    io.to(gameId).emit('play-track', {
      uri: round.track.uri,
      positionMs: round.positionMs,
    });
  }

  // After a short listen time (5 seconds), open voting
  setTimeout(() => {
    gameManager.startVoting(gameId, 15000);

    const gameInfo = gameManager.getGameInfo(gameId);
    if (gameInfo) {
      io.to(gameId).emit('voting-phase', {
        timeLimit: 15000,
        players: gameInfo.players,
      });

      // Auto-reveal after voting timer
      setTimeout(() => {
        const currentGame = gameManager.getGame(gameId);
        if (currentGame && currentGame.state === 'voting') {
          doReveal(gameId);
        }
      }, 15000);
    }
  }, 5000);
}

function doReveal(gameId) {
  const results = gameManager.revealResults(gameId);
  if (!results) return;

  // Pause playback for all players
  const game = gameManager.getGame(gameId);
  if (game) {
    io.to(gameId).emit('pause-playback');
  }

  io.to(gameId).emit('reveal-results', {
    track: results.track,
    actualOwners: results.actualOwners,
    playerResults: results.playerResults,
    scoreboard: gameManager.getScoreboard(gameId),
    winner: results.winner,
  });

  if (results.winner) {
    const winnerPlayer = game ? game.players.get(results.winner) : null;
    io.to(gameId).emit('game-over', {
      reason: 'points_reached',
      winner: winnerPlayer ? {
        id: winnerPlayer.id,
        displayName: winnerPlayer.displayName,
        avatarUrl: winnerPlayer.avatarUrl,
        score: game.scores.get(results.winner),
      } : null,
      scoreboard: gameManager.getScoreboard(gameId),
    });
  } else {
    // Move to next round after reveal delay
    setTimeout(() => startNewRound(gameId), 7000);
  }
}

// ─── Cleanup old games every 30 minutes ───
setInterval(() => gameManager.cleanup(), 1800000);

// ─── Start Server ───

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🎵  GOYGBIV — Spotify Musical Roulette`);
  console.log(`  ───────────────────────────────────────────────`);
  console.log(`  Server:        ${BASE_URL}`);
  console.log(`  Mode:          ${useHttps ? 'HTTPS (Secure)' : 'HTTP'}`);
  console.log(`  Client IDs:    ${CLIENT_IDS.length} configured`);
  console.log(`  Spotify URI:   ${BASE_URL}/callback.html`);
  console.log(`  ───────────────────────────────────────────────\n`);
  if (!useHttps) {
    console.log(`  ℹ️  Note for Spotify Developer Dashboard:`);
    console.log(`     Spotify requires a secure Redirect URI.`);
    console.log(`     For local dev, Spotify allows the loopback IP:`);
    console.log(`     👉 ${BASE_URL}/callback.html`);
    console.log(`     (Use 127.0.0.1 instead of localhost!)\n`);
  }
});
