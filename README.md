# DTV — Self-Hosted Media Server

DTV is a self-hosted streaming server for movies, TV shows, and music. Built with Node.js/Express and SQLite, it runs as a single Docker container and streams directly to any browser — no client app required.

![DTV Screenshot](public/DTV_Logo.png)

## Features

- Browse and stream **movies**, **TV shows**, and **music** from a local NAS or filesystem
- **HLS streaming** with adaptive buffering for video and music — survives brief signal loss on mobile
- **NVIDIA GPU-accelerated transcoding** — HEVC/H.265 and multi-channel audio automatically converted for browser compatibility
- **TMDB integration** — automatic poster art and metadata for all media, with a detail modal per title
- **OpenSubtitles integration** — search and apply subtitles directly in the player
- **MilkDrop visualizer** — WebGL Butterchurn renders while music plays
- **Sort and filter** — by title, release date, or date added, ascending or descending
- **Continue Watching** — resumes playback from where you left off
- **Multi-user** — session auth, invite flow via email, admin panel
- **Pushover notifications** when playback starts

## Requirements

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- **NVIDIA GPU** + [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) (for hardware transcoding)
- [TMDB API key](https://www.themoviedb.org/settings/api) (free)
- [OpenSubtitles](https://www.opensubtitles.com/consumers) account + API key (optional)

## Setup

1. **Clone the repo**

   ```bash
   git clone https://github.com/yourusername/dtv.git
   cd dtv
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   # Edit .env and fill in your values
   ```

3. **Update volume mounts** in `docker-compose.yml` to point to your media directories:

   ```yaml
   volumes:
     - ./data:/usr/src/app/data
     - /path/to/your/media:/media:ro
     - /path/to/your/conversions:/conversions:rw
   ```

   DTV expects media organized as:
   ```
   /media/
     Movies/    (or movies/)
     TV/        (or tv/)
     Music/     (or music/)
   ```

4. **Build and start**

   ```bash
   docker compose up -d --build
   ```

5. **Open** `http://localhost:40086` (or change the port in `docker-compose.yml`)

## Configuration

All secrets live in `.env` — never committed. See `.env.example` for the full variable list.

| Variable | Description |
|---|---|
| `ADMIN_EMAIL` | Email for the initial admin account |
| `ADMIN_PASSWORD` | Admin account password |
| `SESSION_SECRET` | Random string for session signing |
| `TMDB_API_KEY` | From [themoviedb.org](https://www.themoviedb.org/settings/api) |
| `OPENSUBTITLES_API_KEY` | From [opensubtitles.com](https://www.opensubtitles.com/consumers) |
| `OPENSUBTITLES_USERNAME` | OpenSubtitles username |
| `OPENSUBTITLES_PASSWORD` | OpenSubtitles password |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | SMTP server for invite emails |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | [Pushover](https://pushover.net) for playback notifications (optional) |

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20, Express, SQLite (`sqlite3`) |
| Frontend | Vanilla JS, no framework |
| Streaming | ffmpeg, HLS via [hls.js](https://github.com/video-dev/hls.js) |
| GPU | NVIDIA CUDA (NVENC/NVDEC) |
| Music visualizer | [Butterchurn](https://github.com/jberg/butterchurn) (WebGL MilkDrop) |

## Project Structure

```
server.js          — Express app and all API routes
scanner.js         — Filesystem scanner, TMDB poster/metadata fetching
database.js        — SQLite schema init and migrations
opensubtitles.js   — OpenSubtitles API integration
public/
  index.html       — Main app shell
  app.js           — All frontend logic
  styles.css       — Styles
  admin.html/.js   — Admin panel
data/              — Runtime data (gitignored): SQLite DBs, thumbnails, HLS sessions
```

## License

MIT
