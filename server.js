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

// Spotify Development Mode allows up to 5 users per app
const MAX_USERS_PER_CLIENT_ID = 5;

// ─── Middleware ───

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ───

// Get an available Client ID from the pool
// If ?spotifyUserId= is provided, returns the user's existing Client ID first
app.get('/api/client-id', (req, res) => {
  if (CLIENT_IDS.length === 0) {
    return res.status(500).json({ error: 'No Spotify Client IDs configured' });
  }

  // If a Spotify user ID is provided, check if they're already registered under a Client ID
  const spotifyUserId = req.query.spotifyUserId;
  if (spotifyUserId) {
    for (const [clientId, users] of clientIdUsage) {
      if (users.has(spotifyUserId)) {
        return res.json({ clientId, existing: true });
      }
    }
  }

  // Fill each Client ID up to the 5-user Spotify limit before moving to the next.
  let selectedId = null;
  for (const id of CLIENT_IDS) {
    const users = clientIdUsage.get(id);
    if (users.size < MAX_USERS_PER_CLIENT_ID) {
      selectedId = id;
      break;
    }
  }

  if (!selectedId) {
    return res.status(503).json({ error: 'All Spotify Client IDs are full (5 users each). Add more Client IDs to SPOTIFY_CLIENT_IDS.' });
  }

  res.json({ clientId: selectedId });
});

// Look up which Client ID a user is registered under
app.get('/api/client-id-for-user/:spotifyUserId', (req, res) => {
  const { spotifyUserId } = req.params;
  for (const [clientId, users] of clientIdUsage) {
    if (users.has(spotifyUserId)) {
      return res.json({ clientId, found: true });
    }
  }
  res.json({ clientId: null, found: false });
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
        revealDuration: data.revealDuration,
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

      const game = gameManager.getGame(data.gameId);
      const gameInfo = gameManager.getGameInfo(data.gameId);

      // Broadcast to room
      io.to(data.gameId).emit('player-joined', {
        player: {
          id: player.id,
          displayName: player.displayName,
          avatarUrl: player.avatarUrl,
          isPremium: player.isPremium,
          online: true,
        },
        gameInfo,
      });

      callback({
        success: true,
        gameInfo,
        currentRound: (game && game.currentRound && game.state !== 'finished') ? game.currentRound : null,
      });
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

      // If returning from a finished game (rematch), reset first
      if (game.state === 'finished') {
        gameManager.resetGame(data.gameId);
      }

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

    // If all active players have submitted, reveal after a brief 1.5s delay
    if (gameManager.allVotesIn(data.gameId)) {
      const game = gameManager.getGame(data.gameId);
      if (game && game.state === 'voting' && !game.earlyRevealTimeout) {
        clearGameTimers(game);
        game.earlyRevealTimeout = setTimeout(() => {
          if (game) game.earlyRevealTimeout = null;
          doReveal(data.gameId);
        }, 1500);
      }
    }
  });

  // ── Send Reaction ──
  socket.on('send-reaction', (data) => {
    if (data && data.gameId && data.emoji) {
      io.to(data.gameId).emit('reaction-received', {
        emoji: data.emoji,
        isMega: !!data.isMega,
        senderId: currentPlayerId,
      });
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    if (currentGameId && currentPlayerId) {
      const gid = currentGameId;
      const pid = currentPlayerId;
      const sid = socket.id;

      const game = gameManager.getGame(gid);
      if (game) {
        const p = game.players.get(pid);
        // If player already reconnected on a newer socket (e.g. navigated from lobby to game), ignore!
        if (p && p.socketId && p.socketId !== sid) {
          console.log(`[Socket] Stale disconnect ignored for ${p.displayName} (active: ${p.socketId}, closed: ${sid})`);
          return;
        }

        // Clear previous disconnect timer if any
        if (game.disconnectTimers && game.disconnectTimers.has(pid)) {
          clearTimeout(game.disconnectTimers.get(pid));
        }

        // Brief grace period (1.8s) before evaluating disconnect
        const timer = setTimeout(() => {
          if (game.disconnectTimers) game.disconnectTimers.delete(pid);
          const currentP = game.players.get(pid);

          // Only declare offline if the player still hasn't reconnected on a new socket
          if (currentP && (!currentP.socketId || currentP.socketId === sid)) {
            if (game.state === 'lobby') {
              // In lobby: explicitly remove player so they disappear visually from the room
              gameManager.leaveGame(gid, pid);
              io.to(gid).emit('player-left', {
                playerId: pid,
                displayName: currentP.displayName,
                gameInfo: gameManager.getGameInfo(gid),
              });
            } else {
              // In game: mark offline (with grace period for reconnecting)
              gameManager.handleDisconnect(gid, pid, sid);
              io.to(gid).emit('player-left', {
                playerId: pid,
                displayName: currentP.displayName,
                gameInfo: gameManager.getGameInfo(gid),
              });

              // If game is in progress and fewer than 2 active players remain, end the game
              if (game.state !== 'finished') {
                const activeCount = gameManager.getActivePlayerCount(gid);
                if (activeCount < 2) {
                  clearGameTimers(game);
                  game.state = 'finished';
                  io.to(gid).emit('pause-playback');
                  io.to(gid).emit('game-over', {
                    reason: 'not_enough_players',
                    message: 'Game ended: A player left and there are not enough players to continue (minimum 2 players required).',
                    scoreboard: gameManager.getScoreboard(gid),
                  });
                }
              }
            }
          }
        }, 1800);

        if (game.disconnectTimers) {
          game.disconnectTimers.set(pid, timer);
        }
      }
    }
  });
});

