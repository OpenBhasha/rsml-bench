#!/usr/bin/env python3
"""Find Telugu lectures / tutorials / courses on YouTube that are CC-BY licensed,
where Telugu is the *original* (primary) audio and not a dub.

Pipeline
  1. Discover  - YouTube search with the "Creative Commons" filter (no API key) over a
                 list of Telugu queries; optionally expand playlists / channels (--seed).
  2. Verify    - full yt-dlp metadata per candidate (cached, so reruns are cheap):
                   * license must be "Creative Commons Attribution"
                   * multi-audio videos: the track YouTube tags "original" must be Telugu;
                     a Telugu track on an English/Hindi original is a dub -> dropped
                   * title/description dub keywords -> dropped
  3. Classify  - confidence column in the output:
                   confirmed - Telugu is the original audio per YouTube metadata
                               (multi-audio original, or the uploader declared "te"), or
                               Whisper heard Telugu (--verify-audio)
                   likely    - no audio language recorded; Telugu script / "Telugu" in
                               title or description
                   conflict  - uploader declared another language (YouTube defaults many
                               uploads to en/hi) but title/description say Telugu
  4. --verify-audio (recommended) - Whisper language-ID on short clips cut from each video.
     This is the only check that actually listens, so it settles 'likely'/'conflict'.
  5. --single-speaker --verify-speakers - monologue batches: interview/discussion/guest formats
     are dropped by title, then diarization of the same clips keeps only videos that are one
     consistent voice, and a video whose voice matches one already selected is skipped
     (voices are compared after centring on the population mean; see voice_similarity).

Usage
  pip install -r requirements.txt
  python find_telugu_cc_videos.py                         # default queries, metadata only
  python find_telugu_cc_videos.py --verify-audio          # + listen to the audio
  python find_telugu_cc_videos.py --seed https://www.youtube.com/@nptelhrd/videos
  python find_telugu_cc_videos.py --query "NPTEL Telugu" --playlists

  # a second batch: 10 h of single-speaker videos, new voices only, nothing already reviewed
  python find_telugu_cc_videos.py --single-speaker --verify-audio --verify-speakers \\
      --exclude-batch telugu_cc_videos.jsonl --prior-decisions review_decisions.jsonl \\
      --verify-top 160 --target-hours 10 --max-per-channel-hours 0.75 --max-duration 3600 \\
      --workers 1 --sleep 3 --out telugu_cc_batch2

Output: telugu_cc_videos.csv / .jsonl  (+ _rejected.* with --keep-rejected).

Notes
  * Scraping is rate-limited by YouTube (HTTP 429 / "confirm you're not a bot"). The script
    stops after 5 consecutive blocks and caches everything fetched so far; rerun later.
    Lower --workers, raise --sleep, or pass --cookies cookies.txt if it keeps happening.
  * YouTube only exposes "Creative Commons Attribution license" (CC BY); the licence version
    is not in the metadata, so "CC BY 4.0" specifically cannot be verified from YouTube.
  * Manually dubbed re-uploads (a separate video, not a second audio track) can only be
    caught by the dub keyword check and by the human reading the title/channel.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote_plus

import yt_dlp

# sp= filters for YouTube search results: type=video + features=Creative Commons, and type=playlist.
SP_VIDEO_CC = "EgQQATAB"
SP_PLAYLIST = "EgIQAw%3D%3D"

CC_LICENSE_PREFIX = "Creative Commons Attribution"

TELUGU_SCRIPT = re.compile(r"[ఀ-౿]")
TELUGU_WORD = re.compile(r"\btelugu\b|\btelugulo\b|తెలుగు", re.IGNORECASE)
# No \b around Telugu text: combining vowel signs are not \w, so \b misfires there.
DUB_CUES = re.compile(
    r"\bdubbed\b|\bdubbing\b|\bauto[- ]?dub|\btelugu dub\b|translated (?:from|to|into)|డబ్బింగ్|అనువాదం",
    re.IGNORECASE,
)

# Telugu x topic queries. Both Telugu script and Latin transliteration, since uploaders use both.
DEFAULT_QUERIES = [
    "NPTEL Telugu", "NPTEL తెలుగు", "IIT lecture Telugu", "Telugu lecture series",
    "Telugu full course", "తెలుగు లో కోర్స్", "తెలుగు ట్యుటోరియల్",
    "Telugu tutorial for beginners", "Telugu playlist course", "తెలుగు పాఠం",
    "Telugu university lecture", "Telugu e-content lecture", "Telugu MOOC", "Telugu swayam",
]
TOPICS = [
    "Python", "C programming", "Java", "data structures", "machine learning", "mathematics",
    "physics", "chemistry", "biology", "electrical engineering", "electronics",
    "civil engineering", "mechanical engineering", "statistics", "economics", "history",
    "grammar", "Telugu literature", "agriculture", "spoken English",
]


# Spontaneous, unscripted speech (interviews, live Q&A, classroom talk) is where disfluencies
# are dense; these queries are searched in addition to DEFAULT_QUERIES.
SPONTANEOUS_QUERIES = [
    "Telugu interview", "తెలుగు ఇంటర్వ్యూ", "Telugu podcast", "తెలుగు పోడ్కాస్ట్",
    "Telugu panel discussion", "తెలుగు చర్చ", "Telugu live class", "Telugu doubt clearing live session",
    "Telugu Q&A session", "Telugu webinar", "Telugu guest lecture", "Telugu motivational speech",
    "తెలుగు ప్రసంగం", "Telugu classroom lecture", "Telugu conversation", "Telugu professor talk",
    "Telugu farmers interview", "Telugu students interview", "Telugu doctor health talk",
    "Telugu teacher live class",
]

# Speech-style tag from title/description -> rough spontaneity score (0-3). This is a *proxy*
# for disfluency density, not a measurement: unscripted dialogue/Q&A > extempore lecture/talk
# > narrated tutorial. First matching row wins.
STYLES = [
    ("interview", 3, re.compile(r"interview|ఇంటర్వ్యూ|podcast|పోడ్కాస్ట్|conversation|chit ?chat|face to face|talk show",
                                re.IGNORECASE)),
    ("discussion", 3, re.compile(r"discussion|debate|panel|చర్చ|q ?& ?a\b|q and a\b|\bama\b|round ?table",
                                 re.IGNORECASE)),
    ("speech", 3, re.compile(r"speech|ప్రసంగం|ఉపన్యాసం|pravachan|ప్రవచనం|motivational|discourse|sermon|భాషణ",
                             re.IGNORECASE)),
    ("lecture", 2, re.compile(r"lecture|\bclass\b|classroom|webinar|workshop|seminar|guest talk|\btalk\b|session",
                              re.IGNORECASE)),
    ("tutorial", 1, re.compile(r"tutorial|how to|step by step|\bcourse\b|ట్యుటోరియల్", re.IGNORECASE)),
]
# Live / doubt-clearing sessions are extempore: bonus on top of the style score.
LIVE_CUES = re.compile(r"\blive\b|doubts?\b|సందేహ", re.IGNORECASE)
# Single-speaker mode: formats that almost always have 2+ voices.
MULTI_SPEAKER_CUES = re.compile(
    r"\bft\.?\b|\bfeat\b|\bvs\.?\b|\bguests?\b|\bwith (?:dr|mr|mrs|ms|shri|sri|smt|prof)\b|సంభాషణ|ముఖాముఖి",
    re.IGNORECASE,
)
# Monologue-oriented queries for --single-speaker: lectures, classes, speeches, discourses, explainers.
MONOLOGUE_QUERIES = [
    "Telugu lecture", "తెలుగు ఉపన్యాసం", "Telugu motivational speech", "తెలుగు ప్రసంగం",
    "Telugu pravachanam", "ప్రవచనం తెలుగు", "Telugu live class", "Telugu classroom lecture",
    "Telugu teacher explains", "Telugu sir class", "Telugu maths class", "Telugu science class",
    "Telugu history lecture", "Telugu polity class", "Telugu economy explained",
    "Telugu current affairs explained", "Telugu grammar class", "Telugu spoken English class",
    "Telugu coding class live", "Telugu programming lecture", "Telugu engineering lecture",
    "NPTEL Telugu", "Telugu health tips doctor explains", "Telugu farming advice",
    "Telugu career guidance talk", "Telugu story telling", "Telugu book review", "Telugu vlog",
    "Telugu product review", "Telugu opinion talk", "Telugu bhagavad gita lecture",
    "Telugu ramayanam discourse", "Telugu law explained", "Telugu stock market class",
    "Telugu personality development speech", "Telugu stress management talk", "Telugu yoga class",
]
# Channels from earlier batches (--exclude-batch): used last in the round-robin, for diversity across batches.
AVOID_CHANNELS: set[str] = set()
# Scripted / performed / sung content: not what we want for spontaneous-speech data.
SCRIPTED_CUES = re.compile(
    r"\bsongs?\b|lyrical|trailer|teaser|full movie|jukebox|\bbgm\b|\bshorts?\b|\breels?\b|whatsapp status|"
    r"stotram|bhajan|rhymes?|cartoon|\bserial\b|\bpromo\b|short film|comedy scenes?|ringtone",
    re.IGNORECASE,
)


def speech_style(text: str, duration: int | None) -> dict:
    tag, score = "other", 0
    for name, s, pat in STYLES:
        if pat.search(text):
            tag, score = name, s
            break
    if (duration or 0) >= 1200:  # long continuous speech gives more disfluency per video
        score += 1
    if LIVE_CUES.search(text):
        score += 1
    return {"style": tag, "spontaneity": score}


class _Quiet:
    def debug(self, msg): pass
    info = warning = error = debug


# Options shared by every yt-dlp call; main() adds cookies / sleep / JS runtime.
YDL_BASE: dict = {"quiet": True, "no_warnings": True, "logger": _Quiet(), "retries": 3}


class Throttled(Exception):
    """YouTube answered 429 / 'confirm you're not a bot'."""


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- discovery

