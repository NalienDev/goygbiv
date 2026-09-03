// Spotify Web API wrapper — updated for 2026 API changes
// All functions take a user's access token and make requests on their behalf

const SPOTIFY_API = 'https://api.spotify.com/v1';

/**
 * Resilient Spotify API request with graceful error handling
 */
async function spotifyFetch(token, endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${SPOTIFY_API}${endpoint}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (res.status === 204) return null;
    if (res.status === 401) {
      console.warn(`[SpotifyApi] 401 Unauthorized for ${endpoint}`);
      return null;
    }
    if (res.status === 403) {
      console.warn(`[SpotifyApi] 403 Forbidden for ${endpoint}`);
      return null;
    }
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[SpotifyApi] HTTP ${res.status} on ${endpoint}: ${body.slice(0, 100)}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.warn(`[SpotifyApi] Network error for ${endpoint}:`, err.message);
    return null;
  }
}

/**
 * Paginate through results from a Spotify list endpoint
 */
async function paginateAll(token, endpoint, itemsKey = 'items', maxItems = 300) {
  const allItems = [];
  let url = endpoint.startsWith('http') ? endpoint : `${SPOTIFY_API}${endpoint}`;

  while (url && allItems.length < maxItems) {
    const data = await spotifyFetch(token, url);
    if (!data) break;

    const items = data[itemsKey] || data.items || [];
    allItems.push(...items);

    url = data.next;
  }

  return allItems.slice(0, maxItems);
}

// ─── User Profile ───

async function getUserProfile(token) {
  return spotifyFetch(token, '/me');
}

// ─── Top Tracks (Frequently Used) ───

async function getUserTopTracks(token) {
  const results = await Promise.allSettled([
    paginateAll(token, '/me/top/tracks?time_range=short_term&limit=50'),
    paginateAll(token, '/me/top/tracks?time_range=medium_term&limit=50'),
    paginateAll(token, '/me/top/tracks?time_range=long_term&limit=50'),
  ]);

  const seen = new Set();
  const tracks = [];

  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      for (const track of r.value) {
        if (track && track.id && !seen.has(track.id)) {
          seen.add(track.id);
          tracks.push(normalizeTrack(track));
        }
      }
    }
  }

  return tracks;
}

// ─── Liked Songs (Saved Tracks) ───

async function getUserSavedTracks(token) {
  try {
    const items = await paginateAll(token, '/me/tracks?limit=50', 'items', 150);
    return items
      .filter(item => item && item.track && item.track.id)
      .map(item => normalizeTrack(item.track));
  } catch (err) {
    console.warn('[SpotifyApi] /me/tracks error:', err.message);
    return [];
  }
}

// ─── User Playlists & Their Tracks ───

async function getUserPlaylistTracks(token) {
  const playlists = await paginateAll(token, '/me/playlists?limit=50');
  const allTracks = [];
  const seen = new Set();

  // Fetch tracks from each playlist in parallel (batched)
  const batchSize = 5;
  for (let i = 0; i < playlists.length; i += batchSize) {
    const batch = playlists.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (playlist) => {
        try {
          const items = await paginateAll(
            token,
            `/playlists/${playlist.id}/tracks?limit=100`,
            'items',
            200
          );
          return items
            .filter(item => item && item.track && item.track.id)
            .map(item => normalizeTrack(item.track));
        } catch {
          return [];
        }
      })
    );

    for (const tracks of results) {
      for (const track of tracks) {
        if (!seen.has(track.id)) {
          seen.add(track.id);
          allTracks.push(track);
        }
      }
    }
  }

  return allTracks;
}

// ─── Saved Albums & Their Tracks ───

async function getUserSavedAlbumTracks(token) {
  const savedAlbums = await paginateAll(token, '/me/albums?limit=50');
  const allTracks = [];
  const seen = new Set();

  const batchSize = 5;
  for (let i = 0; i < savedAlbums.length; i += batchSize) {
    const batch = savedAlbums.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (savedAlbum) => {
        try {
          const album = savedAlbum.album;
          if (!album || !album.id) return [];

          const items = await paginateAll(
            token,
            `/albums/${album.id}/tracks?limit=50`,
            'items',
            200
          );

          return items
            .filter(item => item && item.id)
            .map(item => normalizeTrack(item, album));
        } catch {
          return [];
        }
      })
    );

    for (const tracks of results) {
      for (const track of tracks) {
        if (!seen.has(track.id)) {
          seen.add(track.id);
          allTracks.push(track);
        }
      }
    }
  }

  return allTracks;
}

// ─── Track Details ───

async function getTrackDetails(token, trackId) {
  return spotifyFetch(token, `/tracks/${trackId}`);
}

// ─── Playback Control ───

async function startPlayback(token, trackUri, deviceId, positionMs = 0) {
  const query = deviceId ? `?device_id=${deviceId}` : '';
  return spotifyFetch(token, `/me/player/play${query}`, {
    method: 'PUT',
    body: JSON.stringify({
      uris: [trackUri],
      position_ms: positionMs,
    }),
  });
}

async function pausePlayback(token, deviceId) {
  const query = deviceId ? `?device_id=${deviceId}` : '';
  return spotifyFetch(token, `/me/player/pause${query}`, {
    method: 'PUT',
  });
}

async function getUserDevices(token) {
  const data = await spotifyFetch(token, '/me/player/devices');
  return data ? data.devices || [] : [];
}

async function transferPlayback(token, deviceId, play = false) {
  return spotifyFetch(token, '/me/player', {
    method: 'PUT',
    body: JSON.stringify({
      device_ids: [deviceId],
      play,
    }),
  });
}

// ─── User Saved Album IDs ───

async function getUserSavedAlbumIds(token) {
  try {
    const savedAlbums = await paginateAll(token, '/me/albums?limit=50', 'items', 100);
    const albumIds = new Set();
    for (const item of savedAlbums) {
      const alb = item ? (item.album || item) : null;
      if (alb && alb.id) {
        albumIds.add(alb.id);
      }
    }
    return albumIds;
  } catch (err) {
    console.warn('[SpotifyApi] /me/albums error:', err.message);
    return new Set();
  }
}

// ─── Helpers ───

/**
 * Normalize a track object to a consistent shape
 */
function normalizeTrack(track, albumOverride = null) {
  const album = albumOverride || track.album || {};
  return {
    id: track.id,
    uri: track.uri || `spotify:track:${track.id}`,
    name: track.name || 'Unknown Track',
    artists: (track.artists || []).map(a => a.name).join(', ') || 'Unknown Artist',
    album: album.name || 'Unknown Album',
    albumId: album.id || null,
    albumArt: (album.images && album.images.length > 0) ? album.images[0].url : null,
    albumArtSmall: (album.images && album.images.length > 1) ? album.images[album.images.length - 1].url : null,
    durationMs: track.duration_ms || 0,
  };
}

module.exports = {
  getUserProfile,
  getUserTopTracks,
  getUserSavedTracks,
  getUserPlaylistTracks,
  getUserSavedAlbumTracks,
  getUserSavedAlbumIds,
  getTrackDetails,
  startPlayback,
  pausePlayback,
  getUserDevices,
  transferPlayback,
  normalizeTrack,
};
