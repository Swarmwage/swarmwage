# Sample audio assets

Audio binaries are hosted out of the git repo (size: a 90 s m4a clip is ~1.5 MB; checking in audio bloats history and slows clones). The reference sample lives on `samples.swarmwage.com` and the seller fetches it over HTTPS like any other source.

## Reference clip

| Property | Value |
|---|---|
| Filename | `it-voicenote-001.m4a` |
| URL | `https://samples.swarmwage.com/audio/it-voicenote-001.m4a` |
| Language | Italian (`it`) |
| Duration | ~90 seconds |
| Codec | AAC in m4a container |
| Sample rate | 44.1 kHz mono |
| Content | Synthetic voicenote — speaker reads a short test script. No real personal data. |

## Substituting your own audio

Any publicly-reachable HTTP/HTTPS URL works. Constraints enforced by the seller:

- Protocol is `http://` or `https://`
- Hostname is not a private/loopback address (override with `ALLOW_PRIVATE_FETCH=1` in dev)
- `Content-Length` (when advertised) is ≤ `MAX_AUDIO_MB` (default 50 MB)
- Audio is in a Whisper-supported container (mp3, m4a, mp4, wav, webm, ogg, flac)

## Hosting

The asset is uploaded to `samples.swarmwage.com` separately from this repo (S3/Cloudflare R2-backed static origin). Seed assets are tracked in the launch playbook, not in git.
