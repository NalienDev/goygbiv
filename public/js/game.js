// game.js — Client-side in-game mechanics and real-time multiplayer flow

let socket = null;
let gameId = null;
let user = null;
let currentRound = 0;
let selectedPlayerIds = new Set();
let hasSubmittedVotes = false;
let currentPlayers = [];
let timerInterval = null;
let revealCountdown = null;
let activeDeviceId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  gameId = params.get('game') || sessionStorage.getItem('current_game_id');

  if (!gameId) {
    window.location.href = '/';
    return;
  }

  if (!isAuthenticated()) {
    sessionStorage.setItem('pending_game', gameId);
    sessionStorage.setItem('spotify_return_path', `/game.html?game=${gameId}`);
    window.location.href = '/';
    return;
  }

  user = getSpotifyUser();
  const token = await getValidToken();

  // User badge
  document.getElementById('user-name').textContent = user.displayName || 'Player';
  const avatar = document.getElementById('user-avatar');
  if (user.avatarUrl) {
    avatar.innerHTML = `<img src="${user.avatarUrl}" alt="${user.displayName}">`;
  } else {
    avatar.textContent = (user.displayName || 'P').charAt(0).toUpperCase();
  }

  // Check saved device preference
  activeDeviceId = sessionStorage.getItem('selected_device_id') || null;

  // Web Playback SDK setup if premium
  if (user.isPremium) {
    document.getElementById('playback-status-text').textContent = 'Connecting audio...';
    initSpotifyPlayer(
      async () => await getValidToken(),
      (deviceId) => {
        console.log('[Game] Web Playback SDK ready with ID:', deviceId);
        // Don't auto-select in-browser device — user should pick a real Spotify device
        document.getElementById('playback-status-text').textContent = 'Audio ready';
        if (socket) {
          socket.emit('update-device', { deviceId: activeDeviceId || deviceId });
        }
        refreshGameDevices();
      },
      (err) => {
        console.warn('[Game] Web Playback warning:', err.message);
        document.getElementById('playback-status-text').textContent = 'Device connected';
        refreshGameDevices();
      }
    );
    // Initial devices fetch
    setTimeout(refreshGameDevices, 1000);
    const select = document.getElementById('game-device-select');
    if (select) {
      select.addEventListener('focus', () => refreshGameDevices());
    }
  } else {
    document.getElementById('playback-status-pill').style.opacity = '0.6';
    document.getElementById('playback-status-text').textContent = 'Free Account (No audio)';
    const select = document.getElementById('game-device-select');
    if (select) select.innerHTML = '<option value="">Audio disabled (Free)</option>';
  }

  // Connect socket
  socket = io();
  socket.on('connect', () => {
    console.log('[Game] Socket connected:', socket.id);
    rejoinGame();
  });

  setupGameSocketListeners();
  initReactions();
});

function rejoinGame() {
  const token = sessionStorage.getItem('spotify_tokens')
    ? JSON.parse(sessionStorage.getItem('spotify_tokens')).accessToken
    : null;

  socket.emit('join-game', {
    gameId,
    playerId: user.id,
    displayName: user.displayName || 'Player',
    spotifyId: user.id,
    avatarUrl: user.avatarUrl,
    token,
    deviceId: activeDeviceId,
    isPremium: user.isPremium,
  }, (res) => {
    if (res && res.success && res.gameInfo) {
      currentPlayers = res.gameInfo.players || [];
      updateScoreboard(res.gameInfo.players, res.gameInfo.scores);
      document.getElementById('target-points-badge').textContent = `Target: ${res.gameInfo.settings.pointsToWin} pts`;

      // Midgame state recovery if rejoining in an ongoing round
      if (res.gameInfo.currentRound && res.gameInfo.state !== 'finished') {
        syncMidgameRound(res.gameInfo, res.gameInfo.currentRound);
      }
    }
  });
}

function syncMidgameRound(gameInfo, round) {
  currentRound = round.roundNumber;
  document.getElementById('round-indicator').textContent = `Round ${currentRound}`;

  if (round.track) {
    document.getElementById('track-title').textContent = round.track.name;
    document.getElementById('track-artist').textContent = round.track.artists;
    document.getElementById('track-album').textContent = round.track.album;
    if (round.track.albumArt) {
      document.getElementById('album-art-img').src = round.track.albumArt;
    }
  }

  if (gameInfo.state === 'voting') {
    document.getElementById('phase-title').textContent = 'Vote Now! 🗳️';
    document.getElementById('phase-subtitle').textContent = 'Select anyone you think has this song in their library!';
    renderVotingGrid(currentPlayers, true);

    const remainingMs = Math.max(1000, (round.votingDeadline || Date.now()) - Date.now());
    startTimer(remainingMs);
  } else if (gameInfo.state === 'playing') {
    document.getElementById('phase-title').textContent = 'Listen Carefully 🎧';
    document.getElementById('phase-subtitle').textContent = 'Who in this room has this song in their library?';
    renderVotingGrid(currentPlayers, false);
  }
}