def _flat_opts(limit: int) -> dict:
    return {**YDL_BASE, "extract_flat": "in_playlist", "skip_download": True,
            "playlistend": limit, "ignoreerrors": True}


def _flat(url: str, limit: int) -> list[dict]:
    with yt_dlp.YoutubeDL(_flat_opts(limit)) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    return [e for e in info.get("entries") or [] if e]


def search_videos(query: str, limit: int) -> list[dict]:
    url = f"https://www.youtube.com/results?search_query={quote_plus(query)}&sp={SP_VIDEO_CC}"
    return [e for e in _flat(url, limit) if e.get("id")]


def search_playlists(query: str, limit: int) -> list[str]:
    url = f"https://www.youtube.com/results?search_query={quote_plus(query)}&sp={SP_PLAYLIST}"
    return [e["url"] for e in _flat(url, limit) if e.get("url")]


def expand(url: str, limit: int) -> list[dict]:
    """Playlist / channel URL -> flat video entries (channel root pages nest their tabs)."""
    out = []
    for e in _flat(url, limit):
        if "entries" in e:
            out += [x for x in e["entries"] if x and x.get("id")]
        elif e.get("id"):
            out.append(e)
    return out


def _meta(e: dict, label: str) -> dict:
    """What a search/playlist page already tells us about a video (no watch-page request)."""
    return {
        "found_by": label,
        "title": e.get("title") or "",
        "snippet": e.get("description") or "",
        "channel": e.get("channel") or e.get("uploader"),
        "channel_id": e.get("channel_id"),
        "channel_url": e.get("channel_url"),
        "duration_s": e.get("duration"),
        "view_count": e.get("view_count"),
        "live_status": e.get("live_status"),
    }


