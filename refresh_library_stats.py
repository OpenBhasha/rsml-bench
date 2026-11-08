#!/usr/bin/env python3
"""Build the persisted library index from a consistent Hugging Face revision.

Run with --publish to upload only data/<lang>/library.json.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

HERE = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="openbhasha/rsml-bench")
    parser.add_argument("--lang", default="telugu")
    parser.add_argument("--output", type=Path, default=HERE / "library.json")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    api = HfApi()
    revision = api.repo_info(args.repo, repo_type="dataset").sha

    def read(path: str, ref: str = revision) -> str:
        local = hf_hub_download(args.repo, path, repo_type="dataset", revision=ref)
        return Path(local).read_text(encoding="utf-8-sig")

    config_source = (HERE / "editor/config.js").read_text()
    config_result = subprocess.run(
        ["node", "--input-type=module", "-e",
         "globalThis.window={};" + config_source + "\nconsole.log(JSON.stringify(window.RSML_BENCH));"],
        capture_output=True, text=True, check=True,
    )
    config = json.loads(config_result.stdout)
    draft_ids = set(config["asrDraftIds"])
    draft_revision = config["asrDraftRevision"]
    fields = (
        "id", "title", "channel", "url", "duration_s", "batch", "style",
        "speakers_detected", "speaker_share_pct", "vad_segments", "vad_speech_s", "segmentation_source",
    )
    videos = [
        {key: row.get(key, "") for key in fields}
        for row in csv.DictReader(io.StringIO(read(f"data/{args.lang}/metadata.csv")))
    ]
    for video in videos:
        for key in ("duration_s", "vad_speech_s"):
            video[key] = float(video.get(key) or 0)
        for key in ("batch", "speakers_detected", "vad_segments"):
            video[key] = int(video.get(key) or 0)

    history: dict[str, list[dict]] = {}
    pattern = re.compile(r"([\w-]+): (\d+) segments, (\d+) verified")
    for commit in reversed(api.list_repo_commits(args.repo, repo_type="dataset", revision=revision)):
        match = pattern.fullmatch(commit.title)
        if match:
            video_id, segments, verified = match.groups()
            history.setdefault(video_id, []).append({
                "time": int(commit.created_at.timestamp() * 1000),
                "done": int(segments) > 0 and int(segments) == int(verified),
            })

    def source(video: dict) -> dict:
        video_id = video["id"]
        path = f"data/{args.lang}/{video_id}.rsml"
        return {
            "video": video,
            "transcript": read(path),
            "draft": read(path, draft_revision) if video_id in draft_ids else None,
            "commits": history.get(video_id, []),
        }

    with ThreadPoolExecutor(max_workers=8) as pool:
        sources = list(pool.map(source, videos))
    payload = {
        "schemaVersion": 1, "dataset": args.repo, "lang": args.lang,
        "sourceRevision": revision,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": sources,
    }
    module = (HERE / "editor/js/libraryStats.js").as_uri()
    program = f"""
import {{ activeSeconds, transcriptStats, videoStats }} from {json.dumps(module)};
let input = "";
for await (const chunk of process.stdin) input += chunk;
const {{ sources, ...index }} = JSON.parse(input);
index.videos = sources.map(({{ video, transcript, draft, commits }}) => {{
  const progress = transcriptStats(transcript, video.duration_s);
  const done = progress.segments > 0 && progress.verified === progress.segments;
  const activity = {{
    seconds: activeSeconds(commits, done),
    lastAt: commits.at(-1)?.time ?? null,
    completed: done && commits.some(commit => commit.done),
  }};
  return {{ ...video, ...videoStats(video, transcript, draft, activity) }};
}});
console.log(JSON.stringify(index));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", program],
        input=json.dumps(payload), text=True, capture_output=True, check=True,
    )
    index = json.loads(result.stdout)
    args.output.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    print(f"Stored statistics for {len(index['videos'])} files in {args.output}")
    if args.publish:
        commit = api.upload_file(
            repo_id=args.repo, repo_type="dataset", path_or_fileobj=str(args.output),
            path_in_repo=f"data/{args.lang}/library.json", parent_commit=revision,
            commit_message="Store library duration, verification and segment WER statistics",
        )
        print(commit.commit_url)


if __name__ == "__main__":
    main()