function setupGameSocketListeners() {
  // New round started
  socket.on('new-round', async (data) => {
    // Clear any previous countdown or timer intervals
    clearInterval(timerInterval);
    clearInterval(revealCountdown);
    resetTimerDisplay();

    currentRound = data.roundNumber;
    hasSubmittedVotes = false;
    selectedPlayerIds.clear();

    document.getElementById('round-indicator').textContent = `Round ${currentRound}`;
    document.getElementById('phase-title').textContent = 'Listen Carefully 🎧';
    document.getElementById('phase-subtitle').textContent = 'Who in this room has this song in their library?';

    // Hide reveal card
    document.getElementById('reveal-card').classList.add('hidden');

    // Update track placeholder / title
    if (data.track) {
      document.getElementById('track-title').textContent = data.track.name;
      document.getElementById('track-artist').textContent = data.track.artists;
      document.getElementById('track-album').textContent = data.track.album;
      if (data.track.albumArt) {
        document.getElementById('album-art-img').src = data.track.albumArt;
      }
    }

    document.getElementById('album-art-container').classList.add('now-playing__art--spinning');

    // Render voting cards (initially ready)
    renderVotingGrid(currentPlayers, false);

    const submitBtn = document.getElementById('btn-submit-votes');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Listening... (Voting opens in a second)';
    updateVoteCountHint();

    // Trigger local Spotify playback if premium
    if (user.isPremium && data.track && data.track.uri) {
      const token = await getValidToken();
      if (token) {
        startSpotifyPlaybackDirect(token, data.track.uri, data.positionMs || 0);
      }
    }
  });

  // Voting phase opened
  socket.on('voting-phase', (data) => {
    // Ensure any reveal countdown is stopped
    clearInterval(revealCountdown);

    document.getElementById('phase-title').textContent = 'Vote Now! 🗳️';
    document.getElementById('phase-subtitle').textContent = 'Select anyone you think has this song in their library!';

    currentPlayers = data.players || currentPlayers;
    renderVotingGrid(currentPlayers, true);

    const submitBtn = document.getElementById('btn-submit-votes');
    submitBtn.style.display = 'none';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Lock In Votes';

    // Start countdown timer
    startTimer(data.timeLimit || 20000);
  });

  // Pause playback instruction
  socket.on('pause-playback', async () => {
    document.getElementById('album-art-container').classList.remove('now-playing__art--spinning');
    if (user.isPremium) {
      const token = await getValidToken();
      if (token) {
        pauseSpotifyPlaybackDirect(token);
      }
    }
  });

  // Reveal results
  socket.on('reveal-results', (data) => {
    clearInterval(timerInterval);
    clearInterval(revealCountdown);
    resetTimerDisplay();

    document.getElementById('phase-title').textContent = 'Round Over — Results!';

    const durationSec = data.revealDuration || 10;
    let secondsLeft = durationSec;
    const subTitle = document.getElementById('phase-subtitle');
    subTitle.textContent = `Next round starts in ${secondsLeft}s...`;

    revealCountdown = setInterval(() => {
      secondsLeft--;
      if (secondsLeft <= 0) {
        clearInterval(revealCountdown);
        subTitle.textContent = 'Starting next round...';
      } else {
        subTitle.textContent = `Next round starts in ${secondsLeft}s...`;
      }
    }, 1000);

    const submitBtn = document.getElementById('btn-submit-votes');
    submitBtn.disabled = true;
    submitBtn.style.display = 'none';
    submitBtn.textContent = 'Round Complete';

    // Update scoreboard
    if (data.scoreboard) {
      renderScoreboardList(data.scoreboard, data.playerResults);
    }

    // Reveal on player cards
    applyRevealToCards(data.actualOwners, data.playerResults);

    // Show who voted for whom on the cards
    if (data.allVotes) {
      showVotesOnCards(data.allVotes);
    }

    // Show breakdown summary card
    showRevealSummary(data.track, data.actualOwners, data.playerResults);
  });

  // Game over
  socket.on('game-over', (data) => {
    clearInterval(timerInterval);
    clearInterval(revealCountdown);
    if (user.isPremium) {
      getValidToken().then(t => t && pauseSpotifyPlaybackDirect(t));
    }

    showWinnerScreen(data.winner, data.scoreboard, data.reason, data.message);
  });

  // Game error (e.g. no songs in libraries)
  socket.on('game-error', (data) => {
    clearInterval(timerInterval);
    clearInterval(revealCountdown);
    document.getElementById('phase-title').textContent = '⚠️ No Songs Found';
    document.getElementById('phase-subtitle').textContent = data.message || 'No playable tracks found';
    showToast(data.message || 'No songs found in libraries');
  });

  // Player left / disconnected
  socket.on('player-left', (data) => {
    const name = data.displayName || 'A player';
    showToast(`⚠️ ${name} disconnected`);
    if (data.gameInfo) {
      currentPlayers = data.gameInfo.players || [];
      updateScoreboard(currentPlayers, data.gameInfo.scores);
    }
    if (data.playerId) {
      markPlayerDisconnected(data.playerId, name);
    }
  });

  // Player rejoined / reconnected
  socket.on('player-joined', (data) => {
    if (data.player) {
      showToast(`🟢 ${data.player.displayName} reconnected`);
    }
    if (data.gameInfo) {
      currentPlayers = data.gameInfo.players || [];
      updateScoreboard(currentPlayers, data.gameInfo.scores);
    }
    if (data.player && data.player.id) {
      markPlayerConnected(data.player.id);
    }
  });

  // In-game emoji reaction received
  socket.on('reaction-received', (data) => {
    if (data && data.emoji) {
      if (data.isMega) {
        spawnMegaReaction(data.emoji);
      } else {
        spawnReactionParticles(data.emoji);
      }
    }
  });
}

