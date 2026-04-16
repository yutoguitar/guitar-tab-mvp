/**
 * MVP goal:
 * - Load local video + MusicXML
 * - Render notation (and TAB staff if present)
 * - Show waveform and keep video/waveform in sync
 * - Let user create a small set of "sync points" (score position ↔ media time)
 *   to fix rubato timing, Soundslice-style.
 *
 * Note: We intentionally keep the MusicXML unchanged and store timing as a separate
 * sync map JSON. Later, the AI transcription pipeline can generate an initial draft
 * score + draft sync map for quick correction.
 */

const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  error: $("error"),
  videoFile: $("videoFile"),
  youtubeUrl: $("youtubeUrl"),
  loadYoutubeBtn: $("loadYoutubeBtn"),
  xmlFile: $("xmlFile"),
  video: $("video"),
  youtubeWrap: $("youtubeWrap"),
  youtubePlayer: $("youtubePlayer"),
  waveform: $("waveform"),
  score: $("score"),
  scoreWrap: $("scoreWrap"),
  scoreClickOverlay: $("scoreClickOverlay"),
  scoreSelection: $("scoreSelection"),
  scorePlayhead: $("scorePlayhead"),
  selectedScorePos: $("selectedScorePos"),
  selectedTime: $("selectedTime"),
  playPauseBtn: $("playPauseBtn"),
  rewindBtn: $("rewindBtn"),
  forwardBtn: $("forwardBtn"),
  addSyncPointBtn: $("addSyncPointBtn"),
  tapSyncBtn: $("tapSyncBtn"),
  synthMode: $("synthMode"),
  syncTableBody: $("syncTableBody"),
  exportSyncBtn: $("exportSyncBtn"),
  importSyncBtn: $("importSyncBtn"),
  syncJsonFile: $("syncJsonFile"),
  saveProjectBtn: $("saveProjectBtn"),
  loadProjectBtn: $("loadProjectBtn"),
  projectFile: $("projectFile"),
  exportMusicXmlBtn: $("exportMusicXmlBtn"),
  editModeCheckbox: $("editModeCheckbox"),
  newTabBtn: $("newTabBtn"),
  addMeasureBtn: $("addMeasureBtn"),
  loopCheckbox: $("loopCheckbox"),
  loopFromMeasure: $("loopFromMeasure"),
  loopFromBeat: $("loopFromBeat"),
  loopToMeasure: $("loopToMeasure"),
  loopToBeat: $("loopToBeat"),
  noteEditorPosition: $("noteEditorPosition"),
  noteEditorList: $("noteEditorList"),
  addNoteBtn: $("addNoteBtn"),
  editModePill: $("editModePill"),
  toolPencil: $("toolPencil"),
  toolEraser: $("toolEraser"),
  editDuration: $("editDuration"),
  newNoteString: $("newNoteString"),
  newNoteFret: $("newNoteFret"),
  newNoteStep: $("newNoteStep"),
  newNoteAlter: $("newNoteAlter"),
  newNoteOctave: $("newNoteOctave"),
  tabEntryHint: $("tabEntryHint"),
  pitchPalette: $("pitchPalette"),
  accFlatBtn: $("accFlatBtn"),
  accNaturalBtn: $("accNaturalBtn"),
  accSharpBtn: $("accSharpBtn"),
  activePitchPill: $("activePitchPill"),
  tabInlineInput: $("tabInlineInput"),
  transcribeBtn: $("transcribeBtn"),
  transcribeStatus: $("transcribeStatus"),
};

/** @typedef {{ measure: number, beat: number }} ScorePos */
/** @typedef {{ id: string, score: ScorePos, timeSec: number }} SyncPoint */

/** @type {{ atApi: any | null, wave: any | null, musicXmlText: string | null, syncPoints: SyncPoint[], scoreModel: { divisions: number, beats: number, beatType: number, measuresCount?: number, notes: Array<{ id: string, measure: number, beat: number, duration: number, step: string, alter: number, octave: number, string?: number, fret?: number }> } | null }} */
const state = {
  atApi: null,
  wave: null,
  musicXmlText: null,
  alphaTexText: null,
  renderFormat: "musicxml", // "musicxml" | "alphatex"
  syncPoints: [],
  scoreModel: null,
};

const editState = {
  enabled: false,
  tool: "pencil", // "pencil" | "eraser"
  duration: 1,
  newNote: { string: 1, fret: 0, step: "C", alter: 0, octave: 4 },
  tabEntry: { activeString: 1, buffer: "", timer: null },
  lastPointer: { x: 0, y: 0 },
};

function pitchLabel(step, alter, octave) {
  const acc = alter === 1 ? "♯" : alter === -1 ? "♭" : "";
  return `${String(step || "C").toUpperCase()}${acc}${Number.isFinite(octave) ? octave : 4}`;
}

function ensureAlphaTab() {
  if (state.atApi) return;
  const alphaTab = window.alphaTab;
  if (!alphaTab) throw new Error("alphaTab is not loaded (check network/CDN).");
  const settings = new alphaTab.Settings();
  settings.core.engine = "svg";
  settings.core.fontDirectory = window.ALPHATAB_FONT || settings.core.fontDirectory;
  settings.display.scale = 1.0;
  settings.display.layoutMode = alphaTab.LayoutMode.Page;
  settings.display.barsPerRow = 4;
  // Reduce excessive horizontal whitespace.
  settings.display.stretchForce = 0.45;
  // Show standard notation + tablature (Soundslice-style).
  settings.display.staveProfile = alphaTab.StaveProfile.ScoreTab;
  settings.notation.notationMode = alphaTab.NotationMode.GuitarPro;
  state.atApi = new alphaTab.AlphaTabApi(els.score, settings);

  // Selection mapping: click a beat in alphaTab -> update our (measure, beat) selection.
  // This is essential for editing (tab entry) to know where to place notes.
  try {
    state.atApi.beatMouseDown?.on?.((beat) => handleBeatSelected(beat));
  } catch (e) {
    console.warn("alphaTab beatMouseDown unavailable", e);
  }
}

/** Shared logic: select beat, infer string, enable edit, focus for tab entry. */
function handleBeatSelected(beat) {
  if (!beat) return;
  try {
    const bar = beat?.voice?.bar;
    const master = bar?.masterBar;
    const measure = Number.isFinite(bar?.index) ? bar.index + 1 : 1;
    const num = Number(master?.timeSignatureNumerator ?? state.scoreModel?.beats ?? 4);
    const den = Number(master?.timeSignatureDenominator ?? state.scoreModel?.beatType ?? 4);
    const beatsPerMeasure = Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num * (4 / den) : 4;
    const barDur = typeof bar?.calculateDuration === "function" ? Number(bar.calculateDuration()) : null;
    const start = Number(beat?.displayStart ?? 0);
    const frac = barDur && barDur > 0 ? start / barDur : 0;
    let b = 1 + frac * beatsPerMeasure;
    b = Math.round(b / 0.25) * 0.25;
    setSelectedScore({ measure, beat: b }, null);
    els.scoreWrap?.focus?.();

    const r = els.scoreWrap?.getBoundingClientRect();
    if (r) {
      const contentY = editState.lastPointer.y - r.top + (els.scoreWrap?.scrollTop ?? 0);
      const scorePaddingTop = (els.score && parseInt(getComputedStyle(els.score).paddingTop, 10)) || 0;
      const notationY = contentY - scorePaddingTop;
      let inferredString = 1;
      const lookup = state.atApi?.boundsLookup;
      if (lookup?.staffSystems?.length) {
        for (const sys of lookup.staffSystems) {
          const vb = sys.visualBounds || sys.realBounds;
          if (!vb || typeof vb.y !== "number") continue;
          const sy = Number(vb.y);
          const sh = Number(vb.h ?? vb.height ?? 0);
          if (sh <= 0 || notationY < sy || notationY > sy + sh) continue;
          const tabTop = sy + 0.45 * sh;
          const tabHeight = 0.55 * sh;
          const tabRelY = notationY - tabTop;
          const frac = tabHeight > 0 ? Math.max(0, Math.min(1, tabRelY / tabHeight)) : 0;
          inferredString = 1 + Math.min(5, Math.max(0, Math.floor(frac * 6)));
          break;
        }
      } else {
        const relY = editState.lastPointer.y - r.top;
        const tabTop = 0.45 * r.height;
        const tabHeight = 0.55 * r.height;
        const tabRelY = relY - tabTop;
        const fracFb = tabHeight > 0 ? Math.max(0, Math.min(1, tabRelY / tabHeight)) : 0;
        inferredString = 1 + Math.min(5, Math.max(0, Math.floor(fracFb * 6)));
      }
      editState.tabEntry.activeString = inferredString;
      editState.newNote.string = inferredString;
      if (els.newNoteString) els.newNoteString.value = String(inferredString);
    }

    if (state.scoreModel && els.scoreWrap) {
      if (!editState.enabled) {
        editState.enabled = true;
        if (els.editModeCheckbox) els.editModeCheckbox.checked = true;
        setStatus("Edit mode ON — type fret number, Enter to add");
      }
      els.scoreWrap.focus();
      renderNoteEditor();
    }
  } catch (e) {
    console.warn("handleBeatSelected failed", e);
  }
}

async function renderCurrentMusicXml() {
  ensureAlphaTab();
  const alphaTab = window.alphaTab;
  let score = null;
  if (state.renderFormat === "alphatex") {
    if (!state.alphaTexText) return;
    score = alphaTab.importer.ScoreLoader.loadAlphaTex(state.alphaTexText);
  } else {
    if (!state.musicXmlText) return;
    const bytes = new TextEncoder().encode(state.musicXmlText);
    score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes);
  }
  // Force score+tab display on first staff where possible.
  try {
    for (const track of score?.tracks || []) {
      for (const staff of track?.staves || []) {
        staff.showStandardNotation = true;
        staff.showTablature = true;
      }
    }
  } catch {
    // ignore - depends on importer/model shape
  }
  state.atApi.renderScore(score, [0]);
  // No OSMD measure boxes; keep click handler for future alphaTab hit-testing.
  attachScoreClickHandler();
  updateButtons();
  renderNoteEditor();
}

