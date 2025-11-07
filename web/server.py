#!/usr/bin/env python3
"""Minimal local API layer that exposes yt-dlp video metadata to the web UI.

Run with:  python web/server.py --port 5050
Then open web/index.html in a browser and paste a YouTube URL to fetch details.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

PROJECT_ROOT = Path(__file__).resolve().parents[1]
YTDLP_SOURCE = PROJECT_ROOT / "yt-dlp"
WEB_ROOT = Path(__file__).resolve().parent

for path in (PROJECT_ROOT, YTDLP_SOURCE):
    path_str = str(path)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)

from yt_dlp import YoutubeDL  # type: ignore  # local package import


def build_format_options(info: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return a curated, de-duplicated set of progressive formats for the dropdown."""
    formats = info.get("formats") or []
    progressive = [
        fmt
        for fmt in formats
        if fmt.get("vcodec") not in (None, "none")
        and fmt.get("acodec") not in (None, "none")
        and fmt.get("format_id")
    ]

    best_per_bucket: Dict[tuple, Dict[str, Any]] = {}
    for fmt in progressive:
        bucket = (
            fmt.get("height"),
            int(fmt.get("fps") or 0),
            fmt.get("dynamic_range"),
            fmt.get("ext"),
        )
        current_best = best_per_bucket.get(bucket)
        if current_best is None or (fmt.get("tbr") or 0) > (current_best.get("tbr") or 0):
            best_per_bucket[bucket] = fmt

    deduped = sorted(
        best_per_bucket.values(),
        key=lambda fmt: ((fmt.get("height") or 0), (fmt.get("fps") or 0), (fmt.get("tbr") or 0)),
        reverse=True,
    )

    options: List[Dict[str, Any]] = []
    for fmt in deduped[:12]:
        options.append(
            {
                "id": fmt["format_id"],
                "label": describe_format(fmt),
                "ext": fmt.get("ext", info.get("ext", "mp4")),
            }
        )

    if not options:
        options.append(
            {
                "id": info.get("format_id") or "bestvideo+bestaudio/best",
                "label": "Best available",
                "ext": info.get("ext", "mp4"),
            }
        )

    return options


def describe_format(fmt: Dict[str, Any]) -> str:
    """Generate a human-friendly label for a format entry."""
    height = fmt.get("height")
    fps = fmt.get("fps")
    note = fmt.get("format_note")
    resolution = fmt.get("resolution")

    if height:
        res_label = f"{height}p"
        if fps:
            res_label += f"{int(fps)}"
    else:
        res_label = resolution or "Video"

    parts = [res_label.strip()]
    if note and note.lower() not in {"dash video", "dash audio", "default"}:
        parts.append(note)
    ext = fmt.get("ext")
    if ext:
        parts.append(ext)
    bitrate = fmt.get("tbr")
    if bitrate:
        parts.append(f"{round(bitrate / 1000, 1)} Mbps")

    label = " • ".join(part for part in parts if part)
    return label or str(fmt.get("format_id", "unknown"))

def pick_thumbnail(info: Dict[str, Any]) -> Optional[str]:
    """Choose the highest-resolution thumbnail URL available."""
    if info.get("thumbnail"):
        return info["thumbnail"]

    thumbnails = info.get("thumbnails") or []
    if thumbnails:
        thumbnails = sorted(thumbnails, key=lambda thumb: thumb.get("height") or 0, reverse=True)
        candidate = thumbnails[0].get("url")
        if candidate:
            return candidate

    video_id = info.get("id")
    if video_id:
        return f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"

    return None


class VideoInfoHandler(BaseHTTPRequestHandler):
    server_version = "VideoDLServer/0.1"

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api(parsed)
            return

        self._serve_static(parsed.path or "/")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003 - keeping name for BaseHTTPRequestHandler
        sys.stdout.write(
            "[api] "
            + format
            % args
            + "\n"
        )

    def _handle_api(self, parsed) -> None:
        if parsed.path == "/api/video-info":
            params = parse_qs(parsed.query)
            url = (params.get("url") or [""])[0].strip()
            if not url:
                self._send_json({"error": "Missing url parameter"}, HTTPStatus.BAD_REQUEST)
                return

            try:
                payload = self._extract_info(url)
            except Exception as exc:  # pragma: no cover - surface raw error to caller
                self._send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
                return

            self._send_json(payload, HTTPStatus.OK)
        elif parsed.path == "/api/default-path":
            default_path = str((Path.home() / "Downloads").expanduser())
            self._send_json({"path": default_path}, HTTPStatus.OK)
        else:
            self.send_error(HTTPStatus.NOT_FOUND.value, "Endpoint not found")
            return

    def _serve_static(self, path: str) -> None:
        requested = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB_ROOT / requested).resolve()

        if not str(target).startswith(str(WEB_ROOT)):
            self.send_error(HTTPStatus.NOT_FOUND.value, "Invalid path")
            return

        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND.value, "File not found")
            return

        mime, _ = mimetypes.guess_type(target.name)
        body = target.read_bytes()

        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _extract_info(self, url: str) -> Dict[str, Any]:
        ydl_opts = {
            "quiet": True,
            "skip_download": True,
            "nocheckcertificate": True,
            "no_warnings": True,
        }
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        return {
            "title": info.get("title"),
            "description": info.get("description") or "",
            "uploader": info.get("uploader"),
            "duration": info.get("duration"),
            "formats": build_format_options(info),
            "thumbnail": pick_thumbnail(info),
        }

    def _send_json(self, payload: Dict[str, Any], status: HTTPStatus) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local API server for the video downloader UI.")
    parser.add_argument("--host", default="127.0.0.1", help="Interface to bind (default: %(default)s)")
    parser.add_argument("--port", type=int, default=5050, help="Port to bind (default: %(default)s)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), VideoInfoHandler)
    print(f"Video downloader API running at http://{args.host}:{args.port}")
    print("Serving UI + API. UI: http://%s:%s/  Endpoint: GET /api/video-info?url=<YouTube URL>" % (args.host, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down…")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
