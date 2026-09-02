// lobby.js — Manages lobby state, player list updates, and game launch

let socket = null;
let gameId = null;
let isHost = false;
let user = null;
let selectedDeviceId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  gameId = params.get('game') || sessionStorage.getItem('current_game_id');

  if (!gameId) {
    window.location.href = '/';
    return;
  }

  // Ensure authenticated
  if (!isAuthenticated()) {
    sessionStorage.setItem('pending_game', gameId);
    sessionStorage.setItem('spotify_return_path', `/lobby.html?game=${gameId}`);
    window.location.href = '/';
    return;
  }

  user = getSpotifyUser();
  const token = await getValidToken();

  // Setup user header badge
  document.getElementById('user-name').textContent = user.displayName || 'Player';
  const avatar = document.getElementById('user-avatar');
  if (user.avatarUrl) {
    avatar.innerHTML = `<img src="${user.avatarUrl}" alt="${user.displayName}">`;
  } else {
    avatar.textContent = (user.displayName || 'P').charAt(0).toUpperCase();
  }

  document.getElementById('room-code').textContent = gameId;

  // Build invite link
  const inviteUrl = `${window.location.origin}/lobby.html?game=${gameId}`;
  document.getElementById('invite-url-text').textContent = inviteUrl;

  // Premium indicator
  const premiumStatus = document.getElementById('premium-status');
  if (user.isPremium) {
    premiumStatus.textContent = '★ Premium account detected: Playback enabled';
    premiumStatus.style.color = 'var(--clr-spotify)';
    setupLobbyDevices(token);
  } else {
    premiumStatus.textContent = '⚠️ Free account: Audio playback disabled, but you can vote';
    premiumStatus.style.color = 'var(--clr-orange)';
    const select = document.getElementById('device-select');
    select.innerHTML = '<option value="">Audio disabled (Free Account)</option>';
  }

  // Connect socket
  socket = io();

  socket.on('connect', () => {
    console.log('[Lobby] Socket connected:', socket.id);
    joinLobby();
  });

  setupSocketListeners();
});

function joinLobby() {
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
    deviceId: selectedDeviceId,
    isPremium: user.isPremium,
  }, (res) => {
    if (res && res.success) {
      updateLobbyUI(res.gameInfo);
    } else {
      showToast('Could not join lobby: ' + (res ? res.error : 'Game not found'));
      setTimeout(() => { window.location.href = '/'; }, 2000);
    }
  });
}

function setupSocketListeners() {
  socket.on('player-joined', (data) => {
    if (data.gameInfo) {
      updateLobbyUI(data.gameInfo);
    }
    showToast(`${data.player.displayName} joined the lobby!`);
  });

  socket.on('player-left', (data) => {
    if (data.gameInfo) {
      updateLobbyUI(data.gameInfo);
    }
    showToast('A player left the lobby');
  });

  socket.on('game-loading', (data) => {
    const overlay = document.getElementById('loading-overlay');
    if (data && data.message) {
      document.getElementById('loading-overlay-text').textContent = data.message;
    }
    overlay.classList.add('active');
  });

  socket.on('game-started', (data) => {
    sessionStorage.setItem('current_game_id', gameId);
    if (selectedDeviceId) {
      sessionStorage.setItem('selected_device_id', selectedDeviceId);
    }
    window.location.href = `/game.html?game=${gameId}`;
  });
}

