## Internal model (MVP)
This app intentionally separates:

- **Score**: MusicXML/GPX content (notation + tab as authored or AI-drafted)
- **Sync map**: a performance-time mapping for rubato/swing alignment

### Why separate?
MusicXML is primarily a notation interchange format; it does not encode arbitrary continuous rubato performance timing well. Soundslice-style editors keep a separate sync map.

### Sync map schema (v1)
`sync-map.json`

```json
{
  "version": 1,
  "createdAt": "2026-03-17T00:00:00.000Z",
  "media": { "durationSec": 123.456 },
  "syncPoints": [
    { "score": { "measure": 1, "beat": 1 }, "timeSec": 0.000 },
    { "score": { "measure": 5, "beat": 1 }, "timeSec": 12.345 }
  ]
}
```

Interpretation:
- The mapping is **piecewise linear** between sorted sync points.
- `score.measure` is 1-indexed.
- `score.beat` is 1-indexed and may be fractional (e.g. 2.5).

### Next planned model upgrades
- Use MusicXML `divisions`, time signatures, and per-note rhythmic positions to turn `measure:beat` into a precise scalar timebase.
- Add `voice` and `staff` addressing for chord-melody editing.
- Add note-level selection from rendered score (click note → set anchor).
