#!/usr/bin/env python3
"""Local server that puts the BhashaCheck Lite workbench (./bhashacheck-lite) over this project's
audio and RSML files, and autosaves the annotator's work straight into those RSML files.

    python3 library_server.py [--port 8766]

then open http://localhost:8766/library.html. It serves

    /                         docs/                      the app
    /library/index.json       the videos in telugu_cc_final.csv, in that order (+ progress read from each rsml)
    /library/audio/<id>.wav   data/telugu/<id>.wav
    /library/rsml/<id>.rsml   data/telugu/<id>.rsml

and the app saves through

    POST   /library/save/<id>   body = the video's whole RSML  -> data/telugu/<id>.rsml

The rsml file is the only copy of a video's segments, speakers and transcript: the browser keeps nothing
(no IndexedDB), and there is no history or backup. Every save replaces the file atomically (a temp file,
then os.replace), and a save whose text is identical to what is on disk is skipped.

Bound to 127.0.0.1. Only ids listed in the CSV (with audio and rsml present) are served or written,
requests whose Host is not localhost / 127.0.0.1 are refused, and writes also need the app's
X-Library header and a same-origin Origin, so another website cannot write through the browser.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
FIELDS = ("id", "title", "channel", "url", "upload_date", "duration_s", "batch", "style",
          "speakers_detected", "speaker_share_pct", "vad_segments", "vad_speech_s", "segmentation_source")
NOT_FOUND = str(HERE / ".no-such-file")
LIB_FILE = re.compile(r"/library/(audio|rsml)/([\w-]+)\.(wav|rsml)")
SAVE_PATH = re.compile(r"/library/save/([\w-]+)")
META_LINE = re.compile(r"^primary=[^|]*\|verified=([01])\|flagged=([01])\|note=", re.M)
MAX_BODY = 10_000_000


def load_videos(csv_path: Path, audio_dir: Path, rsml_dir: Path) -> list[dict]:
    videos = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if not ((audio_dir / f"{r['id']}.wav").exists() and (rsml_dir / f"{r['id']}.rsml").exists()):
                print(f"skipping {r['id']}: audio or rsml missing", file=sys.stderr)
                continue
            v = {k: r.get(k, "") for k in FIELDS}
            v["duration_s"] = float(v["duration_s"] or 0)
            v["vad_speech_s"] = float(v["vad_speech_s"] or 0)
            for k in ("batch", "speakers_detected", "vad_segments"):
                v[k] = int(v[k] or 0)
            videos.append(v)
    return videos


def summarize(path: Path) -> dict | None:
    """Progress in an RSML file, read from its per-cue metadata lines."""
    try:
        metas = META_LINE.findall(path.read_text(encoding="utf-8"))
        mtime = path.stat().st_mtime
    except OSError:
        return None
    return {"segments": len(metas), "verified": sum(v == "1" for v, _ in metas),
            "flagged": sum(f == "1" for _, f in metas), "mtime": mtime}


def write_rsml(dest: Path, text: str) -> bool:
    """Replace dest atomically with text; False if it already held exactly that."""
    data = text.encode("utf-8")
    try:
        if dest.read_bytes() == data:
            return False
    except OSError:
        pass
    tmp = dest.with_name(f".{dest.name}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    return True


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".rsml": "text/plain; charset=utf-8", ".wav": "audio/wav"}
    videos: list[dict] = []
    ids: set[str] = set()
    audio_dir = rsml_dir = HERE
    port = 0

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")   # the app's modules change while it is being worked on
        super().end_headers()

    def _allowed(self, write: bool = False) -> bool:
        origins = (f"http://localhost:{self.port}", f"http://127.0.0.1:{self.port}")
        if self.headers.get("Host", "").lower() not in tuple(o[7:] for o in origins):
            self.send_error(403, "unexpected Host header")
        elif write and (self.headers.get("X-Library") != "1" or self.headers.get("Origin", origins[0]) not in origins):
            self.send_error(403, "writes only from the app itself")
        else:
            return True
        return False

    def _json(self, obj, status: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        if self._allowed():
            super().do_HEAD()

    def do_GET(self):
        if not self._allowed():
            return
        if urlsplit(self.path).path == "/library/index.json":
            self._json([{**v, "progress": summarize(self.rsml_dir / f"{v['id']}.rsml")} for v in self.videos])
            return
        super().do_GET()

    def do_POST(self):
        if not self._allowed(write=True):
            return
        m = SAVE_PATH.fullmatch(unquote(urlsplit(self.path).path))
        if not m or m[1] not in self.ids:
            return self.send_error(404)
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_BODY:
            return self.send_error(413 if n else 400, "body size")
        try:
            text = self.rfile.read(n).decode("utf-8")
        except UnicodeDecodeError:
            return self.send_error(400, "not UTF-8")
        if "-->" not in text or "# BhashaCheck config" not in text:   # what the app's export always writes
            return self.send_error(400, "not an RSML file")
        changed = write_rsml(self.rsml_dir / f"{m[1]}.rsml", text)
        self._json({"ok": True, "bytes": n, "changed": changed})

    def translate_path(self, path: str) -> str:
        p = unquote(urlsplit(path).path)
        if p.startswith("/library/"):
            m = LIB_FILE.fullmatch(p)
            if not m or m[2] not in self.ids or (m[1], m[3]) not in (("audio", "wav"), ("rsml", "rsml")):
                return NOT_FOUND
            return str((self.audio_dir if m[1] == "audio" else self.rsml_dir) / f"{m[2]}.{m[3]}")
        return super().translate_path(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--csv", type=Path, default=HERE / "telugu_cc_final.csv", help="the videos to serve")
    ap.add_argument("--audio-dir", type=Path, default=HERE / "data" / "telugu")
    ap.add_argument("--rsml-dir", type=Path, default=HERE / "data" / "telugu", help="the RSML files: served, and overwritten by autosave")
    ap.add_argument("--web", type=Path, default=HERE / "docs", help="the web app (docs/)")
    args = ap.parse_args()
    if not (args.web / "index.html").exists():
        sys.exit(f"{args.web}/index.html not found - the web app should be in docs/")
    Handler.videos = load_videos(args.csv, args.audio_dir, args.rsml_dir)
    Handler.ids = {v["id"] for v in Handler.videos}
    Handler.audio_dir, Handler.rsml_dir = args.audio_dir, args.rsml_dir
    Handler.port = args.port
    if not Handler.videos:
        sys.exit("no videos with both audio and rsml found")
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(args.web)))
    print(f"{len(Handler.videos)} videos | saves go straight into {args.rsml_dir} | open http://localhost:{args.port}/library.html",
          flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