function newTabFromScratch({ measuresCount = 8, beats = 4, beatType = 4, divisions = 4 } = {}) {
  state.scoreModel = {
    divisions,
    beats,
    beatType,
    measuresCount,
    notes: [],
  };
  state.musicXmlText = buildMusicXmlFromScoreModel(state.scoreModel);
  state.alphaTexText = buildAlphaTexFromScoreModel(state.scoreModel);
  state.renderFormat = "alphatex";
  editState.enabled = true;
  if (els.editModeCheckbox) els.editModeCheckbox.checked = true;
  selection.noteId = null;
  setSelectedScore({ measure: 1, beat: 1 }, null);
  setStatus("New tab created — Edit mode ON");
  return renderCurrentMusicXml();
}

function addMeasure() {
  if (!state.scoreModel) return;
  const current = Number(state.scoreModel.measuresCount || 1);
  state.scoreModel.measuresCount = Math.max(1, current + 1);
  applyScoreModel();
  setStatus(`Added measure ${state.scoreModel.measuresCount}`);
}

// Standard guitar tuning MIDI numbers for open strings (string 1 = high E)
const GUITAR_TUNING_MIDI = [64, 59, 55, 50, 45, 40]; // E4, B3, G3, D3, A2, E2

function midiToPitch(midi) {
  const n = Math.round(Number(midi));
  const pc = ((n % 12) + 12) % 12;
  const octave = Math.floor(n / 12) - 1;
  // Prefer sharps (alter=+1) for simplicity in MVP
  /** @type {{ step: string, alter: number }} */
  const map = [
    { step: "C", alter: 0 },
    { step: "C", alter: 1 },
    { step: "D", alter: 0 },
    { step: "D", alter: 1 },
    { step: "E", alter: 0 },
    { step: "F", alter: 0 },
    { step: "F", alter: 1 },
    { step: "G", alter: 0 },
    { step: "G", alter: 1 },
    { step: "A", alter: 0 },
    { step: "A", alter: 1 },
    { step: "B", alter: 0 },
  ][pc];
  return { step: map.step, alter: map.alter, octave };
}

function computePitchFromStringFret(stringNum, fretNum) {
  const s = Math.max(1, Math.min(6, Math.round(Number(stringNum))));
  const f = Math.max(0, Math.min(36, Math.round(Number(fretNum))));
  const openMidi = GUITAR_TUNING_MIDI[s - 1] ?? 64;
  return midiToPitch(openMidi + f);
}

function upsertNoteAtSelectionForString({ stringNum, fretNum }) {
  if (!state.scoreModel || !selection.score) return;
  const s = Math.max(1, Math.min(6, Math.round(Number(stringNum))));
  const f = Math.max(0, Math.min(36, Math.round(Number(fretNum))));
  const beatRound = Math.round(selection.score.beat * 4) / 4;
  const posMeasure = selection.score.measure;

  const existing = state.scoreModel.notes.find(
    (n) => n.measure === posMeasure && Math.abs(n.beat - beatRound) < 0.01 && Number(n.string) === s
  );
  const pitch = computePitchFromStringFret(s, f);
  if (existing) {
    existing.string = s;
    existing.fret = f;
    existing.step = pitch.step;
    existing.alter = pitch.alter;
    existing.octave = pitch.octave;
    selection.noteId = existing.id;
  } else {
    const nn = {
      id: randomId(),
      measure: posMeasure,
      beat: beatRound,
      duration: editState.duration || 1,
      step: pitch.step,
      alter: pitch.alter,
      octave: pitch.octave,
      string: s,
      fret: f,
    };
    state.scoreModel.notes.push(nn);
    selection.noteId = nn.id;
  }
  state.scoreModel.notes.sort((a, b) => a.measure - b.measure || a.beat - b.beat);
  applyScoreModel();
}

/** @type {{ source: "local" | "youtube", ytPlayer: any | null, ytReady: boolean, rafId: number | null, youtubeId: string | null }} */
const playback = {
  source: "local",
  ytPlayer: null,
  ytReady: false,
  rafId: null,
  youtubeId: null,
};

function isYouTube() {
  return playback.source === "youtube";
}

function setPlaybackSource(source) {
  playback.source = source;
  if (isYouTube()) {
    els.video.style.display = "none";
    els.youtubeWrap.style.display = "block";
    els.waveform.style.opacity = "0.4";
    els.waveform.style.pointerEvents = "none";
  } else {
    els.video.style.display = "block";
    els.youtubeWrap.style.display = "none";
    els.waveform.style.opacity = "1";
    els.waveform.style.pointerEvents = "auto";
  }
  updateButtons();
}

function getMediaTimeSec() {
  if (isSynthMode()) return null;
  if (isYouTube()) {
    if (!playback.ytPlayer?.getCurrentTime) return null;
    return Number(playback.ytPlayer.getCurrentTime());
  }
  if (state.wave?.getCurrentTime) return Number(state.wave.getCurrentTime());
  return Number(els.video.currentTime);
}

function seekMediaTimeSec(t) {
  if (isSynthMode()) return;
  const tt = Math.max(0, Number(t));
  if (!Number.isFinite(tt)) return;
  if (isYouTube()) {
    playback.ytPlayer?.seekTo?.(tt, true);
    updateScorePlayhead(tt);
    return;
  }
  seekToTime(tt);
}

function mediaIsPlaying() {
  if (isSynthMode()) return synth.isPlaying;
  if (isYouTube()) {
    // 1 = playing, 2 = paused
    const s = playback.ytPlayer?.getPlayerState?.();
    return s === 1;
  }
  return Boolean(state.wave?.isPlaying?.());
}

function mediaPlay() {
  if (isSynthMode()) return synthPlay();
  if (isYouTube()) return playback.ytPlayer?.playVideo?.();
  state.wave?.play?.();
  els.video.play?.();
}

function mediaPause() {
  if (isSynthMode()) return synthStop();
  if (isYouTube()) return playback.ytPlayer?.pauseVideo?.();
  state.wave?.pause?.();
  els.video.pause?.();
}

/** @type {{ mode: "video" | "synth", audioCtx: AudioContext | null, parsed: { bpm: number, divisions: number, events: { startBeat: number, durBeat: number, midi: number }[], totalBeats: number } | null, isPlaying: boolean, startCtxTime: number, startBeat: number, rafId: number | null }} */
const synth = {
  mode: "video",
  audioCtx: null,
  parsed: null,
  isPlaying: false,
  startCtxTime: 0,
  startBeat: 0,
  rafId: null,
};

function isSynthMode() {
  return synth.mode === "synth";
}

/** @type {{ score: ScorePos | null, measureBoxPx: { left: number, top: number, width: number, height: number } | null }} */
const selection = {
  score: null,
  measureBoxPx: null,
  timeSec: null,
  /** @type {string | null} id of note highlighted in tab editor */
  noteId: null,
};

/** @type {{ measureCenterXByNumber: Map<number, number>, measureBoxPxByNumber: Map<number, { left: number, top: number, width: number, height: number }> }} */
const renderCache = {
  measureCenterXByNumber: new Map(),
  measureBoxPxByNumber: new Map(),
};

function setStatus(text) {
  els.status.textContent = text;
}

function setError(text) {
  els.error.textContent = text || "";
}

const PITCH_STEPS = ["C", "D", "E", "F", "G", "A", "B"];

function attachScoreClickHandler() {
  // With alphaTab we use beatMouseDown for reliable hit-testing/selection.
  return;
}

function setSelectedScore(scorePos, measureBoxPx) {
  selection.score = scorePos ? normalizeScorePos(scorePos) : null;
  selection.measureBoxPx = measureBoxPx ?? null;
  selection.noteId = null;
  if (state.scoreModel && selection.score) {
    const beatRound = Math.round(selection.score.beat * 4) / 4;
    const atPos = state.scoreModel.notes.filter(
      (n) => n.measure === selection.score.measure && Math.abs(n.beat - beatRound) < 0.01
    );
    if (atPos.length === 1) selection.noteId = atPos[0].id;
  }

  if (!selection.score) {
    els.selectedScorePos.textContent = "None (click the score)";
    els.scoreSelection.style.display = "none";
    return;
  }

  els.selectedScorePos.textContent = `m${selection.score.measure} b${Number(selection.score.beat).toFixed(2)}`;

  if (selection.measureBoxPx) {
    const { left, top, width, height } = selection.measureBoxPx;
    els.scoreSelection.style.display = "block";
    els.scoreSelection.style.left = `${left}px`;
    els.scoreSelection.style.top = `${top}px`;
    els.scoreSelection.style.width = `${width}px`;
    els.scoreSelection.style.height = `${height}px`;
  } else {
    els.scoreSelection.style.display = "none";
  }

  // When editing, clicks are for note entry, not for syncing.
  if (!editState.enabled) maybeAutoAddSyncPoint();
  updateButtons();
  renderNoteEditor();
}

function setPlayheadVisible(visible) {
  els.scorePlayhead.style.display = visible ? "block" : "none";
}

function setSelectedTime(tSec) {
  selection.timeSec = Number.isFinite(tSec) ? Math.max(0, tSec) : null;
  els.selectedTime.textContent = selection.timeSec == null ? "None (click waveform)" : fmtTime(selection.timeSec);
  // Soundslice-like flow: if score anchor already chosen, create sync point immediately.
  maybeAutoAddSyncPoint();
  updateButtons();
}

