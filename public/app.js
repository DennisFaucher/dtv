let currentType = '';
let searchQuery = '';
let searchTimeout = null;
let currentUser = null;
let activeMediaId = null;
let posterTargetId = null;
let posterMode = 'media'; // 'media' | 'tvshow'
let posterTVOldName = null;
let currentSort = 'release_date';
let currentOrder = 'desc';
let progressSaveInterval = null;
let subtitleOffset = 0;
let activeDuration = null;     // DB duration (seconds) for current media
let streamSeekOffset = 0;      // seconds already consumed by server-side ?seek= for transcoded streams
let customControlsKeyHandler = null;
let customControlsFsHandler = null;

const _lazyObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const img = entry.target;
      img.src = img.dataset.src;
      _lazyObserver.unobserve(img);
    }
  });
}, { rootMargin: '200px' });

function observeLazyImages(container) {
  container.querySelectorAll('img[data-src]').forEach(img => _lazyObserver.observe(img));
}
let activeHlsSession = null;   // { sessionId, hls (Hls instance), playlistUrl }
let activeVersion = 'original'; // 'original' | 'converted'
let conversionPollTimer = null; // setInterval handle for progress polling

// MilkDrop (Butterchurn) music visualizer state
let vizAudioCtx = null;             // shared AudioContext (reused across tracks)
let vizSourceMap = new WeakMap();   // <audio> element → MediaElementSourceNode (one allowed per element)
let vizVisualizer = null;           // active butterchurn visualizer instance
let vizRAF = null;                  // requestAnimationFrame handle for the render loop
let vizPresetTimer = null;          // setInterval handle that cycles presets
let vizPresetKeys = [];             // shuffled list of preset names
let vizPresetIndex = 0;
let vizResizeHandler = null;        // window/fullscreen resize listener
let vizCanvasEl = null;             // active canvas (its GL context is released on stop)

// TV Browse state
let tvLevel = 'shows'; // 'shows' | 'seasons' | 'episodes'
let tvCurrentShow = null;
let tvCurrentSeason = null;

// Music Browse state
let musicLevel = 'artists'; // 'artists' | 'albums' | 'tracks'
let musicCurrentArtist = null;
let musicCurrentAlbum = null;

// Playback queue (used by music album play-all / track-to-track navigation)
let mediaQueue = []; // [{id, type, title}, ...]
let queueIndex = -1;

function playFromQueue(items, startIndex) {
  mediaQueue = items.map(t => ({ id: t.id, type: t.type || 'music', title: t.title, artistName: t.artist_name || t.artistName || null, albumName: t.album_name || t.albumName || null }));
  queueIndex = startIndex;
  const item = mediaQueue[startIndex];
  playMedia(item.id, item.type, item.title, 0, item.artistName, item.albumName);
}

function playNext() {
  if (queueIndex < mediaQueue.length - 1) {
    queueIndex++;
    const item = mediaQueue[queueIndex];
    playMedia(item.id, item.type, item.title, 0, item.artistName, item.albumName);
  }
}

function playPrev() {
  if (queueIndex > 0) {
    queueIndex--;
    const item = mediaQueue[queueIndex];
    playMedia(item.id, item.type, item.title, 0, item.artistName, item.albumName);
  }
}

// Icons
const VIDEO_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;
const AUDIO_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path></svg>`;

// Auth Check & Setup
async function init() {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) {
      window.location.href = '/login.html';
      return;
    }
    
    currentUser = await response.json();
    document.getElementById('user-display').innerText = currentUser.email;
    
    if (currentUser.isAdmin) {
      document.getElementById('admin-link').style.display = 'inline-flex';
    }

    // Reflect default sort state in the UI controls
    document.getElementById('sort-select').value = currentSort;
    if (currentOrder === 'desc') {
      document.getElementById('sort-order-icon').innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9M3 12h5m10-4V18m0 0l-3-3m3 3l3-3"/>';
      document.getElementById('sort-order-btn').classList.add('active');
    }

    loadMedia();
    loadResumeList();
  } catch (err) {
    window.location.href = '/login.html';
  }
}

// Logout
async function handleLogout() {
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (response.ok) {
      window.location.href = '/login.html';
    }
  } catch (err) {
    alert('Failed to log out.');
  }
}

// TV Browse
function setTVBreadcrumb() {
  const bc = document.getElementById('tv-breadcrumb');
  const title = document.getElementById('view-title');
  if (!bc) return;

  if (currentType !== 'tv') {
    bc.style.display = 'none';
    title.style.display = '';
    return;
  }

  title.style.display = 'none';
  bc.style.display = 'flex';
  bc.innerHTML = '';

  const crumbs = [{ label: 'TV Shows', action: () => { tvLevel='shows'; tvCurrentShow=null; tvCurrentSeason=null; loadMedia(); } }];
  if (tvCurrentShow) crumbs.push({ label: tvCurrentShow, action: () => { tvLevel='seasons'; tvCurrentSeason=null; loadMedia(); } });
  if (tvCurrentSeason !== null) crumbs.push({ label: `Season ${tvCurrentSeason}`, action: null });

  crumbs.forEach((c, i) => {
    const span = document.createElement('span');
    if (i > 0) { const sep = document.createElement('span'); sep.className = 'tv-bc-sep'; sep.innerText = '›'; bc.appendChild(sep); }
    span.innerText = c.label;
    if (c.action) { span.className = 'tv-bc-link'; span.onclick = c.action; }
    else { span.className = 'tv-bc-current'; }
    bc.appendChild(span);
  });
}

async function loadTVShows() {
  const grid = document.getElementById('media-grid');
  const emptyState = document.getElementById('empty-state');
  grid.innerHTML = '<div class="tv-loading">Loading shows…</div>';
  emptyState.style.display = 'none';

  try {
    const tvParams = [];
    if (currentSort) tvParams.push(`sort=${currentSort}`);
    if (currentOrder === 'desc') tvParams.push(`order=desc`);
    const res = await fetch('/api/tv/shows' + (tvParams.length ? '?' + tvParams.join('&') : ''));
    const shows = await res.json();

    grid.innerHTML = '';
    if (shows.length === 0) { emptyState.style.display = 'block'; return; }

    shows.forEach(show => {
      const escapedName = show.show_name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const card = document.createElement('div');
      card.className = 'media-card tv';
      card.onclick = () => { tvLevel='seasons'; tvCurrentShow=show.show_name; loadMedia(); };
      card.innerHTML = `
        <div class="media-thumbnail-placeholder">
          <img data-src="/api/media/${show.poster_id}/thumbnail" alt="${escapedName}" class="media-thumb-img" id="thumb-tv-${show.poster_id}" onerror="this.style.display='none';">
          ${VIDEO_ICON}
          <div class="media-badge">TV</div>
          ${show.tmdb_url ? `<button class="trailer-btn" title="View on TMDB" onclick="openTrailer(event, '${show.tmdb_url}')">🎥</button>` : ''}
          <button class="poster-edit-btn" title="Edit title &amp; poster" onclick="openTVShowModal(event, ${show.poster_id}, '${escapedName}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
        <div class="media-info">
          <div class="media-title-row">
            <div class="media-title" id="title-tv-${show.poster_id}" title="${escapedName}">${show.show_name}</div>
            <button class="media-info-btn" title="TMDB info" onclick="openTmdbInfo(event, ${show.poster_id})">i</button>
          </div>
          <div class="media-meta"><span>${show.episode_count} episode${show.episode_count === 1 ? '' : 's'}</span></div>
        </div>`;
      grid.appendChild(card);
    });
    observeLazyImages(grid);
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

async function loadTVSeasons() {
  const grid = document.getElementById('media-grid');
  grid.innerHTML = '<div class="tv-loading">Loading seasons…</div>';

  try {
    const res = await fetch(`/api/tv/seasons?show=${encodeURIComponent(tvCurrentShow)}`);
    const seasons = await res.json();

    grid.innerHTML = '';
    seasons.forEach(s => {
      const card = document.createElement('div');
      card.className = 'tv-season-card';
      card.onclick = () => { tvLevel='episodes'; tvCurrentSeason=s.season_number; loadMedia(); };
      card.innerHTML = `
        <div class="tv-season-icon">${VIDEO_ICON}</div>
        <div class="tv-season-info">
          <div class="tv-season-name">Season ${s.season_number}</div>
          <div class="tv-season-count">${s.episode_count} episode${s.episode_count === 1 ? '' : 's'}</div>
        </div>
        <svg class="tv-season-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