function markPlayerDisconnected(playerId, name = '') {
  const card = document.querySelector(`.vote-card[data-player-id="${playerId}"]`);
  if (card) {
    card.classList.add('vote-card--disconnected');
    card.title = `${name || 'Player'} disconnected`;
    const nameEl = card.querySelector('.vote-card__name');
    if (nameEl && !card.querySelector('.offline-badge')) {
      nameEl.insertAdjacentHTML('beforeend', ' <span class="offline-badge">🔌 Offline</span>');
    }
  }
}

function markPlayerConnected(playerId) {
  const card = document.querySelector(`.vote-card[data-player-id="${playerId}"]`);
  if (card) {
    card.classList.remove('vote-card--disconnected');
    card.title = '';
    const badge = card.querySelector('.offline-badge');
    if (badge) badge.remove();
  }
}

// ─── Playback Helper ───

async function startSpotifyPlaybackDirect(token, trackUri, positionMs) {
  try {
    const deviceParam = activeDeviceId ? `?device_id=${activeDeviceId}` : '';
    await fetch(`https://api.spotify.com/v1/me/player/play${deviceParam}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uris: [trackUri],
        position_ms: positionMs,
      }),
    });
  } catch (err) {
    console.warn('[Game] Playback API call error:', err);
  }
}

async function pauseSpotifyPlaybackDirect(token) {
  try {
    const deviceParam = activeDeviceId ? `?device_id=${activeDeviceId}` : '';
    await fetch(`https://api.spotify.com/v1/me/player/pause${deviceParam}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch (err) {
    console.warn('[Game] Pause API call error:', err);
  }
}

// ─── Voting Grid ───

function renderVotingGrid(players, enableVoting = false) {
  const grid = document.getElementById('voting-grid');
  grid.innerHTML = '';

  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'vote-card';
    card.dataset.playerId = p.id;

    const isOffline = (p.online === false);
    if (isOffline) {
      card.classList.add('vote-card--disconnected');
      card.title = `${p.displayName} is disconnected`;
    }

    if (selectedPlayerIds.has(p.id)) {
      card.classList.add('selected');
    }

    card.innerHTML = `
      <div class="vote-card__avatar">
        ${p.avatarUrl ? `<img src="${p.avatarUrl}" alt="${p.displayName}">` : p.displayName.charAt(0).toUpperCase()}
      </div>
      <div class="vote-card__name">
        ${escapeHtml(p.displayName)}${isOffline ? ' <span class="offline-badge">🔌 Offline</span>' : ''}
      </div>
      <div class="vote-card__result" id="result-badge-${p.id}"></div>
    `;

    if (enableVoting && !hasSubmittedVotes && !isOffline) {
      card.addEventListener('click', () => {
        if (hasSubmittedVotes) return;
        togglePlayerVote(p.id, card);
      });
    }

    grid.appendChild(card);
  });
}

function togglePlayerVote(playerId, cardElement) {
  if (selectedPlayerIds.has(playerId)) {
    selectedPlayerIds.delete(playerId);
    cardElement.classList.remove('selected');
  } else {
    selectedPlayerIds.add(playerId);
    cardElement.classList.add('selected');
  }
  updateVoteCountHint();
}

function updateVoteCountHint() {
  const count = selectedPlayerIds.size;
  document.getElementById('vote-count-hint').textContent = `${count} selected`;
  // Show Lock In button only when at least 1 player is selected
  const submitBtn = document.getElementById('btn-submit-votes');
  if (!hasSubmittedVotes) {
    submitBtn.style.display = count >= 1 ? 'block' : 'none';
  }
}

function handleSubmitVotes() {
  if (hasSubmittedVotes) return;
  hasSubmittedVotes = true;

  const submitBtn = document.getElementById('btn-submit-votes');
  submitBtn.disabled = true;
  submitBtn.textContent = '✓ Votes Locked In!';

  showToast(`Locked in ${selectedPlayerIds.size} vote${selectedPlayerIds.size === 1 ? '' : 's'}`);

  socket.emit('submit-votes', {
    gameId,
    votes: Array.from(selectedPlayerIds),
  });
}

// ─── Timer ───

