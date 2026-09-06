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
 * Clean and normalize a song title:
 * - Strips accents/diacritics
 * - Removes featured artist patterns: (feat. X), (ft. X), (featuring X), (with X), - feat. X
 * - Removes version indicators: (remaster), (deluxe), (explicit), (clean), (single), (live), (bonus), (radio edit), (acoustic), etc.
 * - Strips punctuation and collapses whitespace
 */
function cleanSongTitle(title) {
  if (!title) return '';
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Remove (feat. ...), [feat. ...], (with ...), etc.
    .replace(/\s*[\(\[](?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+[\)\]]/gi, '')
    .replace(/\s*-\s*(?:feat\.?|ft\.?|featuring|with)\s+.*$/gi, '')
    // Remove version/remaster/edition/audio in brackets
    .replace(/\s*[\(\[](?:remaster(?:ed)?|deluxe|version|live|bonus|mono|stereo|anniversary|edit|radio|single|ep|explicit|clean|original(?:\s+mix)?|extended(?:\s+mix)?|acoustic|instrumental|album\s+version|recorded\s+at|official(?:\s+(?:audio|video|music\s+video|lyric\s+video))?|audio|visualizer|lyric\s+video).*?[\)\]]/gi, '')
    // Remove version/remaster/edition after hyphens
    .replace(/\s*-\s*.*?(?:remaster(?:ed)?|deluxe|bonus|live|radio|single|ep|explicit|clean|original(?:\s+mix)?|extended(?:\s+mix)?|acoustic|instrumental|album\s+version|anniversary|official(?:\s+(?:audio|video|music\s+video|lyric\s+video))?|audio|visualizer|lyric\s+video).*?$/gi, '')
    // Strip quotes and apostrophes so contractions (don't -> dont) stay intact
    .replace(/['’`"]/g, '')
    // Remove non-alphanumeric chars
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract all artist names from track.artists string and any featured artists in track title
 */
function extractArtists(track) {
  if (!track) return new Set();
  const artists = new Set();

  function addNormalized(name) {
    if (!name) return;
    const clean = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/^the\s+/, '')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length > 0) artists.add(clean);
  }

  // From track.artists
  if (track.artists) {
    const parts = track.artists.split(/[,&/]|(?:\s+(?:feat\.?|ft\.?|featuring|with|and)\s+)/i);
    parts.forEach(addNormalized);
  }

  // Check if track.name has featured artist mentioned
  if (track.name) {
    const featMatches = [
      ...track.name.matchAll(/[\(\[](?:feat\.?|ft\.?|featuring|with)\s+([^()\[\]]+)[\)\]]/gi),
      ...track.name.matchAll(/-\s*(?:feat\.?|ft\.?|featuring|with)\s+([^-\(\[]+)/gi)
    ];
    for (const m of featMatches) {
      if (m[1]) {
        m[1].split(/[,&/]|(?:\s+(?:and)\s+)/i).forEach(addNormalized);
      }
    }
  }

  return artists;
}

/**
 * Check if two tracks are the same song (handling different releases, remasters, explicit/clean, singles, etc.)
 */
function areTracksSameSong(t1, t2) {
  if (!t1 || !t2) return false;
  if (t1.id === t2.id) return true;

  const c1 = cleanSongTitle(t1.name);
  const c2 = cleanSongTitle(t2.name);
  if (!c1 || !c2) return false;

  // Compare titles
  const noSpace1 = c1.replace(/\s+/g, '');
  const noSpace2 = c2.replace(/\s+/g, '');

  let titleMatches = (noSpace1 === noSpace2);
  if (!titleMatches) {
    if ((noSpace1.startsWith(noSpace2) || noSpace2.startsWith(noSpace1)) && Math.abs(noSpace1.length - noSpace2.length) <= 5) {
      titleMatches = true;
    } else if (Math.min(noSpace1.length, noSpace2.length) >= 6 && (noSpace1.includes(noSpace2) || noSpace2.includes(noSpace1))) {
      titleMatches = true;
    }
  }

  if (!titleMatches) return false;

  // Title matches: verify they share at least one artist
  const a1 = extractArtists(t1);
  const a2 = extractArtists(t2);

  if (a1.size === 0 || a2.size === 0) return true;

  for (const artist of a1) {
    if (a2.has(artist)) return true;
    for (const otherArtist of a2) {
      if (artist === otherArtist || artist.includes(otherArtist) || otherArtist.includes(artist)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Create a normalized signature for a song to detect duplicates across
 * different album versions, remasters, or releases.
 */
function getSongSignature(track) {
  if (!track || !track.name) return '';
  const cleanTitle = cleanSongTitle(track.name).replace(/\s+/g, '');
  const artists = [...extractArtists(track)].sort().join(';');
  return `${cleanTitle}:::${artists}`;
}

/**
 * Check if a player has a track in their library (direct ID, saved album, or fuzzy title/artist match)
 */
function doesPlayerHaveTrack(track, playerFullLibrary, playerAlbumIds) {
  if (!track) return false;
  if (!playerFullLibrary || playerFullLibrary.size === 0) return false;

  // 1. Direct track ID
  if (playerFullLibrary.has(track.id)) return true;

  // 2. Saved album ID
  if (playerAlbumIds && track.albumId && playerAlbumIds.has(track.albumId)) return true;

  // 3. Robust comparison against tracks in library
  for (const t of playerFullLibrary.values()) {
    if (areTracksSameSong(track, t)) {
      return true;
    }
  }

  return false;
}

/**
 * Build the song library for all players in a game
 */
async function buildGameLibraries(players, categories) {
  const filteredLibraries = new Map();
  const fullLibraries = new Map();
  const savedAlbumIdsMap = new Map();
  const playlistSourcesMap = new Map(); // playerId → Map<trackId, playlistInfo>

  await Promise.all(players.map(async (player) => {
    try {
      const [filtered, full, albumIds, playlistSources] = await Promise.all([
        collectPlayerSongs(player.token, categories),
        collectAllPlayerSongs(player.token),
        spotifyApi.getUserSavedAlbumIds(player.token),
        spotifyApi.getUserPlaylistSources(player.token),
      ]);
      filteredLibraries.set(player.id, filtered);
      fullLibraries.set(player.id, full);
      savedAlbumIdsMap.set(player.id, albumIds);
      playlistSourcesMap.set(player.id, playlistSources);
      console.log(`[SongMatcher] ${player.displayName}: ${filtered.size} filtered tracks, ${full.size} total tracks, ${albumIds.size} saved albums, ${playlistSources.size} playlist-sourced tracks`);
    } catch (err) {
      console.error(`[SongMatcher] Failed to fetch library for ${player.displayName}:`, err.message);
      filteredLibraries.set(player.id, new Map());
      fullLibraries.set(player.id, new Map());
      savedAlbumIdsMap.set(player.id, new Set());
      playlistSourcesMap.set(player.id, new Map());
    }
  }));

  return { filteredLibraries, fullLibraries, savedAlbumIdsMap, playlistSourcesMap };
}

/**
 * Fisher-Yates array shuffle for uniform randomness
 */
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Order candidate source players:
 * - Deprioritizes lastSourcePlayerId (avoids back-to-back picks)
 * - Prioritizes players with lower pick counts in this game
 * - Breaks ties with a true Fisher-Yates shuffle
 */
function getPrioritizedSourcePlayers(players, lastSourcePlayerId = null, playerPickCounts = new Map()) {
  if (!players || players.length === 0) return [];
  if (players.length === 1) return [...players];

  const shuffled = shuffleArray(players);

  return shuffled.sort((a, b) => {
    // If one is the lastSourcePlayer, heavily deprioritize
    const aIsLast = (a.id === lastSourcePlayerId) ? 1 : 0;
    const bIsLast = (b.id === lastSourcePlayerId) ? 1 : 0;
    if (aIsLast !== bIsLast) return aIsLast - bIsLast;

    const countA = playerPickCounts.get(a.id) || 0;
    const countB = playerPickCounts.get(b.id) || 0;
    return countA - countB;
  });
}

/**
 * Pick a random song for a round:
 * 1. Pick a prioritized player (deprioritizing last source & prioritizing least-picked players)
 * 2. Pick a random song that hasn't been played in this game or session
 * 3. Check which players have that song
 */
function pickRoundSong(
  players,
  filteredLibraries,
  fullLibraries,
  savedAlbumIdsMap = new Map(),
  usedTrackIds = new Set(),
  usedSignatures = new Set(),
  lastSourcePlayerId = null,
  playerPickCounts = new Map(),
  maxAttempts = 120
) {
  if (!players || players.length === 0) return null;
  const candidatePlayers = getPrioritizedSourcePlayers(players, lastSourcePlayerId, playerPickCounts);

  function isTrackAlreadyUsed(track) {
    if (!track) return true;
    if (usedTrackIds.has(track.id)) return true;
    const sig = getSongSignature(track);
    if (sig && usedSignatures.has(sig)) return true;
    return false;
  }

  // Attempt 1: Pick from filtered libraries
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sourcePlayer = candidatePlayers[attempt % candidatePlayers.length];
    let sourceLibrary = filteredLibraries.get(sourcePlayer.id);

    if (!sourceLibrary || sourceLibrary.size === 0) {
      sourceLibrary = fullLibraries.get(sourcePlayer.id);
    }

    if (!sourceLibrary || sourceLibrary.size === 0) continue;

    const availableTracks = [...sourceLibrary.values()].filter(t => !isTrackAlreadyUsed(t));
    if (availableTracks.length === 0) continue;

    const track = availableTracks[Math.floor(Math.random() * availableTracks.length)];
    const trackSig = getSongSignature(track);

    const matchingPlayerIds = [];
    for (const player of players) {
      const playerFullLibrary = fullLibraries.get(player.id);
      const playerAlbums = savedAlbumIdsMap.get(player.id);

      if (doesPlayerHaveTrack(track, playerFullLibrary, playerAlbums)) {
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

  // Attempt 2: Fallback across full libraries
  for (const player of candidatePlayers) {
    const lib = fullLibraries.get(player.id);
    if (!lib || lib.size === 0) continue;

    const availableTracks = [...lib.values()].filter(t => !isTrackAlreadyUsed(t));
    if (availableTracks.length > 0) {
      const track = availableTracks[Math.floor(Math.random() * availableTracks.length)];
      const trackSig = getSongSignature(track);

      const matchingPlayerIds = [];
      for (const p of players) {
        const pLib = fullLibraries.get(p.id);
        const pAlbums = savedAlbumIdsMap.get(p.id);
        if (doesPlayerHaveTrack(track, pLib, pAlbums)) {
          matchingPlayerIds.push(p.id);
        }
      }

      if (!matchingPlayerIds.includes(player.id)) {
        matchingPlayerIds.push(player.id);
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

/**
 * Pick a secret "Shared Round" song that is guaranteed to be in 2+ players' libraries.
 * Looks identical to a regular round to players.
 */
function pickSharedRoundSong(
  players,
  filteredLibraries,
  fullLibraries,
  savedAlbumIdsMap = new Map(),
  usedTrackIds = new Set(),
  usedSignatures = new Set(),
  lastSourcePlayerId = null,
  playerPickCounts = new Map(),
  maxAttempts = 150
) {
  if (players.length < 2) return null;
  const candidatePlayers = getPrioritizedSourcePlayers(players, lastSourcePlayerId, playerPickCounts);

  function isTrackAlreadyUsed(track) {
    if (!track) return true;
    if (usedTrackIds.has(track.id)) return true;
    const sig = getSongSignature(track);
    if (sig && usedSignatures.has(sig)) return true;
    return false;
  }

  // Search across libraries for a track present in at least 2 players' libraries
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sourcePlayer = candidatePlayers[attempt % candidatePlayers.length];
    let sourceLibrary = filteredLibraries.get(sourcePlayer.id);

    if (!sourceLibrary || sourceLibrary.size === 0) {
      sourceLibrary = fullLibraries.get(sourcePlayer.id);
    }

    if (!sourceLibrary || sourceLibrary.size === 0) continue;

    const availableTracks = [...sourceLibrary.values()].filter(t => !isTrackAlreadyUsed(t));
    if (availableTracks.length === 0) continue;

    const track = availableTracks[Math.floor(Math.random() * availableTracks.length)];
    const trackSig = getSongSignature(track);

    const matchingPlayerIds = [];
    for (const player of players) {
      const playerFullLibrary = fullLibraries.get(player.id);
      const playerAlbums = savedAlbumIdsMap.get(player.id);

      if (doesPlayerHaveTrack(track, playerFullLibrary, playerAlbums)) {
        matchingPlayerIds.push(player.id);
      }
    }

    if (!matchingPlayerIds.includes(sourcePlayer.id)) {
      matchingPlayerIds.push(sourcePlayer.id);
    }

    // Must be shared by 2 or more players!
    if (matchingPlayerIds.length >= 2) {
      console.log(`[SongMatcher] Selected shared round song: "${track.name}" (${matchingPlayerIds.length} players share it)`);
      return {
        track,
        sourcePlayerId: sourcePlayer.id,
        matchingPlayerIds,
        signature: trackSig,
        isSharedRound: true,
      };
    }
  }

  console.log('[SongMatcher] Could not find guaranteed shared track in attempt limit, falling back to standard pick');
  return null;
}

module.exports = {
  collectPlayerSongs,
  collectAllPlayerSongs,
  buildGameLibraries,
  pickRoundSong,
  pickSharedRoundSong,
  getSongSignature,
  cleanSongTitle,
  extractArtists,
  areTracksSameSong,
  doesPlayerHaveTrack,
};
