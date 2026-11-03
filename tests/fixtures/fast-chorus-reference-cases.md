# BLACKPINK chorus reference cases

These annotations are test data, not production timing overrides. The user
explicitly confirmed both intervals as the desired first chorus:

| Official video ID | Reference | Captured lyric API guess | Revised audio candidate |
| --- | --- | --- | --- |
| bqzDuRz_P7g | 66–96 s | 75–91 s | 66–96.25 s |
| ivoS3HUJB3Q | 84–116 s | 56–81 s | 84–115.75 s |

The full uploaded WebM recordings were decoded and analyzed during development.
Offline decoding + detection took approximately 0.9–1.1 seconds on the cloud
executor. This is not a measurement of YouTube download, queue or browser latency
on the user's PC. Only the annotated occurrence is asserted; later chorus
occurrences have no human-verified labels here.

The `.npz` fixtures contain derived chroma, timbre, RMS energy and activity
features at a 0.25-second step, plus duration. They contain no original audio,
lyrics, artist-specific detection rules or model weights. Tests rerun the
production recurrence and boundary selection against these features. Synthetic
WAV tests separately exercise decoding and feature extraction.

To regenerate features from a local recording, use `fast_analysis.decode()` and
`fast_analysis.features()`, then save c, t, energy, active, duration and step with
`numpy.savez_compressed`. The production detector must never load these fixtures.

The browser regression uses the captured lyric ranges and actual measured audio
ranges, delaying the audio response to reproduce the source-order bug. A lyric
result must not lock the UI while bounded fast audio analysis is still pending.
After the first selected result is displayed, the existing snapshot protection
continues to prevent late results from silently moving its boundaries.

## SEVENTEEN comment reaction regression

`comment-reaction-reference.json` stores only the relevant short timestamped
reaction line, not the surrounding long comment. The user confirmed first chorus
58–79 s and uploaded the matching recording. The derived fixture
`fast-chorus-aJ55DJE4Os4-features.npz` produces 58.5–79.25 s after refinement.
The data is not a per-song timing override. Only the supplied first occurrence is
verified; later repeats have no human-verified reference here.