function startTimer(durationMs) {
  clearInterval(timerInterval);
  const startTime = Date.now();
  const endTime = startTime + durationMs;

  const timerFill = document.getElementById('timer-fill');
  const timerSeconds = document.getElementById('timer-seconds');

  timerInterval = setInterval(() => {
    const remaining = Math.max(0, endTime - Date.now());
    const pct = (remaining / durationMs) * 100;
    const sec = Math.ceil(remaining / 1000);

    timerFill.style.width = `${pct}%`;
    timerSeconds.textContent = `${sec}s`;

    if (sec <= 5) {
      timerFill.classList.add('timer-bar__fill--danger');
    } else {
      timerFill.classList.remove('timer-bar__fill--danger');
    }

    if (remaining <= 0) {
      clearInterval(timerInterval);
      if (!hasSubmittedVotes) {
        // Auto-submit current selection
        handleSubmitVotes();
      }
    }
  }, 100);
}

function resetTimerDisplay() {
  const timerFill = document.getElementById('timer-fill');
  const timerSeconds = document.getElementById('timer-seconds');
  timerFill.style.width = '0%';
  timerFill.classList.remove('timer-bar__fill--danger');
  timerSeconds.textContent = '0s';
}

// ─── Reveal Processing ───

function applyRevealToCards(actualOwners, playerResults) {
  const ownersSet = new Set(actualOwners);
  const myResult = playerResults ? playerResults[user.id] : null;
  const myDetailsMap = new Map();

  if (myResult && myResult.details) {
    myResult.details.forEach(d => myDetailsMap.set(d.playerId, d.correct));
  }

  document.querySelectorAll('.vote-card').forEach(card => {
    const pid = card.dataset.playerId;
    const badge = document.getElementById(`result-badge-${pid}`);
    if (!badge) return;

    const hasSong = ownersSet.has(pid);
    const iVoted = selectedPlayerIds.has(pid);

    if (iVoted) {
      if (hasSong) {
        card.classList.add('correct');
        badge.textContent = '+3 Correct! 🎧';
        badge.className = 'vote-card__result vote-card__result--correct visible';
      } else {
        card.classList.add('wrong');
        badge.textContent = '-2 Wrong ❌';
        badge.className = 'vote-card__result vote-card__result--wrong visible';
      }
    } else if (hasSong) {
      card.classList.add('correct');
      badge.textContent = 'Missed! -1 🎧';
      badge.className = 'vote-card__result vote-card__result--owns visible';
    } else {
      badge.textContent = 'Doesn\'t have it';
      badge.className = 'vote-card__result visible';
      badge.style.opacity = '0.5';
    }
  });
}

function showRevealSummary(track, actualOwners, playerResults) {
  const card = document.getElementById('reveal-card');
  const ownersText = document.getElementById('reveal-owners-text');
  const scoreDelta = document.getElementById('reveal-score-delta');

  // Find owner names
  const ownerNames = currentPlayers
    .filter(p => actualOwners.includes(p.id))
    .map(p => p.displayName);

  ownersText.innerHTML = `Song: <strong>${escapeHtml(track.name)}</strong> by <em>${escapeHtml(track.artists)}</em><br>`
    + `In the library of: <strong style="color: var(--clr-spotify);">${ownerNames.join(', ') || 'Nobody?!'}</strong>`;

  const myRes = playerResults ? playerResults[user.id] : null;
  if (myRes) {
    const delta = myRes.roundScore;
    const deltaSign = delta > 0 ? `+${delta}` : `${delta}`;
    const color = delta > 0 ? 'var(--clr-green)' : delta < 0 ? 'var(--clr-red)' : 'var(--text-secondary)';

    let bonusHtml = '';
    if (myRes.speedBonus && myRes.speedBonus > 0) {
      bonusHtml = ` <span style="color: var(--clr-violet); font-size: 0.85rem;">⚡ +${myRes.speedBonus} speed bonus</span>`;
    }

    scoreDelta.innerHTML = `Your Round Score: <span style="color: ${color}; font-size: 1.1rem;">${deltaSign} pts</span>${bonusHtml} (Total: ${myRes.totalScore} pts)`;
  }

  card.classList.remove('hidden');
}

// ─── Scoreboard ───

function updateScoreboard(players, scores = {}) {
  const list = players.map(p => ({
    id: p.id,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
    online: p.online !== undefined ? p.online : true,
    score: scores[p.id] || 0,
  })).sort((a, b) => b.score - a.score);

  renderScoreboardList(list);
}

function renderScoreboardList(scoreboard, playerResults = null) {
  const container = document.getElementById('scoreboard-list');
  container.innerHTML = '';

  scoreboard.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'scoreboard__entry';
    if (entry.online === false) {
      row.classList.add('scoreboard__entry--offline');
    }

    const isMe = (entry.id === user.id);
    const result = playerResults ? playerResults[entry.id] : null;
    let deltaHtml = '';

    if (result && result.roundScore !== undefined) {
      const d = result.roundScore;
      if (d > 0) {
        deltaHtml = `<span class="scoreboard__delta scoreboard__delta--positive">+${d}</span>`;
      } else if (d < 0) {
        deltaHtml = `<span class="scoreboard__delta scoreboard__delta--negative">${d}</span>`;
      }
    }

    row.innerHTML = `
      <span class="scoreboard__rank">#${idx + 1}</span>
      <div class="player-avatar" style="width: 28px; height: 28px; font-size: 0.75rem;">
        ${entry.avatarUrl ? `<img src="${entry.avatarUrl}" alt="${entry.displayName}">` : entry.displayName.charAt(0).toUpperCase()}
      </div>
      <span class="scoreboard__name">${escapeHtml(entry.displayName)}${isMe ? ' <small style="color:var(--clr-violet)">(You)</small>' : ''}${entry.online === false ? ' <small style="color:var(--clr-red); font-size:0.7rem; font-weight:600;">(Offline)</small>' : ''}</span>
      ${deltaHtml}
      <span class="scoreboard__score">${entry.score}</span>
    `;

    container.appendChild(row);
  });
}