def discover(args) -> dict[str, dict]:
    """-> {video_id: _meta(...)} for the first query/seed that found each video."""
    found: dict[str, dict] = {}
    queries = list(args.query or (MONOLOGUE_QUERIES if args.single_speaker else DEFAULT_QUERIES + SPONTANEOUS_QUERIES))
    if args.topics:
        queries += [f"Telugu {t} lecture" for t in TOPICS] + [f"{t} in Telugu" for t in TOPICS]

    def run(label, fn, *a):
        try:
            return label, fn(*a)
        except Exception as e:  # network hiccup / throttling: skip this query, keep going
            log(f"  ! {label}: {e}")
            return label, []

    with ThreadPoolExecutor(args.workers) as pool:
        jobs = [pool.submit(run, f"search:{q}", search_videos, q, args.max_per_query) for q in queries]
        if args.playlists:
            jobs += [pool.submit(run, f"playlists:{q}", search_playlists, q, args.playlists_per_query)
                     for q in queries]
        jobs += [pool.submit(run, f"seed:{s}", expand, s, args.seed_limit) for s in args.seed or []]

        playlist_urls: dict[str, str] = {}
        for j in as_completed(jobs):
            label, res = j.result()
            log(f"  {label}: {len(res)}")
            if label.startswith("playlists:"):
                playlist_urls.update({u: label for u in res})
            else:
                for e in res:
                    found.setdefault(e["id"], _meta(e, label))

        # second hop: every video in each playlist is verified individually (license is per video)
        hops = [pool.submit(run, f"playlist:{u}", expand, u, args.seed_limit) for u in playlist_urls]
        for j in as_completed(hops):
            label, res = j.result()
            for e in res:
                found.setdefault(e["id"], _meta(e, label))
    return found


def provisional_facts(video_id: str, m: dict) -> dict:
    """Facts from a search result alone (--catalog-only): no watch-page request, so no audio-track,
    dub or licence-text check. The CC licence comes from YouTube's own search filter."""
    text = f"{m['title']}\n{m['snippet']}"
    return {
        "id": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": m["title"],
        "channel": m["channel"],
        "channel_id": m["channel_id"],
        "channel_url": m["channel_url"],
        "duration_s": m["duration_s"],
        "view_count": m["view_count"],
        "license": f"{CC_LICENSE_PREFIX} license (per search filter)",
        "live_status": m["live_status"],
        "audio_language": None, "multi_audio": None, "telugu_dub_track": None,
        "telugu_in_text": bool(TELUGU_SCRIPT.search(text) or TELUGU_WORD.search(text)),
        "dub_cue": bool(DUB_CUES.search(text)),
        "provisional": True,
        **speech_style(text, m["duration_s"]),
    }


# --------------------------------------------------------------------------- verification

def audio_tracks(info: dict) -> tuple[str | None, bool, bool]:
    """-> (original_lang, telugu_dub_track_present, multi_audio).

    With several audio tracks YouTube/yt-dlp marks the creator's own track "original"
    (and gives it language_preference > 0); dubs carry a language but neither marker.
    With a single track, `language` is just whatever the uploader declared.
    """
    audio = [f for f in info.get("formats") or []
             if f.get("vcodec") in (None, "none") and f.get("acodec") not in (None, "none")
             and f.get("language")]
    langs = {f["language"].split("-")[0] for f in audio}
    orig = [f for f in audio
            if "original" in (f.get("format_note") or "") or (f.get("language_preference") or 0) > 0]
    declared = orig[0]["language"] if orig else info.get("language")
    base = declared.split("-")[0].lower() if declared else None
    multi = len(langs) > 1
    dub_te = multi and base != "te" and "te" in langs
    return base, dub_te, multi


def fetch_facts(video_id: str) -> dict:
    """Everything the classifier needs, from one yt-dlp extraction. Cached as-is."""
    try:
        with yt_dlp.YoutubeDL({**YDL_BASE, "skip_download": True}) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except yt_dlp.utils.DownloadError as e:
        if "not a bot" in str(e) or "429" in str(e):
            raise Throttled(str(e)) from None
        raise
    title, desc = info.get("title") or "", info.get("description") or ""
    text = f"{title}\n{desc[:1500]}"
    lang, dub_te, multi = audio_tracks(info)
    return {
        "id": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": title,
        "channel": info.get("channel") or info.get("uploader"),
        "channel_id": info.get("channel_id"),
        "channel_url": info.get("channel_url"),
        "upload_date": info.get("upload_date"),
        "duration_s": info.get("duration"),
        "view_count": info.get("view_count"),
        "license": info.get("license"),
        "live_status": info.get("live_status"),
        "playable_in_embed": info.get("playable_in_embed"),  # False: owner blocks the embedded player
        "audio_language": lang,
        "multi_audio": multi,
        "telugu_dub_track": dub_te,
        "telugu_in_text": bool(TELUGU_SCRIPT.search(text) or TELUGU_WORD.search(text)),
        "dub_cue": bool(DUB_CUES.search(text)),
        **speech_style(text, info.get("duration")),
    }


