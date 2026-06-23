const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Quality/source tags that mark the end of an episode title in filenames
const QUALITY_TAGS = /\.(HEVC|WEB|BluRay|BDRip|DVDRip|ATVP|NORDiC|x26[45]|H\.26[45]|AAC|DDP[A5]?|DD[P+]|AC3|FLUX|GRACE|MeGusta|NoTrace|playWEB|YIFY|YTS|RARBG|\d{3,4}[pPiI])/i;

function parseMusicInfoFromPath(filePath, folderBasePath) {
  const relative = path.relative(folderBasePath, filePath);
  const parts = relative.split(path.sep).filter(p => p);
  let artistName = null;
  let albumName = null;
  if (parts.length >= 3) {
    artistName = parts[0];
    albumName = parts[1];
  } else if (parts.length === 2) {
    artistName = parts[0];
  }
  return { artistName, albumName };
}

function parseTVInfoFromPath(filePath, folderBasePath) {
  const relative = path.relative(folderBasePath, filePath);
  const parts = relative.split(path.sep).filter(p => p);
  const basename = path.basename(filePath, path.extname(filePath));

  let showName = null;
  let seasonNumber = null;
  let episodeNumber = null;
  let episodeTitle = null;

  // Derive show name and season from folder structure
  if (parts.length >= 3) {
    // FolderRoot/Show Name/Season N/file.mkv
    showName = parts[0];
    const seasonMatch = parts[1].match(/season\s*(\d+)/i);
    if (seasonMatch) seasonNumber = parseInt(seasonMatch[1], 10);
  } else if (parts.length === 2) {
    // FolderRoot/Show Name/file.mkv  (no season subfolder)
    showName = parts[0];
  }

  // Parse S01E03 or 1x03 from filename
  const sxeMatch = basename.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);
  const altMatch  = !sxeMatch && basename.match(/(\d{1,2})[xX](\d{1,2})/);
  const epMatch   = sxeMatch || altMatch;

  if (epMatch) {
    if (!seasonNumber) seasonNumber = parseInt(epMatch[1], 10);
    episodeNumber = parseInt(epMatch[2], 10);

    // Extract episode title: text after SxxExx up to first quality tag
    const afterCode = basename.slice(basename.search(/[Ss]\d{1,2}[Ee]\d{1,2}/) + epMatch[0].length);
    const tagIdx = afterCode.search(QUALITY_TAGS);
    const rawTitle = (tagIdx > 0 ? afterCode.slice(0, tagIdx) : afterCode)
      .replace(/^[.\s-]+/, '').replace(/[.\s-]+$/, '').replace(/\./g, ' ').trim();
    if (rawTitle.length > 2 && !/^\d+$/.test(rawTitle)) {
      episodeTitle = rawTitle;
    }
  }

  return { showName, seasonNumber, episodeNumber, episodeTitle };
}

let isScanning = false;
let scanProgress = {
  status: 'idle',
  totalFiles: 0,
  processedFiles: 0,
  added: 0,
  removed: 0,
  errors: []
};

// Supported file extensions
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac'];

// Clean up movie/tv titles from filenames
function cleanTitle(filename, type) {
  let name = path.parse(filename).name;
  if (type === 'movie' || type === 'tv') {
    // Strip common release group patterns
    name = name
      .replace(/\.(1080p|720p|2160p|480p|360p)\b.*/i, '')
      .replace(/\.(h264|x264|h265|x265|hevc)\b.*/i, '')
      .replace(/\b(bluray|brrip|web-dl|webrip|dvdrip|hdtv)\b.*/i, '')
      .replace(/[\.\-_]/g, ' ') // Replace dots, dashes, underscores with spaces
      .trim();
  }
  return name;
}

// Get MIME type based on extension
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.mkv': return 'video/x-matroska';
    case '.webm': return 'video/webm';
    case '.avi': return 'video/x-msvideo';
    case '.mov': return 'video/quicktime';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.m4a': return 'audio/mp4';
    case '.flac': return 'audio/flac';
    case '.ogg': return 'audio/ogg';
    case '.aac': return 'audio/aac';
    default: return 'application/octet-stream';
  }
}

// Recursive file finder
function getFilesRecursive(dir, allowedExtensions) {
  let results = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.resolve(dir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      continue; // Skip inaccessible files
    }

    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursive(filePath, allowedExtensions));
    } else {
      const ext = path.extname(filePath).toLowerCase();
      if (allowedExtensions.includes(ext)) {
        results.push({
          filePath,
          size: stat.size,
          mtime: stat.mtime.toISOString()
        });
      }
    }
  }
  return results;
}