// ─── Winner Screen & Confetti ───

function showWinnerScreen(winner, scoreboard, reason = null, message = null) {
  const overlay = document.getElementById('winner-overlay');
  const crown = overlay.querySelector('.winner-crown');
  const banner = overlay.querySelector('.heading-lg');
  const winnerName = document.getElementById('winner-name');
  const winnerScore = document.getElementById('winner-score');

  if (reason === 'not_enough_players') {
    if (crown) crown.textContent = '👥';
    if (banner) banner.textContent = 'GAME ENDED';
    winnerName.textContent = 'Not Enough Players';
    winnerScore.textContent = message || 'A player left the game. Minimum 2 players required to play.';
  } else if (winner) {
    if (crown) crown.textContent = '👑';
    if (banner) banner.textContent = 'WINNER!';
    winnerName.textContent = winner.displayName;
    winnerScore.textContent = `Won with ${winner.score} points!`;
    launchConfetti();
  } else if (scoreboard && scoreboard.length > 0) {
    if (crown) crown.textContent = '👑';
    if (banner) banner.textContent = 'GAME OVER';
    winnerName.textContent = scoreboard[0].displayName;
    winnerScore.textContent = `Top of the board with ${scoreboard[0].score} points!`;
    launchConfetti();
  }

  overlay.classList.add('active');
}

// ─── Who Voted For Whom (shown at reveal) ───

/**
 * Render voter chips on each vote card during the reveal phase.
 * allVotes: { [voterId]: [votedForId, ...] }
 */
function showVotesOnCards(allVotes) {
  // Build inverted index: votedForId → [voterDisplayName, ...]
  const votedForMap = new Map(); // votedForId → Set<voterName>

  for (const [voterId, votedForIds] of Object.entries(allVotes)) {
    const voter = currentPlayers.find(p => p.id === voterId);
    const voterName = voter ? voter.displayName : '?';
    for (const votedForId of votedForIds) {
      if (!votedForMap.has(votedForId)) votedForMap.set(votedForId, []);
      votedForMap.get(votedForId).push(voterName);
    }
  }

  // Attach voter chips to each vote card
  document.querySelectorAll('.vote-card').forEach(card => {
    const pid = card.dataset.playerId;
    const voters = votedForMap.get(pid) || [];

    // Remove existing chips if any
    card.querySelectorAll('.vote-card__voters').forEach(el => el.remove());

    if (voters.length === 0) return;

    const chipsEl = document.createElement('div');
    chipsEl.className = 'vote-card__voters';
    chipsEl.title = `Voted by: ${voters.join(', ')}`;

    voters.forEach(name => {
      const chip = document.createElement('span');
      chip.className = 'voter-chip';
      chip.textContent = name.charAt(0).toUpperCase();
      chip.title = name;
      chipsEl.appendChild(chip);
    });

    card.appendChild(chipsEl);
  });
}

// ─── Mid-Game Device Selection ───

async function refreshGameDevices() {
  if (!user || !user.isPremium) return;
  const token = await getValidToken();
  if (!token) return;

  const select = document.getElementById('game-device-select');
  if (!select) return;

  const devices = await getAvailableDevices(token);
  const webDeviceId = getWebPlayerDeviceId();

  select.innerHTML = '';

  // Only show real Spotify Connect devices — skip the in-browser GOYGBIV player
  devices.forEach(d => {
    if (d.id !== webDeviceId) {
      const opt = document.createElement('option');
      opt.value = d.id;
      const icon = d.type === 'Smartphone' ? '📱' : d.type === 'Computer' ? '💻' : '🔊';
      opt.textContent = `${icon} ${d.name}`;
      select.appendChild(opt);
    }
  });

  if (select.options.length === 0) {
    select.innerHTML = '<option value="">No devices found — open Spotify on a device</option>';
  } else {
    if (activeDeviceId) {
      select.value = activeDeviceId;
    } else if (select.options[0]) {
      activeDeviceId = select.options[0].value;
    }
  }
}

async function handleGameDeviceChange() {
  const select = document.getElementById('game-device-select');
  const newDeviceId = select.value;
  if (!newDeviceId) return;

  activeDeviceId = newDeviceId;
  sessionStorage.setItem('selected_device_id', newDeviceId);

  // Notify server of device change
  if (socket) {
    socket.emit('update-device', { deviceId: newDeviceId });
  }

  // Transfer playback immediately
  const token = await getValidToken();
  if (token) {
    try {
      await fetch(`https://api.spotify.com/v1/me/player`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          device_ids: [newDeviceId],
          play: true,
        }),
      });
    } catch (err) {
      console.warn('[Game] Transfer error:', err);
    }
  }

  const deviceName = select.options[select.selectedIndex]?.textContent || 'Device';
  showToast(`Switched playback to ${deviceName}`);
}

