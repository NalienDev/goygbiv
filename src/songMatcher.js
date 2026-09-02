// Song matching engine
// Collects songs from player libraries and finds shared tracks

const spotifyApi = require('./spotifyApi');

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
  }
  if (categories.includes('playlists')) {
    fetchers.push(spotifyApi.getUserPlaylistTracks(token));
  }
  if (categories.includes('albums')) {
    fetchers.push(spotifyApi.getUserSavedAlbumTracks(token));
  }

  const results = await Promise.all(fetchers);

  for (const tracks of results) {
    for (const track of tracks) {
      if (!trackMap.has(track.id)) {
        trackMap.set(track.id, track);
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
  return collectPlayerSongs(token, ['top', 'playlists', 'albums']);
}

/**
 * Build the song library for all players in a game
 * Source player songs are filtered by game categories
 * All player songs (for matching) include ALL categories
 *
 * @param {object[]} players - Array of { id, token, ... }
 * @param {string[]} categories - Host-selected categories
 * @returns {{ filteredLibraries: Map, fullLibraries: Map }}
 */
async function buildGameLibraries(players, categories) {
  const filteredLibraries = new Map(); // playerId → Map<trackId, track>
  const fullLibraries = new Map();     // playerId → Map<trackId, track>

  // Fetch in parallel per player (filtered + full)
  await Promise.all(players.map(async (player) => {
    try {
      const [filtered, full] = await Promise.all([
        collectPlayerSongs(player.token, categories),
        collectAllPlayerSongs(player.token),
      ]);
      filteredLibraries.set(player.id, filtered);
      fullLibraries.set(player.id, full);
      console.log(`[SongMatcher] ${player.displayName}: ${filtered.size} filtered, ${full.size} total tracks`);
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
 * 2. Pick a random song from their FILTERED library
 * 3. Check which OTHER players also have that song in their FULL library
 *
 * @param {object[]} players
 * @param {Map} filteredLibraries
 * @param {Map} fullLibraries
 * @param {Set} usedTrackIds - Tracks already used this game
 * @param {number} maxAttempts - Max retries to find a suitable song
 * @returns {{ track, sourcePlayerId, matchingPlayerIds[] } | null}
 */
function pickRoundSong(players, filteredLibraries, fullLibraries, usedTrackIds = new Set(), maxAttempts = 50) {
  // Shuffle player order for fairness
  const shuffledPlayers = [...players].sort(() => Math.random() - 0.5);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Pick a random source player
    const sourcePlayer = shuffledPlayers[attempt % shuffledPlayers.length];
    const sourceLibrary = filteredLibraries.get(sourcePlayer.id);

    if (!sourceLibrary || sourceLibrary.size === 0) continue;

    // Pick a random track from their filtered library
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

    // We need at least the source player to have it (they always do)
    // but also check that at least someone has it
    if (matchingPlayerIds.length > 0) {
      return {
        track,
        sourcePlayerId: sourcePlayer.id,
        matchingPlayerIds, // All players who have this song (including source)
      };
    }
  }

  return null; // Couldn't find a suitable song
}

module.exports = {
  collectPlayerSongs,
  collectAllPlayerSongs,
  buildGameLibraries,
  pickRoundSong,
};