def classify(f: dict, min_duration: int, max_duration: int | None = None, single_speaker: bool = False) -> dict:
    """Pure function of cached facts -> {'confidence', 'reject'} (exactly one is set)."""
    lang = f.get("audio_language")
    reject = conf = None
    if "license" not in f:
        reject = f.get("reject") or "metadata extraction failed"
    elif not (f["license"] or "").startswith(CC_LICENSE_PREFIX):
        reject = f"license={f['license']!r}"
    elif f.get("live_status") in ("is_live", "is_upcoming"):
        reject = "live/upcoming"
    elif (f.get("duration_s") or 0) < min_duration:
        reject = f"shorter than {min_duration}s"
    elif max_duration and f["duration_s"] > max_duration:
        reject = f"longer than {max_duration}s"
    elif SCRIPTED_CUES.search(f.get("title") or ""):
        reject = "scripted/sung content (song, trailer, short, ...)"
    elif single_speaker and (f.get("style") in ("interview", "discussion")
                             or MULTI_SPEAKER_CUES.search(f.get("title") or "")):
        reject = "multi-speaker format (interview/discussion/guest)"
    elif f["telugu_dub_track"]:
        reject = f"Telugu is a dub track (original audio is {lang!r})"
    elif f["multi_audio"] and lang != "te":
        reject = f"multi-audio video, original audio is {lang!r}"
    elif f["dub_cue"]:
        reject = "title/description mentions dubbing/translation"
    elif lang == "te":
        conf = "confirmed"
    elif f["telugu_in_text"]:
        conf = "unverified" if f.get("provisional") else "likely" if lang is None else "conflict"
    else:
        reject = f"audio language {lang!r}, no Telugu cues in title/description"
    return {"confidence": conf, "reject": reject}


# --------------------------------------------------------------------------- audio check

class StopSelection(Exception):
    """Raised from an accept() callback to end selection early (e.g. YouTube is throttling)."""


def fetch_clips(video_id: str, duration: int, n: int, seconds: int) -> list:
    """`n` clips of `seconds` s spread through the video, as float32 16 kHz mono arrays (what
    Whisper and the speaker models want). One yt-dlp extraction per video; the clips are then
    cut locally by ffmpeg from the audio stream URL, so only ~n*seconds of audio is transferred
    and YouTube sees a single request. (Also avoids faster-whisper's PyAV decoder, which breaks
    on some PyAV versions.)"""
    import numpy as np
    opts = {**YDL_BASE, "skip_download": True, "format": "worstaudio[ext=m4a]/bestaudio[abr<=64]/worstaudio"}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except yt_dlp.utils.DownloadError as e:
        if "not a bot" in str(e) or "429" in str(e):
            raise Throttled(str(e)) from None
        raise
    headers = "".join(f"{k}: {v}\r\n" for k, v in (info.get("http_headers") or {}).items())
    clips = []
    for k in range(1, n + 1):
        start = max(0, int(duration * k / (n + 1)) - seconds // 2)
        for attempt in (1, 2):  # a clip read occasionally fails transiently; one retry saves the video
            try:
                raw = subprocess.run(
                    ["ffmpeg", "-v", "error", "-headers", headers, "-ss", str(start), "-t", str(seconds),
                     "-i", info["url"], "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                    capture_output=True, check=True, timeout=120).stdout
                break
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                if attempt == 2:
                    raise
        clips.append(np.frombuffer(raw, np.float32))
    return clips


def lid_votes(clips: list, model) -> list[dict]:
    """Whisper language ID per clip -> [{'top': 'te', 'p_te': 0.93}, ...]."""
    votes = []
    for x in clips:
        if len(x) < 16000 * 5:
            continue
        lang, _, probs = model.detect_language(x)
        votes.append({"top": lang, "p_te": round(dict(probs).get("te", 0.0), 3)})
    return votes


SEG_MODEL_URL = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/"
                 "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2")
EMB_MODEL_URL = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
                 "wespeaker_en_voxceleb_resnet34.onnx")  # (sic) the release tag is spelled that way


class SpeakerChecker:
    """Single-speaker evidence + a voice fingerprint, from the clips of one video.

    Per clip: pyannote segmentation + clustering (sherpa-onnx) says how many voices there are
    and how much of the speech the main one has. The main voice's speech is embedded (WeSpeaker
    ResNet34) so clips can be compared with each other and videos with each other. Clips are
    only a sample, so a rare second voice (a student's question) can be missed."""

    def __init__(self, models_dir: Path, cluster_threshold: float = 0.6):
        import sherpa_onnx as so
        seg, emb = self._ensure_models(models_dir)
        self._ext = so.SpeakerEmbeddingExtractor(so.SpeakerEmbeddingExtractorConfig(model=str(emb), num_threads=2))
        self._sd = so.OfflineSpeakerDiarization(so.OfflineSpeakerDiarizationConfig(
            segmentation=so.OfflineSpeakerSegmentationModelConfig(
                pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg)), num_threads=2),
            embedding=so.SpeakerEmbeddingExtractorConfig(model=str(emb), num_threads=2),
            clustering=so.FastClusteringConfig(num_clusters=-1, threshold=cluster_threshold),
            min_duration_on=0.3, min_duration_off=0.5))

    @staticmethod
    def _ensure_models(d: Path) -> tuple[Path, Path]:
        d.mkdir(parents=True, exist_ok=True)
        seg, emb = d / "pyannote_segmentation_3_0.int8.onnx", d / "wespeaker_en_voxceleb_resnet34.onnx"
        if not seg.exists():
            log(f"  downloading speaker segmentation model (7 MB) -> {d}")
            tar_path = d / "seg.tar.bz2"
            urllib.request.urlretrieve(SEG_MODEL_URL, tar_path)
            with tarfile.open(tar_path) as tf:  # read one named member: no path-traversal surface
                member = tf.extractfile("sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx")
                seg.write_bytes(member.read())
            tar_path.unlink()
        if not emb.exists():
            log(f"  downloading speaker embedding model (27 MB) -> {d}")
            urllib.request.urlretrieve(EMB_MODEL_URL, emb)
        return seg, emb

    def _embed(self, x):
        import numpy as np
        s = self._ext.create_stream()
        s.accept_waveform(sample_rate=16000, waveform=x)
        s.input_finished()
        e = np.array(self._ext.compute(s))
        return e / np.linalg.norm(e)

    def analyse(self, clips: list) -> dict:
        import numpy as np
        embs, shares, nspk = [], [], []
        for x in clips:
            if len(x) < 16000 * 10:
                continue
            by: dict[int, list] = {}
            for s in self._sd.process(x).sort_by_start_time():
                by.setdefault(s.speaker, []).append((s.start, s.end))
            tot = {k: sum(e - b for b, e in v) for k, v in by.items()}
            speech = sum(tot.values())
            if speech < 6:  # music / silence: tells us nothing
                continue
            dom = max(tot, key=tot.get)
            shares.append(tot[dom] / speech)
            nspk.append(len(by))
            voice = np.concatenate([x[int(b * 16000):int(e * 16000)] for b, e in by[dom]])[: 16000 * 20]
            embs.append(self._embed(voice))
        out = {"clips_used": len(shares), "clean_clips": sum(s >= 0.9 for s in shares),
               "max_speakers": max(nspk, default=0)}
        if embs:
            E = np.array(embs)
            if len(E) > 1:
                out["min_sim"] = round(float((E @ E.T)[np.triu_indices(len(E), 1)].min()), 3)
            m = E.mean(0)
            out["emb"] = (m / np.linalg.norm(m)).round(4).tolist()
        return out