async function loadTVEpisodes() {
  const grid = document.getElementById('media-grid');
  grid.innerHTML = '<div class="tv-loading">Loading episodes…</div>';

  try {
    const res = await fetch(`/api/tv/episodes?show=${encodeURIComponent(tvCurrentShow)}&season=${tvCurrentSeason}`);
    const episodes = await res.json();

    const table = document.createElement('table');
    table.className = 'ep-table';
    table.innerHTML = `
      <thead><tr>
        <th class="col-num">#</th>
        <th class="col-thumb"></th>
        <th>Title</th>
        <th class="col-dur">Duration</th>
        <th class="col-size">Size</th>
        <th class="col-play"></th>
      </tr></thead>
      <tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    episodes.forEach(ep => {
      const epNum = ep.episode_number ? String(ep.episode_number).padStart(2, '0') : '??';
      const dur = ep.duration ? formatDuration(ep.duration) : '—';
      const size = ep.size ? formatBytes(ep.size) : '—';
      const title = ep.episode_title || ep.title || `Episode ${epNum}`;
      const safeTitle = title.replace(/'/g, "\\'");
      const tr = document.createElement('tr');
      tr.onclick = () => playMedia(ep.id, 'tv', title);
      tr.innerHTML = `
        <td class="col-num">E${epNum}</td>
        <td class="col-thumb"><img src="/api/media/${ep.id}/thumbnail" class="ep-thumb-img" onerror="this.style.display='none'"></td>
        <td class="col-title"><div class="ep-title">${title}</div><div class="ep-overview" id="ep-ov-${ep.id}"></div></td>
        <td class="col-dur">${dur}</td>
        <td class="col-size">${size}</td>
        <td class="col-play">
          <button class="btn btn-primary btn-sm ep-play-btn" onclick="event.stopPropagation(); playMedia(${ep.id}, 'tv', '${safeTitle}')">
            <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><circle cx="12" cy="12" r="10" stroke-width="2"/></svg>
            Play
          </button>
        </td>`;
      tbody.appendChild(tr);
    });

    grid.innerHTML = '';
    grid.appendChild(table);

    // Fetch episode summaries in the background (non-blocking)
    episodes.forEach(ep => {
      fetch(`/api/media/${ep.id}/episode-summary`)
        .then(r => r.json())
        .then(data => {
          if (data.overview) {
            const el = document.getElementById(`ep-ov-${ep.id}`);
            if (el) el.textContent = data.overview;
          }
        })
        .catch(() => {});
    });
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

// Music breadcrumb
function setMusicBreadcrumb() {
  const bc = document.getElementById('tv-breadcrumb');
  const title = document.getElementById('view-title');
  if (!bc) return;

  if (currentType !== 'music') {
    bc.style.display = 'none';
    title.style.display = '';
    return;
  }

  title.style.display = 'none';
  bc.style.display = 'flex';
  bc.innerHTML = '';

  const crumbs = [{ label: 'Music', action: () => { musicLevel='artists'; musicCurrentArtist=null; musicCurrentAlbum=null; loadMedia(); } }];
  if (musicCurrentArtist) crumbs.push({ label: musicCurrentArtist, action: () => { musicLevel='albums'; musicCurrentAlbum=null; loadMedia(); } });
  if (musicCurrentAlbum) crumbs.push({ label: musicCurrentAlbum, action: null });

  crumbs.forEach((c, i) => {
    const span = document.createElement('span');
    if (i > 0) { const sep = document.createElement('span'); sep.className = 'tv-bc-sep'; sep.innerText = '›'; bc.appendChild(sep); }
    span.innerText = c.label;
    if (c.action) { span.className = 'tv-bc-link'; span.onclick = c.action; }
    else { span.className = 'tv-bc-current'; }
    bc.appendChild(span);
  });
}

async function loadMusicArtists() {
  const grid = document.getElementById('media-grid');
  const emptyState = document.getElementById('empty-state');
  grid.innerHTML = '<div class="tv-loading">Loading artists…</div>';
  emptyState.style.display = 'none';

  try {
    const res = await fetch('/api/music/artists');
    const artists = await res.json();
    grid.innerHTML = '';
    if (artists.length === 0) { emptyState.style.display = 'block'; return; }

    artists.forEach(a => {
      const card = document.createElement('div');
      card.className = 'media-card music';
      card.onclick = () => { musicLevel='albums'; musicCurrentArtist=a.artist_name; loadMedia(); };
      const escapedName = a.artist_name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const encodedName = encodeURIComponent(a.artist_name);
      card.innerHTML = `
        <div class="media-thumbnail-placeholder">
          <img data-src="/api/music/artist-poster/${encodedName}" alt="" class="media-thumb-img" id="thumb-artist-${encodedName}" onerror="this.style.display='none';">
          ${AUDIO_ICON}
          <button class="poster-edit-btn" title="Edit poster" onclick="openArtistPosterModal(event, '${escapedName}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
        <div class="media-info">
          <div class="media-title" title="${a.artist_name}">${a.artist_name}</div>
          <div class="media-meta"><span>${a.album_count} album${a.album_count === 1 ? '' : 's'} · ${a.track_count} tracks</span></div>
        </div>`;
      grid.appendChild(card);
    });
    observeLazyImages(grid);
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

async function loadMusicAlbums() {
  const grid = document.getElementById('media-grid');
  grid.innerHTML = '<div class="tv-loading">Loading albums…</div>';

  try {
    const res = await fetch(`/api/music/albums?artist=${encodeURIComponent(musicCurrentArtist)}`);
    const albums = await res.json();
    grid.innerHTML = '';

    albums.forEach(a => {
      const card = document.createElement('div');
      card.className = 'media-card music';
      card.onclick = () => { musicLevel='tracks'; musicCurrentAlbum=a.album_name; loadMedia(); };
      const escapedAlbum = a.album_name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      card.innerHTML = `
        <div class="media-thumbnail-placeholder">
          <img data-src="/api/media/${a.poster_id}/thumbnail" alt="" class="media-thumb-img" id="thumb-music-${a.poster_id}" onerror="this.style.display='none';">
          ${AUDIO_ICON}
          <button class="poster-edit-btn" title="Edit poster" onclick="openMusicPosterModal(event, ${a.poster_id}, '${escapedAlbum}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
        <div class="media-info">
          <div class="media-title" title="${a.album_name}">${a.album_name}</div>
          <div class="media-meta"><span>${a.track_count} track${a.track_count === 1 ? '' : 's'}</span></div>
        </div>`;
      grid.appendChild(card);
    });
    observeLazyImages(grid);
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

async function loadMusicTracks() {
  const grid = document.getElementById('media-grid');
  grid.innerHTML = '<div class="tv-loading">Loading tracks…</div>';

  try {
    const res = await fetch(`/api/music/tracks?artist=${encodeURIComponent(musicCurrentArtist)}&album=${encodeURIComponent(musicCurrentAlbum)}`);
    const tracks = await res.json();

    // "Play All" header button
    const header = document.createElement('div');
    header.className = 'ep-table-header';
    header.innerHTML = `
      <button class="btn btn-primary btn-sm ep-play-btn" id="btn-play-all">
        <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><circle cx="12" cy="12" r="10" stroke-width="2"/></svg>
        Play All
      </button>`;

    const table = document.createElement('table');
    table.className = 'ep-table';
    table.innerHTML = `
      <thead><tr>
        <th class="col-num">#</th>
        <th>Title</th>
        <th class="col-dur">Duration</th>
        <th class="col-play"></th>
      </tr></thead>
      <tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    tracks.forEach((track, idx) => {
      const num = track.track_number || (idx + 1);
      const dur = track.duration ? formatDuration(track.duration) : '—';
      const safeTitle = track.title.replace(/'/g, "\\'");
      const tr = document.createElement('tr');
      tr.onclick = () => playFromQueue(tracks, idx);
      tr.innerHTML = `
        <td class="col-num">${String(num).padStart(2, '0')}</td>
        <td class="col-title"><div class="ep-title">${track.title}</div></td>
        <td class="col-dur">${dur}</td>
        <td class="col-play">
          <button class="btn btn-primary btn-sm ep-play-btn music-play-row-btn">
            <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><circle cx="12" cy="12" r="10" stroke-width="2"/></svg>
            Play
          </button>
        </td>`;
      tr.querySelector('.music-play-row-btn').addEventListener('click', e => { e.stopPropagation(); playFromQueue(tracks, idx); });
      tbody.appendChild(tr);
    });

    grid.innerHTML = '';
    grid.appendChild(header);
    grid.appendChild(table);
    document.getElementById('btn-play-all').addEventListener('click', () => playFromQueue(tracks, 0));
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

// Fetch and Render Media
async function loadMedia() {
  setTVBreadcrumb();
  setMusicBreadcrumb();

  // TV uses its own hierarchical browser
  if (currentType === 'tv') {
    const _tvSortCtrl = document.getElementById('sort-controls');
    if (_tvSortCtrl) _tvSortCtrl.style.display = tvLevel === 'shows' ? 'flex' : 'none';
    if (tvLevel === 'shows')   return loadTVShows();
    if (tvLevel === 'seasons') return loadTVSeasons();
    if (tvLevel === 'episodes') return loadTVEpisodes();
  }

  // Music uses its own hierarchical browser
  if (currentType === 'music') {
    document.getElementById('sort-controls')?.style && (document.getElementById('sort-controls').style.display = 'none');
    if (musicLevel === 'artists') return loadMusicArtists();
    if (musicLevel === 'albums')  return loadMusicAlbums();
    if (musicLevel === 'tracks')  return loadMusicTracks();
  }

  if (currentType !== 'tv' && currentType !== 'music') {
    document.getElementById('sort-controls')?.style && (document.getElementById('sort-controls').style.display = 'flex');
  }

  const grid = document.getElementById('media-grid');
  const emptyState = document.getElementById('empty-state');
  grid.innerHTML = '';
  emptyState.style.display = 'none';

  let url = '/api/media';
  const params = [];
  if (currentType) params.push(`type=${currentType}`);
  if (searchQuery) params.push(`search=${encodeURIComponent(searchQuery)}`);
  
  if (currentSort) params.push(`sort=${currentSort}`);
  if (currentOrder === 'desc') params.push(`order=desc`);

  if (params.length > 0) {
    url += '?' + params.join('&');
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch media');
    const items = await response.json();

    if (items.length === 0) {
      emptyState.style.display = 'block';
      return;
    }

    items.forEach(item => {
      const card = document.createElement('div');
      card.className = `media-card ${item.type}`;
      card.onclick = () => playMedia(item.id, item.type, item.title, 0, item.artist_name || null, item.album_name || null);

      const isMusic = item.type === 'music';
      const durationStr = item.duration ? formatDuration(item.duration) : '';

      // For TV items, build a display label: "Show Name — S01E03" as subtitle when show_name is available
      let displayTitle = item.title;
      let tvSubLabel = '';
      if (item.type === 'tv' && item.show_name) {
        const ep = item.episode_number ? String(item.episode_number).padStart(2, '0') : null;
        const se = item.season_number  ? String(item.season_number).padStart(2, '0')  : null;
        const epCode = (se && ep) ? `S${se}E${ep}` : (ep ? `E${ep}` : null);
        tvSubLabel = `<div class="tv-card-sublabel">${item.show_name}${epCode ? ' — ' + epCode : ''}</div>`;
      }

      const escapedTitle = item.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const editPosterBtn = !isMusic ? `
        <button class="poster-edit-btn" title="Edit title &amp; poster" onclick="openPosterModal(event, ${item.id}, '${escapedTitle}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536M9 11l6.293-6.293a1 1 0 011.414 0l2.586 2.586a1 1 0 010 1.414L13 15H9v-4z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21h18"/></svg>
        </button>` : '';

      const trailerBtn = (!isMusic && item.tmdb_url) ? `
        <button class="trailer-btn" title="View on TMDB" onclick="openTrailer(event, '${item.tmdb_url}')">🎥</button>` : '';

      const infoBtn = !isMusic ? `
        <button class="media-info-btn" title="TMDB info" onclick="openTmdbInfo(event, ${item.id})">i</button>` : '';

      card.innerHTML = `
        <div class="media-thumbnail-placeholder">
          <img data-src="/api/media/${item.id}/thumbnail" alt="${item.title}" class="media-thumb-img" onerror="this.style.display='none';" id="thumb-${item.id}">
          ${isMusic ? AUDIO_ICON : VIDEO_ICON}
          <div class="media-badge">${item.type}</div>
          ${editPosterBtn}
          ${trailerBtn}
        </div>
        <div class="media-info">
          <div class="media-title-row">
            <div class="media-title" id="title-${item.id}" title="${item.title}">${item.title}</div>
            ${infoBtn}
          </div>
          ${tvSubLabel}
          <div class="media-meta">
            <span>${formatBytes(item.size)}</span>
            <span>${durationStr}</span>
          </div>
        </div>
      `;
      grid.appendChild(card);

      // For music cards: inject clickable Artist · Album credits below the title
      if (isMusic && (item.artist_name || item.album_name)) {
        const credits = document.createElement('div');
        credits.className = 'music-card-credits';
        if (item.artist_name) {
          const a = document.createElement('button');
          a.className = 'music-card-link';
          a.textContent = item.artist_name;
          a.addEventListener('click', e => { e.stopPropagation(); navigateToArtist(item.artist_name); });
          credits.appendChild(a);
        }
        if (item.artist_name && item.album_name) {
          const sep = document.createElement('span');
          sep.className = 'music-card-sep';
          sep.textContent = '·';
          credits.appendChild(sep);
        }
        if (item.album_name) {
          const b = document.createElement('button');
          b.className = 'music-card-link';
          b.textContent = item.album_name;
          b.addEventListener('click', e => { e.stopPropagation(); navigateToAlbum(item.artist_name, item.album_name); });
          credits.appendChild(b);
        }
        card.querySelector('.media-info').insertBefore(credits, card.querySelector('.media-meta'));
      }
    });
    observeLazyImages(grid);
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<div class="empty-state">Error loading media files: ${err.message}</div>`;
  }
}

// Filter Sidebar Menu
function filterMedia(type) {
  currentType = type;
  // Reset TV state whenever the type changes
  tvLevel = 'shows';
  tvCurrentShow = null;
  tvCurrentSeason = null;
  // Reset Music state whenever the type changes
  musicLevel = 'artists';
  musicCurrentArtist = null;
  musicCurrentAlbum = null;
  
  // Update sidebar and mobile tab active states
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.querySelectorAll('.mobile-tab').forEach(tab => tab.classList.remove('active'));

  if (type === '') {
    document.getElementById('nav-all')?.classList.add('active');
    document.getElementById('mtab-all')?.classList.add('active');
  } else if (type === 'movie') {
    document.getElementById('nav-movie')?.classList.add('active');
    document.getElementById('mtab-movie')?.classList.add('active');
  } else if (type === 'tv') {
    document.getElementById('nav-tv')?.classList.add('active');
    document.getElementById('mtab-tv')?.classList.add('active');
  } else if (type === 'music') {
    document.getElementById('nav-music')?.classList.add('active');
    document.getElementById('mtab-music')?.classList.add('active');
  }

  // Update view title
  const titles = { '': 'All Media', 'movie': 'Movies', 'tv': 'TV Shows', 'music': 'Music' };
  document.getElementById('view-title').innerText = titles[type];

  loadMedia();
}

// Sort controls
function handleSortChange() {
  currentSort = document.getElementById('sort-select').value;
  loadMedia();
}

function toggleSortOrder() {
  currentOrder = currentOrder === 'asc' ? 'desc' : 'asc';
  const icon = document.getElementById('sort-order-icon');
  if (currentOrder === 'desc') {
    icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9M3 12h5m10-4V18m0 0l-3-3m3 3l3-3"/>';
  } else {
    icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9M3 12h5m10 4V6m0 0l-3 3m3-3l3 3"/>';
  }
  document.getElementById('sort-order-btn').classList.toggle('active', currentOrder === 'desc');
  loadMedia();
}

// Music navigation helpers — jump to an artist's album list or an album's track list
// without closing the active player or resetting unrelated state.
function navigateToArtist(artistName) {
  currentType = 'music';
  musicLevel = 'albums';
  musicCurrentArtist = artistName;
  musicCurrentAlbum = null;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.mobile-tab').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-music')?.classList.add('active');
  document.getElementById('mtab-music')?.classList.add('active');
  document.getElementById('view-title').innerText = 'Music';
  loadMedia();
}

function navigateToAlbum(artistName, albumName) {
  currentType = 'music';
  musicLevel = 'tracks';
  musicCurrentArtist = artistName;
  musicCurrentAlbum = albumName;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.mobile-tab').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-music')?.classList.add('active');
  document.getElementById('mtab-music')?.classList.add('active');
  document.getElementById('view-title').innerText = 'Music';
  loadMedia();
}

// Search with Debounce
function handleSearch(query) {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = query;
    loadMedia();
  }, 300);
}

// Open Overlay Media Player
// ── Conversion helpers ────────────────────────────────────────────────────────

function stopConversionPoll() {
  if (conversionPollTimer) { clearInterval(conversionPollTimer); conversionPollTimer = null; }
}

function initMobileBtn() {
  const btn = document.getElementById('btn-convert');
  if (!btn) return;
  btn.textContent = 'Mobile';
  btn.disabled = false;
  btn.title = 'Stream at 720p 2 Mbps (transcoded on the fly)';
  btn.onclick = () => playVersion('converted');
}

function highlightActiveVersion() {
  const btnO = document.getElementById('btn-original');
  const btnC = document.getElementById('btn-convert');
  if (!btnO || !btnC) return;
  btnO.classList.toggle('btn-active', activeVersion === 'original');
  btnC.classList.toggle('btn-active', activeVersion === 'converted');
}

function initConversionUI(id) {
  const actions = document.getElementById('version-actions');
  if (!actions) return;
  actions.style.display = 'flex';
  initMobileBtn();
  highlightActiveVersion();
}


async function playVersion(version, forceSecs) {
  const id = activeMediaId;
  if (!id) return;
  const video = document.getElementById('dtv-player');
  const currentTime = forceSecs != null ? forceSecs : (video ? (video.currentTime + streamSeekOffset) : 0);
  activeVersion = version;
  highlightActiveVersion();

  // Destroy current HLS session
  if (activeHlsSession) {
    activeHlsSession.hls?.destroy();
    fetch('/api/hls/' + activeHlsSession.sessionId, { method: 'DELETE' }).catch(() => {});
    activeHlsSession = null;
  }

  if (!video) return;

  // Show loading message
  const viewport = document.getElementById('media-viewport');
  let loadingMsg = document.getElementById('hls-loading-msg');
  if (!loadingMsg) {
    loadingMsg = document.createElement('div');
    loadingMsg.id = 'hls-loading-msg';
    loadingMsg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:0.95rem;pointer-events:none;';
    viewport.appendChild(loadingMsg);
  }
  loadingMsg.innerHTML = `<div class="snack-stage"><div class="snack">🍿<span class="snack-label">popcorn</span></div><div class="snack">🥤<span class="snack-label">soda</span></div><div class="snack">🍬<span class="snack-label">candy</span></div><div class="snack">🍫<span class="snack-label">choco</span></div><div class="snack">🧃<span class="snack-label">juice</span></div></div><div class="snack-text">${version === 'converted' ? 'Switching to Mobile version…' : 'Switching to Original…'}</div>`;
  video.addEventListener('canplay', () => document.getElementById('hls-loading-msg')?.remove(), { once: true });

  streamSeekOffset = 0;
  try {
    const hlsRes = await fetch('/api/hls/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: id, startSecs: Math.floor(currentTime), useConverted: version === 'converted', lowQuality: version === 'converted' })
    });
    if (!hlsRes.ok) throw new Error('HLS start failed');
    const { sessionId, playlistUrl, startSecs, duration } = await hlsRes.json();
    activeHlsSession = { sessionId, playlistUrl, startSecs: startSecs || 0, hls: null };
    streamSeekOffset = startSecs || 0;
    if (duration) activeDuration = duration;

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 60, maxMaxBufferLength: 120, startPosition: 0 });
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);
      activeHlsSession.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.addEventListener('canplay', () => video.play().catch(() => {}), { once: true });
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) console.error('[HLS error]', data.type, data.details);
      });
    }
  } catch (err) {
    console.error('[playVersion] Failed:', err);
    document.getElementById('hls-loading-msg')?.remove();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// ── MilkDrop visualizer (Butterchurn) ─────────────────────────────────────────

// Resolve the UMD globals, tolerating either a direct export or a `.default` wrapper.
function getButterchurn() {
  let B = window.butterchurn;
  if (B && !B.createVisualizer && B.default) B = B.default;
  return (B && B.createVisualizer) ? B : null;
}
function getButterchurnPresets() {
  let P = window.butterchurnPresets;
  if (P && !P.getPresets && P.default) P = P.default;
  return (P && P.getPresets) ? P : null;
}

function ensureAudioCtx() {
  if (!vizAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    vizAudioCtx = new Ctx();
  }
  return vizAudioCtx;
}

function loadVizPreset(presets, blendTime) {
  const key = vizPresetKeys[vizPresetIndex];
  const preset = presets[key];
  if (!preset || !vizVisualizer) return;
  try { vizVisualizer.loadPreset(preset, blendTime); } catch {}
  const label = document.getElementById('viz-preset-name');
  if (label) {
    label.textContent = key;
    // Restart the fade-in animation
    label.classList.remove('show');
    void label.offsetWidth;
    label.classList.add('show');
  }
}

// Wire an <audio> element into a Butterchurn MilkDrop visualizer rendered on #viz-canvas.
// Fails quietly (audio still plays normally) if WebGL/Web Audio/the CDN libs are unavailable.
function startVisualizer(audioEl) {
  const Butterchurn = getButterchurn();
  const Presets = getButterchurnPresets();
  if (!Butterchurn || !Presets) return;

  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const viewport = document.getElementById('media-viewport');
  const canvas = document.getElementById('viz-canvas');
  if (!viewport || !canvas) return;
  vizCanvasEl = canvas;

  const w = viewport.clientWidth || 800;
  const h = viewport.clientHeight || 450;
  canvas.width = w;
  canvas.height = h;

  // A MediaElementSource can only be created once per element; reuse if present.
  let source = vizSourceMap.get(audioEl);
  if (!source) {
    try {
      source = ctx.createMediaElementSource(audioEl);
      source.connect(ctx.destination); // keep the track audible
      vizSourceMap.set(audioEl, source);
    } catch (e) {
      console.error('[viz] createMediaElementSource failed:', e);
      return;
    }
  }

  try {
    vizVisualizer = Butterchurn.createVisualizer(ctx, canvas, {
      width: w, height: h, pixelRatio: 1, textureRatio: 1,
    });
    vizVisualizer.connectAudio(source);

    const presets = Presets.getPresets();
    vizPresetKeys = Object.keys(presets).sort(() => Math.random() - 0.5);
    vizPresetIndex = 0;
    loadVizPreset(presets, 0);

    // Cycle to a fresh preset every 20s with a smooth blend (à la WinAmp)
    vizPresetTimer = setInterval(() => {
      vizPresetIndex = (vizPresetIndex + 1) % vizPresetKeys.length;
      loadVizPreset(presets, 2.7);
    }, 20000);

    const renderFrame = () => {
      vizRAF = requestAnimationFrame(renderFrame);
      try { vizVisualizer.render(); } catch {}
    };
    renderFrame();

    vizResizeHandler = () => {
      const nw = viewport.clientWidth, nh = viewport.clientHeight;
      if (!nw || !nh || !vizVisualizer) return;
      canvas.width = nw; canvas.height = nh;
      vizVisualizer.setRendererSize(nw, nh);
    };
    window.addEventListener('resize', vizResizeHandler);
    document.addEventListener('fullscreenchange', vizResizeHandler);
  } catch (e) {
    console.error('[viz] init failed:', e);
  }
}

function stopVisualizer() {
  if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = null; }
  if (vizPresetTimer) { clearInterval(vizPresetTimer); vizPresetTimer = null; }
  if (vizResizeHandler) {
    window.removeEventListener('resize', vizResizeHandler);
    document.removeEventListener('fullscreenchange', vizResizeHandler);
    vizResizeHandler = null;
  }
  // Proactively free the GPU/WebGL context so long "Play All" queues don't
  // exhaust the browser's live-context limit before garbage collection runs.
  if (vizCanvasEl) {
    try {
      const gl = vizCanvasEl.getContext('webgl2') || vizCanvasEl.getContext('webgl');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {}
    vizCanvasEl = null;
  }
  // The AudioContext and per-element source nodes are intentionally kept:
  // the context is reused across tracks, and the discarded <audio> element's
  // source is garbage-collected with it.
  vizVisualizer = null;
}

// ──────────────────────────────────────────────────────────────────────────────

async function playMedia(id, type, title, resumePosition = 0, artistName = null, albumName = null) {
  activeMediaId = id;
  const overlay = document.getElementById('player-overlay');
  const viewport = document.getElementById('media-viewport');
  const playerTitle = document.getElementById('player-title');
  const downloadBtn = document.getElementById('player-download-btn');
  const subSection = document.getElementById('subtitles-section');

  playerTitle.innerText = title;
  downloadBtn.href = `/api/media/${id}/download`;

  // If a previous HLS session is active, clean it up first
  if (activeHlsSession) {
    activeHlsSession.hls?.destroy();
    fetch('/api/hls/' + activeHlsSession.sessionId, { method: 'DELETE' }).catch(() => {});
    activeHlsSession = null;
  }

  // Reset conversion state
  stopConversionPoll();
  stopVisualizer();
  activeVersion = 'original';
  const versionActions = document.getElementById('version-actions');
  if (versionActions) versionActions.style.display = 'none';

  // Clear viewport and show window immediately
  viewport.className = 'media-viewport';
  viewport.innerHTML = '';
  subtitleOffset = 0;
  streamSeekOffset = 0;
  activeDuration = null;
  const offsetDisplay = document.getElementById('subtitle-offset-display');
  if (offsetDisplay) offsetDisplay.innerText = '0.0s';
  overlay.style.display = 'flex';

  if (type === 'movie' || type === 'tv') {
    viewport.classList.add('video-viewport');
    subSection.style.display = 'block';

    const video = document.createElement('video');
    video.id = 'dtv-player';
    video.controls = true;
    video.autoplay = false;
    video.preload = 'auto';

    // Show dancing snacks loader while the HLS session starts
    const loadingMsg = document.createElement('div');
    loadingMsg.id = 'hls-loading-msg';
    loadingMsg.innerHTML = `
      <div class="snack-stage">
        <div class="snack">🍿<span class="snack-label">popcorn</span></div>
        <div class="snack">🥤<span class="snack-label">soda</span></div>
        <div class="snack">🍬<span class="snack-label">candy</span></div>
        <div class="snack">🍫<span class="snack-label">choco</span></div>
        <div class="snack">🧃<span class="snack-label">juice</span></div>
      </div>
      <div class="snack-text">Preparing your stream…</div>`;
    viewport.style.position = 'relative';
    viewport.appendChild(video);
    viewport.appendChild(loadingMsg);

    // Remove loading message once video starts buffering
    video.addEventListener('canplay', () => {
      document.getElementById('hls-loading-msg')?.remove();
    }, { once: true });

    // Fetch DB duration before opening stream so custom controls have the correct max
    const _infoRes = await fetch(`/api/media/${id}/info`).catch(() => null);
    activeDuration = (_infoRes?.ok ? (await _infoRes.json().catch(() => null))?.duration : null) || null;

    // Start HLS session
    let hlsStarted = false;
    try {
      const hlsRes = await fetch('/api/hls/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId: id, startSecs: resumePosition || 0 })
      });
      if (hlsRes.ok) {
        const { sessionId, playlistUrl, startSecs, duration } = await hlsRes.json();
        activeHlsSession = { sessionId, playlistUrl, startSecs: startSecs || 0, hls: null };
        // streamSeekOffset tracks the file-level offset so elapsed time displays correctly
        streamSeekOffset = activeHlsSession.startSecs;
        // Use probed duration as source of truth (DB duration field is not populated)
        if (duration) activeDuration = duration;

        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
          const hls = new Hls({
            maxBufferLength: 60,
            maxMaxBufferLength: 120,
            startPosition: 0,  // Always start from segment 0 (not live edge)
          });
          hls.loadSource(playlistUrl);
          hls.attachMedia(video);
          activeHlsSession.hls = hls;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            // HLS mode: always use canNativeSeek=true (hls.js handles seeks via video.currentTime)
            // Do NOT call handleVideoLoaded — it falls back to direct-stream when duration is Infinity
            video.controls = false;
            mountCustomControls(video, id, true);
            // Wait for canplay (data buffered) before calling play() — more reliable than calling
            // play() immediately at MANIFEST_PARSED when no segments are buffered yet
            video.addEventListener('canplay', () => video.play().catch(() => {}), { once: true });
          });
          hls.on(Hls.Events.ERROR, (event, data) => {
            console.error('[HLS error]', data.fatal ? 'FATAL' : 'non-fatal', data.type, data.details, data.reason || '', data.response?.code || '');
          });
        } else {
          // Safari native HLS
          video.src = playlistUrl;
          video.addEventListener('loadedmetadata', () => handleVideoLoaded(video, id, 0), { once: true });
        }
        hlsStarted = true;
      }
    } catch (err) {
      console.error('[HLS] Failed to start HLS session, falling back to direct stream:', err);
    }

    // Fallback to direct stream if HLS session failed
    if (!hlsStarted) {
      video.addEventListener('loadedmetadata', () => handleVideoLoaded(video, id, resumePosition), { once: true });
      video.src = `/api/media/${id}/stream`;
    }

    // Notify server when playback actually starts (fires after buffering, not on src load)
    video.addEventListener('playing', () => {
      fetch(`/api/media/${id}/notify-playing`, { method: 'POST' });
    }, { once: true });

    // Apply subtitle offset to newly loaded cues as the video plays
    video.addEventListener('timeupdate', applyOffsetToAllLoadedCues);

    // Save progress immediately on pause and every 10 seconds while playing
    video.addEventListener('pause', () => saveProgress(id, video, true));

    // When video finishes, remove it from Continue Watching
    video.addEventListener('ended', () => {
      fetch(`/api/media/${id}/progress`, { method: 'DELETE' }).catch(() => {});
      loadResumeList();
    });
    clearInterval(progressSaveInterval);
    progressSaveInterval = setInterval(() => saveProgress(id, video), 10000);

    // Prep OpenSubtitles lookup inputs
    document.getElementById('os-search-input').value = title;
    document.getElementById('os-results').style.display = 'none';
    document.getElementById('os-error-indicator').style.display = 'none';

    // Fetch and apply subtitles
    await loadSubtitlesForPlayer(id);

    // Show Original / Convert buttons and check conversion status
    await initConversionUI(id);
  } else {
    // Music
    viewport.classList.add('audio-viewport');
    viewport.classList.add('has-viz');
    subSection.style.display = 'none';

    // MilkDrop visualizer canvas (sits behind the album art / controls)
    const vizCanvas = document.createElement('canvas');
    vizCanvas.id = 'viz-canvas';
    viewport.appendChild(vizCanvas);

    // Current-preset caption (fades in when the preset changes)
    const presetLabel = document.createElement('div');
    presetLabel.id = 'viz-preset-name';
    presetLabel.className = 'viz-preset-name';
    viewport.appendChild(presetLabel);

    // Create Audio Player Visuals
    const audioWrapper = document.createElement('div');
    audioWrapper.className = 'audio-stage';
    audioWrapper.style.textAlign = 'center';
    audioWrapper.style.width = '80%';
    
    const disc = document.createElement('div');
    disc.className = 'audio-disc';

    // Use album art if available, otherwise fall back to spinning gradient circle.
    // Use fetch HEAD to detect presence — avoids 404 console noise from img onerror.
    const albumArt = document.createElement('img');
    albumArt.className = 'audio-disc-art';
    disc.appendChild(albumArt);
    const thumbUrl = `/api/media/${id}/thumbnail?t=${Date.now()}`;
    fetch(thumbUrl, { method: 'HEAD' })
      .then(r => {
        if (r.ok && !r.headers.get('x-placeholder')) {
          albumArt.src = thumbUrl;
          disc.classList.add('has-art');
        }
      })
      .catch(() => {});

    const audio = document.createElement('audio');
    audio.id = 'dtv-player';
    audio.controls = false;
    audio.autoplay = false;
    audio.preload = 'auto';
    audio.style.display = 'none'; // hide native controls; use custom controls

    // Dancing snacks loader — removed once audio is ready
    const musicLoader = document.createElement('div');
    musicLoader.id = 'hls-loading-msg';
    musicLoader.innerHTML = `
      <div class="snack-stage">
        <div class="snack">🎵<span class="snack-label">notes</span></div>
        <div class="snack">🎸<span class="snack-label">guitar</span></div>
        <div class="snack">🥁<span class="snack-label">drums</span></div>
        <div class="snack">🎹<span class="snack-label">keys</span></div>
        <div class="snack">🎺<span class="snack-label">brass</span></div>
      </div>
      <div class="snack-text">Loading track…</div>`;
    viewport.style.position = 'relative';
    viewport.appendChild(musicLoader);

    audioWrapper.appendChild(disc);
    audioWrapper.appendChild(audio);
    viewport.appendChild(audioWrapper);

    audio.addEventListener('loadedmetadata', () => {
      document.getElementById('hls-loading-msg')?.remove();
      mountCustomControls(audio, id, true);
      if (artistName || albumName) {
        const credits = document.createElement('div');
        credits.className = 'audio-credits';
        if (artistName) {
          const a = document.createElement('button');
          a.className = 'audio-credit-link';
          a.textContent = artistName;
          a.addEventListener('click', async () => { await closePlayer(); navigateToArtist(artistName); });
          credits.appendChild(a);
        }
        if (artistName && albumName) {
          const sep = document.createElement('span');
          sep.className = 'audio-credit-sep';
          sep.textContent = '·';
          credits.appendChild(sep);
        }
        if (albumName) {
          const b = document.createElement('button');
          b.className = 'audio-credit-link';
          b.textContent = albumName;
          b.addEventListener('click', async () => { await closePlayer(); navigateToAlbum(artistName, albumName); });
          credits.appendChild(b);
        }
        audioWrapper.appendChild(credits);
      }
      startVisualizer(audio);
      audio.play().catch(() => {});
    }, { once: true });

    // Start music HLS session — 2-min buffer survives brief signal loss while driving
    let musicHlsStarted = false;
    try {
      const hlsRes = await fetch('/api/music/hls/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId: id })
      });
      if (hlsRes.ok) {
        const { sessionId, playlistUrl, duration } = await hlsRes.json();
        activeHlsSession = { sessionId, playlistUrl, startSecs: 0, hls: null };
        if (duration) activeDuration = duration;

        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
          const hls = new Hls({
            maxBufferLength: 120,
            maxMaxBufferLength: 300,
            lowLatencyMode: false,
            startPosition: 0,
          });
          hls.loadSource(playlistUrl);
          hls.attachMedia(audio);
          activeHlsSession.hls = hls;
          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) console.error('[MusicHLS error]', data.type, data.details);
          });
        } else {
          audio.src = playlistUrl; // Safari native HLS
        }
        musicHlsStarted = true;
      }
    } catch (err) {
      console.error('[MusicHLS] Failed to start HLS session, falling back to direct stream:', err);
    }

    if (!musicHlsStarted) {
      audio.src = `/api/media/${id}/stream`;
    }
  }
}

// Load Subtitles list and mount them into player
async function loadSubtitlesForPlayer(mediaId) {
  const chipList = document.getElementById('subtitle-list');
  chipList.innerHTML = '';
  
  const video = document.getElementById('dtv-player');
  if (!video) return;

  // Remove any existing tracks
  const oldTracks = video.querySelectorAll('track');
  oldTracks.forEach(t => t.remove());

  try {
    const response = await fetch(`/api/media/${mediaId}/subtitles`);
    if (!response.ok) throw new Error('Subtitles list load error');
    const subs = await response.json();

    // Default "None" chip
    const offChip = document.createElement('span');
    offChip.className = 'subtitle-chip active';
    offChip.innerText = 'Off';
    offChip.onclick = () => selectSubtitleTrack(-1, offChip);
    chipList.appendChild(offChip);

    subs.forEach((sub, index) => {
      // Create HTML track tag
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = `${sub.language.toUpperCase()} (${sub.source})`;
      track.srclang = sub.language;
      track.src = `/api/media/${mediaId}/subtitles/${sub.id}/file`;
      track.mode = 'disabled'; // Disabled by default, toggled via chips
      video.appendChild(track);

      // Create subtitle selector chip
      const chip = document.createElement('span');
      chip.className = 'subtitle-chip';
      chip.innerText = `${sub.language.toUpperCase()} (${sub.source})`;
      chip.onclick = () => selectSubtitleTrack(index, chip);
      chipList.appendChild(chip);
    });
  } catch (err) {
    console.error('Failed to load subtitles:', err);
    chipList.innerHTML = `<span style="font-size: 0.85rem; color: var(--danger);">Failed to load subtitles list</span>`;
  }
}

// Handle Subtitle Chip Toggling
function selectSubtitleTrack(index, clickedChip) {
  const video = document.getElementById('dtv-player');
  if (!video) return;

  // Update chip styles
  document.querySelectorAll('.subtitle-chip').forEach(c => c.classList.remove('active'));
  clickedChip.classList.add('active');

  const tracks = video.textTracks;
  for (let i = 0; i < tracks.length; i++) {
    if (i === index) {
      tracks[i].mode = 'showing';
    } else {
      tracks[i].mode = 'disabled';
    }
  }
}

// Close player
async function closePlayer() {
  const video = document.getElementById('dtv-player');
  if (video && activeMediaId) {
    const savedId = activeMediaId;
    const position = streamSeekOffset + (video.currentTime || 0);
    video.pause();
    video.src = '';
    if (position >= 1) {
      await fetch(`/api/media/${savedId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position })
      }).catch(() => {});
    }
  }
  // Clean up conversion poll
  stopConversionPoll();
  stopVisualizer();

  // Clean up HLS session
  if (activeHlsSession) {
    activeHlsSession.hls?.destroy();
    fetch('/api/hls/' + activeHlsSession.sessionId, { method: 'DELETE' }).catch(() => {});
    activeHlsSession = null;
  }
  clearInterval(progressSaveInterval);
  progressSaveInterval = null;
  if (customControlsKeyHandler) {
    document.removeEventListener('keydown', customControlsKeyHandler);
    customControlsKeyHandler = null;
  }
  if (customControlsFsHandler) {
    document.removeEventListener('fullscreenchange', customControlsFsHandler);
    customControlsFsHandler = null;
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  streamSeekOffset = 0;
  activeDuration = null;
  mediaQueue = [];
  queueIndex = -1;
  document.getElementById('player-overlay').style.display = 'none';
  activeMediaId = null;
  loadResumeList();
}

