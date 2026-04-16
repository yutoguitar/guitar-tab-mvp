/**
 * Editable score model: parse MusicXML → notes array, build MusicXML from notes.
 * Note: { id, measure, beat, duration, step, alter, octave, string, fret }
 * - beat: 1-based quarter position (1, 1.25, 1.5, 2...)
 * - duration: quarter length (0.25 = 16th, 1 = quarter, 4 = whole)
 */

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/** @typedef {{ id: string, measure: number, beat: number, duration: number, step: string, alter: number, octave: number, string?: number, fret?: number }} ScoreNote */

/**
 * @param {string} xmlString
 * @returns {{ divisions: number, beats: number, beatType: number, measuresCount?: number, notes: ScoreNote[] }}
 */
function parseMusicXmlToScoreModel(xmlString) {
  const xml = new DOMParser().parseFromString(xmlString, "application/xml");
  const all = Array.from(xml.getElementsByTagName("*"));
  const byLocal = (name) => all.filter((n) => n.localName === name);

  const divisionsEl = all.find((n) => n.localName === "divisions");
  const divisions = Math.max(1, Number(divisionsEl?.textContent ?? 4));
  const beatsEl = all.find((n) => n.localName === "beats");
  const beatTypeEl = all.find((n) => n.localName === "beat-type");
  const beats = Number(beatsEl?.textContent ?? 4);
  const beatType = Number(beatTypeEl?.textContent ?? 4);

  /** @type {ScoreNote[]} */
  const notes = [];
  let measuresCount = 1;
  const parts = byLocal("part");
  for (const part of parts) {
    let timeDiv = 0;
    let lastStartDiv = 0;
    const measures = Array.from(part.children).filter((n) => n.localName === "measure");
    measuresCount = Math.max(1, measures.length);
    for (const measure of measures) {
      const measureNum = Math.max(1, Number(measure.getAttribute("number") ?? 1));
      const noteEls = Array.from(measure.children).filter((n) => n.localName === "note");
      for (const note of noteEls) {
        const isRest = Array.from(note.children).some((n) => n.localName === "rest");
        const isChord = Array.from(note.children).some((n) => n.localName === "chord");
        const durEl = Array.from(note.children).find((n) => n.localName === "duration");
        const durDiv = durEl ? Number(durEl.textContent) : 0;
        const durQuarters = divisions > 0 ? durDiv / divisions : 0.25;
        const startDiv = isChord ? lastStartDiv : timeDiv;
        const beat = 1 + (startDiv / divisions);

        if (!isRest) {
          const pitch = Array.from(note.children).find((n) => n.localName === "pitch");
          const step = pitch ? Array.from(pitch.children).find((n) => n.localName === "step")?.textContent?.trim() ?? "C" : "C";
          const alter = pitch ? Number(Array.from(pitch.children).find((n) => n.localName === "alter")?.textContent ?? 0) : 0;
          const octave = pitch ? Number(Array.from(pitch.children).find((n) => n.localName === "octave")?.textContent ?? 4) : 4;
          const notations = Array.from(note.children).find((n) => n.localName === "notations");
          let stringNum, fretNum;
          if (notations) {
            const tech = Array.from(notations.children).find((n) => n.localName === "technical");
            if (tech) {
              const sEl = Array.from(tech.children).find((n) => n.localName === "string");
              const fEl = Array.from(tech.children).find((n) => n.localName === "fret");
              stringNum = sEl ? Number(sEl.textContent) : undefined;
              fretNum = fEl ? Number(fEl.textContent) : undefined;
            }
          }
          notes.push({
            id: randomId(),
            measure: measureNum,
            beat: Math.round(beat * 100) / 100,
            duration: Math.round(durQuarters * 100) / 100 || 0.25,
            step: String(step),
            alter: Number(alter),
            octave: Number(octave),
            string: stringNum,
            fret: fretNum,
          });
        }
        if (!isChord) {
          timeDiv += durDiv;
          lastStartDiv = timeDiv - durDiv;
        }
      }
    }
    break;
  }
  return { divisions, beats, beatType, measuresCount, notes };
}

