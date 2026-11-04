#!/usr/bin/env python3
"""Copy the speaker / segment numbers of hand-verified RSML files into the metadata CSVs.

    python3 sync_metadata_from_rsml.py 0G9qCPa1Y6c [more ids ...]

segment_audio.py fills speakers_detected, speakers_raw, speaker_share_pct, vad_segments and vad_speech_s from
its own VAD + diarization. Where the annotator has re-segmented and relabelled a video by hand, those numbers
come from the annotator's file instead: for each id given, this reads the cues of data/telugu/<id>.rsml (where the
annotation app autosaves), writes

    speakers_detected   distinct speaker ids that have at least one cue
    speakers_raw        the same number (a hand-checked file has no un-merged clusters)
    speaker_share_pct   "id:percent|..." of the summed cue time, by speaker id
    vad_segments        number of cues
    vad_speech_s        summed cue time (s)
    segmentation_source "human-verified"   (the other rows say "machine")

into every CSV that has the video, and leaves everything else alone. segment_audio.py then skips these videos
(unless --overwrite-verified) so a later run cannot replace the verified file or these numbers.
Re-run this script after changing a verified file's segments or speakers.
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CUE = re.compile(r"^(\d\d):(\d\d):(\d\d),(\d+) --> (\d\d):(\d\d):(\d\d),(\d+)\nprimary=([^|\n]*)\|", re.M)
NEW_COLS = ["segmentation_source"]


def read_cues(path: Path) -> list[tuple[float, float, str]]:
    body = path.read_text(encoding="utf-8").split("# BhashaCheck config")[0]
    cues = []
    for m in CUE.finditer(body):
        a = [int(x) for x in m.groups()[:8]]
        cues.append((a[0] * 3600 + a[1] * 60 + a[2] + a[3] / 1000, a[4] * 3600 + a[5] * 60 + a[6] + a[7] / 1000, m[9]))
    return cues


def numbers(cues) -> dict[str, str]:
    secs: dict[str, float] = {}
    for s, e, k in cues:
        secs[k] = secs.get(k, 0.0) + (e - s)
    total = sum(secs.values())
    share = "|".join(f"{k}:{100 * secs[k] / total:.1f}" for k in sorted(secs, key=lambda k: (not k.isdigit(), int(k) if k.isdigit() else 0, k)))
    return {"speakers_detected": str(len(secs)), "speakers_raw": str(len(secs)), "speaker_share_pct": share,
            "vad_segments": str(len(cues)), "vad_speech_s": f"{total:.1f}", "segmentation_source": "human-verified"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="+", help="video ids whose segmentation and speakers have been verified by hand")
    ap.add_argument("--rsml-dir", type=Path, default=HERE / "data" / "telugu")
    ap.add_argument("--metadata", type=Path, action="append",
                    help="CSV(s) to update (default: telugu_cc_final.csv, telugu_cc_all_reviewed.csv)")
    args = ap.parse_args()

    new: dict[str, dict[str, str]] = {}
    for vid in args.ids:
        src = args.rsml_dir / f"{vid}.rsml"
        if not src.exists():
            sys.exit(f"{vid}: {src} not found")
        cues = read_cues(src)
        if not cues:
            sys.exit(f"{src}: no cues found")
        new[vid] = numbers(cues)
        print(f"{vid}: {src.relative_to(HERE) if src.is_relative_to(HERE) else src}: " + ", ".join(f"{k}={v}" for k, v in new[vid].items()))

    for path in args.metadata or [p for p in (HERE / "telugu_cc_final.csv", HERE / "telugu_cc_all_reviewed.csv") if p.exists()]:
        with open(path, newline="", encoding="utf-8-sig") as f:
            rd = csv.DictReader(f)
            cols, rows = list(rd.fieldnames), list(rd)
        for c in NEW_COLS:
            if c not in cols:
                cols.insert(cols.index("rsml_file") + 1 if "rsml_file" in cols else len(cols), c)
        found = set()
        for r in rows:
            if r["id"] in new:
                r.update(new[r["id"]])
                found.add(r["id"])
            elif not r.get("segmentation_source"):
                r["segmentation_source"] = "machine" if r.get("rsml_file") else ""
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
        tmp.replace(path)
        print(f"{path.name}: updated {len(found)} of {len(new)} video(s)" + (f"; not in this file: {', '.join(sorted(set(new) - found))}" if set(new) - found else ""))


if __name__ == "__main__":
    main()