// Close player on outside overlay click
function closePlayerOnOutsideClick(event) {
  if (event.target === document.getElementById('player-overlay')) {
    closePlayer();
  }
}

// Build a stream URL for the active media, with optional server-side seek
function buildStreamUrl(id, seekSecs) {
  const base = `/api/media/${id}/stream`;
  if (seekSecs > 0) {
    return `${base}?seek=${seekSecs.toFixed(1)}`;
  }
  return base;
}

// Called on loadedmetadata — always mounts custom jump controls
function handleVideoLoaded(video, id, resumePosition) {
  video.controls = false;
  if (isFinite(video.duration)) {
    if (resumePosition > 0) video.currentTime = resumePosition;
    mountCustomControls(video, id, true);
  } else {
    if (resumePosition > 0) {
      streamSeekOffset = resumePosition;
      video.src = buildStreamUrl(id, resumePosition);
      video.addEventListener('loadedmetadata', () => mountCustomControls(video, id, false), { once: true });
    } else {
      mountCustomControls(video, id, false);
    }
  }
}

// Build and wire custom jump-button controls overlay
// canNativeSeek=true: original quality with known duration, jumps via video.currentTime
// canNativeSeek=false: transcoded stream, jumps by restarting stream at new offset
function mountCustomControls(video, id, canNativeSeek) {
  document.getElementById('custom-video-controls')?.remove();

  const viewport = document.getElementById('media-viewport');

  const PLAY  = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  const PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
  const PREV  = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>`;
  const NEXT  = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`;
  const VOL_ON  = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>`;
  const VOL_OFF = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
  const FS_ENTER = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;
  const FS_EXIT  = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;

  function getElapsed() {
    // Always include streamSeekOffset — for HLS it holds the ffmpeg start position,
    // for legacy transcoded streams it holds the seek restart position.
    return streamSeekOffset + (video.currentTime || 0);
  }
  function getTotalDuration() {
    // activeDuration is probed on HLS start — use it as source of truth
    if (activeDuration) return activeDuration;
    // Fallback: video.duration is relative to HLS stream start, add offset for true file duration
    if (isFinite(video.duration)) return streamSeekOffset + video.duration;
    return 0;
  }

  const initElapsed = getElapsed();
  const initDuration = getTotalDuration();

  const ctrl = document.createElement('div');
  ctrl.id = 'custom-video-controls';
  ctrl.className = 'custom-video-controls';
  ctrl.innerHTML = `
    <div class="cvp-jump-row">
      <button class="cvp-btn cvp-jump-btn" id="cvp-back5">« 5m</button>
      <button class="cvp-btn cvp-jump-btn" id="cvp-back1">‹ 1m</button>
      <span id="cvp-time" class="cvp-time">${formatDuration(Math.floor(initElapsed))} / ${formatDuration(initDuration)}</span>
      <button class="cvp-btn cvp-jump-btn" id="cvp-fwd1">1m ›</button>
      <button class="cvp-btn cvp-jump-btn" id="cvp-fwd5">5m »</button>
    </div>
    <div class="cvp-buttons-row">
      <button id="cvp-prev" class="cvp-btn cvp-queue-btn" style="${mediaQueue.length > 1 ? '' : 'visibility:hidden'}" title="Previous track">${PREV}</button>
      <button id="cvp-play" class="cvp-btn">${video.paused ? PLAY : PAUSE}</button>
      <button id="cvp-next" class="cvp-btn cvp-queue-btn" style="${mediaQueue.length > 1 ? '' : 'visibility:hidden'}" title="Next track">${NEXT}</button>
      <span class="cvp-spacer"></span>
      <button id="cvp-mute" class="cvp-btn">${video.muted ? VOL_OFF : VOL_ON}</button>
      <input type="range" id="cvp-vol" class="cvp-vol" min="0" max="1" step="0.05" value="${video.volume}">
      <button id="cvp-fs" class="cvp-btn">${FS_ENTER}</button>
    </div>
  `;
  viewport.appendChild(ctrl);

  const timeEl  = document.getElementById('cvp-time');
  const playBtn = document.getElementById('cvp-play');
  const prevBtn = document.getElementById('cvp-prev');
  const nextBtn = document.getElementById('cvp-next');
  const muteBtn = document.getElementById('cvp-mute');
  const volBar  = document.getElementById('cvp-vol');
  const fsBtn   = document.getElementById('cvp-fs');

  video.addEventListener('timeupdate', () => {
    if (!document.getElementById('cvp-time')) return;
    const t = getElapsed();
    timeEl.innerText = `${formatDuration(t)} / ${formatDuration(getTotalDuration())}`;
  });
  video.addEventListener('play',  () => { playBtn.innerHTML = PAUSE; });
  video.addEventListener('pause', () => { playBtn.innerHTML = PLAY; });
  video.addEventListener('click', () => { video.paused ? video.play().catch(() => {}) : video.pause(); });

  playBtn.addEventListener('click', () => { video.paused ? video.play().catch(() => {}) : video.pause(); });
  prevBtn?.addEventListener('click', () => playPrev());
  nextBtn?.addEventListener('click', () => playNext());

  // Auto-advance to next queued item when track ends
  video.addEventListener('ended', () => { if (queueIndex < mediaQueue.length - 1) playNext(); }, { once: true });

  function doJump(delta) {
    const current = getElapsed();
    const total = getTotalDuration();
    const seekTo = Math.max(0, total > 0 ? Math.min(total, current + delta) : current + delta);
    if (canNativeSeek) {
      if (seekTo < streamSeekOffset) {
        // Seeking before the HLS session's start — must restart the session
        playVersion(activeVersion, seekTo);
      } else {
        // seekTo is a file-level position; convert to HLS-relative time
        video.currentTime = seekTo - streamSeekOffset;
      }
    } else {
      const wasPlaying = !video.paused;
      streamSeekOffset = seekTo;
      video.src = buildStreamUrl(id, seekTo);
      video.addEventListener('loadedmetadata', () => {
        if (wasPlaying) video.play().catch(() => {});
      }, { once: true });
    }
  }

  document.getElementById('cvp-back5').addEventListener('click', () => doJump(-300));
  document.getElementById('cvp-back1').addEventListener('click', () => doJump(-60));
  document.getElementById('cvp-fwd1').addEventListener('click',  () => doJump(60));
  document.getElementById('cvp-fwd5').addEventListener('click',  () => doJump(300));

  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    muteBtn.innerHTML = video.muted ? VOL_OFF : VOL_ON;
  });
  volBar.addEventListener('input', () => {
    video.volume = parseFloat(volBar.value);
    if (video.volume > 0) video.muted = false;
    muteBtn.innerHTML = (video.muted || video.volume === 0) ? VOL_OFF : VOL_ON;
  });

  fsBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.getElementById('player-overlay').requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });

  if (customControlsFsHandler) document.removeEventListener('fullscreenchange', customControlsFsHandler);
  customControlsFsHandler = () => {
    const btn = document.getElementById('cvp-fs');
    if (btn) btn.innerHTML = document.fullscreenElement ? FS_EXIT : FS_ENTER;
  };
  document.addEventListener('fullscreenchange', customControlsFsHandler);

  if (customControlsKeyHandler) document.removeEventListener('keydown', customControlsKeyHandler);
  customControlsKeyHandler = (e) => {
    if (e.code === 'Space' && document.getElementById('custom-video-controls')) {
      e.preventDefault();
      video.paused ? video.play().catch(() => {}) : video.pause();
    }
  };
  document.addEventListener('keydown', customControlsKeyHandler);
}

// OpenSubtitles Lookup
async function lookupOpenSubtitles() {
  const query = document.getElementById('os-search-input').value;
  const resultsContainer = document.getElementById('os-results');
  const loading = document.getElementById('os-loading-indicator');
  const errorInd = document.getElementById('os-error-indicator');

  if (!query) return;

  loading.style.display = 'block';
  errorInd.style.display = 'none';
  resultsContainer.style.display = 'none';
  resultsContainer.innerHTML = '';

  try {
    const response = await fetch(`/api/media/${activeMediaId}/opensubtitles/search?query=${encodeURIComponent(query)}`);
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to search OpenSubtitles');
    }
    const results = await response.json();

    loading.style.display = 'none';

    if (results.length === 0) {
      resultsContainer.innerHTML = '<div style="padding: 15px; text-align: center; color: var(--text-muted); font-size: 0.9rem;">No subtitles found on OpenSubtitles.com</div>';
      resultsContainer.style.display = 'block';
      return;
    }

    results.forEach(sub => {
      const row = document.createElement('div');
      row.className = 'subtitle-result-row';
      row.innerHTML = `
        <div style="flex-grow: 1; padding-right: 15px;">
          <div style="font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 450px;" title="${sub.fileName}">${sub.fileName}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">Uploader: ${sub.uploader} | Downloads: ${sub.downloadCount}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <span class="folder-type" style="margin: 0; background: rgba(168, 85, 247, 0.15); color: var(--accent-secondary);">${sub.language.toUpperCase()}</span>
          <button class="btn btn-primary btn-sm" onclick="downloadSubtitle('${sub.id}', '${sub.language}')" style="padding: 4px 8px; font-size: 0.8rem; width: auto;">Add</button>
        </div>
      `;
      resultsContainer.appendChild(row);
    });
    
    resultsContainer.style.display = 'block';
  } catch (err) {
    loading.style.display = 'none';
    errorInd.innerText = err.message || 'Error executing lookup.';
    errorInd.style.display = 'block';
  }
}

// Download subtitle file from OpenSubtitles selection
async function downloadSubtitle(fileId, language) {
  const loading = document.getElementById('os-loading-indicator');
  const errorInd = document.getElementById('os-error-indicator');
  const resultsContainer = document.getElementById('os-results');

  loading.style.display = 'block';
  loading.innerText = 'Downloading and saving subtitle...';
  errorInd.style.display = 'none';

  try {
    const response = await fetch(`/api/media/${activeMediaId}/opensubtitles/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fileId, language })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to download subtitle');
    }

    // Success! Re-render subtitle list
    await loadSubtitlesForPlayer(activeMediaId);
    
    // Clear list and close search
    resultsContainer.style.display = 'none';
    resultsContainer.innerHTML = '';
    loading.style.display = 'none';
    loading.innerText = 'Searching OpenSubtitles...';
  } catch (err) {
    loading.style.display = 'none';
    loading.innerText = 'Searching OpenSubtitles...';
    errorInd.innerText = err.message || 'Error downloading subtitle.';
    errorInd.style.display = 'block';
  }
}