function addOrUpdateSyncPoint(scorePos, timeSec) {
  const score = normalizeScorePos(scorePos);
  const t = Math.max(0, Number(timeSec));
  if (!Number.isFinite(t)) return;

  const targetScalar = scorePosToScalar(score);
  const existing = state.syncPoints.find((sp) => scorePosToScalar(sp.score) === targetScalar);
  if (existing) existing.timeSec = t;
  else state.syncPoints.push({ id: randomId(), score, timeSec: t });

  renderSyncTable();
  rebuildRenderCache();
  updateScorePlayhead(state.wave?.getCurrentTime?.() ?? els.video.currentTime ?? 0);
  setStatus(`Sync point set: m${score.measure} b${Number(score.beat).toFixed(2)} ↔ ${fmtTime(t)}`);
}

function maybeAutoAddSyncPoint() {
  if (!canEdit()) return;
  if (!selection.score) return;
  if (selection.timeSec == null) return;
  addOrUpdateSyncPoint(selection.score, selection.timeSec);
  // Clear time anchor so the next point requires an explicit waveform click.
  selection.timeSec = null;
  els.selectedTime.textContent = "None (click waveform)";
}

function getBeatsPerMeasure() {
  // MVP: read the first time signature from the loaded MusicXML.
  // If there are changes mid-score, we’ll improve this later by reading measure-specific time signatures.
  try {
    if (!state.musicXmlText) return 4;
    const xml = new DOMParser().parseFromString(state.musicXmlText, "application/xml");
    const beatsEl = xml.querySelector("time > beats");
    const beatTypeEl = xml.querySelector("time > beat-type");
    const beats = beatsEl ? Number(beatsEl.textContent) : 4;
    const beatType = beatTypeEl ? Number(beatTypeEl.textContent) : 4;
    // Convert to quarter-note beats (e.g., 6/8 -> 6*(4/8)=3 quarter beats)
    if (Number.isFinite(beats) && Number.isFinite(beatType) && beatType > 0) {
      return Math.max(1, beats * (4 / beatType));
    }
    return 4;
  } catch {
    return 4;
  }
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return "—";
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function normalizeScorePos(score) {
  return { measure: Math.max(1, Math.floor(score.measure)), beat: Math.max(1, Number(score.beat)) };
}

function scorePosToScalar(score) {
  // Simple scalar key for ordering sync points.
  return score.measure * 1000 + score.beat;
}

function scalarToScorePos(s) {
  const measure = Math.max(1, Math.floor(s / 1000));
  const beat = Math.max(1, s - measure * 1000);
  return { measure, beat };
}

function sortSyncPoints() {
  state.syncPoints.sort((a, b) => scorePosToScalar(a.score) - scorePosToScalar(b.score));
}

function renderSyncTable() {
  sortSyncPoints();
  els.syncTableBody.innerHTML = "";

  if (state.syncPoints.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "muted";
    td.textContent = "No sync points yet. Add 2–5 points across the piece for rubato/swing alignment.";
    tr.appendChild(td);
    els.syncTableBody.appendChild(tr);
    els.exportSyncBtn.disabled = true;
    return;
  }

  els.exportSyncBtn.disabled = false;

  for (const sp of state.syncPoints) {
    const tr = document.createElement("tr");

    const tdScore = document.createElement("td");
    tdScore.innerHTML = `
      <div class="row" style="gap:6px;">
        <span class="muted">m</span>
        <input data-k="measure" data-id="${sp.id}" type="number" min="1" value="${sp.score.measure}" style="width:78px;">
        <span class="muted">b</span>
        <input data-k="beat" data-id="${sp.id}" type="number" min="1" step="0.25" value="${sp.score.beat}" style="width:86px;">
      </div>`;

    const tdTime = document.createElement("td");
    tdTime.innerHTML = `
      <div class="row" style="gap:6px;">
        <input data-k="timeSec" data-id="${sp.id}" type="number" min="0" step="0.001" value="${sp.timeSec.toFixed(3)}" style="width:140px;">
        <span class="muted">${fmtTime(sp.timeSec)}</span>
      </div>`;

    const tdActions = document.createElement("td");
    const seekBtn = document.createElement("button");
    seekBtn.className = "secondary";
    seekBtn.textContent = "Seek";
    seekBtn.addEventListener("click", () => seekMediaTimeSec(sp.timeSec));

    const delBtn = document.createElement("button");
    delBtn.className = "secondary";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      state.syncPoints = state.syncPoints.filter((x) => x.id !== sp.id);
      renderSyncTable();
    });

    tdActions.appendChild(seekBtn);
    tdActions.appendChild(delBtn);
    tdActions.querySelectorAll("button").forEach((b) => (b.style.marginRight = "6px"));

    tr.appendChild(tdScore);
    tr.appendChild(tdTime);
    tr.appendChild(tdActions);
    els.syncTableBody.appendChild(tr);
  }

  // Bind inputs after insertion
  els.syncTableBody.querySelectorAll("input[data-id]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.getAttribute("data-id");
      const k = input.getAttribute("data-k");
      const sp = state.syncPoints.find((x) => x.id === id);
      if (!sp) return;

      const v = Number(input.value);
      if (k === "measure") sp.score.measure = Math.max(1, Math.floor(v));
      if (k === "beat") sp.score.beat = Math.max(1, v);
      if (k === "timeSec") sp.timeSec = Math.max(0, v);
      renderSyncTable();
    });
  });
}

function canEdit() {
  // In synth mode we only need a rendered score + MusicXML loaded.
  if (isSynthMode()) return Boolean(state.atApi && state.musicXmlText);
  if (isYouTube()) return Boolean(state.atApi && playback.ytReady);
  return Boolean(state.wave && state.atApi && els.video.src);
}

function updateButtons() {
  const enabled = canEdit();
  els.playPauseBtn.disabled = !enabled;
  els.rewindBtn.disabled = !enabled;
  els.forwardBtn.disabled = !enabled;
  // "Add sync point here" works when: we have 2+ points (interpolate) OR we have a selected score (use it)
  els.addSyncPointBtn.disabled = !(enabled && (state.syncPoints.length >= 2 || selection.score));
  els.tapSyncBtn.disabled = !enabled;
  els.importSyncBtn.disabled = !enabled;
  els.exportSyncBtn.disabled = state.syncPoints.length === 0;
  els.exportMusicXmlBtn.disabled = !state.musicXmlText;
  els.saveProjectBtn.disabled = !state.musicXmlText && state.syncPoints.length === 0;
  if (els.editModeCheckbox) els.editModeCheckbox.disabled = !state.musicXmlText;
  if (els.addMeasureBtn) els.addMeasureBtn.disabled = !state.scoreModel;
  if (els.transcribeBtn) els.transcribeBtn.disabled = !els.videoFile.files?.[0];
}

function seekToTime(t) {
  if (!state.wave) return;
  const dur = state.wave.getDuration?.() ?? els.video.duration;
  const tt = clamp(t, 0, Number.isFinite(dur) ? dur : t);
  els.video.currentTime = tt;
  state.wave.setTime(tt);
  updateScorePlayhead(tt);
}

function pitchToMidi(step, alter, octave) {
  const m = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step] ?? 0;
  return 12 * (octave + 1) + m + (alter || 0);
}

function parseMusicXmlToSynthEvents(musicXmlText) {
  const xml = new DOMParser().parseFromString(musicXmlText, "application/xml");
  const parseErr = xml.querySelector("parsererror");
  if (parseErr) throw new Error("MusicXML parse error");

  // MusicXML often uses a default XML namespace, which can break querySelector("part").
  // Use namespace-agnostic traversal by localName.
  const all = Array.from(xml.getElementsByTagName("*"));
  const byLocal = (name) => all.filter((n) => n.localName === name);
  const firstLocal = (name) => all.find((n) => n.localName === name) || null;

  const divisionsEl = all.find((n) => n.localName === "divisions");
  const divisionsRaw = divisionsEl ? Number(String(divisionsEl.textContent ?? "").trim()) : 1;
  const divisions = Number.isFinite(divisionsRaw) && divisionsRaw > 0 ? divisionsRaw : 1;
  const soundTempoEl = all.find((n) => n.localName === "sound" && n.getAttribute && n.getAttribute("tempo"));
  const bpmRaw = soundTempoEl ? Number(soundTempoEl.getAttribute("tempo")) : 120;
  const bpm = Number.isFinite(bpmRaw) && bpmRaw > 0 ? bpmRaw : 120;

  /** @type {{ startBeat: number, durBeat: number, midi: number }[]} */
  const events = [];

  // Iterate parts, measures, notes. MVP: single timeline with chord handling.
  const parts = byLocal("part");
  for (const part of parts) {
    let timeDiv = 0;
    let lastNonChordDurDiv = 0;
    const measures = Array.from(part.children).filter((n) => n.localName === "measure");
    for (const measure of measures) {
      const notes = Array.from(measure.children).filter((n) => n.localName === "note");
      for (const note of notes) {
        const isRest = Array.from(note.children).some((n) => n.localName === "rest");
        const durEl = Array.from(note.children).find((n) => n.localName === "duration") || null;
        const durDivRaw = durEl ? Number(String(durEl.textContent ?? "").trim()) : 0;
        const durDiv = Number.isFinite(durDivRaw) && durDivRaw >= 0 ? durDivRaw : 0;
        const durBeat = divisions > 0 ? durDiv / divisions : 0;
        const isChord = Array.from(note.children).some((n) => n.localName === "chord");

        // In MusicXML, <chord/> notes share the start time of the previous non-chord note.
        const startDiv = isChord ? Math.max(0, timeDiv - lastNonChordDurDiv) : timeDiv;

        if (!isRest) {
          const pitchEl = Array.from(note.children).find((n) => n.localName === "pitch") || null;
          const step = pitchEl ? Array.from(pitchEl.children).find((n) => n.localName === "step")?.textContent : null;
          const alterRaw = pitchEl ? Number(String(Array.from(pitchEl.children).find((n) => n.localName === "alter")?.textContent ?? "0").trim()) : 0;
          const octaveRaw = pitchEl ? Number(String(Array.from(pitchEl.children).find((n) => n.localName === "octave")?.textContent ?? "4").trim()) : 4;
          const alter = Number.isFinite(alterRaw) ? alterRaw : 0;
          const octave = Number.isFinite(octaveRaw) ? octaveRaw : 4;
          if (step) {
            events.push({
              startBeat: divisions > 0 ? startDiv / divisions : 0,
              durBeat: Math.max(0.05, durBeat || 0.25),
              midi: pitchToMidi(step, alter, octave),
            });
          }
        }

        // Advance time for non-chord notes only
        if (!isChord) {
          timeDiv += durDiv;
          lastNonChordDurDiv = durDiv;
        }
      }
    }
    // MVP: just first part for playback
    break;
  }

  const totalBeats = events.length ? Math.max(...events.map((e) => e.startBeat + e.durBeat)) : 0;
  return { bpm: Number.isFinite(bpm) ? bpm : 120, divisions: Number.isFinite(divisions) ? divisions : 1, events, totalBeats };
}