function launchConfetti() {
  const container = document.getElementById('confetti');
  container.innerHTML = '';
  const colors = ['#ff3b5c', '#ff8c42', '#ffd166', '#06d6a0', '#118ab2', '#6c5ce7', '#a855f7'];

  for (let i = 0; i < 80; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = `${2 + Math.random() * 3}s`;
    piece.style.animationDelay = `${Math.random() * 1.5}s`;
    container.appendChild(piece);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 3000);
}

// ─── In-Game Emoji Reactions System ───

const EMOJI_CATEGORIES = {
  'Popular': [
    '🔥', '💀', '🎵', '🤯', '💃', '💩', '🤡', '🎸', '⚡', '👏', '🎉', '🗑️',
    '👑', '😱', '🕺', '🍿', '🎧', '🚀', '💔', '👀', '🎤', '🥳', '🍻', '❤️',
    '😭', '🤢', '💯', '🤔', '🏆', '🙌', '🎶', '🧊', '🗿', '✨', '🎯', '🤌',
    '🤐', '🤫', '😇', '🤠', '👽', '🤖', '👻', '💣', '💥'
  ],
  'Flags 🏁': [
    '🇵🇹', '🇧🇷', '🇪🇸', '🇬🇧', '🇺🇸', '🇫🇷', '🇩🇪', '🇮🇹', '🇯🇵', '🇰🇷', '🇨🇦', '🇦🇺',
    '🇲🇽', '🇦🇷', '🇨🇴', '🇨🇱', '🇵🇪', '🇳🇱', '🇧🇪', '🇨🇭', '🇸🇪', '🇳🇴', '🇩🇰', '🇫🇮',
    '🇮🇪', '🇵🇱', '🇬🇷', '🇹🇷', '🇦🇹', '🇨🇿', '🇺🇦', '🇷🇴', '🇭🇺', '🇳🇿', '🇿🇦', '🇳🇬',
    '🇪🇬', '🇲🇦', '🇦🇴', '🇲🇿', '🇨🇻', '🇮🇳', '🇵🇰', '🇨🇳', '🇮🇩', '🇵🇭', '🇻🇳', '🇹🇭',
    '🇲🇾', '🇸🇬', '🇸🇦', '🇦🇪', '🇮🇱', '🇯🇲', '🇨🇺', '🇩🇴', '🇺🇾', '🇻🇪', '🇮🇸', '🏁',
    '🚩', '🎌', '🏴‍☠️', '🏳️‍🌈', '🏳️‍⚧️', '🇪🇺', '🇺🇳'
  ],
  'Faces 😀': [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊',
    '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😋', '😛', '😜', '🤪', '😝',
    '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒',
    '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢',
    '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓',
    '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧',
    '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫',
    '🥱', '😤', '😡', '😠', '🤬', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻',
    '👽', '👾', '🤖'
  ],
  'Music 🎵': [
    '🎵', '🎶', '🎼', '🎧', '🎤', '🎙️', '🎚️', '🎛️', '📻', '🎸', '🎹', '🥁',
    '🎷', '🎺', '🎻', '🪕', '🪗', '🔊', '🔉', '🔈', '🔇', '🔔', '🔕', '📣',
    '📢', '💿', '📀', '📼'
  ],
  'Gestures 🤘': [
    '👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏',
    '✌️', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖',
    '👋', '💪', '🖕', '🤌', '👂', '👃', '🧠', '🫀', '🫁', '👁️', '👀', '👅',
    '👄', '💋'
  ],
  'Party 🎉': [
    '🔥', '⚡', '💥', '🌟', '✨', '💫', '🎈', '🎆', '🎇', '🧨', '🎉', '🎊',
    '🎃', '🎄', '🎀', '🎁', '🎫', '🎟️', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️',
    '⚽', '🏀', '🏈', '⚾', '🎾', '🎱', '🏓', '🎯', '🎮', '🕹️', '🎲', '🧩',
    '🎰', '🚗', '🏎️', '🚀', '🛸', '💎', '💣'
  ],
  'Food 🍕': [
    '🍻', '🍺', '🥂', '🍷', '🥃', '🍸', '🍹', '🍾', '🍶', '🧃', '🧉', '☕',
    '🍵', '🥤', '🍕', '🍔', '🍟', '🌭', '🍿', '🥓', '🥞', '🧀', '🥗', '🥪',
    '🌮', '🌯', '🍜', '🍣', '🍩', '🍪', '🎂', '🍰', '🧁', '🍦', '🍫', '🍬', '🍭'
  ],
  'Nature 🌿': [
    '🌿', '🌱', '🌲', '🌳', '🌴', '🌵', '🌾', '🍀', '☘️', '🍁', '🍂', '🍃',
    '🌸', '🌺', '🌹', '🌻', '🌼', '🌷', '🥀', '🪷', '💐', '🪴', '🍄', '🌰',
    '☀️', '🌞', '🌙', '🌕', '⭐', '🌟', '✨', '⚡', '☄️', '🪐', '🌈', '🌊',
    '💧', '❄️', '🌨️', '☃️', '⛈️', '🌩️', '🌧️', '🌦️', '☁️', '⛅', '🌤️', '💨',
    '🌪️', '🌫️', '🌋', '🗻', '🏔️', '⛰️', '🏕️', '🏜️', '🏝️', '🏞️', '🏖️', '🌅',
    '🌄', '🌌', '🪨', '🪵', '🔥', '🌍', '🌎', '🌏'
  ],
  'Animals 🐾': [
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮',
    '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗',
    '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦟', '🐢', '🐍', '🦎',
    '🦖', '🐙', '🦑', '🦀', '🐡', '🐠', '🐬', '🐳', '🦈', '🐊', '🐆', '🦓',
    '🦍', '🦧', '🐘', '🦛', '🦏', '🐪', '🦒', '🦘', '🦥', '🦦', '🦨', '🦔'
  ]
};

