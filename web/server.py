#!/usr/bin/env python3
"""Minimal local API layer that exposes yt-dlp video metadata to the web UI.

Run with:  python web/server.py --port 5050
Then open web/index.html in a browser and paste a YouTube URL to fetch details.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
import traceback
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

PROJECT_ROOT = Path(__file__).resolve().parents[1]
YTDLP_SOURCE = PROJECT_ROOT / "yt-dlp"
WEB_ROOT = Path(__file__).resolve().parent

for path in (PROJECT_ROOT, YTDLP_SOURCE):
    path_str = str(path)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)

from yt_dlp import YoutubeDL  # type: ignore  # local package import
from yt_dlp import version as yt_dlp_version  # type: ignore
from yt_dlp.cookies import SUPPORTED_KEYRINGS  # type: ignore

AUTH_COOKIE_SOURCE = "chrome"
AUTH_PROFILE_ENV = "VIDEO_DL_CHROME_PROFILE"


def normalize_youtube_url(url: str) -> str:
    """Return a canonical YouTube watch URL when possible."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return url

    host = (parsed.hostname or "").lower()
    if host.endswith("youtu.be"):
        video_id = (parsed.path or "").lstrip("/").split("/")[0]
        if video_id:
            return f"https://www.youtube.com/watch?v={video_id}"

    if host.endswith("youtube.com") or host.endswith("youtube-nocookie.com"):
        qs = parse_qs(parsed.query)
        video_id = (qs.get("v") or [""])[0]
        if video_id:
            return f"https://www.youtube.com/watch?v={video_id}"

    return url