/** duration (quarters) → MusicXML type */
function durationToType(dur) {
  if (dur >= 4) return "whole";
  if (dur >= 2) return "half";
  if (dur >= 1) return "quarter";
  if (dur >= 0.5) return "eighth";
  if (dur >= 0.25) return "16th";
  if (dur >= 0.125) return "32nd";
  return "16th";
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function quantizeQuarterDur(d) {
  // Quantize to a 16th grid so durations map cleanly to MusicXML without ties (MVP).
  const q = Math.round(Number(d) / 0.25) * 0.25;
  return clamp(Number.isFinite(q) ? q : 0.25, 0.25, 16);
}

function emitNoteXml({ divisions, note, isChord }) {
  const escape = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const durQ = quantizeQuarterDur(note.duration);
  const durDiv = Math.max(1, Math.round(durQ * divisions));
  const type = durationToType(durQ);
  let out = "      <note>\n";
  if (isChord) out += "        <chord/>\n";
  out += `        <pitch><step>${escape(note.step || "C")}</step>${
    note.alter ? `<alter>${Number(note.alter)}</alter>` : ""
  }<octave>${Number.isFinite(note.octave) ? Number(note.octave) : 4}</octave></pitch>\n`;
  out += `        <duration>${durDiv}</duration>\n        <type>${type}</type>\n`;
  out += "        <voice>1</voice>\n";
  if (note.string != null || note.fret != null) {
    out += "        <notations><technical>";
    if (note.string != null) out += `<string>${Number(note.string)}</string>`;
    if (note.fret != null) out += `<fret>${Number(note.fret)}</fret>`;
    out += "</technical></notations>\n";
  }
  out += "      </note>\n";
  return out;
}

function emitRestXml({ divisions, durationQuarters }) {
  const durQ = quantizeQuarterDur(durationQuarters);
  const durDiv = Math.max(1, Math.round(durQ * divisions));
  const type = durationToType(durQ);
  return (
    "      <note>\n" +
    "        <rest/>\n" +
    `        <duration>${durDiv}</duration>\n` +
    `        <type>${type}</type>\n` +
    "        <voice>1</voice>\n" +
    "      </note>\n"
  );
}

/**
 * @param {{ divisions: number, beats: number, beatType: number, measuresCount?: number, notes: ScoreNote[] }} model
 * @returns {string}
 */
function buildMusicXmlFromScoreModel(model) {
  const { divisions, beats, beatType, notes } = model;
  const beatsPerMeasure = Number.isFinite(beats) && Number.isFinite(beatType) && beatType > 0 ? beats * (4 / beatType) : 4;
  const sorted = notes
    .slice()
    .map((n) => ({ ...n, beat: Number(n.beat), duration: quantizeQuarterDur(n.duration) }))
    .sort((a, b) => a.measure - b.measure || a.beat - b.beat || String(a.id).localeCompare(String(b.id)));
  const byMeasure = new Map();
  for (const n of sorted) {
    if (!byMeasure.has(n.measure)) byMeasure.set(n.measure, []);
    byMeasure.get(n.measure).push(n);
  }
  const measureNumbers = Array.from(byMeasure.keys()).sort((a, b) => a - b);
  const notesMaxMeasure = measureNumbers.length ? measureNumbers[measureNumbers.length - 1] : 1;
  const maxMeasure = Math.max(1, notesMaxMeasure, Number(model.measuresCount || 1));
  /** @type {{ number: number, notes: ScoreNote[] }[]} */
  const measures = [];
  for (let i = 1; i <= maxMeasure; i++) measures.push({ number: i, notes: byMeasure.get(i) || [] });

  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n  <part-list>\n    <score-part id="P1" name="Guitar"/>\n  </part-list>\n  <part id="P1">\n';
  for (const m of measures) {
    out += `    <measure number="${m.number}">\n`;
    if (m.number === 1) {
      out += `      <attributes>\n        <divisions>${divisions}</divisions>\n        <key><fifths>0</fifths></key>\n        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>\n        <clef><sign>G</sign><line>2</line></clef>\n      </attributes>\n`;
    }
    // Emit notes while preserving their beat positions by inserting rests between onsets.
    // MVP: single voice, no ties; we quantize to 16th grid.
    const notesInMeasure = m.notes.slice().sort((a, b) => a.beat - b.beat);
    let cursorBeat = 1; // 1-based quarter beat within measure
    let i = 0;
    while (i < notesInMeasure.length) {
      const beat = clamp(notesInMeasure[i].beat, 1, 1 + beatsPerMeasure);
      if (beat > cursorBeat + 1e-6) {
        out += emitRestXml({ divisions, durationQuarters: beat - cursorBeat });
        cursorBeat = beat;
      }
      // Emit all notes starting at this beat as a chord group
      const chordGroup = [];
      while (i < notesInMeasure.length && Math.abs(notesInMeasure[i].beat - beat) < 0.01) {
        chordGroup.push(notesInMeasure[i]);
        i++;
      }
      chordGroup.sort((a, b) => (Number(a.string ?? 9) - Number(b.string ?? 9)) || (Number(a.fret ?? 999) - Number(b.fret ?? 999)));
      for (let j = 0; j < chordGroup.length; j++) {
        out += emitNoteXml({ divisions, note: chordGroup[j], isChord: j > 0 });
      }
      // Advance cursor by the longest duration in the chord group
      const maxDur = Math.max(...chordGroup.map((n) => quantizeQuarterDur(n.duration)));
      cursorBeat += maxDur;
      cursorBeat = clamp(cursorBeat, 1, 1 + beatsPerMeasure);
    }
    // Fill remaining time in measure with rest so layout stays stable.
    const measureEnd = 1 + beatsPerMeasure;
    if (cursorBeat < measureEnd - 1e-6) {
      out += emitRestXml({ divisions, durationQuarters: measureEnd - cursorBeat });
    }
    out += "    </measure>\n";
  }
  out += "  </part>\n</score-partwise>\n";
  return out;
}

/**
 * Build alphaTex from the editable score model.
 * We prefer fretted notation (fret.string) with a guitar tuning so alphaTab can show
 * both standard notation + TAB reliably (ScoreTab).
 *
 * @param {{ beats: number, beatType: number, measuresCount?: number, notes: ScoreNote[] }} model
 * @returns {string}
 */
/**
 * Convert transcription engine JSON → editable score model.
 *
 * Input: { meta: {...}, notes: [{ timestamp, pitch, string, fret, ... }] }
 * Output: { divisions, beats, beatType, measuresCount, notes: ScoreNote[] }
 *
 * Also returns syncPoints mapping measure:beat → timeSec.
 *
 * @param {object} transcription — raw output from transcribe.py
 * @param {number} [bpm=120] — beats per minute (caller can estimate from librosa)
 * @returns {{ scoreModel: object, syncPoints: Array<{score: {measure: number, beat: number}, timeSec: number}> }}
 */
function transcriptionJsonToScoreModel(transcription, bpm) {
  const STEP_NAMES = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
  const STEP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

  const notes = (transcription.notes || []).slice();
  if (!notes.length) {
    return {
      scoreModel: { divisions: 4, beats: 4, beatType: 4, measuresCount: 1, notes: [] },
      syncPoints: [],
    };
  }

  // Estimate BPM from median inter-onset interval if not provided
  if (!bpm || bpm <= 0) {
    const timestamps = notes.map((n) => Number(n.timestamp)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < timestamps.length; i++) {
      const g = timestamps[i] - timestamps[i - 1];
      if (g > 0.05 && g < 2.0) gaps.push(g);
    }
    if (gaps.length > 2) {
      gaps.sort((a, b) => a - b);
      const medianGap = gaps[Math.floor(gaps.length / 2)];
      // Assume median gap ≈ one eighth note for chord-melody (2 attacks per beat)
      bpm = Math.round(60 / (medianGap * 2));
      bpm = Math.max(40, Math.min(240, bpm));
    } else {
      bpm = 120;
    }
  }

  const secPerBeat = 60 / bpm;
  const beats = 4;
  const beatType = 4;
  const beatsPerMeasure = 4;
  const divisions = 4; // 16th note resolution

  // Group notes by onset cluster (notes within 50ms are simultaneous)
  const clusters = [];
  const sorted = notes.slice().sort((a, b) => a.timestamp - b.timestamp);
  let curCluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].timestamp - curCluster[0].timestamp <= 0.05) {
      curCluster.push(sorted[i]);
    } else {
      clusters.push(curCluster);
      curCluster = [sorted[i]];
    }
  }
  clusters.push(curCluster);

  const scoreNotes = [];
  const syncPoints = [];
  let lastMeasure = 0;

  for (const cluster of clusters) {
    const t = Number(cluster[0].timestamp);
    // Convert timestamp → beat position
    const totalBeats = t / secPerBeat;
    const measure = 1 + Math.floor(totalBeats / beatsPerMeasure);
    const beatInMeasure = 1 + (totalBeats % beatsPerMeasure);
    // Quantize to 16th grid
    const quantBeat = Math.round(beatInMeasure / 0.25) * 0.25;
    const finalBeat = Math.max(1, Math.min(1 + beatsPerMeasure - 0.25, quantBeat));

    // Find duration: time to next cluster, capped at 1 beat
    const clusterIdx = clusters.indexOf(cluster);
    let durSec = secPerBeat; // default: one beat
    if (clusterIdx < clusters.length - 1) {
      durSec = Math.min(secPerBeat * 2, clusters[clusterIdx + 1][0].timestamp - t);
    }
    const durBeats = Math.max(0.25, Math.min(4, durSec / secPerBeat));
    const quantDur = Math.round(durBeats / 0.25) * 0.25;

    for (const note of cluster) {
      const midi = Number(note.pitch);
      const pc = ((midi % 12) + 12) % 12;
      const octave = Math.floor(midi / 12) - 1;

      scoreNotes.push({
        id: randomId(),
        measure,
        beat: Math.round(finalBeat * 100) / 100,
        duration: Math.max(0.25, quantDur),
        step: STEP_NAMES[pc],
        alter: STEP_ALTER[pc],
        octave,
        string: note.string != null ? Number(note.string) : undefined,
        fret: note.fret != null ? Number(note.fret) : undefined,
      });
    }

    // Add sync point at start of each new measure
    if (measure > lastMeasure) {
      syncPoints.push({
        score: { measure, beat: 1 },
        timeSec: Math.round((measure - 1) * beatsPerMeasure * secPerBeat * 1000) / 1000,
      });
      lastMeasure = measure;
    }
  }

  const measuresCount = Math.max(1, lastMeasure);

  return {
    scoreModel: { divisions, beats, beatType, measuresCount, notes: scoreNotes },
    syncPoints,
    bpm,
  };
}

