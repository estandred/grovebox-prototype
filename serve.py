#!/usr/bin/env python3
"""
Beat Studio dev server.

Replaces `python3 -m http.server`. Serves the project folder for static
files (so the app loads as before) AND adds a POST /save-song endpoint
that writes exported song JSON straight into songs/ and updates
songs/manifest.json. Run this on the laptop; the tablet on the same
Wi-Fi hits the LAN IP and exports publish into the laptop's folder
automatically.

Usage:
    cd /Users/eddesanto/beat-studio
    python3 serve.py            # default port 8765
    python3 serve.py 8080       # custom port
"""
import http.server
import json
import os
import re
import socket
import socketserver
import sys
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.path.join(ROOT, "songs")
MANIFEST = os.path.join(SONGS_DIR, "manifest.json")
# Global app prefs shared across every device hitting this server (laptop
# + tablet on the same LAN). Stored alongside the project as a tiny JSON
# file; the client GETs it at boot and POSTs the full object back when a
# pref changes (currently: deckScale).
PREFS_FILE = os.path.join(ROOT, "prefs.json")


def slugify(s):
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:60] or "song"


def load_manifest():
    if not os.path.exists(MANIFEST):
        return {"songs": []}
    try:
        with open(MANIFEST) as f:
            data = json.load(f)
            if not isinstance(data, dict) or not isinstance(data.get("songs"), list):
                return {"songs": []}
            return data
    except Exception:
        return {"songs": []}


def save_manifest(manifest):
    os.makedirs(SONGS_DIR, exist_ok=True)
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


def upsert_manifest_entry(manifest, filename, song_name, updated_at):
    songs = manifest.get("songs", [])
    entry = {"file": filename, "name": song_name, "updatedAt": int(updated_at or 0)}
    for i, item in enumerate(songs):
        existing_file = item if isinstance(item, str) else (item.get("file") if isinstance(item, dict) else None)
        if existing_file == filename:
            songs[i] = entry
            return
    songs.append(entry)


class Handler(http.server.SimpleHTTPRequestHandler):

    # Add permissive CORS so the tablet can POST from any origin if needed.
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # No caching anywhere — this is a dev server. Chrome was holding
        # onto stale app.js / style.css across edits otherwise, making
        # the user think changes hadn't landed.
        self.send_header("Cache-Control", "no-store, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/save-song":
            self._handle_save_song()
            return
        if parsed.path == "/delete-song":
            self._handle_delete_song()
            return
        if parsed.path == "/prefs":
            self._handle_save_prefs()
            return
        self.send_error(404, "unknown endpoint")

    def do_GET(self):
        # Intercept /prefs ourselves; everything else falls through to the
        # built-in static file handler.
        parsed = urlparse(self.path)
        if parsed.path == "/prefs":
            self._handle_get_prefs()
            return
        super().do_GET()

    def _handle_get_prefs(self):
        try:
            data = {}
            if os.path.exists(PREFS_FILE):
                with open(PREFS_FILE) as f:
                    raw = json.load(f)
                    if isinstance(raw, dict):
                        data = raw
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())

    def _handle_save_prefs(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(body) if body.strip() else {}
            if not isinstance(payload, dict):
                raise ValueError("prefs body must be a JSON object")
            with open(PREFS_FILE, "w") as f:
                json.dump(payload, f, indent=2)
                f.write("\n")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())

    def _handle_save_song(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(body)
            if not isinstance(payload, dict) or payload.get("_format") != "beatstudio-song-v1":
                raise ValueError("bad payload format")
            song = payload.get("song") or {}
            song_name = song.get("name") or "song"
            updated_at = song.get("updatedAt") or 0
            filename = slugify(song_name) + ".beatstudio.json"

            os.makedirs(SONGS_DIR, exist_ok=True)
            file_path = os.path.join(SONGS_DIR, filename)
            with open(file_path, "w") as f:
                json.dump(payload, f)

            manifest = load_manifest()
            upsert_manifest_entry(manifest, filename, song_name, updated_at)
            save_manifest(manifest)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "file": filename, "name": song_name}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())

    def _handle_delete_song(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(body) if body.strip() else {}
            requested = payload.get("file") if isinstance(payload, dict) else None
            if not requested:
                raise ValueError("missing 'file' in body")
            # Strip any path separators so the client can't reach outside SONGS_DIR.
            filename = os.path.basename(requested)
            file_path = os.path.join(SONGS_DIR, filename)
            if os.path.exists(file_path):
                os.remove(file_path)
            # Always update the manifest: removes the entry whether or not the
            # underlying file existed (handles dangling references too).
            manifest = load_manifest()
            songs = manifest.get("songs", [])
            songs = [s for s in songs if (s if isinstance(s, str) else s.get("file")) != filename]
            manifest["songs"] = songs
            save_manifest(manifest)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "file": filename}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] " + (fmt % args) + "\n")


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded server — a hung browser connection no longer freezes the
    whole process. allow_reuse_address lets us restart quickly without
    waiting for TIME_WAIT to clear on the port."""
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.chdir(ROOT)
    os.makedirs(SONGS_DIR, exist_ok=True)
    if not os.path.exists(MANIFEST):
        save_manifest({"songs": []})

    httpd = ThreadedHTTPServer(("0.0.0.0", PORT), Handler)
    ip = lan_ip()
    print(f"Beat Studio dev server")
    print(f"  serving:  {ROOT}")
    print(f"  laptop:   http://localhost:{PORT}/")
    print(f"  network:  http://{ip}:{PORT}/")
    print(f"  songs:    {SONGS_DIR}")
    print(f"Ctrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.server_close()


if __name__ == "__main__":
    main()