function updateLobbyUI(gameInfo) {
  if (!gameInfo) return;

  // Determine host status
  isHost = (gameInfo.hostId === user.id);
  sessionStorage.setItem('is_host', isHost ? 'true' : 'false');

  const hostControls = document.getElementById('host-controls');
  const guestControls = document.getElementById('guest-controls');

  if (isHost) {
    hostControls.classList.remove('hidden');
    guestControls.classList.add('hidden');
  } else {
    hostControls.classList.add('hidden');
    guestControls.classList.remove('hidden');
  }

  // Update game settings summary
  if (gameInfo.settings) {
    document.getElementById('pill-points').textContent = `🎯 Target: ${gameInfo.settings.pointsToWin} pts`;
    document.getElementById('pill-start').textContent = `⏳ Start: ${gameInfo.settings.songStart === 'middle' ? 'Middle (~40%)' : 'Beginning (0:00)'}`;
    const pillReveal = document.getElementById('pill-reveal');
    if (pillReveal) {
      pillReveal.textContent = `⏱️ Results: ${gameInfo.settings.revealDuration || 10}s`;
    }

    const catLabels = {
      top: 'Frequently Used',
      playlists: 'Playlists',
      albums: 'Saved Albums',
    };
    const cats = (gameInfo.settings.categories || []).map(c => catLabels[c] || c).join(', ');
    document.getElementById('pill-categories').textContent = `📂 Categories: ${cats}`;
  }

  // Update players list
  const playersList = document.getElementById('players-list');
  playersList.innerHTML = '';

  const players = gameInfo.players || [];
  document.getElementById('player-count-badge').textContent = `${players.length} Player${players.length === 1 ? '' : 's'} Connected`;

  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'player-card';

    const isThisHost = (p.id === gameInfo.hostId);
    const isMe = (p.id === user.id);

    card.innerHTML = `
      <div class="player-avatar">
        ${p.avatarUrl ? `<img src="${p.avatarUrl}" alt="${p.displayName}">` : p.displayName.charAt(0).toUpperCase()}
      </div>
      <div class="player-info">
        <div class="player-name">
          ${escapeHtml(p.displayName)} ${isMe ? '<span class="text-sm" style="color: var(--clr-violet);">(You)</span>' : ''}
        </div>
        <div class="flex-center gap-xs mt-xs" style="justify-content: flex-start;">
          ${isThisHost ? '<span class="player-badge player-badge--host">Host</span>' : ''}
          ${p.isPremium ? '<span class="player-badge player-badge--premium">Premium</span>' : '<span class="player-badge" style="background: rgba(255,255,255,0.06); color: var(--text-muted);">Free</span>'}
        </div>
      </div>
    `;

    playersList.appendChild(card);
  });

  // Host start game button state
  const startBtn = document.getElementById('start-game-btn');
  if (startBtn) {
    if (players.length >= 2) {
      startBtn.disabled = false;
      startBtn.textContent = `Start Game (${players.length} players ready)`;
    } else {
      startBtn.disabled = true;
      startBtn.textContent = `Start Game (Requires min 2 players — current: ${players.length})`;
    }
  }
}

async function setupLobbyDevices(token) {
  initSpotifyPlayer(
    async () => await getValidToken(),
    (deviceId) => {
      console.log('[Lobby] In-browser player ready:', deviceId);
      selectedDeviceId = deviceId;
      notifyDeviceUpdate(deviceId);
      refreshLobbyDevices();
    },
    (err) => {
      console.warn('[Lobby] In-browser player notice:', err.message);
      refreshLobbyDevices();
    }
  );

  await refreshLobbyDevices();
}

async function refreshLobbyDevices() {
  const token = await getValidToken();
  if (!token || !user.isPremium) return;

  const select = document.getElementById('device-select');
  const devices = await getAvailableDevices(token);
  const webDeviceId = getWebPlayerDeviceId();

  select.innerHTML = '';

  if (webDeviceId) {
    const opt = document.createElement('option');
    opt.value = webDeviceId;
    opt.textContent = `🌐 In-Browser Player (GOYGBIV)`;
    select.appendChild(opt);
  }

  devices.forEach(d => {
    if (d.id !== webDeviceId) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.type === 'Smartphone' ? '📱' : d.type === 'Computer' ? '💻' : '🔊'} ${d.name} (${d.type})`;
      select.appendChild(opt);
    }
  });

  if (select.options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No active Spotify devices found';
    select.appendChild(opt);
  } else {
    if (selectedDeviceId) select.value = selectedDeviceId;
    selectedDeviceId = select.value;
  }
}

function handleDeviceChange() {
  const select = document.getElementById('device-select');
  selectedDeviceId = select.value;
  notifyDeviceUpdate(selectedDeviceId);
}

function notifyDeviceUpdate(deviceId) {
  if (socket && deviceId) {
    socket.emit('update-device', { deviceId });
  }
}

function handleStartGame() {
  const startBtn = document.getElementById('start-game-btn');
  startBtn.disabled = true;
  startBtn.textContent = 'Starting Game...';

  document.getElementById('loading-overlay').classList.add('active');

  socket.emit('start-game', { gameId }, (res) => {
    if (!res || !res.success) {
      document.getElementById('loading-overlay').classList.remove('active');
      startBtn.disabled = false;
      startBtn.textContent = 'Start Game';
      showToast('Failed to start game: ' + (res ? res.error : 'Unknown error'));
    }
  });
}

function copyInviteUrl() {
  const url = `${window.location.origin}/lobby.html?game=${gameId}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copy-invite-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy Link'; }, 2000);
    showToast('Invite link copied to clipboard!');
  }).catch(() => {
    showToast('Failed to copy. Please copy manually.');
  });
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