// Utility Formatting Functions
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(secs) {
  secs = Math.floor(secs || 0);
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const seconds = secs % 60;

  let str = '';
  if (hours > 0) {
    str += `${hours}:`;
  }
  str += `${minutes.toString().padStart(2, '0')}:`;
  str += `${seconds.toString().padStart(2, '0')}`;
  return str;
}

// Subtitle Sync
// Store original cue times so we can re-apply total offset cleanly as new cues load
const originalCueTimes = new WeakMap();

function applyOffsetToCue(cue, totalOffset) {
  if (!originalCueTimes.has(cue)) {
    originalCueTimes.set(cue, { start: cue.startTime, end: cue.endTime });
  }
  const orig = originalCueTimes.get(cue);
  cue.startTime = Math.max(0, orig.start + totalOffset);
  cue.endTime   = Math.max(0, orig.end   + totalOffset);
}

function applyOffsetToAllLoadedCues() {
  const video = document.getElementById('dtv-player');
  if (!video || subtitleOffset === 0) return;
  for (let i = 0; i < video.textTracks.length; i++) {
    const track = video.textTracks[i];
    if (track.mode === 'disabled' || !track.cues) continue;
    for (let j = 0; j < track.cues.length; j++) {
      applyOffsetToCue(track.cues[j], subtitleOffset);
    }
  }
}

