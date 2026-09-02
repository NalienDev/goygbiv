// game.js — Client-side in-game mechanics and real-time multiplayer flow

let socket = null;
let gameId = null;
let user = null;
let currentRound = 0;
let selectedPlayerIds = new Set();
let hasSubmittedVotes = false;
let currentPlayers = [];
let timerInterval = null;
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
        if (!activeDeviceId) {
          activeDeviceId = deviceId;
        }
        document.getElementById('playback-status-text').textContent = 'Audio ready';
        if (socket) {
          socket.emit('update-device', { deviceId: activeDeviceId });
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
    }
  });
}

function setupGameSocketListeners() {
  // New round started
  socket.on('new-round', async (data) => {
    clearInterval(timerInterval);
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

  // Play track instruction from server
  socket.on('play-track', async (data) => {
    if (user.isPremium && data.uri) {
      const token = await getValidToken();
      if (token) {
        startSpotifyPlaybackDirect(token, data.uri, data.positionMs || 0);
      }
    }
  });

  // Voting phase opened
  socket.on('voting-phase', (data) => {
    document.getElementById('phase-title').textContent = 'Vote Now! 🗳️';
    document.getElementById('phase-subtitle').textContent = 'Select anyone you think has this song in their library!';

    currentPlayers = data.players || currentPlayers;
    renderVotingGrid(currentPlayers, true);

    const submitBtn = document.getElementById('btn-submit-votes');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Lock In Votes';

    // Start countdown timer
    startTimer(data.timeLimit || 15000);
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

  let revealCountdown = null;

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
        subTitle.textContent = 'Loading next round...';
      } else {
        subTitle.textContent = `Next round starts in ${secondsLeft}s...`;
      }
    }, 1000);

    const submitBtn = document.getElementById('btn-submit-votes');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Round Complete';

    // Update scoreboard
    if (data.scoreboard) {
      renderScoreboardList(data.scoreboard, data.playerResults);
    }

    // Reveal on player cards
    applyRevealToCards(data.actualOwners, data.playerResults);

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
    document.getElementById('phase-title').textContent = '⚠️ No Songs Found';
    document.getElementById('phase-subtitle').textContent = data.message || 'No playable tracks found';
    showToast(data.message || 'No songs found in libraries');
  });

  // Player left
  socket.on('player-left', (data) => {
    if (data.gameInfo) {
      currentPlayers = data.gameInfo.players;
      updateScoreboard(data.gameInfo.players, data.gameInfo.scores);
    }
  });
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

    if (selectedPlayerIds.has(p.id)) {
      card.classList.add('selected');
    }

    card.innerHTML = `
      <div class="vote-card__avatar">
        ${p.avatarUrl ? `<img src="${p.avatarUrl}" alt="${p.displayName}">` : p.displayName.charAt(0).toUpperCase()}
      </div>
      <div class="vote-card__name">${escapeHtml(p.displayName)}</div>
      <div class="vote-card__result" id="result-badge-${p.id}"></div>
    `;

    if (enableVoting && !hasSubmittedVotes) {
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
        badge.textContent = '+2 Correct! 🎧';
        badge.className = 'vote-card__result vote-card__result--correct visible';
      } else {
        card.classList.add('wrong');
        badge.textContent = '-1 Wrong ❌';
        badge.className = 'vote-card__result vote-card__result--wrong visible';
      }
    } else if (hasSong) {
      card.classList.add('correct');
      badge.textContent = 'Has it! 🎧';
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

    scoreDelta.innerHTML = `Your Round Score: <span style="color: ${color}; font-size: 1.1rem;">${deltaSign} pts</span> (Total: ${myRes.totalScore} pts)`;
  }

  card.classList.remove('hidden');
}

// ─── Scoreboard ───

function updateScoreboard(players, scores = {}) {
  const list = players.map(p => ({
    id: p.id,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
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
      <span class="scoreboard__name">${escapeHtml(entry.displayName)}${isMe ? ' <small style="color:var(--clr-violet)">(You)</small>' : ''}</span>
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

  if (webDeviceId) {
    const opt = document.createElement('option');
    opt.value = webDeviceId;
    opt.textContent = `🌐 In-Browser`;
    select.appendChild(opt);
  }

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
    select.innerHTML = '<option value="">No devices found</option>';
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
