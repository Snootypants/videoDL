# VideoDL

Local, no-API-key video downloader with a clean web UI backed by [`yt-dlp`](https://github.com/yt-dlp/yt-dlp).

## Quick Start
```bash
git clone https://github.com/Snootypants/videoDL.git && cd videoDL
git submodule update --init --recursive
brew install ffmpeg  # or: apt-get install ffmpeg / choco install ffmpeg
python web/server.py --port 5050
python -m webbrowser http://127.0.0.1:5050
```

## Highlights
- Web UI that previews metadata and formats
- Local API server that downloads with `yt-dlp`
- Saves as `%(title)s.%(ext)s` in your chosen directory
- No external Google/YouTube API keys needed

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
python web/server.py --port 5050
```

The server hosts both the web UI and API endpoints, so you do not need to open `web/index.html` directly.

Open the UI:
```
http://127.0.0.1:5050
```

## Usage
1. Paste a YouTube URL.
2. Pick language (some videos have multiple audio tracks) and quality.
3. Click **Download Video**.

The UI currently sends a hidden save location that defaults to `~/Downloads` and is not user-configurable yet.
The server saves files as `%(title)s.%(ext)s` in that directory.

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

## Notes
- The server is local-only by default (`127.0.0.1`).
- The API exposes:
  - `GET /api/video-info?url=...`
  - `POST /api/download` with JSON `{ "url", "quality", "path" }`