function ensureAudioCtx() {
  if (!synth.audioCtx) synth.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return synth.audioCtx;
}

function beatToSec(beat) {
  const bpm = synth.parsed?.bpm ?? 120;
  return (60 / bpm) * beat;
}

function secToBeat(sec) {
  const bpm = synth.parsed?.bpm ?? 120;
  return (bpm / 60) * sec;
}

function synthCurrentBeat() {
  if (!synth.isPlaying) return synth.startBeat;
  const ctx = synth.audioCtx;
  if (!ctx) return synth.startBeat;
  return synth.startBeat + secToBeat(ctx.currentTime - synth.startCtxTime);
}

function synthStop() {
  synth.isPlaying = false;
  if (synth.rafId) cancelAnimationFrame(synth.rafId);
  synth.rafId = null;
  els.playPauseBtn.textContent = "Play";
}

function synthSeekToBeat(beat) {
  synth.startBeat = Math.max(0, beat);
  if (synth.isPlaying) {
    const ctx = ensureAudioCtx();
    synth.startCtxTime = ctx.currentTime;
  }
  // Update score playhead using score scalar if sync map exists; otherwise fall back to measure 1 scaling.
  updateScorePlayheadFromScoreScalar((1 * 1000) + 1);
}

function scheduleSynthWindow() {
  if (!synth.parsed || !synth.audioCtx) return;
  const ctx = synth.audioCtx;
  const now = ctx.currentTime;
  const lookaheadSec = 0.25;
  const startBeat = synthCurrentBeat();
  const endBeat = startBeat + secToBeat(lookaheadSec);
  // Schedule slightly in the future so oscillators aren't created "in the past"
  const baseCtxTime = now + 0.03;

  for (const ev of synth.parsed.events) {
    if (ev.startBeat < startBeat - 0.01 || ev.startBeat > endBeat + 0.01) continue;
    const t = baseCtxTime + beatToSec(ev.startBeat - startBeat);
    const dur = beatToSec(ev.durBeat);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    const freq = 440 * Math.pow(2, (ev.midi - 69) / 12);
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.02, dur));
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + Math.max(0.05, dur) + 0.02);
  }
}

let synthInterval = null;
function synthPlay() {
  if (!synth.parsed || synth.parsed.events.length === 0) {
    setError("No synth notes found in MusicXML (couldn’t parse notes). Try re-importing the MusicXML.");
    return;
  }
  const ctx = ensureAudioCtx();
  ctx.resume?.();
  if (ctx.state === "suspended") {
    setError("Audio is blocked by the browser. Click anywhere, then press Space again.");
    return;
  }
  synth.isPlaying = true;
  synth.startCtxTime = ctx.currentTime;
  els.playPauseBtn.textContent = "Pause";

  if (synthInterval) clearInterval(synthInterval);
  synthInterval = setInterval(scheduleSynthWindow, 50);
  scheduleSynthWindow();

  const tick = () => {
    if (!synth.isPlaying) return;
    const beat = synthCurrentBeat();
    // If we have a sync map, convert beat to an approximate score scalar by treating beat as beat-in-measure within measure 1.
    // (Next iteration will use real MusicXML measure mapping.)
    // For now, just keep the red line visible by moving within the first measure.
    updateScorePlayheadFromScoreScalar(1 * 1000 + (1 + (beat % getBeatsPerMeasure())));

    if (synth.parsed && beat >= synth.parsed.totalBeats + 0.25) {
      synthStop();
      if (synthInterval) clearInterval(synthInterval);
      synthInterval = null;
      return;
    }
    synth.rafId = requestAnimationFrame(tick);
  };
  synth.rafId = requestAnimationFrame(tick);
}

function synthTogglePlay() {
  if (synth.isPlaying) {
    synthStop();
    if (synthInterval) clearInterval(synthInterval);
    synthInterval = null;
  } else {
    synthPlay();
  }
}

function updateScorePlayheadFromScoreScalar(s) {
  // Minimal: reuse updateScorePlayhead by converting scalar to time if we have sync points; otherwise place it in measure 1.
  const t = scoreScalarToTimeSec(s);
  if (t != null) updateScorePlayhead(t);
  else {
    // Without sync map, fake a time so updateScorePlayhead doesn't hide; instead directly position in measure 1 if possible.
    const measure = Math.max(1, Math.floor(s / 1000));
    const beat = s - measure * 1000;
    const box = renderCache.measureBoxPxByNumber.get(measure);
    if (!box) return;
    const rel = clamp((beat - 1) / Math.max(1e-6, getBeatsPerMeasure()), 0, 1);
    els.scorePlayhead.style.left = `${box.left + rel * box.width}px`;
    setPlayheadVisible(true);
  }
}

function togglePlay() {
  if (mediaIsPlaying()) {
    mediaPause();
    els.playPauseBtn.textContent = "Play";
  } else {
    mediaPlay();
    els.playPauseBtn.textContent = "Pause";
  }
}

async function loadVideo(file) {
  setError("");
  setStatus("Loading video…");
  const url = URL.createObjectURL(file);
  els.video.src = url;
  await els.video.play().catch(() => {});
  els.video.pause();
  setStatus("Video loaded");
}

function addNoteAtSelection() {
  if (!state.scoreModel || !selection.score) return;
  const beatRound = Math.round(selection.score.beat * 4) / 4;
  state.scoreModel.notes.push({
    id: randomId(),
    measure: selection.score.measure,
    beat: beatRound,
    duration: editState.duration || 1,
    step: editState.newNote.step || "C",
    alter: Number(editState.newNote.alter || 0),
    octave: Number(editState.newNote.octave || 4),
    string: Number(editState.newNote.string || 1),
    fret: Number(editState.newNote.fret || 0),
  });
  state.scoreModel.notes.sort((a, b) => a.measure - b.measure || a.beat - b.beat);
  applyScoreModel();
  setStatus("Note added");
}

function eraseNotesAtSelection() {
  if (!state.scoreModel || !selection.score) return;
  const beatRound = Math.round(selection.score.beat * 4) / 4;
  const before = state.scoreModel.notes.length;
  if (selection.noteId) {
    state.scoreModel.notes = state.scoreModel.notes.filter((n) => n.id !== selection.noteId);
    selection.noteId = null;
  } else {
    state.scoreModel.notes = state.scoreModel.notes.filter(
      (n) => !(n.measure === selection.score.measure && Math.abs(n.beat - beatRound) < 0.01)
    );
  }
  if (state.scoreModel.notes.length !== before) {
    applyScoreModel();
    setStatus("Deleted note(s)");
  }
}