function shiftSubtitles(seconds) {
  const video = document.getElementById('dtv-player');
  if (!video) return;

  subtitleOffset = Math.round((subtitleOffset + seconds) * 10) / 10;

  for (let i = 0; i < video.textTracks.length; i++) {
    const track = video.textTracks[i];
    if (track.mode === 'disabled' || !track.cues) continue;
    for (let j = 0; j < track.cues.length; j++) {
      applyOffsetToCue(track.cues[j], subtitleOffset);
    }
  }

  updateSubtitleOffsetDisplay();
}

function resetSubtitleSync() {
  subtitleOffset = 0;
  // Restore all cues to their original times
  const video = document.getElementById('dtv-player');
  if (video) {
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      if (!track.cues) continue;
      for (let j = 0; j < track.cues.length; j++) {
        const orig = originalCueTimes.get(track.cues[j]);
        if (orig) {
          track.cues[j].startTime = orig.start;
          track.cues[j].endTime   = orig.end;
        }
      }
    }
  }
  updateSubtitleOffsetDisplay();
}

function updateSubtitleOffsetDisplay() {
  const display = document.getElementById('subtitle-offset-display');
  if (!display) return;
  display.innerText = (subtitleOffset >= 0 ? '+' : '') + subtitleOffset.toFixed(1) + 's';
  display.style.color = subtitleOffset === 0 ? 'var(--text-muted)' : 'var(--accent-secondary)';
}

