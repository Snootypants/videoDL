# VideoDL

A local video downloader with a clean web UI, powered by [`yt-dlp`](https://github.com/yt-dlp/yt-dlp). No API keys, no external services—everything runs on your machine.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-green)

## Quick Start
```bash
git clone https://github.com/Snootypants/videoDL.git && cd videoDL
git submodule update --init --recursive
brew install ffmpeg  # or: apt-get install ffmpeg / choco install ffmpeg
python web/server.py
```
Then open http://127.0.0.1:5050 in your browser.

## Features
- **Live Preview** — Thumbnail, title, duration, and description shown as you paste a URL
- **Format Selection** — Choose from curated quality options with resolution, FPS, codec, and bitrate info
- **Multi-Language Audio** — Select from available audio tracks when videos have multiple languages
- **Browser Cookie Auth** — Access age-restricted or private videos using cookies from Chrome, Firefox, or Safari
- **No API Keys** — Runs entirely locally with yt-dlp, no external service dependencies
- **Auto-Merge** — Uses ffmpeg to combine video and audio streams into a single file

## Supported Sites
VideoDL uses yt-dlp under the hood, which supports **1000+ sites** including:
- YouTube, YouTube Music, YouTube Shorts
- Vimeo, Dailymotion, Twitch
- Twitter/X, Reddit, Instagram, TikTok
- And [many more](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)

## How it works
```
Browser UI (web/index.html)
  -> GET /api/video-info?url=...
  -> POST /api/download
  -> yt-dlp + ffmpeg
```

## Requirements
- Python 3.10+ (check with `python3 --version`)
- `ffmpeg` available on your PATH
- Git submodules initialized (`yt-dlp`)

## Install
```bash
git clone https://github.com/Snootypants/videoDL.git
cd videoDL
git submodule update --init --recursive
```

### Install ffmpeg
macOS (Homebrew):
```bash
brew install ffmpeg
```

Ubuntu/Debian:
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

Windows (Chocolatey):
```powershell
choco install ffmpeg
```
Or download a static build from [ffmpeg.org](https://ffmpeg.org/download.html) and add `ffmpeg` to your PATH.

## Run
```bash
python web/server.py
```

The server hosts both the web UI and API endpoints at http://127.0.0.1:5050.

### Command-Line Options
```bash
python web/server.py [OPTIONS]

--port PORT              Server port (default: 5050)
--cookies-from-browser   Load cookies from browser, e.g. "chrome:Profile 1" or "firefox"
--cookies-file PATH      Load cookies from Netscape-format file
```

Example with authentication:
```bash
python web/server.py --cookies-from-browser "chrome:Default"
```

## Usage
1. Paste a YouTube URL into the input field
2. Wait for the preview to load (metadata fetches automatically)
3. (Optional) Click **Advanced** to select language and quality
4. Click **Download Video**
5. Files save to `~/Downloads` as `Title.ext`

For age-restricted or private videos, start the server with `--cookies-from-browser` to authenticate.

## Troubleshooting
- **403 Forbidden from YouTube**
  - Update the `yt-dlp` submodule:
    ```bash
    git submodule update --remote yt-dlp
    ```
  - If the video requires auth, pass cookies:
    ```bash
    python web/server.py --cookies-from-browser "chrome:Profile 1"
    # or
    python web/server.py --cookies-file /path/to/cookies.txt
    ```

- **Downloads fail or merge errors**
  - Confirm `ffmpeg` is installed and on your PATH.

- **UI falls back to mock data**
  - Make sure the API server is running on `http://127.0.0.1:5050`.

## Updating yt-dlp
```bash
git submodule update --remote yt-dlp
```

## API Endpoints
The server exposes a simple REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/video-info?url=...` | GET | Fetch video metadata, formats, and available languages |
| `/api/download` | POST | Download video with `{ "url", "quality", "language", "path" }` |
| `/api/auth-status?url=...` | GET | Check if URL is accessible or requires authentication |
| `/api/auth-get` | POST | Validate browser cookies for restricted content |
| `/api/default-path` | GET | Returns default save location |
| `/api/diagnostics` | GET | Returns yt-dlp version info |

## Notes
- The server binds to `127.0.0.1` only (local access)
- Files save as `%(title)s.%(ext)s` in the configured download directory
- The UI debounces URL input to avoid excessive API calls

## Tech Stack
- **Backend:** Python 3.10+ with built-in `http.server`
- **Frontend:** Vanilla JavaScript, HTML5, CSS3 (no frameworks)
- **Core:** yt-dlp (as git submodule) + ffmpeg

## License
This project uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) which is licensed under the Unlicense.