async function transcribeAudio() {
  const file = els.videoFile.files?.[0];
  if (!file) {
    setError("Load a video first.");
    return;
  }
  els.transcribeBtn.disabled = true;
  els.transcribeStatus.textContent = "Transcribing… (this may take a few minutes)";
  setError("");

  try {
    const formData = new FormData();
    formData.append("audio", file);

    const resp = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${resp.status}`);
    }
    const transcription = await resp.json();
    const { scoreModel, syncPoints, bpm } = transcriptionJsonToScoreModel(transcription);

    state.scoreModel = scoreModel;
    state.syncPoints = syncPoints || [];
    applyScoreModel();
    renderSyncTable();
    setStatus(`Transcription done — ${scoreModel.notes.length} notes, ~${bpm} BPM`);
    els.transcribeStatus.textContent = `${scoreModel.notes.length} notes loaded`;
    updateButtons();
  } catch (e) {
    console.error("[transcribe]", e);
    setError(String(e?.message ?? e));
    els.transcribeStatus.textContent = "Failed";
  } finally {
    els.transcribeBtn.disabled = !els.videoFile.files?.[0];
  }
}

function applyScoreModel() {
  if (!state.scoreModel) return;
  state.musicXmlText = buildMusicXmlFromScoreModel(state.scoreModel);
  state.alphaTexText = buildAlphaTexFromScoreModel(state.scoreModel);
  state.renderFormat = "alphatex";
  renderCurrentMusicXml().catch((e) => {
    console.error(e);
    setError("Could not re-render score after edit.");
  });
}

function renderNoteEditor() {
  const pos = selection.score;
  els.noteEditorPosition.textContent = pos
    ? `Position: m${pos.measure} b${Number(pos.beat).toFixed(2)} — edit notes below`
    : "Click a note or empty spot in the score above.";
  els.addNoteBtn.disabled = !pos || !state.scoreModel;
  if (els.editModePill) {
    els.editModePill.textContent = editState.enabled ? `Edit: ON (${editState.tool})` : "Edit: OFF";
    els.editModePill.className = "pill " + (editState.enabled ? "ok" : "");
  }
  if (els.tabEntryHint) {
    const buf = editState.tabEntry?.buffer || "";
    const s = editState.tabEntry?.activeString || (editState.newNote?.string ?? 1);
    els.tabEntryHint.textContent = editState.enabled
      ? `Tip: click score, press 1–6 to pick string. Active string: ${s}. Type fret: ${buf || "…"} (Enter commit, Backspace, Esc).`
      : "Tip: turn on Edit mode, click the score, then press 1–6 to pick string and type fret numbers (Enter to commit, Backspace to edit, Esc to cancel).";
  }
  if (els.activePitchPill) {
    els.activePitchPill.textContent = pitchLabel(editState.newNote.step, Number(editState.newNote.alter || 0), Number(editState.newNote.octave || 4));
  }
  // Update pitch palette highlight
  if (els.pitchPalette) {
    els.pitchPalette.querySelectorAll("[data-step]").forEach((btn) => {
      const step = btn.getAttribute("data-step");
      btn.classList.toggle("pitch-btn--active", String(step).toUpperCase() === String(editState.newNote.step || "C").toUpperCase());
    });
  }

  els.noteEditorList.innerHTML = "";
  if (!state.scoreModel || !pos) return;

  const beatRound = Math.round(pos.beat * 4) / 4;
  const atPosition = state.scoreModel.notes.filter(
    (n) => n.measure === pos.measure && Math.abs(n.beat - beatRound) < 0.01
  );

  for (const note of atPosition) {
    const row = document.createElement("div");
    row.className = "row note-editor-row" + (note.id === selection.noteId ? " note-editor-row--selected" : "");
    row.style.alignItems = "center";
    row.style.marginBottom = "6px";
    row.style.gap = "8px";
    row.setAttribute("data-note-id", note.id);
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    const stepOpts = PITCH_STEPS.map((s) => `<option value="${s}"${note.step === s ? " selected" : ""}>${s}</option>`).join("");
    row.innerHTML = `
      <span class="muted">pitch</span>
      <select data-id="${note.id}" data-field="step" style="width:52px;">${stepOpts}</select>
      <input type="number" min="-2" max="2" value="${note.alter}" data-id="${note.id}" data-field="alter" style="width:48px;" title="alter (-2 to 2)" />
      <input type="number" min="1" max="7" value="${note.octave}" data-id="${note.id}" data-field="octave" style="width:52px;" title="octave" />
      <span class="muted">str</span>
      <input type="number" min="1" max="6" value="${note.string ?? 1}" data-id="${note.id}" data-field="string" style="width:48px;" />
      <span class="muted">fret</span>
      <input type="number" min="0" max="24" value="${note.fret ?? 0}" data-id="${note.id}" data-field="fret" style="width:52px;" />
      <span class="muted">dur</span>
      <input type="number" min="0.25" step="0.25" value="${note.duration}" data-id="${note.id}" data-field="duration" style="width:64px;" />
      <button type="button" class="secondary" data-id="${note.id}" data-delete>Delete</button>
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest("button, input, select")) return;
      selection.noteId = note.id;
      renderNoteEditor();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selection.noteId = note.id;
        renderNoteEditor();
      }
    });
    els.noteEditorList.appendChild(row);
  }

  els.noteEditorList.querySelectorAll("input[data-id], select[data-id]").forEach((el) => {
    el.addEventListener("change", () => {
      const note = state.scoreModel.notes.find((n) => n.id === el.getAttribute("data-id"));
      if (!note) return;
      const field = el.getAttribute("data-field");
      if (field === "step") {
        note.step = String(el.value).trim().toUpperCase();
        if (!PITCH_STEPS.includes(note.step)) note.step = "C";
      } else {
        const val = Number(el.value);
        if (field === "alter") note.alter = Math.max(-2, Math.min(2, Math.round(val)));
        if (field === "octave") note.octave = Math.max(1, Math.min(7, Math.round(val)));
        if (field === "string") note.string = Math.max(1, Math.min(6, Math.round(val)));
        if (field === "fret") note.fret = Math.max(0, Math.min(24, Math.round(val)));
        if (field === "duration") note.duration = Math.max(0.25, val);
      }
      applyScoreModel();
    });
  });
  els.noteEditorList.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      state.scoreModel.notes = state.scoreModel.notes.filter((n) => n.id !== id);
      applyScoreModel();
    });
  });
}

async function loadMusicXml(file) {
  setError("");
  setStatus("Loading MusicXML…");
  const raw = await file.text();
  state.musicXmlText = raw;
  state.renderFormat = "musicxml";
  state.alphaTexText = null;

  try {
    state.scoreModel = parseMusicXmlToScoreModel(raw);
  } catch (e) {
    console.warn("Score model parse failed, score is read-only", e);
    state.scoreModel = null;
  }

  try {
    synth.parsed = parseMusicXmlToSynthEvents(state.musicXmlText);
    if (synth.parsed?.events?.length) setStatus(`Synth ready: ${synth.parsed.events.length} notes`);
    else setStatus("Synth ready: 0 notes");
  } catch (e) {
    synth.parsed = null;
  }

  await renderCurrentMusicXml();
  setStatus(state.scoreModel ? "MusicXML loaded — turn on Edit mode to edit/create tabs" : "MusicXML loaded (edit model parse failed)");
  setSelectedScore({ measure: 1, beat: 1 }, null);
}

function getSvgElement() {
  return els.score.querySelector("svg");
}

function domPointToSvgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const sp = pt.matrixTransform(ctm.inverse());
  return { x: sp.x, y: sp.y };
}

function getMeasureList(osmd) {
  // OSMD has moved these around across versions; try a few.
  return (
    osmd?.GraphicSheet?.MeasureList ||
    osmd?.graphicSheet?.MeasureList ||
    osmd?.graphic?.measureList ||
    osmd?.graphicMusicSheet?.MeasureList ||
    null
  );
}

function flattenMeasureList(measureList) {
  if (!measureList) return [];
  // Typical structure: MeasureList[systemIndex][measureIndex] = GraphicalMeasure
  const out = [];
  if (Array.isArray(measureList)) {
    for (const row of measureList) {
      if (Array.isArray(row)) {
        for (const m of row) if (m) out.push(m);
      } else if (row) {
        out.push(row);
      }
    }
  }
  return out;
}

function getMeasureNumber(graphicalMeasure) {
  // Try common fields (fallback to 1)
  return (
    graphicalMeasure?.MeasureNumber ||
    graphicalMeasure?.measureNumber ||
    graphicalMeasure?.parentMeasure?.MeasureNumber ||
    graphicalMeasure?.parentMeasure?.measureNumber ||
    1
  );
}

function getMeasureBBoxSvg(graphicalMeasure) {
  // Preferred: PositionAndShape with AbsolutePosition + Size (OSMD internal units)
  const pas = graphicalMeasure?.PositionAndShape || graphicalMeasure?.positionAndShape;
  const ap = pas?.AbsolutePosition || pas?.absolutePosition;
  const sz = pas?.Size || pas?.size;
  if (ap && sz && Number.isFinite(ap.x) && Number.isFinite(ap.y) && Number.isFinite(sz.width) && Number.isFinite(sz.height)) {
    return { x: ap.x, y: ap.y, w: sz.width, h: sz.height };
  }

  // Fallback: BoundingBox-like shapes
  const bb = pas?.BoundingBox || pas?.boundingBox || graphicalMeasure?.boundingBox;
  if (bb?.AbsolutePosition && bb?.Size) {
    const p = bb.AbsolutePosition;
    const s = bb.Size;
    return { x: p.x, y: p.y, w: s.width, h: s.height };
  }

  return null;
}

function svgBoxToScoreWrapPixels(svg, boxSvg) {
  // Convert two corners in SVG user units → screen px → scoreWrap-relative px
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const wrapRect = els.scoreWrap.getBoundingClientRect();

  const p1 = svg.createSVGPoint();
  p1.x = boxSvg.x;
  p1.y = boxSvg.y;
  const p2 = svg.createSVGPoint();
  p2.x = boxSvg.x + boxSvg.w;
  p2.y = boxSvg.y + boxSvg.h;

  const s1 = p1.matrixTransform(ctm);
  const s2 = p2.matrixTransform(ctm);

  const left = Math.min(s1.x, s2.x) - wrapRect.left + els.scoreWrap.scrollLeft;
  const top = Math.min(s1.y, s2.y) - wrapRect.top + els.scoreWrap.scrollTop;
  const width = Math.abs(s2.x - s1.x);
  const height = Math.abs(s2.y - s1.y);

  return { left, top, width, height };
}

function rebuildRenderCache() {
  renderCache.measureCenterXByNumber.clear();
  renderCache.measureBoxPxByNumber.clear();
  // With alphaTab we currently don't compute OSMD measure boxes.
  if (!state.atApi) return;
  return;
  /* OSMD-only code kept for reference:
  const svg = getSvgElement();
  if (!svg) return;

  const measureList = flattenMeasureList(getMeasureList(state.osmd));
  for (const m of measureList) {
    const boxSvg = getMeasureBBoxSvg(m);
    if (!boxSvg) continue;
    const boxPx = svgBoxToScoreWrapPixels(svg, boxSvg);
    if (!boxPx) continue;
    const measureNum = Number(getMeasureNumber(m)) || 1;
    const cx = boxPx.left + boxPx.width / 2;
    // If multiple staves duplicate the same measure number, keep the left-most center.
    const prev = renderCache.measureCenterXByNumber.get(measureNum);
    if (prev == null || cx < prev) renderCache.measureCenterXByNumber.set(measureNum, cx);

    const prevBox = renderCache.measureBoxPxByNumber.get(measureNum);
    if (!prevBox || boxPx.left < prevBox.left) renderCache.measureBoxPxByNumber.set(measureNum, boxPx);
  }
  */
}

