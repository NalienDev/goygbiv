// Game state manager — handles game lifecycle, rounds, voting, and scoring

const { v4: uuidv4 } = require('uuid');
const songMatcher = require('./songMatcher');

class GameManager {
  constructor() {
    // gameId → game state
    this.games = new Map();
  }

  /**
   * Create a new game
   */
  createGame(hostId, settings) {
    const gameId = uuidv4().slice(0, 8); // Short, shareable ID
    const game = {
      id: gameId,
      hostId,
      settings: {
        songStart: settings.songStart || 'beginning',       // 'beginning' | 'middle'
        categories: settings.categories || ['top'],          // ['top', 'playlists', 'albums']
        pointsToWin: parseInt(settings.pointsToWin, 10) || 50, // 30 | 50 | 75
        revealDuration: parseInt(settings.revealDuration, 10) || 10, // 5 | 10 | 15 (default: 10s)
        votingDuration: parseInt(settings.votingDuration, 10) || 20, // default: 20s
      },
      state: 'lobby', // 'lobby' | 'loading' | 'playing' | 'voting' | 'reveal' | 'finished'
      players: new Map(), // playerId → player object
      scores: new Map(),  // playerId → score
      round: 0,
      currentRound: null,
      usedTrackIds: new Set(),
      filteredLibraries: null,
      fullLibraries: null,
      votes: new Map(), // playerId → Set<votedPlayerId>
      createdAt: Date.now(),
      listenTimeout: null,
      votingTimeout: null,
      earlyRevealTimeout: null,
      revealTimeout: null,
      disconnectTimers: new Map(), // playerId → setTimeout
    };

    this.games.set(gameId, game);
    console.log(`[GameManager] Game ${gameId} created by host ${hostId} (Reveal time: ${game.settings.revealDuration}s)`);
    return game;
  }

  /**
   * Get a game by ID
   */
  getGame(gameId) {
    return this.games.get(gameId) || null;
  }

  /**
   * Add or reconnect a player to a game
   */
  joinGame(gameId, player) {
    const game = this.games.get(gameId);
    if (!game) throw new Error('Game not found');

    const isExistingPlayer = game.players.has(player.id);
    // Allow rejoining a finished game (players returning to lobby for rematch)
    const allowJoin = game.state === 'lobby' || game.state === 'finished' || isExistingPlayer;
    if (!allowJoin) {
      throw new Error('Game already started');
    }

    // Cancel any pending disconnect timer for this player
    if (game.disconnectTimers && game.disconnectTimers.has(player.id)) {
      clearTimeout(game.disconnectTimers.get(player.id));
      game.disconnectTimers.delete(player.id);
      console.log(`[GameManager] Cancelled disconnect timer for ${player.id}`);
    }

    const existingPlayer = game.players.get(player.id);
    const playerData = {
      id: player.id,
      displayName: player.displayName || (existingPlayer ? existingPlayer.displayName : 'Player'),
      spotifyId: player.spotifyId || (existingPlayer ? existingPlayer.spotifyId : null),
      avatarUrl: player.avatarUrl || (existingPlayer ? existingPlayer.avatarUrl : null),
      token: player.token || (existingPlayer ? existingPlayer.token : null),
      deviceId: player.deviceId || (existingPlayer ? existingPlayer.deviceId : null),
      isPremium: player.isPremium ?? (existingPlayer ? existingPlayer.isPremium : false),
      socketId: player.socketId,
      online: true,
      lastSeen: Date.now(),
    };

    game.players.set(player.id, playerData);
    if (!game.scores.has(player.id)) {
      game.scores.set(player.id, 0);
    }

    // Cancel any pending game cleanup timer if host/players return
    if (game.cleanupTimer) {
      clearTimeout(game.cleanupTimer);
      game.cleanupTimer = null;
    }

    console.log(`[GameManager] ${playerData.displayName} ${isExistingPlayer ? 'reconnected to' : 'joined'} game ${gameId} (${game.players.size} players)`);
    return playerData;
  }

  /**
   * Handle temporary socket disconnect (page navigation, refresh)
   */
  handleDisconnect(gameId, playerId) {
    const game = this.games.get(gameId);
    if (!game) return;

    const player = game.players.get(playerId);
    if (player) {
      player.online = false;
      player.lastSeen = Date.now();
      console.log(`[GameManager] Player ${player.displayName} marked offline (grace period)`);
    }

    // Check if ALL players are offline
    const anyOnline = [...game.players.values()].some(p => p.online);
    if (!anyOnline && !game.cleanupTimer) {
      // Schedule game deletion only after 10 minutes of complete abandonment
      game.cleanupTimer = setTimeout(() => {
        const g = this.games.get(gameId);
        if (g && ![...g.players.values()].some(p => p.online)) {
          this.games.delete(gameId);
          console.log(`[GameManager] Game ${gameId} deleted after 10 min abandonment`);
        }
      }, 600000);
    }
  }