// Playback Progress
function saveProgress(mediaId, video, force = false) {
  if (!video || !mediaId) return;
  const position = streamSeekOffset + (video.currentTime || 0);
  if (position < 1) return;
  const totalDuration = isFinite(video.duration) ? (streamSeekOffset + video.duration) : activeDuration;
  if (!force && totalDuration && totalDuration - position < 30) return;
  fetch(`/api/media/${mediaId}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position, duration: totalDuration || undefined })
  }).catch(() => {});
}

async function loadResumeList() {
  const section = document.getElementById('resume-section');
  const list = document.getElementById('resume-list');
  try {
    const res = await fetch('/api/progress/recent');
    if (!res.ok) return;
    const items = await res.json();
    section.style.display = 'block';
    list.innerHTML = '';
    if (items.length === 0) {
      list.innerHTML = '<div class="resume-empty">Nothing watched yet</div>';
      return;
    }
    items.forEach(item => {
      const pct = item.duration ? Math.round((item.position / item.duration) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'resume-item';
      row.title = `Resume ${item.title}`;
      row.onclick = () => playMedia(item.id, item.type, item.title, item.position);
      row.innerHTML = `
        <img data-src="/api/media/${item.id}/thumbnail" class="resume-thumb" onerror="this.style.display='none'">
        <div class="resume-info">
          <div class="resume-title">${item.title}</div>
          <div class="resume-bar-track"><div class="resume-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <button class="resume-dismiss" title="Remove from Continue Watching" onclick="dismissResume(event, ${item.id})">&times;</button>
      `;
      list.appendChild(row);
    });
    observeLazyImages(list);
  } catch {}
}

async function dismissResume(event, mediaId) {
  event.stopPropagation();
  await fetch(`/api/media/${mediaId}/progress`, { method: 'DELETE' }).catch(() => {});
  loadResumeList();
}

// TMDB Info Modal
async function openTmdbInfo(event, mediaId) {
  event.stopPropagation();
  const modal = document.getElementById('tmdb-modal');
  const body = document.getElementById('tmdb-modal-body');
  const titleEl = document.getElementById('tmdb-modal-title');
  titleEl.innerText = 'Loading…';
  body.innerHTML = '<div class="tmdb-loading">Loading…</div>';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/media/${mediaId}/tmdb-info`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load info');

    titleEl.innerText = data.title;

    const isTv = data.type === 'tv';
    const stars = data.vote_average ? '★'.repeat(Math.round(data.vote_average / 2)) + '☆'.repeat(5 - Math.round(data.vote_average / 2)) : null;

    body.innerHTML = `
      ${data.tagline ? `<p class="tmdb-tagline">"${data.tagline}"</p>` : ''}
      ${data.overview ? `<p class="tmdb-overview">${data.overview}</p>` : ''}
      <div class="tmdb-meta-grid">
        ${data.release_date ? `<div class="tmdb-meta-item"><span class="tmdb-label">${isTv ? 'First Aired' : 'Released'}</span><span>${data.release_date}</span></div>` : ''}
        ${isTv && data.seasons ? `<div class="tmdb-meta-item"><span class="tmdb-label">Seasons</span><span>${data.seasons}</span></div>` : ''}
        ${data.runtime ? `<div class="tmdb-meta-item"><span class="tmdb-label">${isTv ? 'Episode Runtime' : 'Runtime'}</span><span>${data.runtime} min</span></div>` : ''}
        ${data.vote_average ? `<div class="tmdb-meta-item"><span class="tmdb-label">Rating</span><span title="${data.vote_average}/10 (${data.vote_count} votes)">${stars} ${data.vote_average}/10</span></div>` : ''}
        ${data.genres.length ? `<div class="tmdb-meta-item"><span class="tmdb-label">Genres</span><span>${data.genres.join(', ')}</span></div>` : ''}
        ${isTv && data.creators?.length ? `<div class="tmdb-meta-item"><span class="tmdb-label">Created by</span><span>${data.creators.join(', ')}</span></div>` : ''}
        ${isTv && data.networks?.length ? `<div class="tmdb-meta-item"><span class="tmdb-label">Network</span><span>${data.networks.join(', ')}</span></div>` : ''}
        ${!isTv && data.director ? `<div class="tmdb-meta-item"><span class="tmdb-label">Director</span><span>${data.director}</span></div>` : ''}
        ${data.cast.length ? `<div class="tmdb-meta-item"><span class="tmdb-label">Cast</span><span>${data.cast.join(', ')}</span></div>` : ''}
      </div>
      <a class="tmdb-link" href="${data.tmdb_url}" target="_blank" rel="noopener">View on TMDB →</a>
    `;
  } catch (err) {
    body.innerHTML = `<p style="color: var(--danger);">${err.message}</p>`;
  }
}