function onScoreClick(e) {
  editState.lastPointer.x = e.clientX;
  editState.lastPointer.y = e.clientY;

  if (!state.scoreModel) {
    setStatus("Create a New tab first, then click here to add notes");
    els.scoreWrap?.focus?.();
    return;
  }
  if (!state.atApi) return;

  const lookup = state.atApi.boundsLookup;
  let beat = null;

  if (lookup) {
    const svg = getSvgElement();
    if (svg) {
      const sp = domPointToSvgPoint(svg, e.clientX, e.clientY);
      if (sp && lookup.staffSystems?.length) {
        for (const sys of lookup.staffSystems) {
          const vb = sys.visualBounds || sys.realBounds;
          if (!vb || typeof vb.y !== "number") continue;
          const sy = Number(vb.y);
          const sx = Number(vb.x ?? 0);
          const sh = Number(vb.h ?? vb.height ?? 0);
          const sw = Number(vb.w ?? vb.width ?? 0);
          if (sp.y >= sy && sp.y <= sy + sh && sp.x >= sx && sp.x <= sx + sw) {
            const masterBar = sys.findBarAtPos?.(sp.x);
            if (masterBar && typeof masterBar.findBeatAtPos === "function") {
              beat = masterBar.findBeatAtPos(sp.x);
            }
            break;
          }
        }
      }
    }
    if (!beat) {
      const scoreRect = els.score?.getBoundingClientRect?.();
      const x = scoreRect ? e.clientX - scoreRect.left : e.clientX;
      const y = scoreRect ? e.clientY - scoreRect.top : e.clientY;
      beat = lookup.getBeatAtPos?.(x, y) ?? lookup.getBeatAtPos?.(e.clientX, e.clientY);
    }
  }

  if (beat) {
    handleBeatSelected(beat);
    return;
  }

  const wrapRect = els.scoreWrap?.getBoundingClientRect?.();
  const inScore = wrapRect &&
    e.clientX >= wrapRect.left && e.clientX <= wrapRect.right &&
    e.clientY >= wrapRect.top && e.clientY <= wrapRect.bottom;
  if (inScore && state.scoreModel) {
    setSelectedScore({ measure: 1, beat: 1 }, null);
    if (!editState.enabled) {
      editState.enabled = true;
      if (els.editModeCheckbox) els.editModeCheckbox.checked = true;
      setStatus("Edit mode ON — type fret number, Enter to add");
    }
    els.scoreWrap?.focus?.();
    renderNoteEditor();
  }
}

function timeToScoreScalar(tSec) {
  // Piecewise-linear inverse mapping using sync points.
  // With >=2 sync points, we interpolate in "score scalar" space.
  if (state.syncPoints.length < 2) return null;
  const pts = state.syncPoints
    .slice()
    .sort((a, b) => a.timeSec - b.timeSec)
    .map((sp) => ({ t: sp.timeSec, s: scorePosToScalar(sp.score), measure: sp.score.measure }));

  // Clamp outside range
  if (tSec <= pts[0].t) return pts[0].s;
  if (tSec >= pts[pts.length - 1].t) return pts[pts.length - 1].s;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (tSec >= a.t && tSec <= b.t) {
      const dt = b.t - a.t;
      const alpha = dt <= 1e-6 ? 0 : (tSec - a.t) / dt;
      return a.s + (b.s - a.s) * alpha;
    }
  }
  return null;
}

function scoreScalarToTimeSec(scoreScalar) {
  // Piecewise-linear forward mapping: score scalar -> time (sec)
  if (state.syncPoints.length < 2) return null;
  const pts = state.syncPoints
    .slice()
    .sort((a, b) => scorePosToScalar(a.score) - scorePosToScalar(b.score))
    .map((sp) => ({ s: scorePosToScalar(sp.score), t: sp.timeSec }));

  if (scoreScalar <= pts[0].s) return pts[0].t;
  if (scoreScalar >= pts[pts.length - 1].s) return pts[pts.length - 1].t;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (scoreScalar >= a.s && scoreScalar <= b.s) {
      const ds = b.s - a.s;
      const alpha = ds <= 1e-6 ? 0 : (scoreScalar - a.s) / ds;
      return a.t + (b.t - a.t) * alpha;
    }
  }
  return null;
}

function updateScorePlayhead(tSec) {
  if (state.syncPoints.length < 2 || renderCache.measureBoxPxByNumber.size === 0) {
    setPlayheadVisible(false);
    return;
  }

  const s = timeToScoreScalar(tSec);
  if (s == null) {
    setPlayheadVisible(false);
    return;
  }

  const measure = Math.max(1, Math.floor(s / 1000));
  const beat = s - measure * 1000;
  const beatsPerMeasure = getBeatsPerMeasure();
  const rel = clamp((beat - 1) / Math.max(1e-6, beatsPerMeasure), 0, 1);

  let x;
  const box = renderCache.measureBoxPxByNumber.get(measure);
  if (box) {
    x = box.left + rel * box.width;
  } else {
    // Interpolate x between nearest measure boxes so playhead works even when measure number gaps exist
    const measures = Array.from(renderCache.measureBoxPxByNumber.keys()).sort((a, b) => a - b);
    if (measures.length === 0) {
      setPlayheadVisible(false);
      return;
    }
    let mLo = measures[0], mHi = measures[measures.length - 1];
    for (let i = 0; i < measures.length - 1; i++) {
      if (measures[i] <= measure && measure <= measures[i + 1]) {
        mLo = measures[i];
        mHi = measures[i + 1];
        break;
      }
    }
    const boxLo = renderCache.measureBoxPxByNumber.get(mLo);
    const boxHi = renderCache.measureBoxPxByNumber.get(mHi);
    if (!boxLo || !boxHi) {
      setPlayheadVisible(false);
      return;
    }
    const scalarLo = mLo * 1000 + 1;
    const scalarHi = mHi * 1000 + 1;
    const alpha = (s - scalarLo) / Math.max(1e-6, scalarHi - scalarLo);
    x = boxLo.left + clamp(alpha, 0, 1) * (boxHi.left + boxHi.width - boxLo.left);
  }

  els.scorePlayhead.style.left = `${x}px`;
  setPlayheadVisible(true);

  // Soundslice-style: auto-scroll score so the playhead stays in view (~20% from left)
  const wrap = els.scoreWrap;
  if (wrap && wrap.scrollWidth > wrap.clientWidth) {
    const targetScrollLeft = x - 0.2 * wrap.clientWidth;
    const maxScroll = wrap.scrollWidth - wrap.clientWidth;
    wrap.scrollLeft = clamp(targetScrollLeft, 0, maxScroll);
  }
}

function initWaveform() {
  if (state.wave) {
    state.wave.destroy();
    state.wave = null;
  }

  // WaveSurfer is loaded as a global by index.html (UMD build)
  const WS = window.WaveSurfer;
  if (!WS?.create) throw new Error("WaveSurfer failed to load (check network/CDN).");

  // For local MP4 videos, decoding via WebAudio can fail / produce blank waveforms in some browsers.
  // MediaElement backend is more reliable because it uses the browser's native media pipeline.
  state.wave = WS.create({
    container: els.waveform,
    media: els.video,
    waveColor: "#2b3a52",
    progressColor: "#2b5cff",
    cursorColor: "#e6edf3",
    height: 96,
    normalize: true,
    backend: "MediaElement",
  });

  // Ensure WaveSurfer is pointed at the current video source.
  // Using the video src (blob URL) is the most consistent across browsers.
  if (els.video.currentSrc || els.video.src) {
    state.wave.load(els.video.currentSrc || els.video.src);
  }

  state.wave.on("ready", () => {
    setStatus("Waveform ready");
    updateButtons();
  });

  state.wave.on("interaction", () => {
    // clicking waveform seeks
    const t = state.wave.getCurrentTime();
    els.video.currentTime = t;
    updateScorePlayhead(t);
    setSelectedTime(t);
    updateButtons();
  });

  state.wave.on("timeupdate", (t) => {
    // keep video aligned to wavesurfer time (wavesurfer is smoother for scrubbing)
    if (Math.abs(els.video.currentTime - t) > 0.05) {
      els.video.currentTime = t;
    }
    updateScorePlayhead(t);
  });

  state.wave.on("play", () => {
    els.playPauseBtn.textContent = "Pause";
    els.video.play().catch(() => {});
  });
  state.wave.on("pause", () => {
    els.playPauseBtn.textContent = "Play";
    els.video.pause();
  });

  // If user uses native video controls, still move the score playhead.
  els.video.addEventListener("timeupdate", () => {
    const t = state.wave?.isPlaying?.() ? state.wave.getCurrentTime() : els.video.currentTime;
    updateScorePlayhead(t);
  });

  // Smooth playhead: drive updates from requestAnimationFrame while playing (like Soundslice)
  let rafId = null;
  function tick() {
    const t = state.wave?.getCurrentTime?.() ?? els.video.currentTime;
    if (Number.isFinite(t)) updateScorePlayhead(t);
    rafId = requestAnimationFrame(tick);
  }
  els.video.addEventListener("play", () => {
    if (!rafId) rafId = requestAnimationFrame(tick);
  });
  els.video.addEventListener("pause", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  });
  els.video.addEventListener("ended", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  });
}

function getLoopTimes() {
  if (!els.loopCheckbox?.checked || state.syncPoints.length < 2) return null;
  const fromM = Number(els.loopFromMeasure?.value ?? 1);
  const fromB = Number(els.loopFromBeat?.value ?? 1);
  const toM = Number(els.loopToMeasure?.value ?? 1);
  const toB = Number(els.loopToBeat?.value ?? 1);
  const s1 = scorePosToScalar({ measure: fromM, beat: fromB });
  const s2 = scorePosToScalar({ measure: toM, beat: toB });
  const t1 = scoreScalarToTimeSec(s1);
  const t2 = scoreScalarToTimeSec(s2);
  if (t1 == null || t2 == null) return null;
  return { startTime: t1, endTime: t2 };
}

