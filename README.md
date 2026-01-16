# VideoDL

Local, no-API-key video downloader with a clean web UI backed by `yt-dlp`.

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
- Python 3.10+
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
Or download a static build and add `ffmpeg` to your PATH.

## Run
```bash
python web/server.py --port 5050
```

Open the UI:
```
http://127.0.0.1:5050
```

## Usage
1. Paste a YouTube URL.
2. Pick language and quality.
3. Click **Download Video**.

The server saves files as `%(title)s.%(ext)s` in the directory sent by the UI.
If no path is provided, it defaults to `~/Downloads`.

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
