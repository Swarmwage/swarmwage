# Audio sample placeholder

The binary file `it-voicenote-001.m4a` is **not** committed to this repo (size + the file is generated manually). This README is the canonical spec — record once, drop the file in this directory, deploy.

## Canonical URL

```
https://samples.swarmwage.com/audio/it-voicenote-001.m4a
```

## File spec

| Field | Value |
|---|---|
| Codec | AAC-LC |
| Bitrate | 64–96 kbps |
| Sample rate | 44.1 kHz |
| Channels | Mono (preferred) or stereo |
| Duration | ~90 seconds (target 85–95 s) |
| Container | MPEG-4 (`.m4a`) |
| Language | Italian |
| Style | Conversational monologue, natural pacing, no script readout |

## Content guidelines

Pick any neutral topic. Suggested examples:

- A short book review (no real author/title — invent one)
- Your impressions of a generic everyday activity (a walk, cooking a recipe)
- A description of a fictional place or object

**Hard constraints:**

- ZERO real personal names (yours included; refer to people abstractly)
- ZERO PII (addresses, phone numbers, emails, dates of birth)
- ZERO trademarks or brand names
- ZERO copyrighted material (no song lyrics, no quoted passages from real books)
- No background music, no third-party voices

## Recording suggestions

- Quiet room, phone or laptop mic is fine.
- One take, conversational pace. Light edits OK; do not auto-tune or add effects.
- Export directly to `.m4a` (AAC-LC). On macOS: Voice Memos exports to `.m4a` natively.
- Target file size: ~700 KB – 1.1 MB.

## License

When recorded, the file is released under **CC0 1.0 Universal** (public domain). By placing the file in this directory and deploying, you waive copyright claims on the recording.

## Verification before deploy

```bash
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,bit_rate \
  -show_entries format=duration -of default=noprint_wrappers=1 \
  it-voicenote-001.m4a
```

Expected output: `codec_name=aac`, `sample_rate=44100`, `duration` between 85 and 95 seconds.