function startPlayheadTicker() {
  if (playback.rafId) cancelAnimationFrame(playback.rafId);
  const tick = () => {
    let t = getMediaTimeSec();
    if (t != null) {
      const loop = getLoopTimes();
      if (loop && t >= loop.endTime) {
        seekMediaTimeSec(loop.startTime);
        t = loop.startTime;
      }
      updateScorePlayhead(t);
    }
    playback.rafId = requestAnimationFrame(tick);
  };
  playback.rafId = requestAnimationFrame(tick);
}

function stopPlayheadTicker() {
  if (playback.rafId) cancelAnimationFrame(playback.rafId);
  playback.rafId = null;
}

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("embed");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {}
  return null;
}

function ensureYouTubePlayer(videoId) {
  return new Promise((resolve, reject) => {
    const tryCreate = () => {
      if (!window.YT || !window.YT.Player) return false;
      // (Re)create player
      els.youtubePlayer.innerHTML = "";
      playback.ytReady = false;
      playback.ytPlayer = new window.YT.Player(els.youtubePlayer, {
        videoId,
        playerVars: { playsinline: 1, modestbranding: 1, rel: 0 },
        events: {
          onReady: () => {
            playback.ytReady = true;
            playback.youtubeId = videoId;
            setPlaybackSource("youtube");
            setStatus("YouTube loaded");
            updateButtons();
            resolve(playback.ytPlayer);
          },
          onStateChange: (ev) => {
            // 1 playing, 2 paused
            if (ev.data === 1) {
              els.playPauseBtn.textContent = "Pause";
              startPlayheadTicker();
            } else if (ev.data === 2 || ev.data === 0) {
              els.playPauseBtn.textContent = "Play";
              stopPlayheadTicker();
            }
          },
          onError: () => {
            reject(new Error("YouTube player error"));
          },
        },
      });
      return true;
    };

    if (tryCreate()) return;
    // Wait for iframe API
    const start = Date.now();
    const poll = () => {
      if (tryCreate()) return;
      if (Date.now() - start > 8000) reject(new Error("YouTube API did not load"));
      else setTimeout(poll, 100);
    };
    poll();
  });
}

function addSyncPointAtPlayhead() {
  if (!canEdit()) return;

  const t = getMediaTimeSec();
  if (!Number.isFinite(t) || t < 0) return;

  let score;
  if (state.syncPoints.length >= 2) {
    const s = timeToScoreScalar(t);
    score = s != null ? scalarToScorePos(s) : (selection.score || { measure: 1, beat: 1 });
    state.syncPoints.push({ id: randomId(), score: normalizeScorePos(score), timeSec: t });
  } else {
    score = selection.score || { measure: 1, beat: 1 };
    addOrUpdateSyncPoint(score, t);
  }

  renderSyncTable();
  rebuildRenderCache();
  updateScorePlayhead(t);
  setStatus(`Sync point added at ${fmtTime(t)} (m${score.measure} b${Number(score.beat).toFixed(2)})`);
  updateButtons();
}