function buildAlphaTexFromScoreModel(model) {
  const beats = Number(model.beats || 4);
  const beatType = Number(model.beatType || 4);
  const beatsPerMeasure = Number.isFinite(beats) && Number.isFinite(beatType) && beatType > 0 ? beats * (4 / beatType) : 4;
  const measuresCount = Math.max(1, Number(model.measuresCount || 1));
  const q = (x) => Math.round(Number(x) / 0.25) * 0.25;
  const durToken = (durQ) => {
    const d = Math.max(0.25, q(durQ));
    const t = Math.round(4 / d);
    // clamp to common values: 1,2,4,8,16,32
    const allowed = [1, 2, 4, 8, 16, 32, 64];
    return allowed.includes(t) ? t : 4;
  };

  const byMeasure = new Map();
  for (const n of model.notes || []) {
    const m = Math.max(1, Math.floor(Number(n.measure || 1)));
    if (!byMeasure.has(m)) byMeasure.set(m, []);
    byMeasure.get(m).push({ ...n, beat: Number(n.beat), duration: Number(n.duration) });
  }

  let out = '';
  out += '\\track "Guitar" ';
  out += '\\staff {tabs} ';
  // Standard tuning high->low
  out += '\\tuning (E4 B3 G3 D3 A2 E2) ';
  out += `\\ts (${beats} ${beatType}) `;

  for (let m = 1; m <= measuresCount; m++) {
    const notes = (byMeasure.get(m) || []).slice().sort((a, b) => a.beat - b.beat);
    let cursorBeat = 1;
    let i = 0;
    const chunks = [];
    while (i < notes.length) {
      const beat = Math.max(1, Math.min(1 + beatsPerMeasure, q(notes[i].beat || 1)));
      if (beat > cursorBeat + 1e-6) {
        const restDur = beat - cursorBeat;
        chunks.push(`r.${durToken(restDur)}`);
        cursorBeat = beat;
      }
      const group = [];
      while (i < notes.length && Math.abs(q(notes[i].beat || 1) - beat) < 0.01) {
        group.push(notes[i]);
        i++;
      }
      const maxDur = Math.max(...group.map((n) => q(n.duration || 1)));
      const token = durToken(maxDur);
      const content = group
        .map((n) => {
          const stringNum = Math.max(1, Math.min(6, Math.round(Number(n.string ?? 1))));
          const fretNum = Math.max(0, Math.min(36, Math.round(Number(n.fret ?? 0))));
          return `${fretNum}.${stringNum}`;
        })
        .join(" ");
      chunks.push(group.length > 1 ? `(${content}).${token}` : `${content}.${token}`);
      cursorBeat += maxDur;
    }
    const measureEnd = 1 + beatsPerMeasure;
    if (cursorBeat < measureEnd - 1e-6) {
      chunks.push(`r.${durToken(measureEnd - cursorBeat)}`);
    }
    out += chunks.join(" ") + " | ";
  }
  return out.trim();
}