  /**
   * Explicitly remove a player from a game
   */
  leaveGame(gameId, playerId) {
    const game = this.games.get(gameId);
    if (!game) return;

    game.players.delete(playerId);
    game.scores.delete(playerId);
    console.log(`[GameManager] Player ${playerId} removed from game ${gameId}`);

    // If no players left at all, clean up after grace period
    if (game.players.size === 0 && !game.cleanupTimer) {
      game.cleanupTimer = setTimeout(() => {
        if (this.games.has(gameId) && this.games.get(gameId).players.size === 0) {
          this.games.delete(gameId);
          console.log(`[GameManager] Game ${gameId} deleted (empty)`);
        }
      }, 300000); // 5 minutes
    }
  }

  /**
   * Update a player's device ID
   */
  updatePlayerDevice(gameId, playerId, deviceId) {
    const game = this.games.get(gameId);
    if (!game) return;
    const player = game.players.get(playerId);
    if (player) {
      player.deviceId = deviceId;
    }
  }

  /**
   * Update a player's token (for refresh)
   */
  updatePlayerToken(gameId, playerId, token) {
    const game = this.games.get(gameId);
    if (!game) return;
    const player = game.players.get(playerId);
    if (player) {
      player.token = token;
    }
  }

  /**
   * Start the game — fetch all libraries
   */
  async startGame(gameId) {
    const game = this.games.get(gameId);
    if (!game) throw new Error('Game not found');
    if (game.players.size < 2) throw new Error('Need at least 2 players');

    game.state = 'loading';
    console.log(`[GameManager] Loading libraries for game ${gameId}...`);

    const players = [...game.players.values()];
    const { filteredLibraries, fullLibraries } = await songMatcher.buildGameLibraries(
      players,
      game.settings.categories
    );

    game.filteredLibraries = filteredLibraries;
    game.fullLibraries = fullLibraries;
    game.state = 'playing';

    console.log(`[GameManager] Game ${gameId} started!`);
    return game;
  }

  /**
   * Start a new round — pick a song and find matches
   */
  nextRound(gameId) {
    const game = this.games.get(gameId);
    if (!game) throw new Error('Game not found');
    if (game.state === 'finished') return null;

    game.round++;
    game.votes.clear();
    game.state = 'playing';

    const players = [...game.players.values()];
    const result = songMatcher.pickRoundSong(
      players,
      game.filteredLibraries,
      game.fullLibraries,
      game.usedTrackIds
    );

    if (!result) {
      // No more suitable songs found
      game.state = 'finished';
      return null;
    }

    game.usedTrackIds.add(result.track.id);

    // Calculate start position
    let positionMs = 0;
    if (game.settings.songStart === 'middle' && result.track.durationMs > 0) {
      // Start at ~40% of the track to get a recognizable part
      positionMs = Math.floor(result.track.durationMs * 0.4);
    }

    game.currentRound = {
      roundNumber: game.round,
      track: result.track,
      sourcePlayerId: result.sourcePlayerId,
      matchingPlayerIds: result.matchingPlayerIds,
      positionMs,
      votingDeadline: null,
    };

    console.log(`[GameManager] Round ${game.round}: "${result.track.name}" by ${result.track.artists}`);
    return game.currentRound;
  }

  /**
   * Set the game to voting state
   */
  startVoting(gameId, timeLimit = 15000) {
    const game = this.games.get(gameId);
    if (!game || !game.currentRound) return;

    game.state = 'voting';
    game.currentRound.votingDeadline = Date.now() + timeLimit;
  }

  /**
   * Submit a player's votes for the current round
   * @param {string[]} votedPlayerIds - Array of player IDs the voter thinks listen to this song
   */
  submitVotes(gameId, playerId, votedPlayerIds) {
    const game = this.games.get(gameId);
    if (!game || game.state !== 'voting') return false;
    if (game.votes.has(playerId)) return false; // Already voted

    game.votes.set(playerId, new Set(votedPlayerIds));
    return true;
  }