function exportSyncJson() {
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    media: {
      durationSec: Number.isFinite(els.video.duration) ? els.video.duration : null,
    },
    syncPoints: state.syncPoints
      .slice()
      .sort((a, b) => scorePosToScalar(a.score) - scorePosToScalar(b.score))
      .map((sp) => ({ score: sp.score, timeSec: sp.timeSec })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sync-map.json";
  a.click();
}

function saveProject() {
  const payload = {
    version: 2,
    app: "guitar-tab-editor",
    savedAt: new Date().toISOString(),
    musicXml: state.musicXmlText || null,
    syncPoints: state.syncPoints
      .slice()
      .sort((a, b) => scorePosToScalar(a.score) - scorePosToScalar(b.score))
      .map((sp) => ({ score: sp.score, timeSec: sp.timeSec })),
    media: {
      type: playback.source,
      youtubeId: playback.youtubeId || null,
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tab-editor-project.json";
  a.click();
  setStatus("Project saved");
}

async function loadProject(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || (data.version !== 1 && data.version !== 2)) {
    throw new Error("Invalid project file");
  }
  const syncPoints = Array.isArray(data.syncPoints)
    ? data.syncPoints.map((sp) => ({
        id: randomId(),
        score: normalizeScorePos(sp.score ?? { measure: 1, beat: 1 }),
        timeSec: Math.max(0, Number(sp.timeSec ?? 0)),
      }))
    : [];
  state.syncPoints = syncPoints;
  state.musicXmlText = data.musicXml || null;

  if (state.musicXmlText) {
    await loadMusicXmlFromString(state.musicXmlText);
  } else {
    setStatus("Project loaded (no score); add MusicXML.");
  }

  if (data.media?.type === "youtube" && data.media?.youtubeId) {
    playback.youtubeId = data.media.youtubeId;
    els.youtubeUrl.value = `https://www.youtube.com/watch?v=${data.media.youtubeId}`;
    setStatus("Loading YouTube from project…");
    await ensureYouTubePlayer(data.media.youtubeId);
  } else {
    playback.source = "local";
    playback.youtubeId = null;
  }

  renderSyncTable();
  rebuildRenderCache();
  updateButtons();
  setStatus("Project loaded");
}

function loadMusicXmlFromString(xmlString) {
  state.musicXmlText = xmlString;
  try {
    state.scoreModel = parseMusicXmlToScoreModel(xmlString);
  } catch (e) {
    state.scoreModel = null;
  }
  return renderCurrentMusicXml().then(() => {
    setStatus("MusicXML rendered");
    setSelectedScore({ measure: 1, beat: 1 }, null);
    try {
      synth.parsed = parseMusicXmlToSynthEvents(state.musicXmlText);
    } catch (e) {
      synth.parsed = null;
    }
    updateButtons();
    renderNoteEditor();
  });
}

function exportMusicXml() {
  if (!state.musicXmlText) return;
  const blob = new Blob([state.musicXmlText], { type: "application/xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "score.musicxml";
  a.click();
  setStatus("MusicXML exported");
}

async function importSyncJson(file) {
  const text = await file.text();
  const obj = JSON.parse(text);
  if (!obj || !Array.isArray(obj.syncPoints)) {
    throw new Error("Invalid sync JSON: expected { syncPoints: [...] }");
  }
  state.syncPoints = obj.syncPoints.map((sp) => ({
    id: randomId(),
    score: normalizeScorePos(sp.score ?? { measure: 1, beat: 1 }),
    timeSec: Math.max(0, Number(sp.timeSec ?? 0)),
  }));
  renderSyncTable();
  rebuildRenderCache();
  updateScorePlayhead(getMediaTimeSec() ?? 0);
  updateButtons();
}

function wireUi() {
  // Track last pointer position within score area (used to place inline fret input).
  els.scoreWrap?.addEventListener("pointerdown", (e) => {
    editState.lastPointer.x = e.clientX;
    editState.lastPointer.y = e.clientY;
  });
  // Inline tab number input: commit on Enter/blur.
  els.tabInlineInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      els.tabInlineInput.style.display = "none";
      els.tabInlineInput.value = "";
      els.scoreWrap?.focus?.();
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      const v = String(els.tabInlineInput.value || "").trim();
      const fret = Number(v);
      if (v.length && Number.isFinite(fret) && state.scoreModel && selection.score) {
        const stringNum = editState.tabEntry.activeString || Number(editState.newNote.string || 1) || 1;
        upsertNoteAtSelectionForString({ stringNum, fretNum: fret });
      }
      els.tabInlineInput.style.display = "none";
      els.tabInlineInput.value = "";
      els.scoreWrap?.focus?.();
      e.preventDefault();
    }
  });
  els.tabInlineInput?.addEventListener("blur", () => {
    // Hide without committing on blur (Soundslice behavior).
    els.tabInlineInput.style.display = "none";
    els.tabInlineInput.value = "";
  });

  els.videoFile.addEventListener("change", async () => {
    const file = els.videoFile.files?.[0];
    if (!file) return;
    try {
      await loadVideo(file);
      initWaveform();
      setSelectedTime(0);
      setPlaybackSource("local");
      updateButtons();
    } catch (e) {
      console.error(e);
      setError(String(e?.message ?? e));
      setStatus("Error");
    }
  });

  els.loadYoutubeBtn.addEventListener("click", async () => {
    const url = els.youtubeUrl.value.trim();
    if (!url) return;
    const id = extractYouTubeVideoId(url);
    if (!id) {
      setError("Could not parse YouTube video ID from URL.");
      return;
    }
    setError("");
    setStatus("Loading YouTube…");
    try {
      await ensureYouTubePlayer(id);
      updateButtons();
    } catch (e) {
      console.error(e);
      setError(String(e?.message ?? e));
      setStatus("Error");
    }
  });

  els.xmlFile.addEventListener("change", async () => {
    const file = els.xmlFile.files?.[0];
    if (!file) return;
    try {
      await loadMusicXml(file);
      updateButtons();
    } catch (e) {
      console.error(e);
      setError("Could not load MusicXML. If it’s a large file, try a smaller excerpt first.");
      setStatus("Error");
    }
  });

  els.playPauseBtn.addEventListener("click", togglePlay);
  els.rewindBtn.addEventListener("click", () => {
    const t = getMediaTimeSec();
    if (t != null) seekMediaTimeSec(t - 2);
  });
  els.forwardBtn.addEventListener("click", () => {
    const t = getMediaTimeSec();
    if (t != null) seekMediaTimeSec(t + 2);
  });
  els.addSyncPointBtn.addEventListener("click", addSyncPointAtPlayhead);
  els.tapSyncBtn.addEventListener("click", () => addSyncPointAtPlayhead());
  els.addNoteBtn.addEventListener("click", addNoteAtSelection);
  els.scoreClickOverlay?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onScoreClick(e);
  });
  els.scoreClickOverlay?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  els.editModeCheckbox?.addEventListener("change", () => {
    editState.enabled = Boolean(els.editModeCheckbox.checked);
    renderNoteEditor();
  });
  els.toolPencil?.addEventListener("change", () => {
    if (els.toolPencil.checked) editState.tool = "pencil";
    renderNoteEditor();
  });
  els.toolEraser?.addEventListener("change", () => {
    if (els.toolEraser.checked) editState.tool = "eraser";
    renderNoteEditor();
  });
  els.editDuration?.addEventListener("change", () => {
    editState.duration = Math.max(0.25, Number(els.editDuration.value) || 1);
  });
  const syncNewNoteFromUi = () => {
    editState.newNote.string = Math.max(1, Math.min(6, Number(els.newNoteString?.value || 1)));
    editState.newNote.fret = Math.max(0, Math.min(24, Number(els.newNoteFret?.value || 0)));
    editState.newNote.step = String(els.newNoteStep?.value || "C").trim().toUpperCase();
    editState.newNote.alter = Math.max(-2, Math.min(2, Number(els.newNoteAlter?.value || 0)));
    editState.newNote.octave = Math.max(1, Math.min(7, Number(els.newNoteOctave?.value || 4)));
  };
  [els.newNoteString, els.newNoteFret, els.newNoteStep, els.newNoteAlter, els.newNoteOctave].forEach((el) => {
    el?.addEventListener("change", syncNewNoteFromUi);
    el?.addEventListener("input", syncNewNoteFromUi);
  });
  syncNewNoteFromUi();

  // Pitch palette: click C D E F G A B / accidentals
  els.pitchPalette?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-step]");
    if (!btn) return;
    editState.newNote.step = String(btn.getAttribute("data-step") || "C").toUpperCase();
    if (els.newNoteStep) els.newNoteStep.value = editState.newNote.step;
    renderNoteEditor();
  });
  els.accFlatBtn?.addEventListener("click", () => {
    editState.newNote.alter = -1;
    if (els.newNoteAlter) els.newNoteAlter.value = String(editState.newNote.alter);
    renderNoteEditor();
  });
  els.accNaturalBtn?.addEventListener("click", () => {
    editState.newNote.alter = 0;
    if (els.newNoteAlter) els.newNoteAlter.value = String(editState.newNote.alter);
    renderNoteEditor();
  });
  els.accSharpBtn?.addEventListener("click", () => {
    editState.newNote.alter = 1;
    if (els.newNoteAlter) els.newNoteAlter.value = String(editState.newNote.alter);
    renderNoteEditor();
  });
  els.synthMode?.addEventListener("change", () => {
    synth.mode = els.synthMode.checked ? "synth" : "video";
    // Stop whichever mode is playing when switching
    if (synth.mode === "synth") {
      mediaPause();
      els.playPauseBtn.textContent = "Play";
      setStatus("Synth mode: Space to play MusicXML");
    } else {
      synthStop();
      setStatus("Video mode: Space to play video");
    }
  });
  els.exportSyncBtn.addEventListener("click", exportSyncJson);
  els.saveProjectBtn.addEventListener("click", saveProject);
  els.loadProjectBtn.addEventListener("click", () => els.projectFile.click());
  els.projectFile.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      setError("");
      await loadProject(file);
    } catch (e) {
      console.error(e);
      setError(String(e?.message ?? e));
      setStatus("Error");
    } finally {
      els.projectFile.value = "";
    }
  });
  els.exportMusicXmlBtn.addEventListener("click", exportMusicXml);
  els.newTabBtn?.addEventListener("click", () => {
    setError("");
    newTabFromScratch().catch((e) => {
      console.error(e);
      setError(String(e?.message ?? e));
      setStatus("Error");
    });
  });
  els.addMeasureBtn?.addEventListener("click", addMeasure);
  els.transcribeBtn?.addEventListener("click", transcribeAudio);
  els.importSyncBtn.addEventListener("click", () => els.syncJsonFile.click());
  els.syncJsonFile.addEventListener("change", async () => {
    const file = els.syncJsonFile.files?.[0];
    if (!file) return;
    try {
      await importSyncJson(file);
      setStatus("Sync map imported");
    } catch (e) {
      console.error(e);
      setError(String(e?.message ?? e));
      setStatus("Error");
    } finally {
      els.syncJsonFile.value = "";
    }
  });

  updateButtons();
  renderSyncTable();
  setSelectedScore(null, null);
  setSelectedTime(null);
  setPlayheadVisible(false);

  // Spacebar playback (Soundslice-style): click score, then Space toggles play/pause.
  window.addEventListener("keydown", (ev) => {
    if (ev.code !== "Space") return;
    const tag = ev.target?.tagName ? ev.target.tagName.toLowerCase() : "";
    const isTypingTarget = tag === "input" || tag === "textarea" || tag === "select" || ev.target?.isContentEditable;
    if (isTypingTarget) return;

    const active = document.activeElement;
    const scoreFocused = active === els.scoreWrap || (active && els.scoreWrap.contains(active));
    if (!scoreFocused) return;

    ev.preventDefault();
    togglePlay();
  });

  // Tap timing: press "T" to add a sync point at current time.
  window.addEventListener("keydown", (ev) => {
    if (ev.key?.toLowerCase?.() !== "t") return;
    const tag = ev.target?.tagName ? ev.target.tagName.toLowerCase() : "";
    const isTypingTarget = tag === "input" || tag === "textarea" || tag === "select" || ev.target?.isContentEditable;
    if (isTypingTarget) return;
    if (!canEdit()) return;
    addSyncPointAtPlayhead();
  });

  // Edit mode shortcuts: E toggle, P pencil, X erase.
  window.addEventListener("keydown", (ev) => {
    const tag = ev.target?.tagName ? ev.target.tagName.toLowerCase() : "";
    const isTypingTarget = tag === "input" || tag === "textarea" || tag === "select" || ev.target?.isContentEditable;
    if (isTypingTarget) return;

    // Tab number entry (Soundslice-like): only when edit mode ON and score has a selected position.
    // Allow direct tab entry without requiring focus; only block when typing in inputs (handled above).
    const canTabEnter = editState.enabled && state.scoreModel && selection.score;
    if (canTabEnter) {
      // 1–6 selects string
      if (/^[1-6]$/.test(ev.key)) {
        editState.tabEntry.activeString = Number(ev.key);
        // keep "new note" UI in sync for clarity
        if (els.newNoteString) els.newNoteString.value = String(editState.tabEntry.activeString);
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
      // Digits build fret buffer (supports 0–36; commit with Enter)
      if (/^[0-9]$/.test(ev.key)) {
        const next = (editState.tabEntry.buffer || "") + ev.key;
        // Limit buffer to 2 digits to keep it predictable (0–36)
        editState.tabEntry.buffer = next.slice(0, 2);
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
      if (ev.key === "Backspace") {
        editState.tabEntry.buffer = (editState.tabEntry.buffer || "").slice(0, -1);
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
      if (ev.key === "Escape") {
        editState.tabEntry.buffer = "";
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
      if (ev.key === "Enter") {
        const buf = String(editState.tabEntry.buffer || "").trim();
        if (buf.length) {
          const fret = Number(buf);
          const stringNum = editState.tabEntry.activeString || 1;
          if (Number.isFinite(fret)) {
            editState.newNote.string = stringNum;
            editState.newNote.fret = fret;
            if (els.newNoteFret) els.newNoteFret.value = String(fret);
            upsertNoteAtSelectionForString({ stringNum, fretNum: fret });
            els.scoreWrap?.focus?.(); // Keep focus for next note (re-render may steal it)
          }
        }
        editState.tabEntry.buffer = "";
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
    }

    // Pitch entry shortcuts: A–G sets step (when edit mode ON).
    // Do NOT require score focus; users expect note entry keys to "just work" like Soundslice.
    if (editState.enabled) {
      const k = String(ev.key || "").toUpperCase();
      if (/^[A-G]$/.test(k)) {
        editState.newNote.step = k;
        if (els.newNoteStep) els.newNoteStep.value = k;
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
      if (ev.key === "#" || ev.key === "ArrowUp") {
        editState.newNote.alter = 1;
        if (els.newNoteAlter) els.newNoteAlter.value = String(editState.newNote.alter);
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
      // Use ArrowDown or '-' for flat to avoid conflict with pitch "B".
      if (ev.key === "ArrowDown" || ev.key === "-") {
        editState.newNote.alter = -1;
        if (els.newNoteAlter) els.newNoteAlter.value = String(editState.newNote.alter);
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
      if (ev.key === "n" || ev.key === "N") {
        editState.newNote.alter = 0;
        if (els.newNoteAlter) els.newNoteAlter.value = String(editState.newNote.alter);
        ev.preventDefault();
        renderNoteEditor();
        return;
      }
    }

    if (ev.key === "e" || ev.key === "E") {
      editState.enabled = !editState.enabled;
      if (els.editModeCheckbox) els.editModeCheckbox.checked = editState.enabled;
      if (editState.enabled) els.scoreWrap?.focus?.();
      renderNoteEditor();
    }
    if (ev.key === "p" || ev.key === "P") {
      editState.tool = "pencil";
      if (els.toolPencil) els.toolPencil.checked = true;
      renderNoteEditor();
    }
    if (ev.key === "x" || ev.key === "X") {
      editState.tool = "eraser";
      if (els.toolEraser) els.toolEraser.checked = true;
      renderNoteEditor();
    }
  });
}

wireUi();