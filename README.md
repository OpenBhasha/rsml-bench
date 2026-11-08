# RSML Bench

A small, open dataset of disfluency-rich speech, and the tools to annotate it. The first language is
Telugu. Each video has its audio and an RSML transcript: time-aligned segments with the speaker, a
verified flag and a note for each segment, and the transcript with its markup.

- **Dataset (gated, on request):** https://huggingface.co/datasets/openbhasha/rsml-bench
- **Annotation app:** https://openbhasha.github.io/rsml-bench/library.html

## Use the annotation app

1. Request access to the dataset on Hugging Face. Access is approved by hand.
2. Create an access token with write access to `openbhasha/rsml-bench`.
3. Open the annotation app and paste the token in the box at the top. It stays in that browser tab only,
   and is sent only to huggingface.co.
4. Open a video. Every edit is saved to the dataset: each save commits the video's `.rsml` file within
   about half a minute of the edit, or at once when you leave the video. Wait for "All changes saved" before you
   close the tab.

Saving needs write access to the dataset, which is granted to members of the OpenBhasha organisation on
Hugging Face. Approved readers can listen and read but not save.

Two annotators should not edit the same video at the same time: the last save wins.

## Run the app on your computer

```bash
python3 library_server.py
```

Then open http://localhost:8766/library.html. This reads and writes the files in `data/telugu/` directly,
with no token and no Hugging Face access needed.

## Data layout

```
data/<lang>/<id>.wav      16 kHz mono audio (on the Hub, not in this repository)
data/<lang>/<id>.rsml     the transcript for that video (on the Hub, not in this repository)
data/<lang>/metadata.csv  every field for each video (on the Hub, and telugu_cc_final.csv here)
data/<lang>/library.json  stored library statistics, updated with transcript saves
```

`data/` is not in this repository: the audio is too large for git. `publish_hf.py` uploads it.

After changing transcripts outside the editor, rebuild the library statistics with
`python3 refresh_library_stats.py --publish` (requires Node.js and Hugging Face write access).
The local server stores its statistics in `data/<lang>/library-stats.json` and refreshes changed files.

## Make the dataset

```bash
pip install -r requirements.txt
python3 find_telugu_cc_videos.py     # search YouTube for CC BY, primary-audio, non-dubbed videos
python3 download_audio.py            # fetch the audio into data/telugu/
python3 segment_audio.py             # VAD + speaker diarization -> data/telugu/<id>.rsml
python3 sync_metadata_from_rsml.py <id>   # after a human has checked a file: copy its counts into the CSV
hf auth login                        # once, with a token that can write to the dataset
python3 publish_hf.py --lang telugu  # upload audio, transcripts, metadata and the dataset card
```

`segment_audio.py` skips any video that a person has verified (or that has verified cues), unless
`--overwrite-verified` is given.

## Licence and credit

Every video was listed on YouTube under the "Creative Commons Attribution license (reuse allowed)". YouTube
does not say which CC BY version applies to each video. The dataset card lists every video with its title,
channel and URL. Credit them when you use the data.

## Credits

The annotation editor is adapted from [BhashaCheck Lite](https://github.com/OpenBhasha/BhashaCheck-Lite)
(v1.0.4). It has been changed to read and save the library, and to drop the browser-side copies.
