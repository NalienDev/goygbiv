// create.js — Handles game configuration and creation

let selectedSongStart = 'beginning';
let selectedPoints = 50;
let selectedCategories = ['top', 'playlists', 'albums'];
let selectedDeviceId = null;
let socket = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Check auth
  if (!isAuthenticated()) {
    sessionStorage.setItem('spotify_return_path', '/create.html');
    window.location.href = '/';
    return;
  }

  const user = getSpotifyUser();
  const token = await getValidToken();

  // Populate user badge
  document.getElementById('display-name').value = user.displayName || '';
  document.getElementById('user-name').textContent = user.displayName || 'Player';
  const avatar = document.getElementById('user-avatar');
  if (user.avatarUrl) {
    avatar.innerHTML = `<img src="${user.avatarUrl}" alt="${user.displayName}">`;
  } else {
    avatar.textContent = (user.displayName || 'P').charAt(0).toUpperCase();
  }

  if (!user.isPremium) {
    document.getElementById('premium-warning').classList.remove('hidden');
    document.getElementById('device-hint').textContent = 'Free account: Audio playback will be disabled on your side, but you can still host and vote.';
  }

  // Initialize Socket.io
  socket = io();

  // Init interactive UI components
  setupToggleGroups();
  setupCategoryCheckboxes();

  // Setup Spotify devices
  if (user.isPremium) {
    initWebPlayerAndDevices(token);
  } else {
    const select = document.getElementById('device-select');
    select.innerHTML = '<option value="">No playback (Free Account)</option>';
  }
});

function setupToggleGroups() {
  // Song start toggle
  const songStartGroup = document.getElementById('song-start-group');
  songStartGroup.querySelectorAll('.toggle-option').forEach(btn => {
    btn.addEventListener('click', () => {
      songStartGroup.querySelectorAll('.toggle-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSongStart = btn.dataset.value;
    });
  });

  // Points to win toggle
  const pointsGroup = document.getElementById('points-group');
  pointsGroup.querySelectorAll('.toggle-option').forEach(btn => {
    btn.addEventListener('click', () => {
      pointsGroup.querySelectorAll('.toggle-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPoints = parseInt(btn.dataset.value, 10);
    });
  });
}

function setupCategoryCheckboxes() {
  const cards = document.querySelectorAll('.checkbox-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      card.classList.toggle('checked');
      updateSelectedCategories();
    });
  });
}

function updateSelectedCategories() {
  const checked = document.querySelectorAll('.checkbox-card.checked');
  selectedCategories = Array.from(checked).map(c => c.dataset.category);
  const submitBtn = document.getElementById('btn-submit');
  if (selectedCategories.length === 0) {
    submitBtn.disabled = true;
    showToast('Please select at least one song category');
  } else {
    submitBtn.disabled = false;
  }
}

async function initWebPlayerAndDevices(token) {
  const select = document.getElementById('device-select');

  // Try initializing Web Playback SDK
  initSpotifyPlayer(
    async () => await getValidToken(),
    (deviceId) => {
      console.log('[Create] Web SDK device ready:', deviceId);
      selectedDeviceId = deviceId;
      refreshDevices();
    },
    (err) => {
      console.warn('[Create] Web SDK error:', err.message);
      refreshDevices();
    }
  );

  // Initial populate from Spotify Connect devices
  await refreshDevices();
}

async function refreshDevices() {
  const select = document.getElementById('device-select');
  const token = await getValidToken();
  if (!token) return;

  const devices = await getAvailableDevices(token);
  const webDeviceId = getWebPlayerDeviceId();

  select.innerHTML = '';

  if (webDeviceId) {
    const opt = document.createElement('option');
    opt.value = webDeviceId;
    opt.textContent = `🌐 This Browser (GOYGBIV Player)${selectedDeviceId === webDeviceId ? ' [Selected]' : ''}`;
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
    // Select first or previously selected
    if (selectedDeviceId) {
      select.value = selectedDeviceId;
    }
    selectedDeviceId = select.value;
  }

  select.onchange = () => {
    selectedDeviceId = select.value;
  };
}

async function handleCreateGame(e) {
  e.preventDefault();

  if (selectedCategories.length === 0) {
    showToast('Select at least one song category');
    return;
  }

  const displayName = document.getElementById('display-name').value.trim();
  if (!displayName) {
    showToast('Please enter your display name');
    return;
  }

  const user = getSpotifyUser();
  const token = await getValidToken();
  const submitBtn = document.getElementById('btn-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating Lobby...';

  // Save preferred display name in session
  user.displayName = displayName;
  sessionStorage.setItem('spotify_user', JSON.stringify(user));

  const payload = {
    playerId: user.id,
    displayName,
    spotifyId: user.id,
    avatarUrl: user.avatarUrl,
    token,
    deviceId: selectedDeviceId,
    isPremium: user.isPremium,
    songStart: selectedSongStart,
    categories: selectedCategories,
    pointsToWin: selectedPoints,
  };

  socket.emit('create-game', payload, (res) => {
    if (res && res.success) {
      sessionStorage.setItem('current_game_id', res.gameId);
      sessionStorage.setItem('is_host', 'true');
      window.location.href = `/lobby.html?game=${res.gameId}`;
    } else {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Lobby & Get Invite URL';
      showToast('Error creating game: ' + (res ? res.error : 'Unknown error'));
    }
  });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 3000);
}
