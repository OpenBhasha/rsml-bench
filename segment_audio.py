#!/usr/bin/env python3
"""Voice-activity detection + speaker diarization for the downloaded audio.

For every data/telugu/<id>.wav it writes data/telugu/<id>.rsml: one empty (no transcript) segment per stretch of
speech, each labelled with the speaker who talks in it (primary=<speaker id>), in the layout of
lecture_01.rsml, and it adds the speaker counts to the metadata CSV(s).

  1. Silero VAD (sherpa-onnx) finds the speech segments.
  2. Pyannote segmentation + WeSpeaker voice clustering (sherpa-onnx) says who talks when.
  3. Each VAD segment is cut where the speaker changes and every piece gets its speaker.
  4. Clusters with very little speech are folded into the nearest real speaker: a few seconds of a
     "second voice" in an hour of lecture is nearly always a clustering artefact, not a person.
     The unfolded count stays in the metadata as speakers_raw.

Speaker 1 is the one who talks the most. Gender is not guessed: the [speakers] lines leave it blank.
The config footer of every .rsml is copied from the template (lecture_01.rsml).

Usage:
    python segment_audio.py                                   # data/telugu/*.wav -> data/telugu/*.rsml, updates the CSVs
    python segment_audio.py --only wWqZ9UCCfe0 --no-metadata  # one video, nothing else touched

Needs: sherpa-onnx, numpy (pip install -r requirements.txt). The three models (~30 MB) are
downloaded to ./models on first use.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import wave
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SR = 16000
VAD_MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
CONFIG_MARKER = "# BhashaCheck config"
META_COLS = ["speakers_detected", "speakers_raw", "speaker_share_pct", "vad_segments", "vad_speech_s", "rsml_file",
             "segmentation_source"]
VERIFIED = "human-verified"   # set by sync_metadata_from_rsml.py: the annotator re-segmented / relabelled this video by hand


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- models

def ensure_models(models_dir: Path) -> dict:
    """Paths of the three models, downloading whichever is missing (same source as find_telugu_cc_videos)."""
    import urllib.request
    from find_telugu_cc_videos import SpeakerChecker
    seg, emb = SpeakerChecker._ensure_models(models_dir)
    vad = models_dir / "silero_vad.onnx"
    if not vad.exists():
        log(f"  downloading Silero VAD model (0.6 MB) -> {models_dir}")
        urllib.request.urlretrieve(VAD_MODEL_URL, vad)
    return {"seg": str(seg), "emb": str(emb), "vad": str(vad)}


_W: dict = {}   # per-process models, built by _init_worker


def _init_worker(cfg: dict):
    import sherpa_onnx as so
    _W["cfg"] = cfg
    _W["vad"] = so.VadModelConfig(
        silero_vad=so.SileroVadModelConfig(
            model=cfg["models"]["vad"], threshold=cfg["vad_threshold"], min_silence_duration=cfg["min_silence"],
            min_speech_duration=cfg["min_speech"], max_speech_duration=cfg["max_segment"], window_size=512),
        sample_rate=SR, num_threads=1)
    _W["sd"] = so.OfflineSpeakerDiarization(so.OfflineSpeakerDiarizationConfig(
        segmentation=so.OfflineSpeakerSegmentationModelConfig(
            pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=cfg["models"]["seg"]),
            num_threads=cfg["threads"]),
        embedding=so.SpeakerEmbeddingExtractorConfig(model=cfg["models"]["emb"], num_threads=cfg["threads"]),
        clustering=so.FastClusteringConfig(num_clusters=-1, threshold=cfg["cluster_threshold"]),
        min_duration_on=0.3, min_duration_off=0.5))


# --------------------------------------------------------------------------- the two detectors

def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        if (w.getnchannels(), w.getframerate(), w.getsampwidth()) != (1, SR, 2):
            raise ValueError(f"{path.name}: expected 16 kHz mono 16-bit WAV")
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0


def run_vad(x: np.ndarray) -> list[tuple[float, float]]:
    """Speech segments (start_s, end_s) from Silero VAD."""
    import sherpa_onnx as so
    vad = so.VoiceActivityDetector(_W["vad"], buffer_size_in_seconds=60)
    segs: list[tuple[float, float]] = []

    def drain():
        while not vad.empty():
            s = vad.front
            segs.append((s.start / SR, (s.start + len(s.samples)) / SR))
            vad.pop()

    step = 512 * 8
    for i in range(0, len(x), step):
        vad.accept_waveform(x[i:i + step])
        drain()
    vad.flush()
    drain()
    return segs


def run_diarization(x: np.ndarray) -> list[tuple[float, float, int]]:
    """Speaker turns (start_s, end_s, cluster) - clusters are anonymous and may overlap in time."""
    res = _W["sd"].process(x).sort_by_start_time()
    return [(r.start, r.end, r.speaker) for r in res]


# --------------------------------------------------------------------------- combining them

def pad_segments(segs: list[tuple[float, float]], pad: float, total: float) -> list[tuple[float, float]]:
    """Widen each segment by `pad` s (VAD tends to clip word onsets), never into its neighbour."""
    out = []
    for i, (s, e) in enumerate(segs):
        lo = (segs[i - 1][1] + s) / 2 if i else 0.0
        hi = (e + segs[i + 1][0]) / 2 if i + 1 < len(segs) else total
        out.append((max(s - pad, lo), min(e + pad, hi)))
    return out


def fold_minor(turns: list[tuple[float, float, int]], min_s: float, min_share: float) -> list[tuple[float, float, int]]:
    """Relabel turns of clusters with too little speech as the nearest big speaker in time."""
    total: dict[int, float] = {}
    for s, e, k in turns:
        total[k] = total.get(k, 0.0) + (e - s)
    if not total:
        return turns
    floor = max(min_s, min_share * sum(total.values()))
    major = {k for k, v in total.items() if v >= floor} or {max(total, key=total.get)}
    if len(major) == len(total):
        return turns
    big = np.array([(s, e, k) for s, e, k in turns if k in major])
    out = []
    for s, e, k in turns:
        if k not in major:
            gap = np.maximum(0.0, np.maximum(big[:, 0] - e, s - big[:, 1]))
            k = int(big[gap.argmin(), 2])
        out.append((s, e, k))
    return out


def label_segments(vad: list[tuple[float, float]], turns: list[tuple[float, float, int]],
                   min_piece: float, frame: float = 0.02) -> list[tuple[float, float, int]]:
    """Cut each VAD segment where the speaker changes; each piece gets its speaker.
    Where turns overlap the longest turn wins; stretches no turn covers take the nearest speaker;
    a piece shorter than min_piece is absorbed by its longer neighbour."""
    if not turns:
        return [(s, e, 0) for s, e in vad]
    ts, te, tk = (np.array(c) for c in zip(*turns))
    out = []
    for S, E in vad:
        n = max(1, int(round((E - S) / frame)))
        lab = np.full(n, -1)
        for i in sorted(np.nonzero((ts < E) & (te > S))[0], key=lambda i: te[i] - ts[i]):
            lab[max(0, int((ts[i] - S) / frame)):min(n, int(np.ceil((te[i] - S) / frame)))] = tk[i]
        known = np.nonzero(lab >= 0)[0]
        if len(known) == 0:
            lab[:] = tk[np.maximum(0.0, np.maximum(ts - E, S - te)).argmin()]
        else:
            pos = np.arange(n)
            j = np.searchsorted(known, pos)
            left, right = known[np.clip(j - 1, 0, len(known) - 1)], known[np.clip(j, 0, len(known) - 1)]
            lab = lab[np.where(pos - left <= right - pos, left, right)]
        cut = np.nonzero(np.diff(lab))[0] + 1
        runs = [[int(a), int(b), int(lab[a])] for a, b in zip(np.r_[0, cut], np.r_[cut, n])]
        min_f = int(round(min_piece / frame))
        while len(runs) > 1:
            j = min(range(len(runs)), key=lambda i: runs[i][1] - runs[i][0])
            if runs[j][1] - runs[j][0] >= min_f:
                break
            t = max((i for i in (j - 1, j + 1) if 0 <= i < len(runs)), key=lambda i: runs[i][1] - runs[i][0])
            runs[t][0], runs[t][1] = min(runs[t][0], runs[j][0]), max(runs[t][1], runs[j][1])
            del runs[j]
            merged: list[list[int]] = []
            for r in runs:
                if merged and merged[-1][2] == r[2]:
                    merged[-1][1] = r[1]
                else:
                    merged.append(r)
            runs = merged
        for a, b, k in runs:
            out.append((S + a * frame, E if b >= n else S + b * frame, k))
    return out


def split_long(segs: list[tuple[float, float, int]], x: np.ndarray, max_len: float,
               frame: float = 0.02) -> list[tuple[float, float, int]]:
    """Silero's max-duration cap is soft (segments of 60 s slip through). Cut anything longer than
    max_len at its quietest point, looking only at the middle 40% so no piece gets tiny; repeat."""
    out: list[tuple[float, float, int]] = []
    hop = int(frame * SR)

    def cut(s: float, e: float, k: int):
        if e - s <= max_len:
            out.append((s, e, k))
            return
        a, b = int((s + 0.3 * (e - s)) * SR), int((e - 0.3 * (e - s)) * SR)
        n = (b - a) // hop
        rms = np.sqrt((x[a:a + n * hop].reshape(n, hop) ** 2).mean(axis=1))
        m = (a + (int(np.convolve(rms, np.ones(5) / 5, mode="same").argmin()) + 0.5) * hop) / SR   # 100 ms smoothing
        cut(s, m, k)
        cut(m, e, k)

    for s, e, k in segs:
        cut(s, e, k)
    return out


# --------------------------------------------------------------------------- RSML

def timestamp(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def template_tail(template: Path, speakers: list[int], lang: str) -> str:
    """The '# BhashaCheck config' footer of the template, with [speakers] replaced."""
    text = template.read_text(encoding="utf-8")
    i = text.index("\n" + CONFIG_MARKER) + 1
    head, rest = text[i:].split("[speakers]\n", 1)
    _, rest = rest.split("\n\n", 1)
    return head + "[speakers]\n" + "".join(f"{k} = , {lang}\n" for k in speakers) + "\n" + rest


def write_rsml(path: Path, segs: list[tuple[float, float, int]], footer: str):
    body = "".join(f"{i}\n{timestamp(s)} --> {timestamp(e)}\nprimary={k}|verified=0|flagged=0|note=\n\n\n"
                   for i, (s, e, k) in enumerate(segs, 1))
    path.write_text(body + footer, encoding="utf-8")


# --------------------------------------------------------------------------- one video

def process(job: tuple[str, str]) -> dict:
    vid, wav = job
    cfg = _W["cfg"]
    x = read_wav(Path(wav))
    total = len(x) / SR
    t = time.time()
    vad = pad_segments(run_vad(x), cfg["pad"], total)
    t_vad = time.time() - t
    t = time.time()
    raw = run_diarization(x)
    t_diar = time.time() - t
    raw_s: dict[int, float] = {}
    for s, e, k in raw:
        raw_s[k] = raw_s.get(k, 0.0) + (e - s)
    segs = label_segments(vad, fold_minor(raw, cfg["min_speaker_s"], cfg["min_speaker_share"]), cfg["min_piece"])
    # a cluster with enough diarized speech can still end up with a few seconds once cut to the VAD segments
    segs = split_long(fold_minor(segs, cfg["min_speaker_s"], cfg["min_speaker_share"]), x, cfg["split_over"])
    secs: dict[int, float] = {}
    for s, e, k in segs:
        secs[k] = secs.get(k, 0.0) + (e - s)
    rank = {k: i for i, k in enumerate(sorted(secs, key=secs.get, reverse=True), 1)}   # 1 = talks the most
    segs = [(s, e, rank[k]) for s, e, k in segs]
    out = Path(cfg["out_dir"]) / f"{vid}.rsml"
    write_rsml(out, segs, template_tail(Path(cfg["template"]), sorted(rank.values()), cfg["lang"]))
    speech = sum(secs.values())
    return {
        "id": vid, "duration_s": round(total, 1), "rsml_file": f"{Path(cfg['out_dir']).name}/{vid}.rsml",
        "speakers_detected": len(rank), "speakers_raw": len(raw_s),
        "speaker_share_pct": "|".join(f"{rank[k]}:{100 * secs[k] / speech:.1f}" for k in sorted(rank, key=rank.get)) if speech else "",
        "vad_segments": len(segs), "vad_speech_s": round(speech, 1),
        "raw_cluster_s": {str(k): round(v, 1) for k, v in sorted(raw_s.items(), key=lambda kv: -kv[1])},
        "no_speaker_found": not raw, "seconds_vad": round(t_vad, 1), "seconds_diarization": round(t_diar, 1),
    }


# --------------------------------------------------------------------------- metadata

def verified_ids(paths: list[Path]) -> set[str]:
    """Videos whose segments and speakers the annotator has checked by hand (see sync_metadata_from_rsml.py)."""
    out: set[str] = set()
    for p in paths:
        with open(p, newline="", encoding="utf-8-sig") as f:
            out |= {r["id"] for r in csv.DictReader(f) if r.get("segmentation_source") == VERIFIED}
    return out


def has_annotation(path: Path) -> bool:
    """True if the annotation app has verified any cue in this rsml file (it autosaves into these files)."""
    try:
        return "|verified=1|" in path.read_text(encoding="utf-8")
    except OSError:
        return False


def update_metadata(path: Path, results: dict, overwrite_verified: bool = False):
    """Write the machine's numbers for the videos in `results`; every other row keeps what it has."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        cols, rows = [c for c in rd.fieldnames if c not in META_COLS], list(rd)
    at = cols.index("single_speaker_check") + 1 if "single_speaker_check" in cols else len(cols)
    cols[at:at] = META_COLS
    for r in rows:
        res = results.get(r["id"])
        if res and (overwrite_verified or r.get("segmentation_source") != VERIFIED):
            r.update({c: res[c] for c in META_COLS if c != "segmentation_source"}, segmentation_source="machine")
        else:
            for c in META_COLS:
                r.setdefault(c, "")
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    tmp.replace(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audio-dir", type=Path, default=HERE / "data" / "telugu")
    ap.add_argument("--out-dir", type=Path, default=HERE / "data" / "telugu")
    ap.add_argument("--template", type=Path, default=HERE / "lecture_01.rsml",
                    help="example .rsml whose '# BhashaCheck config' footer is copied")
    ap.add_argument("--metadata", type=Path, action="append",
                    help="CSV(s) to add the speaker columns to (default: telugu_cc_final.csv, telugu_cc_all_reviewed.csv)")
    ap.add_argument("--no-metadata", action="store_true", help="do not touch any CSV")
    ap.add_argument("--only", help="comma-separated video ids (default: every .wav in --audio-dir)")
    ap.add_argument("--force", action="store_true", help="redo videos already done with the same settings")
    ap.add_argument("--overwrite-verified", action="store_true",
                    help="also redo videos that are marked human-verified in the metadata CSV or have verified cues in "
                         "their rsml file (this replaces the annotator's work)")
    ap.add_argument("--models-dir", type=Path, default=HERE / "models")
    ap.add_argument("--workers", type=int, default=4, help="videos processed in parallel")
    ap.add_argument("--threads", type=int, default=2, help="threads per worker for the diarization models")
    ap.add_argument("--lang", default="te", help="language written in the [speakers] lines")
    g = ap.add_argument_group("VAD")
    g.add_argument("--vad-threshold", type=float, default=0.5)
    g.add_argument("--min-silence", type=float, default=0.5, help="pause (s) that ends a segment")
    g.add_argument("--min-speech", type=float, default=0.25, help="shortest segment (s)")
    g.add_argument("--max-segment", type=float, default=20.0, help="longest segment (s) before a forced cut")
    g.add_argument("--pad", type=float, default=0.1, help="seconds added each side of a segment")
    g.add_argument("--split-over", type=float, default=25.0,
                   help="segments longer than this (s) are cut at their quietest point")
    g = ap.add_argument_group("diarization")
    g.add_argument("--cluster-threshold", type=float, default=0.8,
                   help="clustering threshold: higher merges more voices, so fewer speakers (0.5-0.9 tried)")
    g.add_argument("--min-speaker-s", type=float, default=10.0, help="a speaker needs at least this much speech (s) ...")
    g.add_argument("--min-speaker-share", type=float, default=0.01, help="... and this share of all speech")
    g.add_argument("--min-piece", type=float, default=0.6, help="shortest piece (s) a segment is cut into at a speaker change")
    args = ap.parse_args()

    ids = [p.stem for p in sorted(args.audio_dir.glob("*.wav"))]
    if args.only:
        want = set(args.only.split(","))
        ids = [i for i in ids if i in want]
        if want - set(ids):
            sys.exit(f"no audio for: {', '.join(sorted(want - set(ids)))}")
    if not ids:
        sys.exit(f"no .wav files in {args.audio_dir}")
    args.out_dir.mkdir(exist_ok=True)
    csvs = args.metadata or [p for p in (HERE / "telugu_cc_final.csv", HERE / "telugu_cc_all_reviewed.csv") if p.exists()]
    if not args.overwrite_verified:
        keep = (verified_ids(csvs) | {i for i in ids if has_annotation(args.out_dir / f"{i}.rsml")}) & set(ids)
        if keep:
            log(f"leaving {len(keep)} annotated / human-verified video(s) alone ({', '.join(sorted(keep))}); "
                "--overwrite-verified redoes them")
            ids = [i for i in ids if i not in keep]
        if not ids:
            sys.exit("nothing to do")

    params = {k: getattr(args, k) for k in ("vad_threshold", "min_silence", "min_speech", "max_segment", "pad",
                                            "split_over", "cluster_threshold", "min_speaker_s", "min_speaker_share",
                                            "min_piece")}
    summary_path = args.out_dir / "_summary.json"
    summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
    todo = [i for i in ids if args.force or i not in summary or summary[i].get("params") != params
            or not (args.out_dir / f"{i}.rsml").exists()]
    log(f"{len(ids)} videos, {len(ids) - len(todo)} already done with these settings, {len(todo)} to do")

    if todo:
        cfg = {**params, "models": ensure_models(args.models_dir), "threads": args.threads, "out_dir": str(args.out_dir),
               "template": str(args.template), "lang": args.lang}
        t0 = time.time()
        if args.workers <= 1:
            _init_worker(cfg)
            results = (process((i, str(args.audio_dir / f"{i}.wav"))) for i in todo)
            pool = None
        else:
            pool = ProcessPoolExecutor(args.workers, initializer=_init_worker, initargs=(cfg,))
            futs = {pool.submit(process, (i, str(args.audio_dir / f"{i}.wav"))): i for i in todo}
            results = (f.result() for f in as_completed(futs))
        for n, r in enumerate(results, 1):
            summary[r["id"]] = {**r, "params": params}
            tmp = summary_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(summary, ensure_ascii=False, indent=1))
            tmp.replace(summary_path)
            log(f"  {n}/{len(todo)} {r['id']}: {r['vad_segments']} segments, {r['speakers_detected']} speaker(s) "
                f"(raw {r['speakers_raw']}; {r['speaker_share_pct']}%), {r['duration_s'] / 60:.0f} min audio in "
                f"{r['seconds_vad'] + r['seconds_diarization']:.0f}s")
        if pool:
            pool.shutdown()
        log(f"done in {(time.time() - t0) / 60:.1f} min")

    if not args.no_metadata:
        for p in csvs:
            update_metadata(p, {i: summary[i] for i in ids if i in summary}, args.overwrite_verified)
            log(f"  speaker columns written to {p.name}")


if __name__ == "__main__":
    main()