// ─── Round Flow ───

function clearGameTimers(game) {
  if (!game) return;
  if (game.listenTimeout) { clearTimeout(game.listenTimeout); game.listenTimeout = null; }
  if (game.votingTimeout) { clearTimeout(game.votingTimeout); game.votingTimeout = null; }
  if (game.earlyRevealTimeout) { clearTimeout(game.earlyRevealTimeout); game.earlyRevealTimeout = null; }
  if (game.revealTimeout) { clearTimeout(game.revealTimeout); game.revealTimeout = null; }
}

function startNewRound(gameId) {
  const game = gameManager.getGame(gameId);
  if (!game || game.state === 'finished') return;

  clearGameTimers(game);

  // Check if at least 2 players are active
  if (gameManager.getActivePlayerCount(gameId) < 2) {
    game.state = 'finished';
    io.to(gameId).emit('pause-playback');
    io.to(gameId).emit('game-over', {
      reason: 'not_enough_players',
      message: 'Game ended: Not enough players to continue (minimum 2 players required).',
      scoreboard: gameManager.getScoreboard(gameId),
    });
    return;
  }

  const round = gameManager.nextRound(gameId);
  if (!round) {
    if (game.round <= 1 && [...game.scores.values()].every(s => s === 0)) {
      console.warn(`[Game] Game ${gameId} ended immediately: 0 songs found in libraries`);
      io.to(gameId).emit('game-error', {
        message: 'No playable songs were found in the connected Spotify accounts! Make sure players have Liked Songs, public playlists, or listening history on Spotify.',
      });
      return;
    }

    const scoreboard = gameManager.getScoreboard(gameId);
    io.to(gameId).emit('game-over', {
      reason: 'no_more_songs',
      scoreboard,
      winner: scoreboard.length > 0 ? scoreboard[0] : null,
    });
    return;
  }

  // Emit round info and playback instruction
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

  // Open voting after a brief 2-second buffer for audio buffer
  game.listenTimeout = setTimeout(() => {
    const curG = gameManager.getGame(gameId);
    if (!curG || curG.state === 'finished') return;

    const votingTimeMs = (curG.settings.votingDuration || 20) * 1000;
    gameManager.startVoting(gameId, votingTimeMs);

    const gameInfo = gameManager.getGameInfo(gameId);
    if (gameInfo) {
      io.to(gameId).emit('voting-phase', {
        timeLimit: votingTimeMs,
        players: gameInfo.players,
      });

      // Auto-reveal when voting time expires
      curG.votingTimeout = setTimeout(() => {
        const checkG = gameManager.getGame(gameId);
        if (checkG && checkG.state === 'voting') {
          doReveal(gameId);
        }
      }, votingTimeMs);
    }
  }, 2000);
}

function doReveal(gameId) {
  const game = gameManager.getGame(gameId);
  // Strict idempotency: do not re-run reveal if already revealing, finished, etc.
  if (!game || game.state !== 'voting') return;

  clearGameTimers(game);

  const results = gameManager.revealResults(gameId);
  if (!results) return;

  // Only pause playback if game is finished / has a winner; otherwise keep song playing into results!
  if (results.winner) {
    io.to(gameId).emit('pause-playback');
  }

  const revealSeconds = game.settings.revealDuration || 10;

  io.to(gameId).emit('reveal-results', {
    track: results.track,
    actualOwners: results.actualOwners,
    playerResults: results.playerResults,
    allVotes: results.allVotes,
    scoreboard: gameManager.getScoreboard(gameId),
    winner: results.winner,
    revealDuration: revealSeconds,
    playlistSources: results.playlistSources,
  });

  if (results.winner) {
    const winnerPlayer = game.players.get(results.winner);
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
    // Keep results on screen for configured duration (default: 10s)
    game.revealTimeout = setTimeout(() => {
      startNewRound(gameId);
    }, revealSeconds * 1000);
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