function closeTmdbModal() {
  document.getElementById('tmdb-modal').style.display = 'none';
}

function closeTmdbModalOnOutside(event) {
  if (event.target === document.getElementById('tmdb-modal')) closeTmdbModal();
}

// Poster URL Modal
function openPosterModal(event, mediaId, currentTitle) {
  event.stopPropagation();
  posterMode = 'media';
  posterTVOldName = null;
  posterTargetId = mediaId;
  document.getElementById('poster-title-input').value = currentTitle || '';
  document.getElementById('poster-url-input').value = '';
  document.getElementById('poster-error').style.display = 'none';
  document.getElementById('poster-modal').style.display = 'flex';
  document.getElementById('poster-title-input').focus();
}

function openTrailer(event, url) {
  event.stopPropagation();
  window.open(url, '_blank', 'noopener');
}

function openMusicPosterModal(event, posterId, name) {
  event.stopPropagation();
  posterMode = 'music';
  posterTVOldName = null;
  posterTargetId = posterId;
  document.getElementById('poster-title-row').style.display = 'none';
  document.getElementById('poster-modal-heading').innerText = 'Edit Album Poster';
  document.getElementById('poster-url-input').value = '';
  document.getElementById('poster-error').style.display = 'none';
  document.getElementById('poster-modal').style.display = 'flex';
  document.getElementById('poster-url-input').focus();
}

