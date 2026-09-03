// Spotify PKCE Authorization Flow
// Handles authentication with Client ID pool rotation

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

const SCOPES = [
  'user-top-read',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'streaming',
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-read-email',
  'user-read-private',
].join(' ');

// ─── PKCE Helpers ───

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, v => chars[v % chars.length]).join('');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(codeVerifier) {
  const hash = await sha256(codeVerifier);
  return base64urlEncode(hash);
}

/**
 * Start the Spotify OAuth PKCE flow
 * Checks for a previously used Client ID (localStorage) to avoid 403 errors
 * from Spotify's Development Mode per-app user limit.
 */
async function startSpotifyAuth(returnPath = '/') {
  let clientId = null;

  // 1. Check localStorage for a remembered Client ID from a previous session
  const savedClientId = localStorage.getItem('goygbiv_client_id');
  if (savedClientId) {
    clientId = savedClientId;
  }

  // 2. If we have a remembered Spotify user ID, ask the server in case the
  //    Client ID changed or localStorage was cleared but the server still knows
  if (!clientId) {
    const savedUser = localStorage.getItem('goygbiv_spotify_user_id');
    if (savedUser) {
      try {
        const lookupRes = await fetch(`/api/client-id?spotifyUserId=${encodeURIComponent(savedUser)}`);
        const lookupData = await lookupRes.json();
        if (lookupData.clientId) {
          clientId = lookupData.clientId;
        }
      } catch {
        // Fall through to fresh assignment
      }
    }
  }

  // 3. Fall back to requesting a fresh Client ID from the pool
  if (!clientId) {
    const res = await fetch('/api/client-id');
    const data = await res.json();
    if (data.error || !data.clientId) {
      throw new Error(data.error || 'No Client ID available');
    }
    clientId = data.clientId;
  }

  // Generate PKCE values
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Store in session for the callback
  sessionStorage.setItem('spotify_code_verifier', codeVerifier);
  sessionStorage.setItem('spotify_client_id', clientId);
  sessionStorage.setItem('spotify_return_path', returnPath);

  // Also persist in localStorage so it survives across sessions
  localStorage.setItem('goygbiv_client_id', clientId);

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: `${window.location.origin}/callback.html`,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    scope: SCOPES,
    show_dialog: 'false',
  });

  window.location.href = `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code for tokens (called on callback page)
 */
async function exchangeCodeForToken() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const error = urlParams.get('error');

  if (error) {
    throw new Error(`Spotify auth error: ${error}`);
  }

  if (!code) {
    throw new Error('No authorization code received');
  }

  const codeVerifier = sessionStorage.getItem('spotify_code_verifier');
  const clientId = sessionStorage.getItem('spotify_client_id');

  if (!codeVerifier || !clientId) {
    throw new Error('Missing PKCE session data. Please try logging in again.');
  }

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${window.location.origin}/callback.html`,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Token exchange failed: ${errBody}`);
  }

  const data = await response.json();

  // Store tokens
  const tokenData = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    clientId,
  };

  sessionStorage.setItem('spotify_tokens', JSON.stringify(tokenData));
  sessionStorage.removeItem('spotify_code_verifier');

  // Fetch user profile and register with server
  const profile = await fetchSpotifyApi('/me', tokenData.accessToken);
  sessionStorage.setItem('spotify_user', JSON.stringify({
    id: profile.id,
    displayName: profile.display_name || profile.id,
    email: profile.email,
    avatarUrl: (profile.images && profile.images.length > 0) ? profile.images[0].url : null,
    isPremium: profile.product === 'premium',
  }));

  // Persist the user→clientId mapping in localStorage so it survives across sessions.
  // This prevents 403 errors when the user returns and the server has restarted.
  localStorage.setItem('goygbiv_client_id', clientId);
  localStorage.setItem('goygbiv_spotify_user_id', profile.id);

  // Register this user against the Client ID pool
  await fetch('/api/register-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      spotifyUserId: profile.id,
    }),
  });

  return tokenData;
}

/**
 * Refresh the access token
 */
async function refreshAccessToken() {
  const tokens = getTokens();
  if (!tokens || !tokens.refreshToken) {
    throw new Error('No refresh token available');
  }

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
    }),
  });

  if (!response.ok) {
    // Refresh failed — need to re-authenticate
    clearAuthData();
    throw new Error('Token refresh failed');
  }

  const data = await response.json();

  const newTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + (data.expires_in * 1000),
    clientId: tokens.clientId,
  };

  sessionStorage.setItem('spotify_tokens', JSON.stringify(newTokens));
  return newTokens;
}

/**
 * Get a valid access token, refreshing if needed
 */
async function getValidToken() {
  let tokens = getTokens();
  if (!tokens) return null;

  // Refresh if within 5 minutes of expiry
  if (tokens.expiresAt - Date.now() < 300000) {
    try {
      tokens = await refreshAccessToken();
    } catch {
      return null;
    }
  }

  return tokens.accessToken;
}

// ─── Storage Helpers ───

function getTokens() {
  const raw = sessionStorage.getItem('spotify_tokens');
  return raw ? JSON.parse(raw) : null;
}

function getSpotifyUser() {
  const raw = sessionStorage.getItem('spotify_user');
  return raw ? JSON.parse(raw) : null;
}

function isAuthenticated() {
  return getTokens() !== null && getSpotifyUser() !== null;
}

/**
 * Re-register the user→clientId mapping with the server.
 * Call this on page load when the user is already authenticated to ensure
 * the server's in-memory clientIdUsage map is repopulated after a restart.
 */
async function ensureRegisteredWithServer() {
  const tokens = getTokens();
  const user = getSpotifyUser();
  if (!tokens || !tokens.clientId || !user || !user.id) return;

  try {
    await fetch('/api/register-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: tokens.clientId,
        spotifyUserId: user.id,
      }),
    });
  } catch {
    // Non-critical — server will learn about the mapping on next auth
  }
}

function clearAuthData() {
  sessionStorage.removeItem('spotify_tokens');
  sessionStorage.removeItem('spotify_user');
  sessionStorage.removeItem('spotify_code_verifier');
  sessionStorage.removeItem('spotify_client_id');
  sessionStorage.removeItem('spotify_return_path');
}

// ─── API Helper ───

async function fetchSpotifyApi(endpoint, token) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.spotify.com/v1${endpoint}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify API ${res.status}`);
  return res.json();
}
