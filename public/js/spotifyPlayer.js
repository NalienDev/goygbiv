// Spotify Web Playback SDK integration
// Initializes an in-browser Spotify Connect device for premium users

let spotifyPlayer = null;
let currentDeviceId = null;
let isPlayerReady = false;
let onDeviceReady = null; // callback when device is ready

/**
 * Initialize the Web Playback SDK player
 * @param {Function} getToken - async function returning a valid access token
 * @param {Function} onReady - callback(deviceId) when player is connected
 * @param {Function} onError - callback(error) on failure
 */
function initSpotifyPlayer(getToken, onReady, onError) {
  // Load the SDK script if not already loaded
  if (!window.Spotify) {
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    document.body.appendChild(script);
  }

  onDeviceReady = onReady;

  window.onSpotifyWebPlaybackSDKReady = async () => {
    const token = await getToken();
    if (!token) {
      if (onError) onError(new Error('No token available'));
      return;
    }

    spotifyPlayer = new window.Spotify.Player({
      name: 'GOYGBIV Game',
      getOAuthToken: async (cb) => {
        const freshToken = await getToken();
        cb(freshToken);
      },
      volume: 0.6,
    });

    // Ready
    spotifyPlayer.addListener('ready', ({ device_id }) => {
      console.log('[SpotifyPlayer] Ready with device:', device_id);
      currentDeviceId = device_id;
      isPlayerReady = true;
      if (onDeviceReady) onDeviceReady(device_id);
    });

    // Not ready
    spotifyPlayer.addListener('not_ready', ({ device_id }) => {
      console.log('[SpotifyPlayer] Device went offline:', device_id);
      isPlayerReady = false;
    });

    // Errors
    spotifyPlayer.addListener('initialization_error', ({ message }) => {
      console.error('[SpotifyPlayer] Init error:', message);
      if (onError) onError(new Error(message));
    });

    spotifyPlayer.addListener('authentication_error', ({ message }) => {
      console.error('[SpotifyPlayer] Auth error:', message);
      if (onError) onError(new Error(message));
    });

    spotifyPlayer.addListener('account_error', ({ message }) => {
      console.error('[SpotifyPlayer] Account error (premium required):', message);
      if (onError) onError(new Error('Spotify Premium is required for playback'));
    });

    spotifyPlayer.addListener('playback_error', ({ message }) => {
      console.error('[SpotifyPlayer] Playback error:', message);
    });

    // Connect
    const connected = await spotifyPlayer.connect();
    if (!connected) {
      console.error('[SpotifyPlayer] Failed to connect');
      if (onError) onError(new Error('Failed to connect to Spotify'));
    }
  };

  // If SDK is already loaded, trigger setup
  if (window.Spotify) {
    window.onSpotifyWebPlaybackSDKReady();
  }
}

/**
 * Play a track on the web player using the Spotify Web API
 */
async function playTrack(token, trackUri, positionMs = 0) {
  if (!currentDeviceId || !isPlayerReady) {
    console.warn('[SpotifyPlayer] Player not ready, skipping playback');
    return false;
  }

  try {
    const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${currentDeviceId}`, {
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

    if (res.status === 403) {
      console.warn('[SpotifyPlayer] Premium required for playback');
      return false;
    }

    return res.ok || res.status === 204;
  } catch (err) {
    console.error('[SpotifyPlayer] Playback error:', err);
    return false;
  }
}

/**
 * Pause playback
 */
async function pauseTrack(token) {
  if (!currentDeviceId || !isPlayerReady) return;

  try {
    await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${currentDeviceId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch (err) {
    console.error('[SpotifyPlayer] Pause error:', err);
  }
}

/**
 * Get the current device ID
 */
function getWebPlayerDeviceId() {
  return currentDeviceId;
}

/**
 * Check if the player is ready
 */
function isWebPlayerReady() {
  return isPlayerReady;
}

/**
 * Disconnect the player
 */
function disconnectPlayer() {
  if (spotifyPlayer) {
    spotifyPlayer.disconnect();
    spotifyPlayer = null;
    currentDeviceId = null;
    isPlayerReady = false;
  }
}

/**
 * Get available devices from Spotify (for users who prefer external device)
 */
async function getAvailableDevices(token) {
  try {
    const res = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.devices || [];
  } catch {
    return [];
  }
}
