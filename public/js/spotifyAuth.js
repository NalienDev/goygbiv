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

// ─── Auth Flow ───

/**
 * Start the Spotify OAuth PKCE flow
 * Fetches an available Client ID from the server pool, then redirects
 */
async function startSpotifyAuth(returnPath = '/') {
  // Get a Client ID from the server pool
  const res = await fetch('/api/client-id');
  const { clientId, error } = await res.json();

  if (error || !clientId) {
    throw new Error(error || 'No Client ID available');
  }

  // Generate PKCE values
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Store in session for the callback
  sessionStorage.setItem('spotify_code_verifier', codeVerifier);
  sessionStorage.setItem('spotify_client_id', clientId);
  sessionStorage.setItem('spotify_return_path', returnPath);

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