// Flattened list for search and random selection
const ALL_EMOJIS = Array.from(new Set(Object.values(EMOJI_CATEGORIES).flat()));

let activeReactions = ['🔥', '💀', '🎵', '🤯'];
let selectedCustomSlot = 0;
let currentEmojiCategory = 'Popular';

function initReactions() {
  try {
    const saved = localStorage.getItem('goygbiv_reactions');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length === 4) {
        activeReactions = parsed;
      }
    } else {
      const shuffled = [...EMOJI_CATEGORIES['Popular']].sort(() => 0.5 - Math.random());
      activeReactions = shuffled.slice(0, 4);
      localStorage.setItem('goygbiv_reactions', JSON.stringify(activeReactions));
    }
  } catch {
    activeReactions = ['🔥', '💀', '🎵', '🤯'];
  }

  renderReactionButtons();
  setupCustomizerModal();
}

function renderReactionButtons() {
  const container = document.getElementById('reaction-buttons-wrap');
  if (!container) return;
  container.innerHTML = '';

  activeReactions.forEach(emoji => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reaction-btn';
    btn.textContent = emoji;
    btn.title = `Tap for stream, hold 1s for MEGA ${emoji}`;

    let holdTimer = null;
    let isMegaSent = false;
    let holdStartTime = 0;

    function startHold(e) {
      isMegaSent = false;
      holdStartTime = Date.now();
      btn.classList.add('reaction-btn--charging');

      // 1-second hold threshold triggers MEGA reaction
      holdTimer = setTimeout(() => {
        isMegaSent = true;
        btn.classList.remove('reaction-btn--charging');
        btn.classList.add('reaction-btn--discharged');
        setTimeout(() => btn.classList.remove('reaction-btn--discharged'), 350);

        if (navigator.vibrate) {
          try { navigator.vibrate([60, 40, 90]); } catch {}
        }

        sendReaction(emoji, true);
      }, 1000);
    }

    function endHold(e) {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      btn.classList.remove('reaction-btn--charging');

      // If user released before the 1-second threshold, send normal stream reaction
      if (!isMegaSent && holdStartTime > 0 && Date.now() - holdStartTime < 1000) {
        sendReaction(emoji, false);
      }
      holdStartTime = 0;
      isMegaSent = false;
    }

    function cancelHold() {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      btn.classList.remove('reaction-btn--charging');
      holdStartTime = 0;
      isMegaSent = false;
    }

    // Pointer events handle both mouse and touch seamlessly
    btn.addEventListener('pointerdown', startHold);
    btn.addEventListener('pointerup', endHold);
    btn.addEventListener('pointerleave', cancelHold);
    btn.addEventListener('pointercancel', cancelHold);

    // Prevent context menu on long-press
    btn.addEventListener('contextmenu', (e) => e.preventDefault());

    container.appendChild(btn);
  });
}

function sendReaction(emoji, isMega = false) {
  if (socket) {
    socket.emit('send-reaction', { gameId, emoji, isMega });
  }
  if (isMega) {
    spawnMegaReaction(emoji);
  } else {
    spawnReactionParticles(emoji);
  }
}

function spawnMegaReaction(emoji) {
  const container = document.getElementById('mega-reaction-container');
  if (!container) return;

  const item = document.createElement('div');
  item.className = 'mega-emoji-item';

  // Shockwave radial pulse
  const shockwave = document.createElement('div');
  shockwave.className = 'mega-shockwave';
  item.appendChild(shockwave);

  // Massive emoji display
  const charEl = document.createElement('div');
  charEl.className = 'mega-emoji-char';
  charEl.textContent = emoji;
  item.appendChild(charEl);

  container.appendChild(item);

  // Accompanying burst particles
  spawnBurstParticles(emoji);

  // Clean up element after animation
  setTimeout(() => {
    item.remove();
  }, 2900);
}