MIN_POPULATION = 8     # videos needed before voices can be centred
RAW_SAME_SIM = 0.92    # raw-cosine fallback below that (calibrated: same speaker >= 0.92, others <= 0.91)


def voice_similarity(a: list, b: list, mu) -> float:
    """Cosine of two voice embeddings. Raw embeddings of this audio all look alike (different
    speakers reach 0.9), so both are centred on the population mean first: calibration gave
    same-speaker pairs >= 0.49 and different speakers <= 0.24 after centring."""
    import numpy as np
    x, y = np.array(a), np.array(b)
    if mu is not None:
        x, y = x - mu, y - mu
    return float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y)))


def is_single_speaker(a: dict, min_sim: float) -> bool:
    """>=3 informative clips, >=80% of them dominated (>=90% of speech) by one voice, and the
    dominant voice is consistent across clips."""
    return (a.get("clips_used", 0) >= 3 and a["clean_clips"] >= 0.8 * a["clips_used"]
            and a.get("min_sim", 0) >= min_sim)


# --------------------------------------------------------------------------- selection

CONF_RANK = {"confirmed": 0, "likely": 1, "conflict": 2, "unverified": 3}


def select(rows: list[dict], target_h: float, cap_h: float, accept=None) -> tuple[list[dict], list[dict], list[dict]]:
    """Pick ~target_h hours, spreading across channels (the closest proxy for distinct speakers
    that metadata gives): round-robin over channels, most spontaneous video first. A channel's
    first video is always allowed; further ones only while the channel stays within cap_h hours.
    `accept(row)` is a lazy last check (e.g. listening to the audio) run only on videos the
    selector actually reaches. -> (selected, not_reached, refused_by_accept)."""
    def key(r):  # new channels first, then embeddable (blocked ones can only be reviewed on youtube.com)
        return (CONF_RANK[r["confidence"]], r.get("channel_id") in AVOID_CHANNELS,
                r.get("playable_in_embed") is False, -r["spontaneity"], r["title"])

    queues: dict[str, list[dict]] = {}
    for r in sorted(rows, key=key):
        queues.setdefault(r.get("channel_id") or r.get("channel") or r["id"], []).append(r)
    order = sorted(queues.values(), key=lambda q: key(q[0]))
    used: dict[int, float] = {id(q): 0.0 for q in order}
    chosen, refused, total, progress, stopped = [], [], 0.0, True, False
    while total < target_h * 3600 and progress and not stopped:
        progress = False
        for q in order:
            if total >= target_h * 3600:
                break
            u = used[id(q)]
            i = next((i for i, r in enumerate(q) if u == 0 or u + r["duration_s"] <= cap_h * 3600), None)
            if i is None:
                continue
            r = q.pop(i)
            progress = True
            try:
                ok = not accept or accept(r)
            except StopSelection:
                q.insert(0, r)
                stopped = True
                break
            if not ok:
                refused.append(r)
                continue
            used[id(q)] += r["duration_s"]
            total += r["duration_s"]
            chosen.append(r)
    return chosen, [r for q in order for r in q], refused


