#!/usr/bin/env python3
"""Publish one language's dataset to the Hugging Face Hub.

    python3 publish_hf.py --lang telugu
    python3 publish_hf.py --lang telugu --dry-run      # build the dataset card and check the files only

Uploads, for every id in the CSV:
    data/<lang>/<id>.wav and data/<lang>/<id>.rsml
plus data/<lang>/metadata.csv (the CSV) and the dataset card (README.md).

The repo is public but gated: anyone can see the card, and people ask for access on the Hub, which a
maintainer approves by hand. Access is for reading; saving from the annotation app needs a token with
write access to the repo (see README.md).

Uses the login from `hf auth login` (or the HF_TOKEN environment variable).
"""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_REPO = "openbhasha/rsml-bench"
LANG_CODES = {"telugu": "te"}
SEGMENTATION = {
    "human-verified": "hand-checked (segments and speakers)",
    "machine": "machine (VAD and diarization, not checked)",
}


def read_rows(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [r for r in csv.DictReader(f) if r.get("id")]


def cell(text: str) -> str:
    return (text or "").replace("|", "\\|").replace("\n", " ").strip()


def clock(seconds: float) -> str:
    s = round(seconds)
    h, m, sec = s // 3600, (s // 60) % 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def dataset_card(rows: list[dict], lang: str, repo: str) -> str:
    code = LANG_CODES.get(lang, lang)
    hours = sum(float(r.get("duration_s") or 0) for r in rows) / 3600
    channels = len({r.get("channel_id") or r.get("channel") for r in rows})
    counts: dict[str, int] = {}
    for r in rows:
        key = r.get("segmentation_source") or "machine"
        counts[key] = counts.get(key, 0) + 1
    status = ", ".join(f"{n} {SEGMENTATION.get(k, k)}" for k, n in sorted(counts.items()))
    table = "\n".join(
        f"| {i} | [{cell(r['title'])}]({r['url']}) | {cell(r['channel'])} | {clock(float(r.get('duration_s') or 0))} "
        f"| {r.get('speakers_detected') or ''} | {r.get('segmentation_source') or ''} |"
        for i, r in enumerate(rows, 1)
    )
    return f"""---
language:
- {code}
pretty_name: RSML Bench - {lang.capitalize()}
license: other
license_name: 'CC BY (YouTube "reuse allowed")'
license_link: https://creativecommons.org/licenses/by/
task_categories:
- automatic-speech-recognition
size_categories:
- n<1K
extra_gated_prompt: >-
  This dataset is gated. Access is approved by hand. By requesting access you agree to credit the
  creator and channel of every video you use (the list is in the dataset card), to link to the
  original video, and to use the data for research and tools in line with its Creative Commons
  Attribution licence.
extra_gated_fields:
  Name: text
  Affiliation: text
  Intended use: text
  I agree to credit each video's creator and channel: checkbox
---

# RSML Bench: {lang.capitalize()}

Disfluency-rich transcription data for {lang.capitalize()}, built from Creative Commons (CC BY) YouTube
lectures and interviews. Each video has its full audio (16 kHz mono WAV) and an RSML transcript: time-
aligned segments with the speaker, verification and flags for each segment, and the transcript text with
its markup (code-mixing, normalisation, disfluency and background-speaker tags).

- **Videos:** {len(rows)} from {channels} channels, {hours:.2f} hours in total.
- **Segmentation:** {status}. Speaker counts for the machine-segmented videos are estimates and are
  often wrong for interviews.
- **Files:** `data/{lang}/<id>.wav`, `data/{lang}/<id>.rsml`, and `data/{lang}/metadata.csv` (every field
  for each video: title, channel, URL, upload date, duration, speakers, segmentation source).
- **Annotation:** the annotation app (https://openbhasha.github.io/rsml-bench/library.html) reads and saves
  these files. Each save commits the video's `.rsml` to this repo.

## Licence and credit

Every video was listed on YouTube under the "Creative Commons Attribution license (reuse allowed)". YouTube
does not say which CC BY version applies to each video, so check the video page if the version matters.
Credit the channel and video title, and link the URL below, when you use a video. The audio and transcripts
are derived from those videos.

## Videos

| # | Title | Channel | Length | Speakers | Segmentation |
|---|---|---|---|---|---|
{table}

## Gated access

Access is approved by hand. Request it on this page; once approved, read with a token from your account
(`hf auth login`, or the token box in the annotation app). Annotators who save changes also need write
access to the repo.

## Building this dataset

The files are produced by `publish_hf.py` and the scripts in the source repository
(https://github.com/OpenBhasha/rsml-bench). Generated {date.today().isoformat()}.
"""


def publish(args: argparse.Namespace, rows: list[dict], card: str) -> None:
    from huggingface_hub import HfApi

    data_dir = args.data_dir
    missing = [r["id"] for r in rows
               if not (data_dir / f"{r['id']}.wav").exists() or not (data_dir / f"{r['id']}.rsml").exists()]
    if missing:
        sys.exit(f"missing audio or RSML for: {', '.join(missing)}")
    names = [f"{r['id']}.{ext}" for r in rows for ext in ("wav", "rsml")]

    api = HfApi()
    api.create_repo(args.repo, repo_type="dataset", private=False, exist_ok=True)
    api.update_repo_settings(args.repo, repo_type="dataset", gated="manual")
    api.upload_folder(
        repo_id=args.repo, repo_type="dataset", folder_path=str(data_dir), path_in_repo=f"data/{args.lang}",
        allow_patterns=names, commit_message=f"Add {len(rows)} {args.lang} videos (audio and RSML)",
    )
    api.upload_file(
        repo_id=args.repo, repo_type="dataset", path_or_fileobj=str(args.csv),
        path_in_repo=f"data/{args.lang}/metadata.csv", commit_message="Add metadata",
    )
    api.upload_file(
        repo_id=args.repo, repo_type="dataset", path_or_fileobj=card.encode("utf-8"),
        path_in_repo="README.md", commit_message="Dataset card",
    )
    print(f"published {len(rows)} videos to https://huggingface.co/datasets/{args.repo} (gated: manual)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", default="telugu", help="language folder under data/ (default: telugu)")
    ap.add_argument("--csv", type=Path, default=HERE / "telugu_cc_final.csv", help="the videos and their metadata")
    ap.add_argument("--data-dir", type=Path, default=None, help="default: data/<lang>")
    ap.add_argument("--repo", default=DEFAULT_REPO, help=f"Hub dataset repo (default: {DEFAULT_REPO})")
    ap.add_argument("--dry-run", action="store_true", help="write the card to the scratch file and stop")
    args = ap.parse_args()
    args.data_dir = args.data_dir or HERE / "data" / args.lang

    rows = read_rows(args.csv)
    card = dataset_card(rows, args.lang, args.repo)
    if args.dry_run:
        out = HERE / ".dataset_card.preview.md"
        out.write_text(card, encoding="utf-8")
        present = sum((args.data_dir / f"{r['id']}.wav").exists() for r in rows)
        print(f"{len(rows)} videos in the CSV, {present} with audio. Card written to {out} (not committed)")
        return
    publish(args, rows, card)


if __name__ == "__main__":
    main()