function spawnBurstParticles(emoji) {
  const container = document.getElementById('reaction-particles-container');
  if (!container) return;

  for (let i = 0; i < 14; i++) {
    const p = document.createElement('span');
    p.className = 'reaction-particle';
    p.textContent = emoji;

    const left = Math.random() * 50 + 25; // center burst
    const size = Math.floor(Math.random() * 20 + 26);
    const drift = Math.floor(Math.random() * 240 - 120);
    const rot = Math.floor(Math.random() * 120 - 60);
    const duration = (Math.random() * 0.9 + 1.7).toFixed(2);
    const delay = (Math.random() * 0.25).toFixed(2);

    p.style.left = `${left}%`;
    p.style.fontSize = `${size}px`;
    p.style.setProperty('--drift', `${drift}px`);
    p.style.setProperty('--rot', `${rot}deg`);
    p.style.setProperty('--duration', `${duration}s`);
    p.style.animationDelay = `${delay}s`;

    container.appendChild(p);

    p.addEventListener('animationend', () => {
      p.remove();
    });
  }
}

function spawnReactionParticles(emoji) {
  const container = document.getElementById('reaction-particles-container');
  if (!container) return;

  const count = 18 + Math.floor(Math.random() * 8);

  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'reaction-particle';
    p.textContent = emoji;

    const left = Math.random() * 88 + 6;
    const size = Math.floor(Math.random() * 16 + 18);
    const drift = Math.floor(Math.random() * 140 - 70);
    const rot = Math.floor(Math.random() * 80 - 40);
    const duration = (Math.random() * 1.4 + 2.1).toFixed(2);
    const delay = (Math.random() * 0.45).toFixed(2);

    p.style.left = `${left}%`;
    p.style.fontSize = `${size}px`;
    p.style.setProperty('--drift', `${drift}px`);
    p.style.setProperty('--rot', `${rot}deg`);
    p.style.setProperty('--duration', `${duration}s`);
    p.style.animationDelay = `${delay}s`;

    container.appendChild(p);

    p.addEventListener('animationend', () => {
      p.remove();
    });
  }
}

function setupCustomizerModal() {
  const modal = document.getElementById('emoji-customizer-modal');
  const btnOpen = document.getElementById('btn-open-customize');
  const btnClose = document.getElementById('btn-close-customizer');
  const slotContainer = document.getElementById('reaction-slot-selector');
  const tabsContainer = document.getElementById('emoji-category-tabs');
  const searchInput = document.getElementById('emoji-search-input');
  const paletteContainer = document.getElementById('emoji-palette-grid');

  if (!modal || !btnOpen) return;

  btnOpen.addEventListener('click', () => {
    selectedCustomSlot = 0;
    currentEmojiCategory = 'Popular';
    if (searchInput) searchInput.value = '';
    renderCustomizerSlots();
    renderCategoryTabs();
    renderCustomizerPalette();
    modal.classList.remove('hidden');
  });

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (q) {
        // Search across all emojis
        const matches = ALL_EMOJIS.filter(em => em.includes(q));
        renderPaletteEmojis(matches);
      } else {
        renderCustomizerPalette();
      }
    });
  }

  function renderCategoryTabs() {
    if (!tabsContainer) return;
    tabsContainer.innerHTML = '';
    Object.keys(EMOJI_CATEGORIES).forEach(cat => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `emoji-category-tab ${cat === currentEmojiCategory ? 'active' : ''}`;
      tab.textContent = cat;
      tab.addEventListener('click', () => {
        currentEmojiCategory = cat;
        if (searchInput) searchInput.value = '';
        renderCategoryTabs();
        renderCustomizerPalette();
      });
      tabsContainer.appendChild(tab);
    });
  }

  function renderCustomizerSlots() {
    if (!slotContainer) return;
    slotContainer.innerHTML = '';
    activeReactions.forEach((emoji, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `reaction-slot-btn ${idx === selectedCustomSlot ? 'active' : ''}`;
      btn.textContent = emoji;
      btn.title = `Slot ${idx + 1}`;
      btn.addEventListener('click', () => {
        selectedCustomSlot = idx;
        renderCustomizerSlots();
      });
      slotContainer.appendChild(btn);
    });
  }

  function renderCustomizerPalette() {
    const list = EMOJI_CATEGORIES[currentEmojiCategory] || EMOJI_CATEGORIES['Popular'];
    renderPaletteEmojis(list);
  }

  function renderPaletteEmojis(emojis) {
    if (!paletteContainer) return;
    paletteContainer.innerHTML = '';

    if (emojis.length === 0) {
      paletteContainer.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: var(--space-md);">No emojis found</div>';
      return;
    }

    emojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-option-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        activeReactions[selectedCustomSlot] = emoji;
        try {
          localStorage.setItem('goygbiv_reactions', JSON.stringify(activeReactions));
        } catch {}
        renderReactionButtons();
        // Advance to next slot for easy 1-2-3-4 customization
        selectedCustomSlot = (selectedCustomSlot + 1) % 4;
        renderCustomizerSlots();
      });
      paletteContainer.appendChild(btn);
    });
  }
}