def shortlist(found: dict, cache: dict, args) -> dict:
    """--verify-top: rank search hits by the provisional (search-page) data and keep only the best N
    for watch-page fetches, so a big discovery doesn't trigger YouTube's rate limit."""
    prov = [provisional_facts(v, m) for v, m in found.items()
            if m["found_by"].startswith("search:") and v not in cache]
    prov = [{**f, **classify(f, args.min_duration, args.max_duration, args.single_speaker)} for f in prov]
    ranked, rest, _ = select([r for r in prov if not r["reject"]], float("inf"), args.max_per_channel_hours)
    top = {r["id"] for r in (ranked + rest)[: args.verify_top]}
    return {v: m for v, m in found.items()
            if v in top or v in cache or not m["found_by"].startswith("search:")}


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--query", action="append", help="Search query (repeatable). Replaces the defaults.")
    ap.add_argument("--seed", action="append", help="Channel / playlist URL to scan (repeatable).")
    ap.add_argument("--seed-limit", type=int, default=500, help="Max videos taken per seed/playlist.")
    ap.add_argument("--max-per-query", type=int, default=50, help="Search results per query.")
    ap.add_argument("--playlists", action="store_true",
                    help="Also search playlists per query and verify every video in them.")
    ap.add_argument("--playlists-per-query", type=int, default=10)
    ap.add_argument("--min-duration", type=int, default=120, help="Skip clips shorter than this (s).")
    ap.add_argument("--max-duration", type=int, default=7200, help="Skip videos longer than this (s).")
    ap.add_argument("--topics", action="store_true",
                    help="Also search 'Telugu <topic> lecture' / '<topic> in Telugu' for ~20 subjects.")
    ap.add_argument("--catalog-only", action="store_true",
                    help="Use search-result data only (title, channel, duration); never open a watch "
                         "page. Rows come out as 'unverified': no dub/audio-language check. For when "
                         "YouTube is throttling watch pages; rerun without it later to verify.")
    ap.add_argument("--verify-top", type=int, metavar="N",
                    help="Only open watch pages for the N best candidates (ranked by speech style and "
                         "channel spread). Keeps request volume low; the cache makes reruns add more.")
    ap.add_argument("--target-hours", type=float,
                    help="Select about this many hours (the rest goes to <out>_pool.csv).")
    ap.add_argument("--max-per-channel-hours", type=float, default=1.0,
                    help="With --target-hours: soft cap per channel, for speaker diversity.")
    ap.add_argument("--strict", action="store_true", help="Only keep 'confirmed' results.")
    ap.add_argument("--single-speaker", action="store_true",
                    help="Monologue mode: search lecture/class/speech/explainer queries, drop interview, "
                         "discussion and guest formats. Pair with --verify-speakers to check the audio.")
    ap.add_argument("--exclude-batch", action="append", metavar="JSONL",
                    help="Earlier finder output (repeatable): its videos are skipped and its channels "
                         "are used last, so a new batch adds new voices.")
    ap.add_argument("--verify-audio", action="store_true",
                    help="Whisper language-ID on short clips (needs ffmpeg + faster-whisper).")
    ap.add_argument("--verify-speakers", action="store_true",
                    help="Diarize the clips: keep only videos whose speech is one consistent voice, and skip "
                         "a video whose voice matches one already selected (needs sherpa-onnx + ffmpeg).")
    ap.add_argument("--same-speaker-sim", type=float, default=0.40,
                    help="With --verify-speakers: population-centred cosine at/above which two videos "
                         "count as the same speaker (calibration: same 0.49+, different 0.24-).")
    ap.add_argument("--prior-decisions", metavar="JSONL",
                    help="review_decisions.jsonl: with --exclude-batch, the *accepted* videos of earlier "
                         "batches are analysed first, so new videos avoid their voices and the voice "
                         "population is diverse from the start.")
    ap.add_argument("--min-within-sim", type=float, default=0.70,
                    help="With --verify-speakers: lowest allowed similarity between a video's own clips.")
    ap.add_argument("--models-dir", default="models", help="Where the speaker models are downloaded.")
    ap.add_argument("--audio-cache", default=".telugu_cc_audio_cache.jsonl",
                    help="Per-video Whisper / speaker results (resume after a throttle).")
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--min-p-te", type=float, default=0.6,
                    help="With --verify-audio: minimum mean Whisper P(Telugu) over the clips.")
    ap.add_argument("--clips", type=int, default=6, help="Clips per video for --verify-audio/--verify-speakers.")
    ap.add_argument("--clip-seconds", type=int, default=30)
    ap.add_argument("--keep-rejected", action="store_true", help="Also write *_rejected.csv with reasons.")
    ap.add_argument("--workers", type=int, default=3,
                    help="Parallel yt-dlp calls. Higher gets the IP rate-limited faster.")
    ap.add_argument("--sleep", type=float, default=1.0, help="Seconds between requests inside yt-dlp.")
    ap.add_argument("--cookies", help="Netscape cookies.txt, if YouTube asks to 'confirm you're not a bot'.")
    ap.add_argument("--cookies-from-browser", metavar="BROWSER",
                    help="e.g. chrome. Uses that browser's YouTube session; heavy scraping while "
                         "signed in can get the account flagged, so prefer a throwaway account.")
    ap.add_argument("--out", default="telugu_cc_videos", help="Output basename (.csv/.jsonl).")
    ap.add_argument("--cache", default=".telugu_cc_cache.jsonl", help="Per-video metadata cache (resume).")
    args = ap.parse_args()

    YDL_BASE["sleep_interval_requests"] = args.sleep
    if args.cookies:
        YDL_BASE["cookiefile"] = args.cookies
    if args.cookies_from_browser:
        YDL_BASE["cookiesfrombrowser"] = (args.cookies_from_browser,)
    if not shutil.which("deno"):  # yt-dlp's default JS runtime; YouTube extraction needs one
        for rt in ("node", "bun"):
            if shutil.which(rt):
                YDL_BASE["js_runtimes"] = {rt: {}}
                break

    cache: dict[str, dict] = {}
    cache_path = Path(args.cache)
    if cache_path.exists():
        for line in cache_path.read_text().splitlines():
            r = json.loads(line)
            cache[r["id"]] = r

    prior_ids: set[str] = set()
    for p in args.exclude_batch or []:
        for line in Path(p).read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                prior_ids.add(r["id"])
                if r.get("channel_id"):
                    AVOID_CHANNELS.add(r["channel_id"])

    log("== discovering")
    found = {v: m for v, m in discover(args).items() if v not in prior_ids}
    if prior_ids:
        log(f"== skipped videos from earlier batches ({len(prior_ids)} ids, {len(AVOID_CHANNELS)} channels deprioritised)")
    if args.catalog_only:
        # Only search-filtered hits have a licence guarantee; playlist/seed hits would need the watch page.
        for v, m in found.items():
            if v not in cache and m["found_by"].startswith("search:"):
                cache[v] = provisional_facts(v, m)
        todo = []
    else:
        if args.verify_top:
            found = shortlist(found, cache, args)
        todo = [v for v in found if v not in cache]
    log(f"== {len(found)} unique candidates, {len(todo)} to fetch ({len(found) - len(todo)} cached/catalogued)")

    with ThreadPoolExecutor(args.workers) as pool, cache_path.open("a") as cf:
        futs = {pool.submit(fetch_facts, v): v for v in todo}
        throttled_in_a_row = 0
        for i, fut in enumerate(as_completed(futs), 1):
            v = futs[fut]
            try:
                rec = fut.result()
                throttled_in_a_row = 0
            except Throttled:
                throttled_in_a_row += 1
                if throttled_in_a_row >= 5:
                    for f in futs:
                        f.cancel()
                    log("!! YouTube is rate-limiting this IP (429 / 'not a bot'). Stopping; progress is "
                        "cached, so rerun later, use fewer --workers, or pass --cookies.")
                    break
                continue
            except Exception as e:  # private/removed/age-gated etc.: reported as rejected
                cache[v] = {"id": v, "reject": f"extract failed: {str(e)[:100]}"}
                continue
            cache[v] = rec
            cf.write(json.dumps(rec, ensure_ascii=False) + "\n")
            cf.flush()
            if i % 25 == 0:
                log(f"  fetched {i}/{len(todo)}")

    keep, dropped = [], []
    pending = [v for v in found if v not in cache]
    if pending:
        log(f"== {len(pending)} candidates have no watch-page data "
            + ("(not search hits; skipped by --catalog-only)" if args.catalog_only
               else "(throttled); rerun to resume"))
    for v in found:
        if v not in cache:
            continue
        r = {**cache[v], "found_by": found[v]["found_by"]}
        if "style" not in r and "license" in r:  # cache written by an older version
            r.update(speech_style(f"{r['title']}", r["duration_s"]))
        r.update(classify(r, args.min_duration, args.max_duration, args.single_speaker))
        (dropped if r["reject"] else keep).append(r)

    model = speaker = None
    if args.verify_audio:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            sys.exit("--verify-audio needs: pip install faster-whisper   (and ffmpeg on PATH)")
        model = WhisperModel(args.whisper_model, compute_type="int8")
    if args.verify_speakers:
        try:
            speaker = SpeakerChecker(Path(args.models_dir))
        except ImportError:
            sys.exit("--verify-speakers needs: pip install sherpa-onnx   (and ffmpeg on PATH)")

    audio_cache: dict[str, dict] = {}  # id -> {'votes': Whisper per clip, 'spk': speaker stats + voice embedding}
    audio_cache_path = Path(args.audio_cache)
    if audio_cache_path.exists():
        for line in audio_cache_path.read_text().splitlines():
            a = json.loads(line)
            audio_cache[a.pop("id")] = a
    voices: list[tuple[str, list]] = []  # (title, embedding) of every video selected so far
    ac = audio_cache_path.open("a")      # append-only log behind audio_cache; closed after selection
    listened = throttled = 0

    def accept(r: dict) -> bool:
        """Last check, run lazily on videos the selector reaches: the audio must be Telugu
        (--verify-audio), one consistent voice (--verify-speakers), and a voice not yet selected."""
        nonlocal listened, throttled
        if model or speaker:
            a = audio_cache.get(r["id"], {})
            if (model and "votes" not in a) or (speaker and "spk" not in a):
                listened += 1
                try:
                    n = min(args.clips, max(1, r["duration_s"] // (args.clip_seconds * 2)))
                    clips = fetch_clips(r["id"], r["duration_s"], n, args.clip_seconds)
                    if model and "votes" not in a:
                        a["votes"] = lid_votes(clips, model)
                    if speaker and "spk" not in a:
                        a["spk"] = speaker.analyse(clips)
                except Throttled:
                    throttled += 1
                    if throttled >= 3:
                        log("!! YouTube is rate-limiting audio requests; stopping. Results so far are cached: rerun later.")
                        raise StopSelection
                    r["reject"] = "audio fetch throttled (will retry on rerun)"
                    return False
                except Exception as e:
                    r["reject"] = f"could not fetch audio: {str(e)[:60]}"
                    return False
                throttled = 0
                audio_cache[r["id"]] = a
                ac.write(json.dumps({"id": r["id"], **a}) + "\n")
                ac.flush()
                log(f"  listened {listened}: {(r['channel'] or '')[:28]} | {r['title'][:50]}")
            if model:
                votes = a["votes"]
                r["whisper"] = json.dumps(votes)
                if not votes:
                    r["reject"] = "no usable audio clips"
                    return False
                r["whisper_mean_p_te"] = round(sum(v["p_te"] for v in votes) / len(votes), 3)
                if sum(v["top"] == "te" for v in votes) < math.ceil(len(votes) / 2):
                    r["reject"] = f"Whisper heard {[v['top'] for v in votes]}, not Telugu"
                    return False
                if r["whisper_mean_p_te"] < args.min_p_te:
                    r["reject"] = f"Whisper only weakly Telugu (mean P(te) {r['whisper_mean_p_te']})"
                    return False
                r["confidence"] = "confirmed"
            if speaker:
                s = a["spk"]
                r.update(speaker_clips_used=s["clips_used"], speaker_clean_clips=s["clean_clips"],
                         speaker_max_per_clip=s["max_speakers"], speaker_min_sim=s.get("min_sim"))
                if not is_single_speaker(s, args.min_within_sim):
                    r["reject"] = (f"not clearly one voice ({s['clean_clips']}/{s['clips_used']} clean clips, "
                                   f"min similarity {s.get('min_sim')})")
                    return False
                import numpy as np
                pop = [c["spk"]["emb"] for c in audio_cache.values() if c.get("spk", {}).get("emb")]
                mu = np.mean(pop, axis=0) if len(pop) >= MIN_POPULATION else None
                limit = args.same_speaker_sim if mu is not None else RAW_SAME_SIM
                nearest = max(((voice_similarity(s["emb"], e, mu), t) for t, e in voices), default=(-1.0, ""))
                r["speaker_nearest_sim"] = round(nearest[0], 3) if voices else None
                if nearest[0] >= limit:
                    r["reject"] = f"same voice as '{nearest[1][:40]}' (similarity {nearest[0]:.2f})"
                    return False
        if args.strict and r["confidence"] != "confirmed":
            r["reject"] = f"not confirmed ({r['confidence']}); --strict"
            return False
        if speaker:
            voices.append((r["title"], a["spk"]["emb"]))
        return True

    if speaker and args.exclude_batch and args.prior_decisions:
        # Voices of videos you already accepted: analysed first so new videos avoid them and so
        # the population used for centring is diverse before the first candidate is judged.
        decided: dict[str, str] = {}
        for line in Path(args.prior_decisions).read_text(encoding="utf-8").splitlines():
            e = json.loads(line)
            decided[e["id"]] = e["decision"]
        prior_rows = [json.loads(line) for p in args.exclude_batch
                      for line in Path(p).read_text(encoding="utf-8").splitlines() if line.strip()]
        prior_rows = [r for r in prior_rows if decided.get(r["id"]) == "accept"]
        log(f"== analysing the voices of {len(prior_rows)} previously accepted videos")
        for i, r in enumerate(prior_rows, 1):
            a = audio_cache.get(r["id"], {})
            if "spk" not in a:
                try:
                    n = min(args.clips, max(1, r["duration_s"] // (args.clip_seconds * 2)))
                    a["spk"] = speaker.analyse(fetch_clips(r["id"], r["duration_s"], n, args.clip_seconds))
                except Throttled:
                    log("!! throttled while analysing earlier batches; continuing with what we have")
                    break
                except Exception as e:
                    log(f"  ! {r['id']}: {str(e)[:60]}")
                    continue
                audio_cache[r["id"]] = a
                ac.write(json.dumps({"id": r["id"], **a}) + "\n")
                ac.flush()
                log(f"  prior {i}/{len(prior_rows)}: {(r['channel'] or '')[:28]} | {r['title'][:46]}")
            if a["spk"].get("emb"):
                voices.append((f"earlier batch: {r['title']}", a["spk"]["emb"]))

    target, cap = (args.target_hours, args.max_per_channel_hours) if args.target_hours else (float("inf"), float("inf"))
    eligible_h = sum(r["duration_s"] for r in keep) / 3600
    keep, pool, refused = select(keep, target, cap, accept)
    ac.close()
    dropped += refused
    if args.target_hours and sum(r["duration_s"] for r in keep) / 3600 < target:
        log(f"!! only {eligible_h:.1f} h eligible under the {cap} h/channel cap; add queries/--seed, "
            "raise --verify-top / --max-per-channel-hours, or lower the target")
    keep.sort(key=lambda r: (CONF_RANK[r["confidence"]], -r["spontaneity"], r.get("channel") or ""))

    def write(rows, base):
        if not rows:
            return
        cols = list(dict.fromkeys(k for r in rows for k in r))
        with open(f"{base}.csv", "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.DictWriter(fh, cols)
            w.writeheader()
            w.writerows(rows)
        with open(f"{base}.jsonl", "w", encoding="utf-8") as fh:
            fh.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)

    write(keep, args.out)
    write(pool, f"{args.out}_pool")
    if args.keep_rejected:
        write(dropped, f"{args.out}_rejected")

    by_conf = {c: sum(r["confidence"] == c for r in keep) for c in CONF_RANK}
    by_style: dict[str, float] = {}
    for r in keep:
        by_style[r["style"]] = by_style.get(r["style"], 0) + r["duration_s"] / 3600
    hours = sum(r["duration_s"] for r in keep) / 3600
    log(f"== kept {len(keep)} videos, {hours:.1f} h, {len({r.get('channel_id') or r.get('channel') for r in keep})} "
        f"channels; {by_conf}")
    log(f"   hours by style: { {k: round(v, 1) for k, v in sorted(by_style.items())} }")
    if model or speaker:
        log(f"   audio fetched and analysed for {listened} videos this run (others came from the audio cache)")
    log(f"   {len(pool)} more in pool, {len(dropped)} dropped -> {args.out}.csv/.jsonl")


if __name__ == "__main__":
    main()