// Perform scan
async function scanAll() {
  if (isScanning) return;
  isScanning = true;
  
  scanProgress = {
    status: 'scanning',
    totalFiles: 0,
    processedFiles: 0,
    added: 0,
    removed: 0,
    errors: []
  };

  console.log('Media scan started.');

  try {
    // 1. Get all configured folders
    const folders = await db.all('SELECT * FROM media_folders');
    const dbFiles = await db.all('SELECT id, filepath, size FROM media_items');
    
    // Track existing filepaths in database for cleanup and size checks
    const dbFilePathsMap = new Map(dbFiles.map(f => [f.filepath, { id: f.id, size: f.size }]));
    const foundFilePaths = new Set();

    // Dynamically import music-metadata (requires version <= 7.x or dynamic import for ESM/CommonJS compatibility)
    let musicMetadata;
    try {
      musicMetadata = require('music-metadata');
    } catch (e) {
      console.warn('Could not load music-metadata, fallback to filename parsing', e);
    }

    // 2. Scan folders
    for (const folder of folders) {
      const allowedExts = folder.type === 'music' ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
      console.log(`Scanning folder: ${folder.path} (${folder.type})`);
      
      const files = getFilesRecursive(folder.path, allowedExts);
      scanProgress.totalFiles += files.length;

      for (const fileInfo of files) {
        const filePath = fileInfo.filePath;
        foundFilePaths.add(filePath);
        scanProgress.processedFiles++;

        const dbItem = dbFilePathsMap.get(filePath);
        if (dbItem) {
          if (dbItem.size === fileInfo.size) {
            // File already registered with matching size, skip
            continue;
          }
          // Size changed (e.g. overwritten dummy file), remove old entry to re-index
          console.log(`Re-indexing changed file: ${filePath}`);
          await db.run('DELETE FROM media_items WHERE id = ?', [dbItem.id]);
        }

        // Parse file details
        const filename = path.basename(filePath);
        let title = cleanTitle(filename, folder.type);
        let duration = null;

        // Try extracting metadata if audio file
        let artistName = null, albumName = null, trackNumber = null;
        if (folder.type === 'music' && musicMetadata) {
          try {
            const metadata = await musicMetadata.parseFile(filePath);
            if (metadata.common.title) title = metadata.common.title;
            if (metadata.format.duration) duration = Math.round(metadata.format.duration);
            artistName = metadata.common.albumartist || metadata.common.artist || null;
            albumName = metadata.common.album || null;
            trackNumber = metadata.common.track?.no || null;
          } catch (err) {
            // Ignore metadata errors, use filename/path
          }
          // Fallback to folder structure if tags missing
          if (!artistName || !albumName) {
            const fromPath = parseMusicInfoFromPath(filePath, folder.path);
            if (!artistName) artistName = fromPath.artistName;
            if (!albumName) albumName = fromPath.albumName;
          }
        }

        // Parse TV hierarchy info
        let showName = null, seasonNumber = null, episodeNumber = null, episodeTitle = null;
        if (folder.type === 'tv') {
          ({ showName, seasonNumber, episodeNumber, episodeTitle } = parseTVInfoFromPath(filePath, folder.path));
          // Use parsed episode title as display title if available
          if (episodeTitle) title = episodeTitle;
        }

        // Insert new media item
        try {
          const mimeType = getMimeType(filePath);
          await db.run(
            `INSERT INTO media_items (folder_id, filepath, filename, title, type, mime_type, size, duration, created_at, show_name, season_number, episode_number, episode_title, artist_name, album_name, track_number)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [folder.id, filePath, filename, title, folder.type, mimeType, fileInfo.size, duration, fileInfo.mtime, showName, seasonNumber, episodeNumber, episodeTitle, artistName, albumName, trackNumber]
          );
          scanProgress.added++;
        } catch (err) {
          scanProgress.errors.push(`Failed to insert ${filename}: ${err.message}`);
        }
      }
    }

    // 3. Clean up deleted files from DB
    for (const [filePath, info] of dbFilePathsMap.entries()) {
      if (!foundFilePaths.has(filePath)) {
        try {
          await db.run('DELETE FROM media_items WHERE id = ?', [info.id]);
          scanProgress.removed++;
        } catch (err) {
          scanProgress.errors.push(`Failed to remove dead link ${filePath}: ${err.message}`);
        }
      }
    }

    scanProgress.status = 'completed';
    console.log(`Media scan completed. Added: ${scanProgress.added}, Removed: ${scanProgress.removed}`);
    
    // Generate thumbnails in the background so scan output returns instantly
    generateAllMissingThumbnails().catch(err => console.error('Thumbnail generation failed:', err));
  } catch (err) {
    scanProgress.status = 'error';
    scanProgress.errors.push(`Scan failed: ${err.message}`);
    console.error('Scan error:', err);
  } finally {
    isScanning = false;
  }
}

function getScanStatus() {
  return {
    isScanning,
    ...scanProgress
  };
}

// Fetch TMDB search + detail for a title; returns metadata object or null
async function fetchTMDbMeta(title, type) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  const yearMatch = title.match(/\((\d{4})\)/) || title.match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? yearMatch[1] : '';
  const cleanQuery = title.replace(/\(\d{4}\)/g, '').replace(/\b(19\d\d|20\d\d)\b/g, '').trim();
  const searchType = type === 'tv' ? 'tv' : 'movie';

  const searchUrl = new URL(`https://api.themoviedb.org/3/search/${searchType}`);
  searchUrl.searchParams.append('api_key', apiKey);
  searchUrl.searchParams.append('query', cleanQuery);
  if (year) searchUrl.searchParams.append(searchType === 'movie' ? 'primary_release_year' : 'first_air_date_year', year);

  const searchRes = await fetch(searchUrl.toString());
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  if (!searchData.results || searchData.results.length === 0) return null;

  const top = searchData.results[0];

  const detailRes = await fetch(`https://api.themoviedb.org/3/${searchType}/${top.id}?api_key=${apiKey}&append_to_response=credits,videos`);
  if (!detailRes.ok) return null;
  const detail = await detailRes.json();

  const trailer = (detail.videos?.results || [])
    .find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
    (detail.videos?.results || []).find(v => v.site === 'YouTube');

  return {
    tmdb_id: detail.id,
    title: detail.title || detail.name,
    tagline: detail.tagline || null,
    overview: detail.overview || null,
    release_date: detail.release_date || detail.first_air_date || null,
    runtime: detail.runtime || (detail.episode_run_time?.[0]) || null,
    vote_average: detail.vote_average ? Math.round(detail.vote_average * 10) / 10 : null,
    vote_count: detail.vote_count || null,
    genres: (detail.genres || []).map(g => g.name),
    director: (detail.credits?.crew || []).find(c => c.job === 'Director')?.name || null,
    cast: (detail.credits?.cast || []).slice(0, 5).map(c => c.name),
    tmdb_url: `https://www.themoviedb.org/${searchType}/${detail.id}`,
    poster_path: top.poster_path || null,
    trailer_key: trailer?.key || null,
  };
}

// Helper to download movie/show posters from TMDb
async function downloadTMDbPoster(title, type, thumbPath, metaCachePath, itemId) {
  try {
    const meta = await fetchTMDbMeta(title, type);
    if (!meta || !meta.poster_path) return false;

    const imageUrl = `https://image.tmdb.org/t/p/w342${meta.poster_path}`;
    console.log(`Downloading TMDb poster for "${title}": ${imageUrl}`);

    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) return false;

    fs.writeFileSync(thumbPath, Buffer.from(await imageRes.arrayBuffer()));

    // Save metadata JSON cache
    if (metaCachePath) {
      const { poster_path: _p, ...metaToSave } = meta;
      fs.writeFileSync(metaCachePath, JSON.stringify(metaToSave));
    }

    // Persist release_date, trailer_key, and tmdb_url to DB
    if (itemId) {
      if (meta.release_date) await db.run('UPDATE media_items SET release_date = ? WHERE id = ?', [meta.release_date, itemId]);
      if (meta.trailer_key) await db.run('UPDATE media_items SET trailer_key = ? WHERE id = ?', [meta.trailer_key, itemId]);
      if (meta.tmdb_url) await db.run('UPDATE media_items SET tmdb_url = ? WHERE id = ?', [meta.tmdb_url, itemId]);
    }

    return true;
  } catch (err) {
    console.error(`TMDb poster download failed for "${title}":`, err.message);
    return false;
  }
}

// Fetch and cache TMDB metadata for items that have a poster but no metadata JSON yet
async function generateAllMissingMetadata() {
  if (!process.env.TMDB_API_KEY) return;
  const items = await db.all('SELECT id, title, type FROM media_items WHERE type IN (\'movie\', \'tv\')');
  const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
  let fetched = 0;

  for (const item of items) {
    const metaPath = path.join(thumbsDir, `tmdb_meta_${item.id}.json`);
    if (fs.existsSync(metaPath)) continue; // already cached

    try {
      const meta = await fetchTMDbMeta(item.title, item.type);
      if (!meta) continue;

      const { poster_path: _p, ...metaToSave } = meta;
      fs.writeFileSync(metaPath, JSON.stringify(metaToSave));

      if (meta.release_date) {
        await db.run('UPDATE media_items SET release_date = ? WHERE id = ?', [meta.release_date, item.id]);
      }
      if (meta.tmdb_url) {
        await db.run('UPDATE media_items SET tmdb_url = ? WHERE id = ?', [meta.tmdb_url, item.id]);
      }
      fetched++;
    } catch (err) {
      console.error(`Metadata fetch failed for "${item.title}":`, err.message);
    }

    // Respect TMDB rate limit (~40 req/s to stay safe)
    await new Promise(r => setTimeout(r, 25));
  }

  if (fetched > 0) console.log(`Fetched TMDB metadata for ${fetched} items.`);
}

function tvShowPosterPath(thumbsDir, showName) {
  const hash = crypto.createHash('md5').update(showName || '').digest('hex');
  return path.join(thumbsDir, `tvshow_${hash}.jpg`);
}
// Background thumbnail generation for movies/shows and music album art
async function generateAllMissingThumbnails() {
  const items = await db.all('SELECT id, filepath, type, title, show_name FROM media_items');
  const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
  if (!fs.existsSync(thumbsDir)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  // Load music-metadata (CommonJS requires)
  let musicMetadata;
  try {
    musicMetadata = require('music-metadata');
  } catch (e) {
    console.error('Failed to load music-metadata for thumbnails:', e);
  }

  // Track which TV show posters have already been downloaded this run
  const tvShowsDone = new Set();

  for (const item of items) {
    const tmdbPath = path.join(thumbsDir, `tmdb_${item.id}.jpg`);
    const musicPath = path.join(thumbsDir, `music_${item.id}.jpg`);
    const ffmpegPath = path.join(thumbsDir, `ffmpeg_${item.id}.jpg`);
    const legacyPath = path.join(thumbsDir, `thumb_${item.id}.jpg`);

    if (item.type === 'tv') {
      const showPosterPath = tvShowPosterPath(thumbsDir, item.show_name);
      // Show poster already exists (from a prior run or custom upload) — nothing to do
      if (fs.existsSync(showPosterPath)) continue;
      // Already fetched this show during this run
      if (tvShowsDone.has(item.show_name)) continue;
      tvShowsDone.add(item.show_name);
      if (process.env.TMDB_API_KEY) {
        const metaCachePath = path.join(thumbsDir, `tmdb_meta_show_${crypto.createHash('md5').update(item.show_name || '').digest('hex')}.json`);
        await downloadTMDbPoster(item.show_name, 'tv', showPosterPath, metaCachePath, item.id);
      }
      continue;
    }

    // If we already have a TMDb poster or music album art, skip it entirely
    if (fs.existsSync(tmdbPath) || fs.existsSync(musicPath)) {
      continue;
    }

    if (item.type === 'movie') {
      // Try TMDb — only source for video posters
      if (process.env.TMDB_API_KEY) {
        const metaCachePath = path.join(thumbsDir, `tmdb_meta_${item.id}.json`);
        const success = await downloadTMDbPoster(item.title, item.type, tmdbPath, metaCachePath, item.id);
        if (success) {
          // Clean up any stale legacy files
          if (fs.existsSync(ffmpegPath)) fs.unlinkSync(ffmpegPath);
          if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
          continue;
        }
      }
      // No TMDb key or no match — no poster for this item

    } else if (item.type === 'music') {
      if (fs.existsSync(legacyPath)) {
        // Upgrade legacy to music format
        fs.renameSync(legacyPath, musicPath);
        continue;
      }
      if (fs.existsSync(musicPath)) {
        continue;
      }
      if (musicMetadata) {
        try {
          const metadata = await musicMetadata.parseFile(item.filepath);
          if (metadata.common.picture && metadata.common.picture.length > 0) {
            const pic = metadata.common.picture[0];
            console.log(`Extracting album art for item ${item.id}: ${item.filepath}`);
            fs.writeFileSync(musicPath, pic.data);
          }
        } catch (err) {
          console.error(`Failed to extract album art for ${item.filepath}: ${err.message}`);
        }
      }
    }
  }
}

// Scan only folders of a specific type (movie, tv, music)
async function scanByType(type) {
  if (isScanning) return;
  isScanning = true;

  scanProgress = { status: 'scanning', totalFiles: 0, processedFiles: 0, added: 0, removed: 0, errors: [] };
  console.log(`Auto-scan started for type: ${type}`);

  try {
    const folders = await db.all('SELECT * FROM media_folders WHERE type = ?', [type]);
    const dbFiles = await db.all('SELECT id, filepath, size FROM media_items WHERE type = ?', [type]);

    const dbFilePathsMap = new Map(dbFiles.map(f => [f.filepath, f.id]));
    const foundFilePaths = new Set();

    const allowedExtensions = type === 'music'
      ? ['.mp3', '.flac', '.aac', '.ogg', '.wav', '.m4a', '.opus']
      : ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.webm'];

    for (const folder of folders) {
      if (!fs.existsSync(folder.path)) continue;
      const files = getFilesRecursive(folder.path, allowedExtensions);
      scanProgress.totalFiles += files.length;

      for (const fileInfo of files) {
        const filePath = fileInfo.filePath;
        foundFilePaths.add(filePath);
        scanProgress.processedFiles++;

        if (dbFilePathsMap.has(filePath)) continue;

        const filename = path.basename(filePath);
        let title = path.parse(filename).name;
        let duration = null;

        let artistName = null, albumName = null, trackNumber = null;
        if (type === 'music') {
          try {
            const musicMetadata = require('music-metadata');
            const metadata = await musicMetadata.parseFile(filePath, { duration: true });
            if (metadata.common.title) title = metadata.common.title;
            if (metadata.format.duration) duration = Math.round(metadata.format.duration);
            artistName = metadata.common.albumartist || metadata.common.artist || null;
            albumName = metadata.common.album || null;
            trackNumber = metadata.common.track?.no || null;
          } catch {}
          if (!artistName || !albumName) {
            const fromPath = parseMusicInfoFromPath(filePath, folder.path);
            if (!artistName) artistName = fromPath.artistName;
            if (!albumName) albumName = fromPath.albumName;
          }
        }

        let showName = null, seasonNumber = null, episodeNumber = null, episodeTitle = null;
        if (type === 'tv') {
          ({ showName, seasonNumber, episodeNumber, episodeTitle } = parseTVInfoFromPath(filePath, folder.path));
          if (episodeTitle) title = episodeTitle;
        }

        try {
          const mimeType = getMimeType(filePath);
          await db.run(
            `INSERT INTO media_items (folder_id, filepath, filename, title, type, mime_type, size, duration, created_at, show_name, season_number, episode_number, episode_title, artist_name, album_name, track_number)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [folder.id, filePath, filename, title, folder.type, mimeType, fileInfo.size, duration, fileInfo.mtime, showName, seasonNumber, episodeNumber, episodeTitle, artistName, albumName, trackNumber]
          );
          scanProgress.added++;
        } catch (err) {
          scanProgress.errors.push(`Failed to insert ${filename}: ${err.message}`);
        }
      }
    }

    // Remove deleted files for this type
    for (const [filePath, id] of dbFilePathsMap.entries()) {
      if (!foundFilePaths.has(filePath)) {
        await db.run('DELETE FROM media_items WHERE id = ?', [id]).catch(() => {});
        scanProgress.removed++;
      }
    }

    scanProgress.status = 'completed';
    console.log(`Auto-scan (${type}) done. Added: ${scanProgress.added}, Removed: ${scanProgress.removed}`);
    generateAllMissingThumbnails().catch(() => {});
  } catch (err) {
    scanProgress.status = 'error';
    console.error(`Auto-scan (${type}) error:`, err.message);
  } finally {
    isScanning = false;
  }
}

module.exports = {
  scanAll,
  scanByType,
  getScanStatus,
  generateAllMissingThumbnails,
  generateAllMissingMetadata,
  parseTVInfoFromPath,
  parseMusicInfoFromPath,
  tvShowPosterPath
};