function openArtistPosterModal(event, artistName) {
  event.stopPropagation();
  posterMode = 'music-artist';
  posterTVOldName = artistName; // reuse field to carry the artist name
  posterTargetId = null;
  document.getElementById('poster-title-row').style.display = 'none';
  document.getElementById('poster-modal-heading').innerText = 'Edit Artist Poster';
  document.getElementById('poster-url-input').value = '';
  document.getElementById('poster-error').style.display = 'none';
  document.getElementById('poster-modal').style.display = 'flex';
  document.getElementById('poster-url-input').focus();
}

function openTVShowModal(event, posterId, showName) {
  event.stopPropagation();
  posterMode = 'tvshow';
  posterTVOldName = showName;
  posterTargetId = posterId;
  document.getElementById('poster-title-input').value = showName || '';
  document.getElementById('poster-url-input').value = '';
  document.getElementById('poster-error').style.display = 'none';
  document.getElementById('poster-modal').style.display = 'flex';
  document.getElementById('poster-title-input').focus();
}

function closePosterModal() {
  document.getElementById('poster-modal').style.display = 'none';
  document.getElementById('poster-title-row').style.display = '';
  document.getElementById('poster-modal-heading').innerText = 'Edit Media';
  posterTargetId = null;
  posterMode = 'media';
  posterTVOldName = null;
}

function closePosterModalOnOutside(event) {
  if (event.target === document.getElementById('poster-modal')) closePosterModal();
}

async function savePoster() {
  const url = document.getElementById('poster-url-input').value.trim();
  const newTitle = document.getElementById('poster-title-input').value.trim();
  const errorEl = document.getElementById('poster-error');
  errorEl.style.display = 'none';

  if (!newTitle && posterMode !== 'music' && posterMode !== 'music-artist') {
    errorEl.innerText = 'Title cannot be empty.';
    errorEl.style.display = 'block';
    return;
  }

  const saveBtn = document.querySelector('#poster-modal .btn-primary');
  saveBtn.disabled = true;
  saveBtn.innerText = 'Saving...';

  try {
    if (posterMode === 'music-artist') {
      if (!url) { closePosterModal(); return; }
      const res = await fetch(`/api/music/artist-poster/${encodeURIComponent(posterTVOldName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save poster');
      const img = document.getElementById(`thumb-artist-${encodeURIComponent(posterTVOldName)}`);
      if (img) { img.style.display = ''; img.src = `/api/music/artist-poster/${encodeURIComponent(posterTVOldName)}?t=${Date.now()}`; }
      closePosterModal();
      saveBtn.disabled = false;
      saveBtn.innerText = 'Save';
      return;
    }

    if (posterMode === 'music') {
      if (!url) { closePosterModal(); return; }
      const posterRes = await fetch(`/api/media/${posterTargetId}/poster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const posterData = await posterRes.json();
      if (!posterRes.ok) throw new Error(posterData.error || 'Failed to save poster');
      const img = document.getElementById(`thumb-music-${posterTargetId}`);
      if (img) { img.style.display = ''; img.src = `/api/media/${posterTargetId}/thumbnail?t=${Date.now()}`; }
      closePosterModal();
      saveBtn.disabled = false;
      saveBtn.innerText = 'Save';
      return;
    }

    if (posterMode === 'tvshow') {
      // Rename show across all episodes
      const titleRes = await fetch('/api/tv/show-name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldName: posterTVOldName, newName: newTitle })
      });
      if (!titleRes.ok) {
        const d = await titleRes.json();
        throw new Error(d.error || 'Failed to rename show');
      }

      // Save poster if URL provided
      if (url) {
        const posterRes = await fetch(`/api/media/${posterTargetId}/poster`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const posterData = await posterRes.json();
        if (!posterRes.ok) throw new Error(posterData.error || 'Failed to save poster');

        const img = document.getElementById(`thumb-tv-${posterTargetId}`);
        if (img) {
          img.style.display = '';
          img.src = `/api/media/${posterTargetId}/thumbnail?t=${Date.now()}`;
        }
      }

      // Update the title text on the card in-place
      const titleEl = document.getElementById(`title-tv-${posterTargetId}`);
      if (titleEl) {
        titleEl.innerText = newTitle;
        titleEl.title = newTitle;
      }

      // Also update tvCurrentShow if we're currently browsing this show's seasons/episodes
      if (tvCurrentShow === posterTVOldName) {
        tvCurrentShow = newTitle;
      }

    } else {
      // Save title
      const titleRes = await fetch(`/api/media/${posterTargetId}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
      });
      if (!titleRes.ok) {
        const d = await titleRes.json();
        throw new Error(d.error || 'Failed to save title');
      }

      // Save poster if a URL was provided
      if (url) {
        const posterRes = await fetch(`/api/media/${posterTargetId}/poster`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const posterData = await posterRes.json();
        if (!posterRes.ok) throw new Error(posterData.error || 'Failed to save poster');

        const img = document.getElementById(`thumb-${posterTargetId}`);
        if (img) {
          img.style.display = '';
          img.src = `/api/media/${posterTargetId}/thumbnail?t=${Date.now()}`;
        }
      }

      // Update the title text on the card in-place
      const titleEl = document.getElementById(`title-${posterTargetId}`);
      if (titleEl) {
        titleEl.innerText = newTitle;
        titleEl.title = newTitle;
      }
    }

    closePosterModal();
  } catch (err) {
    errorEl.innerText = err.message;
    errorEl.style.display = 'block';
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerText = 'Save';
  }
}

document.addEventListener('DOMContentLoaded', init);