  /**
   * Reveal results and calculate scores for the round
   * Returns { actualOwners, playerResults, scores, winner }
   */
  revealResults(gameId) {
    const game = this.games.get(gameId);
    // Strict idempotency: only reveal if game is currently in voting state
    if (!game || !game.currentRound || game.state !== 'voting') return null;

    game.state = 'reveal';

    const actualOwners = new Set(game.currentRound.matchingPlayerIds);
    const playerResults = {};
    const allPlayerIds = [...game.players.keys()];

    // Calculate score changes for each voter
    for (const [voterId, votedIds] of game.votes) {
      let roundScore = 0;
      const details = [];

      for (const votedId of votedIds) {
        if (actualOwners.has(votedId)) {
          roundScore += 2; // +2 points for correct guess
          details.push({ playerId: votedId, correct: true });
        } else {
          roundScore -= 1; // -1 point for wrong guess
          details.push({ playerId: votedId, correct: false });
        }
      }

      // Update total score
      const currentScore = game.scores.get(voterId) || 0;
      game.scores.set(voterId, currentScore + roundScore);

      playerResults[voterId] = {
        roundScore,
        totalScore: game.scores.get(voterId),
        details,
      };
    }

    // Players who didn't vote get no score change but still get results
    for (const playerId of allPlayerIds) {
      if (!playerResults[playerId]) {
        playerResults[playerId] = {
          roundScore: 0,
          totalScore: game.scores.get(playerId) || 0,
          details: [],
        };
      }
    }

    // Check for winner
    let winner = null;
    for (const [playerId, score] of game.scores) {
      if (score >= game.settings.pointsToWin) {
        if (!winner || score > game.scores.get(winner)) {
          winner = playerId;
        }
      }
    }

    if (winner) {
      game.state = 'finished';
    }

    return {
      actualOwners: [...actualOwners],
      track: game.currentRound.track,
      playerResults,
      scores: Object.fromEntries(game.scores),
      winner,
      // Map of voterId → [votedForId, ...] so clients can show who voted for whom at reveal
      allVotes: Object.fromEntries(
        [...game.votes].map(([k, v]) => [k, [...v]])
      ),
    };
  }

  /**
   * Get public game info (for lobby and mid-game synchronization)
   */
  getGameInfo(gameId) {
    const game = this.games.get(gameId);
    if (!game) return null;

    return {
      id: game.id,
      hostId: game.hostId,
      state: game.state,
      settings: game.settings,
      players: [...game.players.values()].map(p => ({
        id: p.id,
        displayName: p.displayName,
        avatarUrl: p.avatarUrl,
        isPremium: p.isPremium,
        online: !!p.online,
      })),
      scores: Object.fromEntries(game.scores),
      round: game.round,
      currentRound: (game.currentRound && game.state !== 'finished') ? {
        roundNumber: game.currentRound.roundNumber,
        track: {
          uri: game.currentRound.track.uri,
          name: game.currentRound.track.name,
          artists: game.currentRound.track.artists,
          album: game.currentRound.track.album,
          albumArt: game.currentRound.track.albumArt,
          durationMs: game.currentRound.track.durationMs,
        },
        positionMs: game.currentRound.positionMs,
        votingDeadline: game.currentRound.votingDeadline,
      } : null,
    };
  }

  /**
   * Get the scoreboard
   */
  getScoreboard(gameId) {
    const game = this.games.get(gameId);
    if (!game) return [];

    return [...game.players.values()]
      .map(p => ({
        id: p.id,
        displayName: p.displayName,
        avatarUrl: p.avatarUrl,
        score: game.scores.get(p.id) || 0,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Check if all currently active players have voted
   */
  allVotesIn(gameId) {
    const game = this.games.get(gameId);
    if (!game || game.state !== 'voting') return false;
    const onlinePlayers = [...game.players.values()].filter(p => p.online);
    // Must have at least 2 active players before considering all votes legitimately in
    if (onlinePlayers.length < 2) return false;
    return onlinePlayers.every(p => game.votes.has(p.id));
  }

  /**
   * Get number of online active players
   */
  getActivePlayerCount(gameId) {
    const game = this.games.get(gameId);
    if (!game) return 0;
    return [...game.players.values()].filter(p => p.online).length;
  }

  /**
   * Reset a finished game back to lobby state for a rematch.
   * Keeps the same players but wipes scores, rounds, and song history.
   */
  resetGame(gameId) {
    const game = this.games.get(gameId);
    if (!game) throw new Error('Game not found');

    // Clear all round/voting timers
    if (game.listenTimeout) clearTimeout(game.listenTimeout);
    if (game.votingTimeout) clearTimeout(game.votingTimeout);
    if (game.earlyRevealTimeout) clearTimeout(game.earlyRevealTimeout);
    if (game.revealTimeout) clearTimeout(game.revealTimeout);

    game.state = 'lobby';
    game.round = 0;
    game.currentRound = null;
    game.usedTrackIds = new Set();
    game.filteredLibraries = null;
    game.fullLibraries = null;
    game.votes = new Map();
    game.listenTimeout = null;
    game.votingTimeout = null;
    game.earlyRevealTimeout = null;
    game.revealTimeout = null;

    // Reset all scores to 0
    for (const playerId of game.scores.keys()) {
      game.scores.set(playerId, 0);
    }

    console.log(`[GameManager] Game ${gameId} reset to lobby for rematch`);
    return game;
  }

  /**
   * Clean up old games (run periodically)
   */
  cleanup(maxAgeMs = 3600000) { // 1 hour
    const now = Date.now();
    for (const [gameId, game] of this.games) {
      if (now - game.createdAt > maxAgeMs) {
        this.games.delete(gameId);
        console.log(`[GameManager] Cleaned up stale game ${gameId}`);
      }
    }
  }
}

module.exports = GameManager;