def build_format_options(info: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return resolution-tier options that use yt-dlp's DASH merge (bestvideo+bestaudio).

    Instead of listing individual progressive streams (which cap at ~720p on modern
    YouTube), we detect which resolutions are actually available and offer clean tiers.
    """
    formats = info.get("formats") or []

    # Collect available video heights (DASH or progressive)
    available_heights: set = set()
    for fmt in formats:
        if fmt.get("vcodec") not in (None, "none") and fmt.get("height"):
            available_heights.add(fmt["height"])

    # Define tiers from highest to lowest
    TIERS = [
        (2160, "4K (2160p)"),
        (1440, "1440p"),
        (1080, "1080p"),
        (720,  "720p"),
        (480,  "480p"),
        (360,  "360p"),
    ]

    options: List[Dict[str, Any]] = []

    # Always offer "Best Available" as default
    options.append({
        "id": "bestvideo+bestaudio/best",
        "label": "Best Available (mkv)",
        "ext": "mkv",
        "format_string": "bestvideo+bestaudio/best",
    })

    # Add tiers where at least one format matches
    for height, label in TIERS:
        if any(h >= height for h in available_heights):
            options.append({
                "id": f"tier_{height}",
                "label": f"{label} (mp4)",
                "ext": "mp4",
                "format_string": f"bestvideo[height<={height}]+bestaudio/best",
            })

    # Audio-only option
    options.append({
        "id": "bestaudio",
        "label": "Audio only (m4a)",
        "ext": "m4a",
        "format_string": "bestaudio/best",
    })

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


def build_language_options(info: Dict[str, Any]) -> List[Dict[str, str]]:
    formats = info.get("formats") or []
    languages: Dict[str, Dict[str, str]] = {}
    for fmt in formats:
        code = fmt.get("language") or "und"
        if code in languages:
            continue
        label = fmt.get("language_preference") or fmt.get("language_name")
        if not label:
            label = code if code != "und" else "Unknown"
        languages[code] = {"code": code, "label": label}

    ordered = list(languages.values())
    ordered.sort(key=lambda item: (item["code"] != "en", item["label"]))
    return ordered

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


def format_speed(speed: Optional[float]) -> str:
    """Format download speed in human-readable form."""
    if not speed:
        return "—"
    if speed >= 1_000_000:
        return f"{speed / 1_000_000:.1f} MB/s"
    if speed >= 1_000:
        return f"{speed / 1_000:.0f} KB/s"
    return f"{speed:.0f} B/s"


def format_eta(eta: Optional[int]) -> str:
    """Format ETA seconds into mm:ss or hh:mm:ss."""
    if eta is None:
        return "—"
    eta = int(eta)
    if eta <= 0:
        return "—"
    hours = eta // 3600
    minutes = (eta % 3600) // 60
    seconds = eta % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


class AuthRequiredError(Exception):
    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def get_chrome_profile() -> Optional[str]:
    profile = os.environ.get(AUTH_PROFILE_ENV, "").strip()
    return profile or None


def cookie_cli_arg() -> str:
    profile = get_chrome_profile()
    return f"{AUTH_COOKIE_SOURCE}:{profile}" if profile else AUTH_COOKIE_SOURCE


def cookie_spec() -> Tuple[str, Optional[str], Optional[str], Optional[str]]:
    profile = get_chrome_profile()
    return (AUTH_COOKIE_SOURCE, profile, None, None)


def validate_url(value: str) -> bool:
    if not value:
        return False
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def summarize_probe_error(message: str) -> str:
    if not message:
        return "Probe failed"
    for line in message.splitlines():
        cleaned = line.strip()
        if cleaned:
            if cleaned.lower().startswith("error:"):
                cleaned = cleaned[6:].strip()
            return cleaned[:240]
    return "Probe failed"


def ytdlp_version_payload() -> Dict[str, Any]:
    """Expose yt-dlp build info for quick debugging."""
    ver = getattr(yt_dlp_version, "__version__", "unknown")
    age_days: Optional[int] = None
    warning: Optional[str] = None

    try:
        parts = [int(p) for p in str(ver).split(".")[:3]]
        built = date(parts[0], parts[1], parts[2])
        age_days = (date.today() - built).days
        if age_days >= 30:
            warning = (
                f"yt-dlp is {age_days} days old. If metadata broke recently, update the yt-dlp submodule "
                "and restart the server."
            )
    except Exception:
        pass

    extractor_status: Dict[str, Any] = {"name": "youtube", "ok": True}
    try:
        from yt_dlp.extractor.youtube import YoutubeIE  # type: ignore

        extractor_status["version"] = getattr(YoutubeIE, "_VERSION", None)
    except Exception as exc:
        extractor_status = {"name": "youtube", "ok": False, "error": str(exc)}

    return {
        "yt_dlp": {
            "version": ver,
            "age_days": age_days,
            "warning": warning,
        },
        "extractor": extractor_status,
    }


def run_yt_dlp_probe(url: str) -> Tuple[bool, str]:
    env = os.environ.copy()
    pythonpath = env.get("PYTHONPATH", "")
    entries = [str(PROJECT_ROOT), str(YTDLP_SOURCE)]
    if pythonpath:
        entries.append(pythonpath)
    env["PYTHONPATH"] = os.pathsep.join(entries)
    browser_arg = cookie_cli_arg()
    canonical_url = normalize_youtube_url(url)
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "-J",
        "--skip-download",
        "--no-warnings",
        "--ignore-config",
        "--no-playlist",
        "--js-runtimes", "node",
        "--remote-components", "ejs:github",
        "--cookies-from-browser",
        browser_arg,
        canonical_url,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            env=env,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, summarize_probe_error(str(exc))
    if result.returncode == 0:
        return True, ""
    stderr = result.stderr or result.stdout or ""
    return False, summarize_probe_error(stderr)


def auth_status_payload(url: Optional[str]) -> Dict[str, Any]:
    if not url or not validate_url(url):
        return {"ok": False, "browser": AUTH_COOKIE_SOURCE, "reason": "Invalid URL"}
    ok, reason = run_yt_dlp_probe(url)
    return {
        "ok": ok,
        "browser": AUTH_COOKIE_SOURCE,
        "reason": "" if ok else reason,
    }


def auth_get_payload(url: str) -> Dict[str, Any]:
    ok, reason = run_yt_dlp_probe(url)
    return {
        "ok": ok,
        "browser": AUTH_COOKIE_SOURCE,
        "reason": "" if ok else reason,
    }


def auth_error_detail(message: str) -> Optional[str]:
    if not message:
        return None
    lowered = message.lower()
    if "sign in to confirm" in lowered or "not a bot" in lowered:
        return summarize_probe_error(message)
    if "http error 403" in lowered or "403 forbidden" in lowered or "status code 403" in lowered:
        return summarize_probe_error(message)
    return None

class VideoInfoHandler(BaseHTTPRequestHandler):
    server_version = "VideoDLServer/0.1"
    ydl_auth_opts: Dict[str, Any] = {}
    base_ydl_opts: Dict[str, Any] = {
        "quiet": True,
        "nocheckcertificate": True,
        "no_warnings": True,
        "ignoreconfig": True,
        # YouTube requires JS challenge solving for signatures/n-parameter.
        # Since yt-dlp is loaded from a git submodule (not PyPI), EJS scripts
        # aren't bundled — fetch them from GitHub on first use.
        "js_runtimes": {"node": {}},
        "remote_components": {"ejs:github"},
    }

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api(parsed)
            return

        self._serve_static(parsed.path or "/")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/download":
            self._handle_download()
            return
        if parsed.path == "/api/download-stream":
            self._handle_download_stream()
            return
        if parsed.path == "/api/auth-get":
            self._handle_auth_get()
            return

        self.send_error(HTTPStatus.NOT_FOUND.value, "Endpoint not found")

    def do_OPTIONS(self) -> None:  # noqa: N802 - CORS preflight
        self.send_response(HTTPStatus.NO_CONTENT.value)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

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
            except AuthRequiredError as exc:
                self._send_json({"error": "AUTH_REQUIRED", "detail": exc.detail}, HTTPStatus.UNAUTHORIZED)
                return
            except Exception as exc:  # pragma: no cover - surface raw error to caller
                self._send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
                return

            self._send_json(payload, HTTPStatus.OK)
        elif parsed.path == "/api/auth-status":
            params = parse_qs(parsed.query)
            url = (params.get("url") or [""])[0].strip()
            payload = auth_status_payload(url or None)
            self._send_json(payload, HTTPStatus.OK)
        elif parsed.path == "/api/default-path":
            default_path = str((Path.home() / "Downloads").expanduser())
            self._send_json({"path": default_path}, HTTPStatus.OK)
        elif parsed.path == "/api/diagnostics":
            self._send_json(ytdlp_version_payload(), HTTPStatus.OK)
        else:
            self.send_error(HTTPStatus.NOT_FOUND.value, "Endpoint not found")
            return

    def _handle_download(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            content_length = 0

        raw_body = self.rfile.read(content_length) if content_length else b""
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON payload"}, HTTPStatus.BAD_REQUEST)
            return

        url = (payload.get("url") or "").strip()
        quality = (payload.get("quality") or "").strip()
        format_string = (payload.get("format_string") or "").strip()
        target = (payload.get("path") or "").strip()
        language = (payload.get("language") or "").strip()

        if not url:
            self._send_json({"error": "Missing url"}, HTTPStatus.BAD_REQUEST)
            return

        save_dir = self._resolve_save_dir(target)
        save_dir.mkdir(parents=True, exist_ok=True)

        try:
            result = self._download_video(url, quality, save_dir, format_string=format_string)
        except AuthRequiredError as exc:
            self._send_json({"error": "AUTH_REQUIRED", "detail": exc.detail}, HTTPStatus.UNAUTHORIZED)
            return
        except Exception as exc:  # pragma: no cover - surfaces yt-dlp errors
            traceback.print_exc()
            self._send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self._send_json(result, HTTPStatus.OK)

    def _handle_download_stream(self) -> None:
        """SSE endpoint that streams real yt-dlp progress to the frontend."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            content_length = 0

        raw_body = self.rfile.read(content_length) if content_length else b""
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON payload"}, HTTPStatus.BAD_REQUEST)
            return

        url = (payload.get("url") or "").strip()
        quality = (payload.get("quality") or "").strip()
        format_string = (payload.get("format_string") or "").strip()
        target = (payload.get("path") or "").strip()

        if not url:
            self._send_json({"error": "Missing url"}, HTTPStatus.BAD_REQUEST)
            return

        save_dir = self._resolve_save_dir(target)
        save_dir.mkdir(parents=True, exist_ok=True)

        # Set up SSE response
        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        def send_event(data: Dict[str, Any]) -> None:
            try:
                line = f"data: {json.dumps(data)}\n\n"
                self.wfile.write(line.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

        def progress_hook(d: Dict[str, Any]) -> None:
            status = d.get("status", "")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded = d.get("downloaded_bytes", 0)
                percent = round((downloaded / total * 100), 1) if total else 0
                speed = d.get("speed")
                eta = d.get("eta")
                send_event({
                    "type": "progress",
                    "percent": percent,
                    "speed": format_speed(speed),
                    "eta": format_eta(eta),
                    "status": "downloading",
                })
            elif status == "finished":
                send_event({
                    "type": "progress",
                    "percent": 100,
                    "speed": "—",
                    "eta": "—",
                    "status": "merging",
                })

        # Build format string
        if format_string:
            fmt = format_string
        elif quality:
            fmt = f"{quality}/bestvideo+bestaudio/best"
        else:
            fmt = "bestvideo+bestaudio/best"

        merge_fmt = "mp4"
        if fmt == "bestvideo+bestaudio/best":
            merge_fmt = "mkv"
        elif "bestaudio" in fmt and "bestvideo" not in fmt:
            merge_fmt = None

        output_template = str(save_dir / "%(title)s.%(ext)s")
        extra_opts: Dict[str, Any] = {
            "format": fmt,
            "outtmpl": output_template,
            "paths": {"home": str(save_dir)},
            "noprogress": True,
            "progress_hooks": [progress_hook],
        }
        if merge_fmt:
            extra_opts["merge_output_format"] = merge_fmt

        ydl_opts = self._compose_ydl_opts(**extra_opts)

        try:
            with YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(info)

            send_event({
                "type": "complete",
                "title": info.get("title"),
                "filepath": filename,
                "format_id": info.get("format_id"),
            })
        except Exception as exc:
            detail = auth_error_detail(str(exc))
            send_event({
                "type": "error",
                "error": detail or str(exc),
            })

    def _handle_auth_get(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            content_length = 0

        raw_body = self.rfile.read(content_length) if content_length else b""
        try:
            payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON payload"}, HTTPStatus.BAD_REQUEST)
            return

        url = (payload.get("url") or "").strip()
        if not validate_url(url):
            self._send_json(
                {"ok": False, "browser": AUTH_COOKIE_SOURCE, "reason": "Invalid URL"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        result = auth_get_payload(url)
        self._send_json(result, HTTPStatus.OK)

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
        canonical_url = normalize_youtube_url(url)
        ydl_opts = self._compose_ydl_opts(
            skip_download=True,
            noplaylist=True,
            extract_flat=False,
        )
        try:
            with YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(canonical_url, download=False)
        except Exception as exc:
            detail = auth_error_detail(str(exc))
            if detail:
                raise AuthRequiredError(detail)
            raise

        return {
            "title": info.get("title"),
            "description": info.get("description") or "",
            "uploader": info.get("uploader"),
            "duration": info.get("duration"),
            "formats": build_format_options(info),
            "thumbnail": pick_thumbnail(info),
            "languages": build_language_options(info),
        }

    def _download_video(self, url: str, quality: str, save_dir: Path, format_string: str = "") -> Dict[str, Any]:
        # Use the format_string from the tier if provided, else fall back
        if format_string:
            fmt = format_string
        elif quality:
            fmt = f"{quality}/bestvideo+bestaudio/best"
        else:
            fmt = "bestvideo+bestaudio/best"

        # Determine merge format based on the format string
        merge_fmt = "mp4"
        if fmt == "bestvideo+bestaudio/best":
            merge_fmt = "mkv"  # Best available keeps original quality
        elif "bestaudio" in fmt and "bestvideo" not in fmt:
            merge_fmt = None  # Audio-only, no merge needed

        output_template = str(save_dir / "%(title)s.%(ext)s")
        extra_opts: Dict[str, Any] = {
            "format": fmt,
            "outtmpl": output_template,
            "paths": {"home": str(save_dir)},
            "noprogress": True,
        }
        if merge_fmt:
            extra_opts["merge_output_format"] = merge_fmt

        ydl_opts = self._compose_ydl_opts(**extra_opts)

        try:
            with YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(info)
        except Exception as exc:
            detail = auth_error_detail(str(exc))
            if detail:
                raise AuthRequiredError(detail)
            raise
        return {
            "status": "ok",
            "title": info.get("title"),
            "filepath": filename,
            "format_id": info.get("format_id"),
        }

    def _resolve_save_dir(self, provided: str) -> Path:
        if provided:
            path = Path(provided).expanduser()
        else:
            path = Path.home() / "Downloads"
        return path

    def _send_json(self, payload: Dict[str, Any], status: HTTPStatus) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _compose_ydl_opts(self, **overrides: Any) -> Dict[str, Any]:
        opts: Dict[str, Any] = dict(self.base_ydl_opts)
        opts.update(self.ydl_auth_opts)
        opts.update(overrides)
        # Cookie precedence: CLI cookiefile -> CLI cookiesfrombrowser -> default chrome cookies.
        if "cookiefile" in self.ydl_auth_opts:
            opts.pop("cookiesfrombrowser", None)
        elif "cookiesfrombrowser" in self.ydl_auth_opts:
            opts.pop("cookiefile", None)
        elif "cookiefile" in opts:
            opts.pop("cookiesfrombrowser", None)
        elif "cookiesfrombrowser" in opts:
            opts.pop("cookiefile", None)
        else:
            opts["cookiesfrombrowser"] = cookie_spec()
            opts.pop("cookiefile", None)
        return opts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local API server for the video downloader UI.")
    parser.add_argument("--host", default="127.0.0.1", help="Interface to bind (default: %(default)s)")
    parser.add_argument("--port", type=int, default=5050, help="Port to bind (default: %(default)s)")
    parser.add_argument(
        "--cookies-file",
        dest="cookies_file",
        help="Path to a Netscape cookies.txt file to forward to yt-dlp for authenticated requests.",
    )
    parser.add_argument(
        "--cookies-from-browser",
        dest="cookies_from_browser",
        metavar="SPEC",
        help=(
            "Load cookies from a browser using yt-dlp's syntax "
            "(e.g. 'safari', 'chrome:Profile 1', 'brave+keyring:Default')."
        ),
    )

    args = parser.parse_args()

    if args.cookies_file:
        cookie_path = Path(args.cookies_file).expanduser()
        if not cookie_path.exists():
            parser.error(f"Cookies file not found: {cookie_path}")
        args.cookies_file = str(cookie_path)

    if args.cookies_from_browser:
        try:
            args.cookies_from_browser = parse_browser_cookie_spec(args.cookies_from_browser)
        except ValueError as exc:  # pragma: no cover - validation error surfaces to user
            parser.error(str(exc))

    return args


COOKIE_SPEC_RE = re.compile(
    r"""
    (?P<name>[^+:]+)              # browser name, e.g. chrome
    (?:\s*\+\s*(?P<keyring>[^:]+))?   # optional keyring segment
    (?:\s*:\s*(?!:)(?P<profile>.+?))? # optional profile after colon
    (?:\s*::\s*(?P<container>.+))?    # optional container (Firefox)
""",
    re.VERBOSE,
)


def parse_browser_cookie_spec(spec: str) -> Tuple[str, Optional[str], Optional[str], Optional[str]]:
    spec = spec.strip()
    match = COOKIE_SPEC_RE.fullmatch(spec)
    if not match:
        raise ValueError(f"Invalid cookies-from-browser value: {spec!r}")

    browser_name = match.group("name").lower()
    if browser_name != AUTH_COOKIE_SOURCE:
        raise ValueError(f'Unsupported browser "{browser_name}". Only "{AUTH_COOKIE_SOURCE}" is supported.')

    keyring = match.group("keyring")
    if keyring is not None:
        keyring = keyring.upper()
        if keyring not in SUPPORTED_KEYRINGS:
            supported = ", ".join(sorted(SUPPORTED_KEYRINGS))
            raise ValueError(f'Unsupported keyring "{keyring}". Supported keyrings: {supported}')

    profile = match.group("profile")
    container = match.group("container")
    return browser_name, profile, keyring, container


def main() -> None:
    args = parse_args()
    auth_opts: Dict[str, Any] = {}
    if getattr(args, "cookies_file", None):
        auth_opts["cookiefile"] = args.cookies_file
    if getattr(args, "cookies_from_browser", None):
        auth_opts["cookiesfrombrowser"] = args.cookies_from_browser
    if auth_opts:
        print("Cookies configured for yt-dlp requests.")
    VideoInfoHandler.ydl_auth_opts = auth_opts
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
