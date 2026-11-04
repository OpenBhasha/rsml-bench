"""Download best audio for every video in telugu_cc_final.csv -> data/telugu/<id>.wav (16 kHz mono, 16-bit).
Resumable: a video whose WAV already exists and matches the expected duration is skipped."""
import csv, subprocess, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import yt_dlp
import find_telugu_cc_videos as m

rows = list(csv.DictReader(open(ROOT / "telugu_cc_final.csv", encoding="utf-8-sig")))
out, src = ROOT / "data" / "telugu", ROOT / "data" / "_source"
src.mkdir(parents=True, exist_ok=True)
MAX_DRIFT = 3.0  # seconds between the WAV and YouTube's reported duration

def wav_seconds(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                       capture_output=True, text=True)
    try: return float(r.stdout.strip())
    except ValueError: return None

def ok(p, expected):
    d = wav_seconds(p) if p.exists() else None
    return d is not None and abs(d - expected) <= MAX_DRIFT

opts = {**m.YDL_BASE, "format": "bestaudio[ext=m4a]/bestaudio", "outtmpl": str(src / "%(id)s.%(ext)s"),
        "noprogress": True, "overwrites": False}
fails, throttled_in_a_row = [], 0
for n, r in enumerate(rows, 1):
    vid, expected = r["id"], float(r["duration_s"])
    wav = out / f"{vid}.wav"
    if ok(wav, expected):
        print(f"{n}/{len(rows)} {vid} already done", flush=True); continue
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            info = y.extract_info(r["url"], download=True)
            f = Path(y.prepare_filename(info))
        tmp = out / f"{vid}.partial.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(f), "-vn", "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", "-f", "wav", str(tmp)], check=True)
        d = wav_seconds(tmp)
        if d is None or abs(d - expected) > MAX_DRIFT:
            tmp.unlink(missing_ok=True); raise RuntimeError(f"duration {d} vs expected {expected}")
        tmp.rename(wav); f.unlink(missing_ok=True)
        throttled_in_a_row = 0
        print(f"{n}/{len(rows)} {vid} ok {d/60:.1f} min  {wav.stat().st_size/1e6:.0f} MB  "
              f"[{info.get('acodec')} {info.get('abr')} kbps]  {r['channel'][:30]}", flush=True)
    except Exception as e:
        msg = str(e)[:160]
        throttled_in_a_row = throttled_in_a_row + 1 if ("not a bot" in msg or "429" in msg) else 0
        fails.append((vid, msg)); print(f"{n}/{len(rows)} {vid} FAILED: {msg}", flush=True)
        if throttled_in_a_row >= 3:
            print("YouTube is throttling; stopping. Re-run later to resume.", flush=True); break
    time.sleep(3)
print(f"done: {len(rows) - len(fails)} ok, {len(fails)} failed", flush=True)
for v, e in fails: print(" failed:", v, e)
