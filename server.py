from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from html import unescape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen
import json
import re
import sys
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        parsed = urlparse(path)
        clean = parsed.path.lstrip("/")
        return str((ROOT / clean).resolve())

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/subtitles":
            self.handle_subtitles(parsed)
            return
        super().do_GET()

    def handle_subtitles(self, parsed):
        params = parse_qs(parsed.query)
        video_id = (params.get("video_id") or params.get("v") or [""])[0]
        preferred_lang = (params.get("lang") or ["en"])[0]

        if not VIDEO_ID_RE.match(video_id):
            self.write_json({"error": "Invalid YouTube video ID."}, 400)
            return

        try:
            payload = fetch_subtitles(video_id, preferred_lang)
        except SubtitleError as exc:
            self.write_json({"error": str(exc)}, exc.status)
            return
        except (HTTPError, URLError, TimeoutError) as exc:
            self.write_json({"error": f"Could not reach YouTube captions: {exc}"}, 502)
            return
        except Exception as exc:
            self.write_json({"error": f"Subtitle loader failed: {exc}"}, 500)
            return

        self.write_json(payload, 200)

    def write_json(self, payload, status):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SubtitleError(Exception):
    def __init__(self, message, status=404):
        super().__init__(message)
        self.status = status


def youtube_get(url):
    request = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
            )
        },
    )
    with urlopen(request, timeout=12) as response:
        return response.read()


def fetch_subtitles(video_id, preferred_lang):
    tracks = fetch_timedtext_tracks(video_id)
    watch_tracks = []

    if not tracks:
        watch_tracks = fetch_watch_page_tracks(video_id)
        tracks = watch_tracks

    if not tracks:
        raise SubtitleError("No YouTube captions are available for this video.")

    selected = select_track(tracks, preferred_lang)
    if selected.get("baseUrl"):
        separator = "&" if "?" in selected["baseUrl"] else "?"
        subtitle_url = f"{selected['baseUrl']}{separator}fmt=json3"
    else:
        query = {
            "v": video_id,
            "lang": selected.get("lang_code", ""),
            "fmt": "json3",
        }
        if selected.get("name"):
            query["name"] = selected["name"]
        if selected.get("kind"):
            query["kind"] = selected["kind"]
        subtitle_url = "https://www.youtube.com/api/timedtext?" + urlencode(
            query, quote_via=quote
        )

    raw = youtube_get(subtitle_url)
    data = json.loads(raw.decode("utf-8") or "{}")
    cues = json3_to_cues(data)

    if not cues:
        raise SubtitleError(
            "YouTube lists captions for this video, but blocked or returned an empty caption file.",
            502,
        )

    return {
        "videoId": video_id,
        "language": selected.get("lang_code", ""),
        "languageName": selected.get(
            "lang_translated", selected.get("lang_original", selected.get("name", ""))
        ),
        "tracks": [
            {
                "language": track.get("lang_code", ""),
                "name": track.get(
                    "lang_translated", track.get("lang_original", track.get("name", ""))
                ),
                "kind": track.get("kind", ""),
            }
            for track in tracks
        ],
        "cues": cues,
    }


def fetch_timedtext_tracks(video_id):
    track_url = "https://www.youtube.com/api/timedtext?" + urlencode(
        {"type": "list", "v": video_id}
    )
    track_xml = youtube_get(track_url)
    if not track_xml.strip():
        return []
    root = ET.fromstring(track_xml)
    return [track.attrib for track in root.findall("track")]


def fetch_watch_page_tracks(video_id):
    watch_url = f"https://www.youtube.com/watch?v={video_id}&hl=en"
    html = youtube_get(watch_url).decode("utf-8", errors="ignore")
    data = extract_player_response(html)
    renderer = (
        data.get("captions", {})
        .get("playerCaptionsTracklistRenderer", {})
    )
    tracks = []
    for track in renderer.get("captionTracks", []):
        name = track.get("name", {})
        label = name.get("simpleText") or "".join(
            item.get("text", "") for item in name.get("runs", [])
        )
        tracks.append(
            {
                "baseUrl": track.get("baseUrl", ""),
                "lang_code": track.get("languageCode", ""),
                "lang_original": label,
                "lang_translated": label,
                "kind": track.get("kind", ""),
                "name": label,
            }
        )
    return [track for track in tracks if track.get("baseUrl")]


def extract_player_response(html):
    marker = "ytInitialPlayerResponse"
    start = html.find(marker)
    if start == -1:
        raise SubtitleError("Could not find YouTube player metadata.", 502)
    brace_start = html.find("{", start)
    if brace_start == -1:
        raise SubtitleError("Could not parse YouTube player metadata.", 502)

    depth = 0
    in_string = False
    escaped = False
    for index in range(brace_start, len(html)):
        char = html[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return json.loads(html[brace_start : index + 1])

    raise SubtitleError("Could not parse YouTube player metadata.", 502)


def select_track(tracks, preferred_lang):
    if preferred_lang:
        for track in tracks:
            if track.get("lang_code") == preferred_lang:
                return track
        for track in tracks:
            if track.get("lang_code", "").startswith(preferred_lang):
                return track
    for track in tracks:
        if track.get("lang_code", "").startswith("en"):
            return track
    return tracks[0]


def json3_to_cues(data):
    cues = []
    for event in data.get("events", []):
        segs = event.get("segs") or []
        text = "".join(seg.get("utf8", "") for seg in segs)
        text = " ".join(unescape(text).split())
        if not text:
            continue
        start = event.get("tStartMs", 0) / 1000
        duration = event.get("dDurationMs", 0) / 1000
        cues.append(
            {
                "start": start,
                "end": start + max(duration, 0.8),
                "text": text,
            }
        )
    return cues


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    server = ThreadingHTTPServer(("", port), Handler)
    print(f"Serving Shadowing Studio on http://localhost:{port}")
    server.serve_forever()
