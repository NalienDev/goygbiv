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
 * Create a normalized signature for a song to detect duplicates across
 * different album versions, remasters, or releases.
 */
function getSongSignature(track) {
  if (!track || !track.name) return '';
  const cleanName = track.name
    .toLowerCase()
    .replace(/\s*[\(\[].*?(remaster|deluxe|version|live|bonus|mono|stereo|anniversary|edit|radio).*?[\)\]]/gi, '')
    .replace(/\s*-\s*.*?(remaster|deluxe|bonus|live|radio).*?$/gi, '')
    .trim();
  const cleanArtist = (track.artists || '').toLowerCase().split(',')[0].trim();
  return `${cleanName}:::${cleanArtist}`;
}

/**
 * Build the song library for all players in a game
 */
async function buildGameLibraries(players, categories) {
  const filteredLibraries = new Map();
  const fullLibraries = new Map();
  const savedAlbumIdsMap = new Map();

  await Promise.all(players.map(async (player) => {
    try {
      const [filtered, full, albumIds] = await Promise.all([
        collectPlayerSongs(player.token, categories),
        collectAllPlayerSongs(player.token),
        spotifyApi.getUserSavedAlbumIds(player.token),
      ]);
      filteredLibraries.set(player.id, filtered);
      fullLibraries.set(player.id, full);
      savedAlbumIdsMap.set(player.id, albumIds);
      console.log(`[SongMatcher] ${player.displayName}: ${filtered.size} filtered tracks, ${full.size} total tracks, ${albumIds.size} saved albums`);
    } catch (err) {
      console.error(`[SongMatcher] Failed to fetch library for ${player.displayName}:`, err.message);
      filteredLibraries.set(player.id, new Map());
      fullLibraries.set(player.id, new Map());
      savedAlbumIdsMap.set(player.id, new Set());
    }
  }));

  return { filteredLibraries, fullLibraries, savedAlbumIdsMap };
}

/**
 * Pick a random song for a round:
 * 1. Pick a random player
 * 2. Pick a random song that hasn't been played in this game (by track ID or song title/artist signature)
 * 3. Check which OTHER players have that song (by track ID, saved album, or matching title+artist)
 */
function pickRoundSong(
  players,
  filteredLibraries,
  fullLibraries,
  savedAlbumIdsMap = new Map(),
  usedTrackIds = new Set(),
  usedSignatures = new Set(),
  maxAttempts = 80
) {
  const shuffledPlayers = [...players].sort(() => Math.random() - 0.5);

  // Helper to check if a track has already been used in this game
  function isTrackAlreadyUsed(track) {
    if (!track) return true;
    if (usedTrackIds.has(track.id)) return true;
    const sig = getSongSignature(track);
    if (sig && usedSignatures.has(sig)) return true;
    return false;
  }

  // Attempt 1: Pick from filtered libraries
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sourcePlayer = shuffledPlayers[attempt % shuffledPlayers.length];
    let sourceLibrary = filteredLibraries.get(sourcePlayer.id);

    // Fallback to full library if filtered is empty
    if (!sourceLibrary || sourceLibrary.size === 0) {
      sourceLibrary = fullLibraries.get(sourcePlayer.id);
    }

    if (!sourceLibrary || sourceLibrary.size === 0) continue;

    const availableTracks = [...sourceLibrary.values()].filter(t => !isTrackAlreadyUsed(t));
    if (availableTracks.length === 0) continue;

    const track = availableTracks[Math.floor(Math.random() * availableTracks.length)];
    const trackSig = getSongSignature(track);

    // Find which players have this track:
    // - Direct track ID match
    // - OR the player has the entire album saved!
    // - OR player has matching title + artist
    const matchingPlayerIds = [];
    for (const player of players) {
      const playerFullLibrary = fullLibraries.get(player.id);
      const playerAlbums = savedAlbumIdsMap.get(player.id);

      let hasSong = false;

      // 1. Direct track ID in full library
      if (playerFullLibrary && playerFullLibrary.has(track.id)) {
        hasSong = true;
      }

      // 2. Saved album match (player saved the album this song belongs to)
      if (!hasSong && playerAlbums && track.albumId && playerAlbums.has(track.albumId)) {
        hasSong = true;
      }

      // 3. Name + primary artist match in player's library (different edition/remaster)
      if (!hasSong && playerFullLibrary && trackSig) {
        for (const t of playerFullLibrary.values()) {
          if (getSongSignature(t) === trackSig) {
            hasSong = true;
            break;
          }
        }
      }

      if (hasSong) {
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
      signature: trackSig,
    };
  }

  // Attempt 2: Fallback across all full libraries if filtered libraries exhausted
  for (const player of shuffledPlayers) {
    const lib = fullLibraries.get(player.id);
    if (!lib || lib.size === 0) continue;

    const availableTracks = [...lib.values()].filter(t => !isTrackAlreadyUsed(t));
    if (availableTracks.length > 0) {
      const track = availableTracks[Math.floor(Math.random() * availableTracks.length)];
      const trackSig = getSongSignature(track);

      const matchingPlayerIds = [player.id];
      for (const otherPlayer of players) {
        if (otherPlayer.id === player.id) continue;
        const otherLib = fullLibraries.get(otherPlayer.id);
        const otherAlbums = savedAlbumIdsMap.get(otherPlayer.id);

        let hasSong = false;
        if (otherLib && otherLib.has(track.id)) hasSong = true;
        if (!hasSong && otherAlbums && track.albumId && otherAlbums.has(track.albumId)) hasSong = true;
        if (!hasSong && otherLib && trackSig) {
          for (const t of otherLib.values()) {
            if (getSongSignature(t) === trackSig) {
              hasSong = true;
              break;
            }
          }
        }
        if (hasSong) matchingPlayerIds.push(otherPlayer.id);
      }

      return {
        track,
        sourcePlayerId: player.id,
        matchingPlayerIds,
        signature: trackSig,
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
  getSongSignature,
};
