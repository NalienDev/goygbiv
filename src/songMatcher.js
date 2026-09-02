// Song matching engine
// Collects songs from player libraries and finds shared tracks

const spotifyApi = require('./spotifyApi');

/**
 * Collect songs from a player's library filtered by selected categories
 * @param {string} token - Spotify access token
 * @param {string[]} categories - Array of: 'top', 'playlists', 'albums'
 * @returns {Map<string, object>} Map of trackId → track object
 */
/**
 * Collect songs from a player's library filtered by selected categories
 * @param {string} token - Spotify access token
 * @param {string[]} categories - Array of: 'top', 'playlists', 'albums'
 * @returns {Map<string, object>} Map of trackId → track object
 */
async function collectPlayerSongs(token, categories) {
  const trackMap = new Map();
  const fetchers = [];

  if (categories.includes('top')) {
    fetchers.push(spotifyApi.getUserTopTracks(token));
    // Also include saved/liked songs as part of user favorites
    fetchers.push(spotifyApi.getUserSavedTracks(token));
  }
  if (categories.includes('playlists')) {
    fetchers.push(spotifyApi.getUserPlaylistTracks(token));
  }
  if (categories.includes('albums')) {
    fetchers.push(spotifyApi.getUserSavedAlbumTracks(token));
  }

  const results = await Promise.allSettled(fetchers);

  for (const res of results) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      for (const track of res.value) {
        if (track && track.id && !trackMap.has(track.id)) {
          trackMap.set(track.id, track);
        }
      }
    }
  }

  return trackMap;
}

/**
 * Collect ALL songs from a player's library (all categories, for matching)
 * @param {string} token - Spotify access token
 * @returns {Map<string, object>} Map of trackId → track object
 */
async function collectAllPlayerSongs(token) {
  const trackMap = new Map();

  const results = await Promise.allSettled([
    spotifyApi.getUserTopTracks(token),
    spotifyApi.getUserSavedTracks(token),
    spotifyApi.getUserPlaylistTracks(token),
    spotifyApi.getUserSavedAlbumTracks(token),
  ]);

  for (const res of results) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      for (const track of res.value) {
        if (track && track.id && !trackMap.has(track.id)) {
          trackMap.set(track.id, track);
        }
      }
    }
  }

  return trackMap;
}

/**
 * Build the song library for all players in a game
 */
async function buildGameLibraries(players, categories) {
  const filteredLibraries = new Map();
  const fullLibraries = new Map();

  await Promise.all(players.map(async (player) => {
    try {
      const [filtered, full] = await Promise.all([
        collectPlayerSongs(player.token, categories),
        collectAllPlayerSongs(player.token),
      ]);
      filteredLibraries.set(player.id, filtered);
      fullLibraries.set(player.id, full);
      console.log(`[SongMatcher] ${player.displayName}: ${filtered.size} filtered tracks, ${full.size} total tracks`);
    } catch (err) {
      console.error(`[SongMatcher] Failed to fetch library for ${player.displayName}:`, err.message);
      filteredLibraries.set(player.id, new Map());
      fullLibraries.set(player.id, new Map());
    }
  }));

  return { filteredLibraries, fullLibraries };
}

/**
 * Pick a random song for a round:
 * 1. Pick a random player
 * 2. Pick a random song from their FILTERED library (or fallback to FULL library)
 * 3. Check which OTHER players also have that song in their FULL library
 */
function pickRoundSong(players, filteredLibraries, fullLibraries, usedTrackIds = new Set(), maxAttempts = 50) {
  const shuffledPlayers = [...players].sort(() => Math.random() - 0.5);

  // Attempt 1: Pick from filtered libraries
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sourcePlayer = shuffledPlayers[attempt % shuffledPlayers.length];
    let sourceLibrary = filteredLibraries.get(sourcePlayer.id);

    // Fallback to full library if filtered is empty
    if (!sourceLibrary || sourceLibrary.size === 0) {
      sourceLibrary = fullLibraries.get(sourcePlayer.id);
    }

    if (!sourceLibrary || sourceLibrary.size === 0) continue;

    const trackIds = [...sourceLibrary.keys()].filter(id => !usedTrackIds.has(id));
    if (trackIds.length === 0) continue;

    const randomTrackId = trackIds[Math.floor(Math.random() * trackIds.length)];
    const track = sourceLibrary.get(randomTrackId);

    // Find which other players also have this track (checking FULL libraries)
    const matchingPlayerIds = [];
    for (const player of players) {
      const playerFullLibrary = fullLibraries.get(player.id);
      if (playerFullLibrary && playerFullLibrary.has(randomTrackId)) {
        matchingPlayerIds.push(player.id);
      }
    }

    if (!matchingPlayerIds.includes(sourcePlayer.id)) {
      matchingPlayerIds.push(sourcePlayer.id);
    }

    return {
      track,
      sourcePlayerId: sourcePlayer.id,
      matchingPlayerIds,
    };
  }

  // Attempt 2: Fallback across all full libraries if all else fails
  for (const player of shuffledPlayers) {
    const lib = fullLibraries.get(player.id);
    if (!lib || lib.size === 0) continue;
    const trackIds = [...lib.keys()].filter(id => !usedTrackIds.has(id));
    if (trackIds.length > 0) {
      const trackId = trackIds[Math.floor(Math.random() * trackIds.length)];
      const track = lib.get(trackId);
      return {
        track,
        sourcePlayerId: player.id,
        matchingPlayerIds: [player.id],
      };
    }
  }

  return null;
}

module.exports = {
  collectPlayerSongs,
  collectAllPlayerSongs,
  buildGameLibraries,
  pickRoundSong,
};
