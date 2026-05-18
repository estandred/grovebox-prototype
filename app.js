// Beat Studio — sample launcher (tablet-landscape)
// Vanilla JS. Songs in localStorage; sample blobs in IndexedDB.

const TRACKS = [
  { id: "drums",  label: "drums",  color: "var(--row-drums)",  side: "left",  slot: 0 },
  { id: "hook",   label: "hook",   color: "var(--row-hook)",   side: "left",  slot: 1 },
  { id: "bass",   label: "bass",   color: "var(--row-bass)",   side: "left",  slot: 2 },
  { id: "chords", label: "chords", color: "var(--row-chords)", side: "right", slot: 0 },
  { id: "vocals", label: "vocals", color: "var(--row-vocals)", side: "right", slot: 1 },
  { id: "efx",    label: "efx",    color: "var(--row-efx)",    side: "right", slot: 2 },
];
const PADS_PER_TRACK = 6;        // 3 cols x 2 rows
const DEFAULT_BPM = 120;
const BAR_BEATS = 4;
const TIMELINE_BARS = 2;         // performer timeline = 2 bars = 8 beats
const TIMELINE_BEATS = BAR_BEATS * TIMELINE_BARS;

// ───────── Storage ─────────
const LS_KEY = "beatstudio.songs.v1";

function loadSongs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { return []; }
}
function saveSongs(songs) {
  localStorage.setItem(LS_KEY, JSON.stringify(songs));
}
function uid() { return Math.random().toString(36).slice(2, 9); }

// fitToBar defaults to true for songs created before the setting existed.
function isFitToBar(song) { return song?.fitToBar !== false; }

// Shared-mode bar length in beats — 8 or 16. Older songs default to 8.
function songTimelineBeats(song) {
  return song?.timelineBeats === 16 ? 16 : 8;
}

// Timeline mode controls how the bar period and audio loop relate to the samples:
//   "shared" — single 8-beat timeline at the song's BPM; samples are padded to
//              fit (or truncated to first 8 beats if longer); one shared bar.
//   "free"   — per-track timelines; each row's timeline equals the duration of
//              the sample it's playing; each row has its own bar moving at its
//              own sample's rate. One sample per row at a time.
function timelineMode(song) { return song?.timelineMode === "free" ? "free" : "shared"; }
function isTimelineShared(song) { return timelineMode(song) === "shared"; }

// Pad mode: "loop" (default — loops at the bar period) or "shot" (one-shot).
function padMode(pad)   { return pad?.mode === "shot" ? "shot" : "loop"; }
function padIsLoop(pad) { return padMode(pad) === "loop"; }

// Pad interaction: "solo" stops every other pad on the same track when this pad
// is launched. "stack" (default) plays alongside other pads on the same track.
function padInteraction(pad) { return pad?.interaction === "solo" ? "solo" : "stack"; }
function padIsSolo(pad)      { return padInteraction(pad) === "solo"; }

// Pad re-tap behavior: when a pad is already playing and you tap it again,
// "stop" (default) just stops it; "restart" stops then immediately retriggers
// it from sample-pos 0.
function padRetap(pad)      { return pad?.retap === "restart" ? "restart" : "stop"; }
function padIsRestart(pad)  { return padRetap(pad) === "restart"; }

// ───── Per-track effects ─────
// Each track has one set of knob values (0..1 each) stored on the song.
// The audio routing per-track is built in the Audio module and the knob
// values get pushed in via Audio.setEffectParam.
//   filter knob: 0 = closed LP at 150Hz, 1 = fully open (~18kHz). Default 1.
//   all other knobs: 0 = bypass, 1 = full wet/depth. Default 0.
const TRACK_EFFECT_KEYS = [
  "reverb", "echo", "delay", "drive", "distortion", "vibrato",
  "filter", "compressor", "volume", "pump",
];
const VOCAL_EXTRA_EFFECTS = ["robot"];
// Per-knob defaults. filter is now bipolar (0.5 = bypass center; <0.5 = LPF,
// >0.5 = HPF). volume's 0.5 = unity gain (1.0); 1.0 = +6dB hot. pump is the
// rhythmic LFO that boosts compression + volume on the beat (0 = bypass).
const EFFECT_DEFAULTS = {
  reverb: 0, echo: 0, delay: 0, drive: 0, distortion: 0, vibrato: 0,
  filter: 0.5, compressor: 0, volume: 0.5, pump: 0, robot: 0,
};
function trackEffectKeys(trackId) {
  return trackId === "vocals"
    ? [...TRACK_EFFECT_KEYS, ...VOCAL_EXTRA_EFFECTS]
    : TRACK_EFFECT_KEYS;
}
function getTrackEffects(song, trackId) {
  if (!song.effects) song.effects = {};
  if (!song.effects[trackId]) {
    const def = {};
    for (const k of trackEffectKeys(trackId)) def[k] = EFFECT_DEFAULTS[k];
    song.effects[trackId] = def;
    return song.effects[trackId];
  }
  const eff = song.effects[trackId];
  // One-time migration for songs saved before distortion/volume existed and
  // when filter=1 meant "fully open". Detect the legacy schema by the
  // absence of the new keys, then reset filter to the new bypass center.
  if (eff.distortion === undefined && eff.volume === undefined) {
    if (eff.filter === undefined || eff.filter >= 0.95) eff.filter = 0.5;
  }
  // Backfill any missing keys with defaults.
  for (const k of trackEffectKeys(trackId)) {
    if (!Number.isFinite(eff[k])) eff[k] = EFFECT_DEFAULTS[k];
  }
  return eff;
}
function getEffect(song, trackId, name) {
  const eff = getTrackEffects(song, trackId);
  const v = eff[name];
  return Number.isFinite(v) ? v : EFFECT_DEFAULTS[name];
}
function setEffect(song, trackId, name, value) {
  const eff = getTrackEffects(song, trackId);
  eff[name] = Math.max(0, Math.min(1, value));
}

// ───── Per-effect sub-parameters (automation lanes) ─────
// Each effect can expose multiple sub-parameters. Each sub-parameter has a
// fixed numeric range [min, max] (the horizontal bar in the UI) plus a
// per-song "automation": { low, high } telling us the value at main-knob 0
// and main-knob 1. The current value at knob = v is the linear interpolation
//   low + (high - low) * v.
// Drag the two endpoints on the bar to customize the automation.
const EFFECT_PARAMS = {
  reverb: [
    // wet: dry/wet mix (0 = bypass, 2 = ~+6dB hot wet)
    { key: "wet",     label: "dry/wet",   min: 0,    max: 2,  defaultLow: 0,   defaultHigh: 1.5 },
    // size: normalized room size (0 = small box → 1 = cavern). Maps to
    // pre-delay + build-up density in makeReverbIR.
    { key: "size",    label: "room size", min: 0,    max: 1,  defaultLow: 0.4, defaultHigh: 0.4 },
    // release: RT60 tail in seconds. How long the reverb keeps ringing after
    // the source stops.
    { key: "release", label: "release",   min: 0.2,  max: 6,  defaultLow: 1.5, defaultHigh: 1.5 },
  ],
  // pump: rhythmic LFO that boosts compression + volume on the beat.
  pump: [
    // compression: depth of the threshold modulation (0 = no compression
    // change, 1 = full -35dB swing on the peak of the LFO).
    { key: "compression", label: "compression", min: 0, max: 1, defaultLow: 0, defaultHigh: 1 },
    // volume: depth of the gain modulation (0 = no swing, 1 = ±0.5 around
    // unity → roughly ±6dB pump).
    { key: "volume", label: "volume", min: 0, max: 1, defaultLow: 0, defaultHigh: 1 },
    // intensity: how dramatic the LFO shape is. 0 = smooth sine wobble,
    // 1 = near-square shape that dwells at peak/trough with abrupt
    // transitions (classic "hard pump" feel). Single-value fader — not
    // part of the automation, just one setting.
    { key: "intensity", label: "intensity", type: "fader", min: 0, max: 1, defaultValue: 0.5 },
    // rate: discrete choice of how often the LFO cycles, in beats. Stored
    // as a single value (not an automation range) — see paramRowChoice.
    {
      key: "rate", label: "rate", type: "choice", defaultValue: 1,
      choices: [
        { label: "1/2", value: 0.5 },
        { label: "1",   value: 1   },
      ],
    },
  ],
};

function getEffectParamsDef(name) {
  return EFFECT_PARAMS[name] || null;
}

function getParamRange(song, trackId, effect, paramKey) {
  const def = (EFFECT_PARAMS[effect] || []).find(p => p.key === paramKey);
  if (!def) return null;
  if (!song.effectParams) song.effectParams = {};
  if (!song.effectParams[trackId]) song.effectParams[trackId] = {};
  if (!song.effectParams[trackId][effect]) song.effectParams[trackId][effect] = {};
  const slot = song.effectParams[trackId][effect];

  if (def.type === "choice") {
    // Choice params store a single `value`. Migrate from any older shape
    // that used {low, high} (rate used to be a numeric automation range).
    if (!slot[paramKey] || !Number.isFinite(slot[paramKey].value)) {
      const old = slot[paramKey];
      const guess = old?.value ?? old?.low ?? def.defaultValue ?? def.choices[0].value;
      slot[paramKey] = { value: guess };
    }
    // Snap to the closest valid choice if the stored value drifted.
    if (!def.choices.some(c => Math.abs(c.value - slot[paramKey].value) < 1e-6)) {
      let best = def.choices[0], bestDist = Infinity;
      for (const c of def.choices) {
        const d = Math.abs(c.value - slot[paramKey].value);
        if (d < bestDist) { best = c; bestDist = d; }
      }
      slot[paramKey].value = best.value;
    }
    return slot[paramKey];
  }

  if (def.type === "fader") {
    // Single-value slider (not an automation range). Migrate from any older
    // {low, high} shape by averaging.
    if (!slot[paramKey] || !Number.isFinite(slot[paramKey].value)) {
      const old = slot[paramKey];
      let guess;
      if (Number.isFinite(old?.value))                    guess = old.value;
      else if (Number.isFinite(old?.low) && Number.isFinite(old?.high))
                                                          guess = (old.low + old.high) / 2;
      else                                                guess = def.defaultValue ?? def.min;
      slot[paramKey] = { value: guess };
    }
    slot[paramKey].value = Math.max(def.min, Math.min(def.max, slot[paramKey].value));
    return slot[paramKey];
  }

  if (!slot[paramKey]) slot[paramKey] = { low: def.defaultLow, high: def.defaultHigh };
  // Defensive clamp so songs saved with an older range (e.g. when reverb
  // "size" was IR-duration-in-seconds) don't push values past the new bar
  // limits. Idempotent for in-range values.
  slot[paramKey].low  = Math.max(def.min, Math.min(def.max, slot[paramKey].low));
  slot[paramKey].high = Math.max(def.min, Math.min(def.max, slot[paramKey].high));
  return slot[paramKey];
}

function setParamSide(song, trackId, effect, paramKey, side, value) {
  const def = (EFFECT_PARAMS[effect] || []).find(p => p.key === paramKey);
  if (!def) return;
  const range = getParamRange(song, trackId, effect, paramKey);
  const v = Math.max(def.min, Math.min(def.max, value));
  if (side === "low")  range.low  = v;
  if (side === "high") range.high = v;
}

// Linear interpolation between automation endpoints for the current main
// knob value. The two handles are just the LEFT and RIGHT endpoints of the
// automation line on the bar — the actual sweep always goes left → right
// as the main knob turns up, regardless of which handle was dragged first.
// For "choice" params (e.g. pump.rate) the main knob doesn't sweep — the
// stored value is returned directly.
function paramValueAt(song, trackId, effect, paramKey, knobValue) {
  const def = (EFFECT_PARAMS[effect] || []).find(p => p.key === paramKey);
  const range = getParamRange(song, trackId, effect, paramKey);
  if (!range) return null;
  if (def?.type === "choice" || def?.type === "fader") return range.value;
  const lo = Math.min(range.low, range.high);
  const hi = Math.max(range.low, range.high);
  const v = Math.max(0, Math.min(1, knobValue));
  return lo + (hi - lo) * v;
}

function newSong(name = "untitled") {
  const pads = {};
  for (const t of TRACKS) pads[t.id] = Array.from({ length: PADS_PER_TRACK }, () => null);
  const effects = {};
  for (const t of TRACKS) {
    const def = {};
    for (const k of trackEffectKeys(t.id)) def[k] = EFFECT_DEFAULTS[k];
    effects[t.id] = def;
  }
  return {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pads,
    bpm: DEFAULT_BPM,
    quantize: "off",        // "off" | "1/4" | "1/2"
    timelineMode: "shared", // "shared" | "free" (see helpers above)
    timelineBeats: 8,       // 8 or 16 — length of the shared-mode bar
    fitToBar: true,         // legacy, kept on disk for older songs
    effects,                // per-track effect knob values (0..1)
  };
}

// ───────── IndexedDB for sample blobs ─────────
const DB_NAME = "beatstudio";
const DB_STORE = "samples";
let _dbPromise = null;
function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return _dbPromise;
}
async function putSample(id, blob) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(blob, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function getSample(id) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const r = tx.objectStore(DB_STORE).get(id);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}
async function deleteSample(id) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ───────── Audio engine ─────────
const Audio = (() => {
  let ctx = null;
  const buffers = new Map();           // sampleId -> AudioBuffer (original)
  const inflightBuffers = new Map();   // sampleId -> Promise<AudioBuffer>
  const peaksCache = new Map();        // sampleId -> Float32Array (peaks)
  const paddedBuffers = new Map();     // `${sampleId}|${tlDur.toFixed(4)}` -> AudioBuffer (sample + silence to tlDur)
  const activeSources = new Map();     // padKey -> { src, startedAt, duration, looping }

  function ensure() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      try { ctx = new Ctor({ latencyHint: "interactive" }); }
      catch { ctx = new Ctor(); }
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function nowCtx() { return ensure(); }
  function hasCtx() { return !!ctx; }

  // Total scheduling-to-audible latency. Prefer outputLatency (the real thing);
  // fall back to baseLatency on browsers (mostly Safari) that don't expose it.
  function outputLatency() {
    if (!ctx) return 0;
    const ol = ctx.outputLatency;
    if (typeof ol === "number" && ol > 0) return ol;
    const bl = ctx.baseLatency;
    if (typeof bl === "number" && bl > 0) return bl;
    return 0;
  }

  async function loadSample(sampleId) {
    if (buffers.has(sampleId)) return buffers.get(sampleId);
    if (inflightBuffers.has(sampleId)) return inflightBuffers.get(sampleId);
    const p = (async () => {
      const blob = await getSample(sampleId);
      if (!blob) return null;
      const arr = await blob.arrayBuffer();
      const c = ensure();
      const buf = await c.decodeAudioData(arr.slice(0));
      buffers.set(sampleId, buf);
      return buf;
    })().finally(() => inflightBuffers.delete(sampleId));
    inflightBuffers.set(sampleId, p);
    return p;
  }

  function computePeaks(buf, bins = 480) {
    const ch = buf.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(ch.length / bins));
    const peaks = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      let max = 0;
      const start = i * blockSize;
      const end = Math.min(ch.length, start + blockSize);
      for (let j = start; j < end; j++) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }
  async function getPeaks(sampleId) {
    if (peaksCache.has(sampleId)) return peaksCache.get(sampleId);
    const buf = await loadSample(sampleId);
    if (!buf) return null;
    const p = computePeaks(buf);
    peaksCache.set(sampleId, p);
    return p;
  }

  // ── Band peaks (for the "frequency" view) ──
  // Splits the audio into 3 perceptual bands and returns peak amplitude per
  // bin for each band. Bands are crude (one-pole IIR cascades) — accuracy
  // doesn't matter, this is a visual hint at frequency content. Cached.
  const bandPeaksCache = new Map();
  function onePoleLP(input, fc, sr) {
    // 6 dB/oct low-pass. a = 1 - e^(-2πfc/sr).
    const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
    const out = new Float32Array(input.length);
    let y = 0;
    for (let i = 0; i < input.length; i++) {
      y = y + a * (input[i] - y);
      out[i] = y;
    }
    return out;
  }
  function computeBandPeaks(buf, bins = 480) {
    const ch = buf.getChannelData(0);
    const sr = buf.sampleRate;
    // Cascade two one-pole sections per band for a ~12 dB/oct slope.
    const lowAll  = onePoleLP(onePoleLP(ch,    300, sr), 300, sr);
    const midLow  = onePoleLP(onePoleLP(ch,   3000, sr), 3000, sr);
    const mid = new Float32Array(ch.length);
    const high = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      mid[i]  = midLow[i] - lowAll[i];
      high[i] = ch[i]     - midLow[i];
    }
    const blockSize = Math.max(1, Math.floor(ch.length / bins));
    const lowP  = new Float32Array(bins);
    const midP  = new Float32Array(bins);
    const highP = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      let l = 0, m = 0, h = 0;
      const start = i * blockSize;
      const end = Math.min(ch.length, start + blockSize);
      for (let j = start; j < end; j++) {
        const lv = Math.abs(lowAll[j]); if (lv > l) l = lv;
        const mv = Math.abs(mid[j]);    if (mv > m) m = mv;
        const hv = Math.abs(high[j]);   if (hv > h) h = hv;
      }
      lowP[i] = l; midP[i] = m; highP[i] = h;
    }
    return { low: lowP, mid: midP, high: highP };
  }
  async function getBandPeaks(sampleId) {
    if (bandPeaksCache.has(sampleId)) return bandPeaksCache.get(sampleId);
    const buf = await loadSample(sampleId);
    if (!buf) return null;
    const p = computeBandPeaks(buf);
    bandPeaksCache.set(sampleId, p);
    return p;
  }

  function stopPad(padKey) {
    const e = activeSources.get(padKey);
    if (!e) return;
    try { e.src.stop(); } catch {}
    activeSources.delete(padKey);
  }

  // Stop every voice on a track (used for clearPad and stop-all).
  function stopTrack(trackId) {
    const prefix = trackId + ":";
    for (const padKey of [...activeSources.keys()]) {
      if (padKey.startsWith(prefix)) stopPad(padKey);
    }
  }

  function stopAll() {
    for (const padKey of [...activeSources.keys()]) stopPad(padKey);
  }

  // Returns a buffer that loops cleanly within the bar.
  //
  //   fitToBar = true (default): every loop is locked to the bar.
  //     - sample < bar → padded with silence to bar length
  //     - sample ≥ bar → first 8 beats only (loopEnd = tlDur)
  //   fitToBar = false:
  //     - sample < bar → still padded (it'd drift to the next loop instead)
  //     - sample ≥ bar → full sample plays end-to-end (loop period = sample.duration,
  //       drifts relative to the bar)
  function getLoopBuffer(sampleId, tlDur, fitToBar = true) {
    const buf = buffers.get(sampleId);
    if (!buf) return null;
    if (!tlDur || tlDur <= 0) return { buf, loopEnd: buf.duration };
    if (buf.duration >= tlDur - 1e-4) {
      // No truncation. The sample plays its full natural length and loops at
      // its natural duration. drawWaveform handles "wrap to next bar cycle"
      // visually by showing different segments of the waveform per cycle.
      return { buf, loopEnd: buf.duration };
    }
    const key = `${sampleId}|${tlDur.toFixed(4)}`;
    const cached = paddedBuffers.get(key);
    if (cached) return { buf: cached, loopEnd: cached.duration };
    const c = ensure();
    const sr = buf.sampleRate;
    const ch = buf.numberOfChannels;
    const targetSamples = Math.ceil(tlDur * sr);
    const padded = c.createBuffer(ch, targetSamples, sr);
    for (let i = 0; i < ch; i++) padded.getChannelData(i).set(buf.getChannelData(i));
    paddedBuffers.set(key, padded);
    return { buf: padded, loopEnd: padded.duration };
  }

  // Synchronous play — requires the buffer to already be decoded and cached.
  // Returns null if not cached. Used for the lowest-latency trigger path.
  //
  // When `opts.loop` is true and `opts.timelineDur` is supplied, the loop period
  // is forced to exactly `timelineDur` seconds so the sample's audio position is
  // perfectly locked to the visual playhead — no drift ever.
  function playSync(trackId, padKey, sampleId, opts = {}) {
    const baseBuf = buffers.get(sampleId);
    if (!baseBuf) return null;
    const c = ensure();
    // Defensive: if the context is still suspended at the moment of playback
    // (the global gesture-unlock handler somehow missed), try resuming again.
    // playSync is called from a pointerdown handler so this counts as a user
    // gesture in all browsers.
    if (c.state === "suspended") c.resume().catch(() => {});
    if (activeSources.has(padKey)) stopPad(padKey);

    const shouldLoop = !!opts.loop;
    let playBuf = baseBuf;
    let loopEnd = baseBuf.duration;
    if (shouldLoop && opts.timelineDur) {
      const lb = getLoopBuffer(sampleId, opts.timelineDur, opts.fitToBar !== false);
      if (lb) { playBuf = lb.buf; loopEnd = lb.loopEnd; }
    }

    const src = c.createBufferSource();
    src.buffer = playBuf;
    src.loop = shouldLoop;
    if (shouldLoop) {
      src.loopStart = 0;
      src.loopEnd = loopEnd;
    }
    const gain = c.createGain();
    gain.gain.value = opts.gain ?? 1.0;
    // Split the connect chain into two lines so it works on older browsers
    // where `node.connect(...)` doesn't return the destination node.
    src.connect(gain);
    // Route through the per-track effects chain (drive → filter → vibrato →
    // delay → echo → reverb → compressor [→ robot]) so the song's effect
    // settings get applied. Falls back to destination if no trackId was passed.
    const dest = trackId ? ensureTrackChain(trackId).input : c.destination;
    gain.connect(dest);
    const when = opts.when || c.currentTime;
    console.log("[Audio.playSync] src.start", {
      padKey, sampleId, when, ctxTime: c.currentTime, ctxState: c.state,
      loopEnd, shouldLoop, gainValue: gain.gain.value,
      bufDuration: playBuf?.duration,
    });
    src.start(when);
    const entry = { src, startedAt: when, duration: baseBuf.duration, looping: shouldLoop };
    activeSources.set(padKey, entry);
    src.onended = () => {
      if (activeSources.get(padKey)?.src === src) activeSources.delete(padKey);
      opts.onEnd && opts.onEnd();
    };
    return entry;
  }

  // Async wrapper — decodes if not cached, then plays.
  async function play(trackId, padKey, sampleId, opts = {}) {
    let buf = buffers.get(sampleId);
    if (!buf) buf = await loadSample(sampleId);
    if (!buf) return null;
    return playSync(trackId, padKey, sampleId, opts);
  }

  function hasBuffer(sampleId) { return buffers.has(sampleId); }
  function getBufferDuration(sampleId) {
    const b = buffers.get(sampleId);
    return b ? b.duration : null;
  }

  // Play a tiny silent buffer to wake the audio hardware. The very first audible
  // sound on iOS/Safari (and some Android setups) has noticeable extra latency
  // until the device's audio output is "live". This eats that cost up front so
  // the first sample the user actually triggers is snappy.
  function warmUp() {
    try {
      const c = ensure();
      const buf = c.createBuffer(1, 1, c.sampleRate);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start(0);
    } catch {}
  }

  function isPadPlaying(padKey) { return activeSources.has(padKey); }
  function evict(sampleId) {
    buffers.delete(sampleId);
    peaksCache.delete(sampleId);
    bandPeaksCache.delete(sampleId);
    for (const key of [...paddedBuffers.keys()]) {
      if (key.startsWith(sampleId + "|")) paddedBuffers.delete(key);
    }
  }
  function progressFor(padKey) {
    const e = activeSources.get(padKey);
    if (!e) return null;
    const t = ensure().currentTime;
    const p = (t - e.startedAt) / e.duration;
    if (p < 0) return 0;
    if (p > 1) return 1;
    return p;
  }

  // ───── Per-track effects chain ─────
  // Each track has a persistent Web Audio graph: input → drive → filter →
  // vibrato → delay → echo → reverb → compressor [→ robot for vocals] →
  // output → destination. Pads route to the input via playSync; knobs mutate
  // AudioParams live so changes are heard on currently-playing voices.
  const trackChains = new Map();
  let lastBpm = DEFAULT_BPM;

  function makeDriveCurve(amount) {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = amount * 50;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = k <= 0 ? x : Math.tanh(x * k) / Math.tanh(k);
    }
    return curve;
  }
  // LFO shape curve for the pump effect. Takes a -1..+1 sine and morphs it
  // toward a square-ish shape — values dwell at the extremes, transitions
  // get steeper. intensity 0 = passthrough (smooth sine), 1 = tanh hard
  // saturation (near square, abrupt swings).
  function makeLFOShapeCurve(intensity) {
    const n = 512;
    const curve = new Float32Array(n);
    if (intensity <= 0) {
      for (let i = 0; i < n; i++) curve[i] = (i / (n - 1)) * 2 - 1;
      return curve;
    }
    const k = 1 + intensity * 9; // 1 → 10
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * k) / norm;
    }
    return curve;
  }
  // Distortion = harder than drive. Asymmetric hard-clip with a small fold,
  // produces buzzier upper harmonics. amount 0 = passthrough, 1 = max grit.
  function makeDistortionCurve(amount) {
    const n = 1024;
    const curve = new Float32Array(n);
    if (amount <= 0) {
      for (let i = 0; i < n; i++) curve[i] = (i / (n - 1)) * 2 - 1;
      return curve;
    }
    const drive = 1 + amount * 30;
    const threshold = 1 - amount * 0.7;
    for (let i = 0; i < n; i++) {
      let x = (i / (n - 1)) * 2 - 1;
      x = x * drive;
      // Hard clip with a soft knee around the threshold.
      if (x > threshold)      x = threshold + (x - threshold) / (1 + Math.pow((x - threshold) / 0.1, 2));
      else if (x < -threshold) x = -threshold + (x + threshold) / (1 + Math.pow((x + threshold) / 0.1, 2));
      curve[i] = Math.max(-1, Math.min(1, x));
    }
    return curve;
  }
  // Synthesize a reverb impulse response.
  //   size    — 0..1, perceived room size. Drives THREE audible things:
  //               (a) pre-delay: 0ms → 250ms before the first reflection
  //                   (closet vs cathedral),
  //               (b) build-up window: 5ms → 250ms before reflections reach
  //                   full density (sharp early reflections vs lush bloom),
  //               (c) tone: small rooms reflect brightly, big rooms absorb
  //                   high frequencies — modeled as a one-pole low-pass on
  //                   the IR noise whose cutoff drops with size.
  //   release — RT60 tail length in seconds. Exponential e^(-t/τ) envelope
  //             with τ = release / ln(1000), IR buffer length = release sec
  //             so the wet tail rings out naturally after the source stops.
  function makeReverbIR(c, size = 0.5, release = 1.5) {
    size    = Math.max(0,    Math.min(1,  size));
    release = Math.max(0.15, Math.min(10, release));
    const sr = c.sampleRate;
    const length = Math.max(1, Math.floor(sr * release));
    const ir = c.createBuffer(2, length, sr);
    // Pre-delay 0 → 400ms (closet → cathedral).
    const preDelay = Math.floor(sr * size * 0.4);
    // Build-up: 2ms → 300ms before reaching full diffuse density.
    const buildup = Math.max(1, Math.floor(sr * (0.002 + size * 0.298)));
    // Tail RT60 → time constant.
    const tau = release / Math.log(1000);
    // One-pole low-pass coefficient. Small room = bright (no filtering,
    // alpha≈1). Big room = dark (alpha≈0.03 = very heavy LP, only low
    // frequencies survive). This is what makes "big room" sound big on
    // sustained signals where pre-delay alone wouldn't be obvious.
    const lpAlpha = Math.max(0.03, 1 - size * 0.97);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      let lpState = 0;
      for (let i = 0; i < length; i++) {
        if (i < preDelay) { data[i] = 0; continue; }
        const td = (i - preDelay) / sr;
        const tailEnv = Math.exp(-td / tau);
        const k = i - preDelay;
        const buildEnv = k < buildup ? (k / buildup) : 1;
        const noise = (Math.random() * 2 - 1);
        // One-pole low-pass: lpAlpha small = darker (big room).
        lpState = lpState + lpAlpha * (noise - lpState);
        data[i] = lpState * tailEnv * buildEnv;
      }
    }
    return ir;
  }

  function ensureTrackChain(trackId) {
    if (trackChains.has(trackId)) return trackChains.get(trackId);
    const c = ensure();
    const isVocals = trackId === "vocals";

    const input = c.createGain();

    // Drive (WaveShaper, tanh soft saturation) — dry/wet via parallel gains.
    const driveShaper = c.createWaveShaper();
    driveShaper.curve = makeDriveCurve(0);
    driveShaper.oversample = "2x";
    const driveDry = c.createGain(); driveDry.gain.value = 1;
    const driveWet = c.createGain(); driveWet.gain.value = 0;
    input.connect(driveDry);
    input.connect(driveShaper);
    driveShaper.connect(driveWet);
    const afterDrive = c.createGain();
    driveDry.connect(afterDrive);
    driveWet.connect(afterDrive);

    // Distortion (WaveShaper, hard-clip) — sits after drive in the chain.
    const distShaper = c.createWaveShaper();
    distShaper.curve = makeDistortionCurve(0);
    distShaper.oversample = "4x";
    const distDry = c.createGain(); distDry.gain.value = 1;
    const distWet = c.createGain(); distWet.gain.value = 0;
    afterDrive.connect(distDry);
    afterDrive.connect(distShaper);
    distShaper.connect(distWet);
    const afterDist = c.createGain();
    distDry.connect(afterDist);
    distWet.connect(afterDist);

    // Filter — bipolar. Single biquad whose `type` swaps between lowpass
    // (knob < 0.5) and highpass (knob > 0.5). Knob = 0.5 leaves both modes
    // out of audible range, i.e. effective bypass.
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 20000; // bypass-ish
    filter.Q.value = 0.7;
    afterDist.connect(filter);

    // Vibrato (1/4-note rate LFO modulating a short delay).
    const vibratoDelay = c.createDelay(0.05);
    vibratoDelay.delayTime.value = 0.005;
    const vibratoLFO = c.createOscillator();
    vibratoLFO.frequency.value = lastBpm / 60; // 1 cycle per beat
    const vibratoDepth = c.createGain();
    vibratoDepth.gain.value = 0;
    vibratoLFO.connect(vibratoDepth);
    vibratoDepth.connect(vibratoDelay.delayTime);
    try { vibratoLFO.start(); } catch {}
    filter.connect(vibratoDelay);

    // Delay (1/4-note single tap, light feedback).
    const delayNode = c.createDelay(2);
    delayNode.delayTime.value = 60 / lastBpm;
    const delayFb = c.createGain(); delayFb.gain.value = 0.25;
    const delayWet = c.createGain(); delayWet.gain.value = 0;
    vibratoDelay.connect(delayNode);
    delayNode.connect(delayFb);
    delayFb.connect(delayNode);
    delayNode.connect(delayWet);
    const afterDelay = c.createGain();
    vibratoDelay.connect(afterDelay);
    delayWet.connect(afterDelay);

    // Echo (longer delay, more feedback).
    const echoNode = c.createDelay(3);
    echoNode.delayTime.value = 0.38;
    const echoFb = c.createGain(); echoFb.gain.value = 0.5;
    const echoWet = c.createGain(); echoWet.gain.value = 0;
    afterDelay.connect(echoNode);
    echoNode.connect(echoFb);
    echoFb.connect(echoNode);
    echoNode.connect(echoWet);
    const afterEcho = c.createGain();
    afterDelay.connect(afterEcho);
    echoWet.connect(afterEcho);

    // Reverb (convolution with synth IR).
    const reverb = c.createConvolver();
    reverb.normalize = true;
    reverb.buffer = makeReverbIR(c, 0.4, 1.5);
    const reverbWet = c.createGain(); reverbWet.gain.value = 0;
    afterEcho.connect(reverb);
    reverb.connect(reverbWet);
    const afterReverb = c.createGain();
    afterEcho.connect(afterReverb);
    reverbWet.connect(afterReverb);

    // Compressor (knob sweeps threshold + ratio).
    const compressor = c.createDynamicsCompressor();
    compressor.threshold.value = 0;
    compressor.knee.value = 30;
    compressor.ratio.value = 1;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    afterReverb.connect(compressor);

    let afterAll = compressor;
    let robot = null;
    if (isVocals) {
      // Robot = ring-modulator at ~75Hz. Knob = wet mix.
      const robotOsc = c.createOscillator();
      robotOsc.frequency.value = 75;
      const ringGain = c.createGain();
      ringGain.gain.value = 0; // gain is *modulated* by the oscillator
      robotOsc.connect(ringGain.gain);
      compressor.connect(ringGain);
      const robotWet = c.createGain(); robotWet.gain.value = 0;
      ringGain.connect(robotWet);
      const afterRobot = c.createGain();
      compressor.connect(afterRobot);
      robotWet.connect(afterRobot);
      try { robotOsc.start(); } catch {}
      afterAll = afterRobot;
      robot = { robotOsc, robotWet };
    }

    // Per-track volume — knob 0..1 maps to 0..2 (0.5 = unity, 1.0 = +6dB).
    const volume = c.createGain();
    volume.gain.value = 1.0;
    afterAll.connect(volume);

    // ── Pump (LFO-driven sidechain-style effect) ──
    // A dedicated low-frequency sine drives BOTH a compressor's threshold
    // and a gain node's value. When the LFO swings positive (on the beat,
    // approximately) the compressor's threshold drops (more compression)
    // and the gain rises (louder). Each leg has its own "depth" gain so
    // the sub-parameter values can attenuate the modulation independently.
    const pumpComp = c.createDynamicsCompressor();
    pumpComp.threshold.value = 0;
    pumpComp.knee.value = 12;
    pumpComp.ratio.value = 6;
    pumpComp.attack.value = 0.005;
    pumpComp.release.value = 0.1;

    const pumpVol = c.createGain();
    pumpVol.gain.value = 1.0;

    const pumpLFO = c.createOscillator();
    pumpLFO.type = "sine";
    pumpLFO.frequency.value = lastBpm / 60; // 1 cycle per beat at song BPM
    // Shape the sine before it feeds the depth gains. Default = passthrough.
    const pumpShape = c.createWaveShaper();
    pumpShape.curve = makeLFOShapeCurve(0.5);
    pumpLFO.connect(pumpShape);
    const pumpCompDepth = c.createGain();
    pumpCompDepth.gain.value = 0; // signed (negative pushes threshold down)
    pumpShape.connect(pumpCompDepth);
    pumpCompDepth.connect(pumpComp.threshold);
    const pumpVolDepth = c.createGain();
    pumpVolDepth.gain.value = 0;
    pumpShape.connect(pumpVolDepth);
    pumpVolDepth.connect(pumpVol.gain);
    try { pumpLFO.start(); } catch {}

    // Splice pump nodes in after the per-track volume.
    volume.connect(pumpComp);
    pumpComp.connect(pumpVol);

    const output = c.createGain();
    pumpVol.connect(output);
    output.connect(c.destination);

    const chain = {
      input, output,
      driveShaper, driveDry, driveWet,
      distShaper, distDry, distWet,
      filter,
      vibratoLFO, vibratoDepth,
      delayNode, delayWet,
      echoNode, echoWet,
      reverb, reverbWet,
      // afterEcho is the node feeding the convolver — keep a reference so
      // setReverbParams can disconnect+recreate the convolver when the IR
      // changes (more reliable than mutating `.buffer` on a live node).
      _reverbInput: afterEcho,
      compressor,
      robot,
      volume,
      pumpLFO, pumpShape, pumpCompDepth, pumpVolDepth, pumpComp, pumpVol,
      _pumpRateBeats: 1, // cached so updateBpm can re-derive LFO Hz
    };
    trackChains.set(trackId, chain);
    return chain;
  }

  function setEffectParam(trackId, name, value) {
    const chain = ensureTrackChain(trackId);
    if (!ctx) return;
    const v = Math.max(0, Math.min(1, value));
    const t = ctx.currentTime + 0.02;
    const tc = 0.05;
    switch (name) {
      case "drive":
        chain.driveShaper.curve = makeDriveCurve(v);
        chain.driveDry.gain.setTargetAtTime(1 - v, t, tc);
        chain.driveWet.gain.setTargetAtTime(v * 0.9, t, tc);
        break;
      case "distortion":
        chain.distShaper.curve = makeDistortionCurve(v);
        chain.distDry.gain.setTargetAtTime(1 - v, t, tc);
        // Distortion gets attenuated more than drive — hard clipping is loud.
        chain.distWet.gain.setTargetAtTime(v * 0.6, t, tc);
        break;
      case "volume":
        // 0.5 = unity (1.0×). 0 = silence. 1 = +6dB (~2×).
        chain.volume.gain.setTargetAtTime(v * 2, t, tc);
        break;
      case "filter": {
        // Bipolar filter:
        //   v < 0.5 → LPF, cutoff 150Hz (closed) at v=0 → 20kHz at v=0.5
        //   v > 0.5 → HPF, cutoff 20Hz at v=0.5 → 8kHz (closed) at v=1
        //   v ≈ 0.5 → effective bypass (LP at 20kHz)
        if (v <= 0.5) {
          chain.filter.type = "lowpass";
          const lpT = v / 0.5; // 0..1
          const freq = 150 * Math.pow(20000 / 150, lpT);
          chain.filter.frequency.setTargetAtTime(freq, t, tc);
        } else {
          chain.filter.type = "highpass";
          const hpT = (v - 0.5) / 0.5; // 0..1
          const freq = 20 * Math.pow(8000 / 20, hpT);
          chain.filter.frequency.setTargetAtTime(freq, t, tc);
        }
        break;
      }
      case "vibrato":
        chain.vibratoDepth.gain.setTargetAtTime(v * 0.005, t, tc);
        break;
      case "delay":
        chain.delayWet.gain.setTargetAtTime(v, t, tc);
        break;
      case "echo":
        chain.echoWet.gain.setTargetAtTime(v, t, tc);
        break;
      case "reverb":
        chain.reverbWet.gain.setTargetAtTime(v * 1.5, t, tc);
        break;
      case "compressor":
        chain.compressor.threshold.setTargetAtTime(-v * 40, t, tc);
        chain.compressor.ratio.setTargetAtTime(1 + v * 19, t, tc);
        break;
      case "robot":
        if (chain.robot) chain.robot.robotWet.gain.setTargetAtTime(v, t, tc);
        break;
    }
  }

  function updateBpm(bpm) {
    lastBpm = bpm;
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    const tc = 0.05;
    for (const chain of trackChains.values()) {
      chain.delayNode.delayTime.setTargetAtTime(60 / bpm, t, tc);
      chain.vibratoLFO.frequency.setTargetAtTime(bpm / 60, t, tc);
      // Pump LFO is also beat-synced: rate is stored in beats-per-cycle, so
      // the actual Hz must be recomputed when BPM changes.
      if (chain.pumpLFO && chain._pumpRateBeats != null) {
        chain.pumpLFO.frequency.setTargetAtTime((bpm / 60) * chain._pumpRateBeats, t, tc);
      }
    }
  }

  // Pump: LFO-driven compression + volume modulation.
  //   compAmount — 0..1 depth of threshold modulation (0 = bypass, 1 = full
  //                threshold swings down to -35dB at the LFO peak).
  //   volAmount  — 0..1 depth of gain modulation (1 = ±0.5 around unity).
  //   rate       — LFO frequency in beats per cycle (1 = once per beat).
  //   intensity  — 0..1 LFO shape (0 = smooth sine, 1 = near-square shape
  //                that dwells at peak/trough with abrupt transitions).
  function setPumpParams(trackId, compAmount, volAmount, rate, intensity) {
    const chain = ensureTrackChain(trackId);
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    const tc = 0.05;
    // Negative depth so the LFO peak drives threshold DOWN (more compression
    // on the beat). When LFO is at +1, threshold ≈ -35dB at full depth.
    chain.pumpCompDepth.gain.setTargetAtTime(-compAmount * 35, t, tc);
    // Positive depth so the LFO peak boosts gain (louder on the beat).
    chain.pumpVolDepth.gain.setTargetAtTime(volAmount * 0.5, t, tc);
    chain._pumpRateBeats = rate;
    chain.pumpLFO.frequency.setTargetAtTime((lastBpm / 60) * rate, t, tc);
    // Shape morph is applied via curve replacement (cheap; the waveshaper
    // re-reads the curve table on every sample).
    chain.pumpShape.curve = makeLFOShapeCurve(Math.max(0, Math.min(1, intensity)));
  }

  // Reverb has 3 sub-parameters: wet (0..2 gain), size (IR duration in
  // seconds), release (decay exponent). Wet is cheap (a gain ramp); size and
  // release require regenerating the impulse response — we cache the last
  // values per chain and only rebuild when they change by a meaningful
  // amount, since IR generation isn't free.
  function setReverbParams(trackId, wet, size, release) {
    const chain = ensureTrackChain(trackId);
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    chain.reverbWet.gain.setTargetAtTime(Math.max(0, wet), t, 0.05);
    const sizeChanged = Math.abs((chain._lastReverbSize ?? -1) - size) > 0.02;
    const relChanged  = Math.abs((chain._lastReverbRel  ?? -1) - release) > 0.02;
    const willRebuild = sizeChanged || relChanged;
    console.log("[reverb]", trackId, {
      wet: +wet.toFixed(3), size: +size.toFixed(3), release: +release.toFixed(3),
      rebuiltIR: willRebuild,
    });
    if (willRebuild) {
      chain._lastReverbSize = size;
      chain._lastReverbRel  = release;
      try {
        // Recreate the convolver entirely. Mutating .buffer on a live node
        // is spec-allowed but flaky in some browsers (Safari especially can
        // keep convolving the old IR). Splicing in a new node guarantees
        // the new IR takes effect on the very next audio quantum.
        const newReverb = ctx.createConvolver();
        newReverb.normalize = true;
        newReverb.buffer = makeReverbIR(ctx, size, release);
        try { chain._reverbInput.disconnect(chain.reverb); } catch {}
        try { chain.reverb.disconnect(); } catch {}
        chain._reverbInput.connect(newReverb);
        newReverb.connect(chain.reverbWet);
        chain.reverb = newReverb;
      } catch (err) { console.warn("[reverb] IR rebuild failed", err); }
    }
  }

  function trackInputNode(trackId) {
    return ensureTrackChain(trackId).input;
  }

  return {
    play, playSync, stopAll, stopTrack, stopPad, isPadPlaying,
    loadSample, getPeaks, getBandPeaks, hasBuffer, getBufferDuration, evict, progressFor,
    nowCtx, hasCtx, outputLatency, warmUp,
    setEffectParam, setReverbParams, setPumpParams, updateBpm, ensureTrackChain, trackInputNode,
  };
})();

// ───────── Global transport ─────────
// Song starts when the first sample is launched and runs continuously,
// looping every TIMELINE_BEATS at the song's BPM.
const Transport = {
  songStartTime: null,
  start(when) { if (this.songStartTime === null) this.songStartTime = when; },
  stop() { this.songStartTime = null; },
  isRunning() { return this.songStartTime !== null; },
  // Visual position — what's audible right now (compensates for outputLatency).
  positionAt(t) {
    if (this.songStartTime === null) return 0;
    const dur = timelineDuration();
    if (dur <= 0) return 0;
    const elapsed = Math.max(0, t - Audio.outputLatency() - this.songStartTime);
    return (elapsed % dur) / dur;
  },
  // Raw scheduling position — where the playhead WILL be when audio at scheduling
  // time `t` is actually audible. Used for sample start markers so the green bar
  // lands where the playhead arrives the instant the audio starts.
  positionRaw(t) {
    if (this.songStartTime === null) return 0;
    const dur = timelineDuration();
    if (dur <= 0) return 0;
    const elapsed = Math.max(0, t - this.songStartTime);
    return (elapsed % dur) / dur;
  },
};
function timelineDuration() {
  // Shared-mode bar = song.timelineBeats (8 or 16) at the song's BPM.
  const bpm = (editor && editor.song && editor.song.bpm) || DEFAULT_BPM;
  const beats = (editor && editor.song)
    ? songTimelineBeats(editor.song)
    : TIMELINE_BEATS;
  return (60 / bpm) * beats;
}

// ───────── Router ─────────
function route() {
  const h = location.hash || "#/";
  if (h.startsWith("#/song/")) return { name: "song",     id: h.slice("#/song/".length) };
  if (h.startsWith("#/edit/")) return { name: "songEdit", id: h.slice("#/edit/".length) };
  if (h === "#/edit") return { name: "editList" };
  if (h === "#/new")  return { name: "new" };
  return { name: "home" };
}
window.addEventListener("hashchange", () => { teardownEditor(); render(); });

// ───────── DOM helper ─────────
const $app = document.getElementById("app");
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k === "style") e.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return e;
}

// ───────── Render dispatch ─────────
function render() {
  const r = route();
  if (r.name === "home")     return renderHome();
  if (r.name === "editList") return renderEditList();
  if (r.name === "new")      return createSongFlow();
  if (r.name === "song" || r.name === "songEdit") {
    const song = loadSongs().find(s => s.id === r.id);
    if (!song) { location.hash = "#/"; return; }
    return renderEditor(song, r.name === "songEdit" ? "edit" : "performance");
  }
}

// ───────── Home: square song tiles ─────────
function renderHome() {
  const songs = loadSongs().sort((a, b) => b.updatedAt - a.updatedAt);
  const grid = el("div", { class: "tile-grid" });

  grid.appendChild(
    el("div", { class: "tile new", onclick: () => (location.hash = "#/new") },
      el("div", { class: "plus" }, "+"),
      el("div", { class: "lbl" }, "new song")
    )
  );

  if (songs.length === 0) {
    grid.appendChild(
      el("div", { class: "empty-state" },
        el("strong", {}, "no songs yet"),
        "tap “+ new song” to load samples onto the pads"
      )
    );
  }

  for (const s of songs) grid.appendChild(songTile(s));

  $app.replaceChildren(
    el("section", { class: "home" },
      el("header", { class: "home-head" },
        el("div", { class: "brand" }, "beat ", el("span", {}, "studio")),
        el("a", { class: "btn", href: "#/edit" }, "song editing →"),
      ),
      el("h1", { class: "home-title" }, "your songs"),
      grid
    )
  );
}

// Edit list — same square-tile grid, but tapping a tile enters edit mode
// (#/edit/:id) and the "+ new song" tile also lands you in edit mode for the
// fresh song. From edit you set pad modes, BPM, etc. before performing.
function renderEditList() {
  const songs = loadSongs().sort((a, b) => b.updatedAt - a.updatedAt);
  const grid = el("div", { class: "tile-grid" });

  grid.appendChild(
    el("div", { class: "tile new", onclick: () => (location.hash = "#/new") },
      el("div", { class: "plus" }, "+"),
      el("div", { class: "lbl" }, "new song")
    )
  );

  if (songs.length === 0) {
    grid.appendChild(
      el("div", { class: "empty-state" },
        el("strong", {}, "no songs yet"),
        "create a song to start editing"
      )
    );
  }

  for (const s of songs) grid.appendChild(songTile(s, "edit"));

  $app.replaceChildren(
    el("section", { class: "home" },
      el("header", { class: "home-head" },
        el("a", { class: "back-link", href: "#/" }, "← home"),
        el("div", { class: "brand" }, "song ", el("span", {}, "editing")),
      ),
      el("h1", { class: "home-title" }, "edit a song"),
      grid
    )
  );
}

// `target` controls where tapping the tile goes:
//   "perform" → #/song/:id (default, from home)
//   "edit"    → #/edit/:id (from the edit list)
function songTile(song, target = "perform") {
  const targetHash = target === "edit" ? `#/edit/${song.id}` : `#/song/${song.id}`;
  const loaded = Object.values(song.pads).flat().filter(Boolean).length;
  const strip = el("div", { class: "tile-row-strip" });
  for (const t of TRACKS) {
    const filled = song.pads[t.id]?.some(Boolean);
    strip.appendChild(el("span", { style: `background: ${filled ? `var(--row-${t.id})` : "var(--line)"}` }));
  }
  return el("div", {
    class: "tile",
    onclick: () => (location.hash = targetHash)
  },
    strip,
    el("div", { class: "tile-name" }, song.name),
    el("div", { class: "tile-meta" },
      `${loaded}/${TRACKS.length * PADS_PER_TRACK} pads · `,
      timeago(song.updatedAt)
    ),
    el("div", { class: "tile-actions" },
      el("button", {
        onclick: (e) => { e.stopPropagation(); renameSong(song.id); }
      }, "rename"),
      el("button", {
        onclick: (e) => { e.stopPropagation(); confirmDeleteSong(song.id); }
      }, "delete"),
    )
  );
}

function timeago(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function createSongFlow() {
  promptModal({
    title: "new song",
    placeholder: "song name",
    initial: `song ${loadSongs().length + 1}`,
    okLabel: "create",
    onSubmit: (name) => {
      const songs = loadSongs();
      const s = newSong((name || "").trim() || `song ${songs.length + 1}`);
      songs.push(s);
      saveSongs(songs);
      // New songs land in edit mode — that's where you set up samples and BPM.
      location.hash = `#/edit/${s.id}`;
    },
    onCancel: () => (location.hash = "#/"),
  });
}

function renameSong(id) {
  const songs = loadSongs();
  const s = songs.find(x => x.id === id);
  if (!s) return;
  promptModal({
    title: "rename song",
    initial: s.name,
    okLabel: "save",
    onSubmit: (v) => {
      s.name = (v || "").trim() || s.name;
      s.updatedAt = Date.now();
      saveSongs(songs);
      render();
    }
  });
}

function confirmDeleteSong(id) {
  const songs = loadSongs();
  const s = songs.find(x => x.id === id);
  if (!s) return;
  confirmModal({
    title: `delete "${s.name}"?`,
    body: "this cannot be undone. samples will be removed.",
    okLabel: "delete",
    danger: true,
    onConfirm: async () => {
      for (const arr of Object.values(s.pads)) {
        for (const p of arr) if (p) { await deleteSample(p.sampleId); Audio.evict(p.sampleId); }
      }
      saveSongs(songs.filter(x => x.id !== id));
      render();
    }
  });
}

// ───────── Editor ─────────
let editor = null;
// Kick off decoding + peak computation for every sample on the song. Fire-and-forget;
// the inflight cache dedupes if a pad tap arrives mid-preload.
function preloadSongSamples(song) {
  const tasks = [];
  for (const trackId of Object.keys(song.pads || {})) {
    for (const pad of song.pads[trackId] || []) {
      if (pad?.sampleId) {
        tasks.push(Audio.getPeaks(pad.sampleId).catch(() => null));
      }
    }
  }
  return Promise.all(tasks);
}

function teardownEditor() {
  if (!editor) return;
  if (editor.raf) cancelAnimationFrame(editor.raf);
  Audio.stopAll();
  Transport.stop();
  window.removeEventListener("resize", onResize);
  editor = null;
}

function renderEditor(song, mode = "performance") {
  teardownEditor();
  editor = {
    song,
    mode,                    // "performance" | "edit"
    dirty: false,
    raf: null,
    playing: {},
    decks: {},
    pendingApplies: {},
    areaTab: {},             // trackId -> "samples" | "effects" (per-area UI tab)
    areaEffectFocus: {},     // trackId -> effect name (e.g. "reverb") when zoomed into params
    // Waveform view style. "track" = row-color amplitude waveform (default).
    // "freq" = frequency-content coloring + light row-color background tint.
    // Persists across sessions in localStorage.
    viewMode: localStorage.getItem("beatstudio.viewMode") === "freq" ? "freq" : "track",
  };
  for (const t of TRACKS) {
    editor.playing[t.id] = {};
    editor.areaTab[t.id] = "samples";
    editor.areaEffectFocus[t.id] = null;
  }

  Audio.nowCtx();
  preloadSongSamples(song);
  // Push the song's effect knob values into the per-track audio chains so
  // playback is filtered/wet/etc. according to the saved settings.
  applySongEffectsToAudio(song);
  Audio.updateBpm(song.bpm || DEFAULT_BPM);

  const isEdit = mode === "edit";
  const backHref = isEdit ? "#/edit" : "#/";

  const head = el("header", { class: "editor-head" + (isEdit ? " edit-mode" : "") },
    el("div", { class: "head-left" },
      el("a", { class: "back-link", href: backHref }, isEdit ? "← edit list" : "← songs"),
      el("span", { class: "mode-badge " + mode }, isEdit ? "editing" : "performing"),
    ),
    el("div", { class: "editor-title" },
      isEdit
        ? el("input", {
            value: song.name,
            oninput: (e) => { song.name = e.target.value; markDirty(); },
            onblur:  () => persist({ silent: true }),
          })
        : el("span", { class: "title-static" }, song.name)
    ),
    el("div", { class: "head-right" },
      // BPM control is edit-mode only. In performance mode the BPM is set
      // and forgotten — no need to show it on the live header.
      isEdit ? renderBpmSelector(song) : null,
      el("div", { class: "group" },
        el("span", { class: "label" }, "quant"),
        el("button", {
          "data-quant": "off",
          class: song.quantize === "off" ? "active" : "",
          onclick: () => setQuantize("off")
        }, "off"),
        el("button", {
          "data-quant": "1/2",
          class: song.quantize === "1/2" ? "active" : "",
          onclick: () => setQuantize("1/2")
        }, "1/2"),
        el("button", {
          "data-quant": "1/4",
          class: song.quantize === "1/4" ? "active" : "",
          onclick: () => setQuantize("1/4")
        }, "1/4"),
      ),
      el("div", { class: "group", title: "shared: one fixed-length bar (8 or 16 beats) for all rows. free: each row's bar is sized to its own samples." },
        el("span", { class: "label" }, "timeline"),
        el("button", {
          "data-tlmode": "shared",
          class: isTimelineShared(song) ? "active" : "",
          onclick: () => setTimelineMode("shared"),
        }, "shared"),
        el("button", {
          "data-tlmode": "free",
          class: !isTimelineShared(song) ? "active" : "",
          onclick: () => setTimelineMode("free"),
        }, "free"),
      ),
      isTimelineShared(song)
        ? el("div", { class: "group", title: "Length of the shared bar in beats (= 2 bars at 8, = 4 bars at 16)." },
            el("span", { class: "label" }, "bar"),
            el("button", {
              "data-bars": "8",
              class: songTimelineBeats(song) === 8 ? "active" : "",
              onclick: () => setTimelineBeats(8),
            }, "8"),
            el("button", {
              "data-bars": "16",
              class: songTimelineBeats(song) === 16 ? "active" : "",
              onclick: () => setTimelineBeats(16),
            }, "16"),
          )
        : null,
      el("div", { class: "group", title: "Waveform color: row color, or by frequency content (bass=red, mid=yellow, high=cyan) with row-color background." },
        el("span", { class: "label" }, "view"),
        el("button", {
          "data-view": "track",
          class: editor.viewMode === "track" ? "active" : "",
          onclick: () => setViewMode("track"),
        }, "track"),
        el("button", {
          "data-view": "freq",
          class: editor.viewMode === "freq" ? "active" : "",
          onclick: () => setViewMode("freq"),
        }, "freq"),
      ),
      // Cross-link to the other mode.
      isEdit
        ? el("a", { class: "btn", href: `#/song/${song.id}`, title: "switch to performance" }, "▶ perform")
        : el("a", { class: "btn", href: `#/edit/${song.id}`, title: "switch to edit"        }, "✎ edit"),
      // Stop-all is only useful when audio plays.
      isEdit ? null
             : el("button", { class: "btn ghost", onclick: () => stopAllAndReset() }, "■ stop all"),
    )
  );

  const left = el("div", { class: "side-stack" },
    TRACKS.filter(t => t.side === "left").map(t => renderArea(song, t))
  );
  const right = el("div", { class: "side-stack" },
    TRACKS.filter(t => t.side === "right").map(t => renderArea(song, t))
  );

  const deck = renderDeck(song);

  const body = el("div", { class: "editor-body" }, left, deck, right);

  $app.replaceChildren(el("section",
    { class: "editor" + (editor.viewMode === "freq" ? " freq-view" : "") },
    head, body));

  // initial canvas sizing + start playhead loop
  requestAnimationFrame(() => {
    for (const t of TRACKS) sizeDeckCanvas(t.id);
    fitAllPadNames();
    editor.raf = requestAnimationFrame(tickPlayheads);
  });
  window.addEventListener("resize", onResize);
}

function onResize() {
  if (!editor) return;
  for (const t of TRACKS) sizeDeckCanvas(t.id);
  fitAllPadNames();
}

// Auto-size every .pad-name on screen so the full sample name fits inside
// its pad — growing the font when there's room, shrinking and wrapping onto
// 2-3 lines for long names. Cheap binary search per pad against the actual
// rendered geometry, deferred to the next frame so layout has settled.
function fitAllPadNames() {
  requestAnimationFrame(() => {
    for (const span of document.querySelectorAll(".pad-name")) {
      fitPadName(span);
    }
  });
}

function fitPadName(span) {
  const pad = span.parentElement;
  if (!pad) return;
  const cs = getComputedStyle(pad);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const availW = pad.clientWidth - padL - padR;
  const availH = pad.clientHeight - padT - padB;
  if (availW <= 4 || availH <= 4) return;
  // Lock width so wrapping decisions match the available space.
  span.style.maxWidth = availW + "px";

  const MIN_FS = 8, MAX_FS = 28;
  // Probe a given font-size: returns whether it fits and how many lines it
  // produced. Line count = scrollHeight / computed line-height.
  const probe = (fs) => {
    span.style.fontSize = fs + "px";
    const lh = parseFloat(getComputedStyle(span).lineHeight) || fs * 1.1;
    const sh = span.scrollHeight;
    const sw = span.scrollWidth;
    const lineCount = Math.max(1, Math.round(sh / lh));
    const fits = sw <= availW + 1 && sh <= availH + 1;
    return { fits, lineCount };
  };

  // Step 1 — find the largest font that fits at all (max-fit baseline).
  let lo = MIN_FS, hi = MAX_FS, maxFit = MIN_FS;
  while (lo <= hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (probe(mid).fits) { maxFit = mid; lo = mid + 1; }
    else                 { hi = mid - 1; }
  }

  // Step 2 — prefer fewer lines. Find the minimum line count achievable
  // among sizes that still fit. Line count is non-increasing as font size
  // decreases, so the smallest size gives the lower bound.
  const minLines = probe(MIN_FS).lineCount;

  // Step 3 — pick the LARGEST size that fits AND lands on minLines, so a
  // name that almost-but-not-quite fits one line shrinks just enough to
  // pull the trailing letters back up.
  lo = MIN_FS; hi = maxFit;
  let best = MIN_FS;
  while (lo <= hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const { fits, lineCount } = probe(mid);
    if (fits && lineCount === minLines) { best = mid; lo = mid + 1; }
    else                                 { hi = mid - 1; }
  }
  span.style.fontSize = best + "px";
}

// Update the quantize setting in place — used by the on / off / 1/2 / 1/4 group.
// Doesn't stop or restart the song; quantize only affects the *next* trigger.
function setQuantize(value) {
  if (!editor) return;
  const song = editor.song;
  if (song.quantize === value) return;
  song.quantize = value;
  markDirty();
  refreshTransport();
  persist({ silent: true });
}

// View-mode toggle. Switches the waveform rendering between row-color and
// frequency-colored. Persisted globally (not per song) since it's a viewing
// preference. Updates the `.freq-view` class on the editor and redraws all
// waveforms so the change is immediate.
function setViewMode(mode) {
  if (!editor) return;
  mode = (mode === "freq") ? "freq" : "track";
  if (editor.viewMode === mode) return;
  editor.viewMode = mode;
  try { localStorage.setItem("beatstudio.viewMode", mode); } catch {}
  const editorEl = document.querySelector(".editor");
  if (editorEl) editorEl.classList.toggle("freq-view", mode === "freq");
  document.querySelectorAll(".editor-head [data-view]").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === mode);
  });
  for (const t of TRACKS) drawWaveform(t.id);
}

function setTimelineBeats(beats) {
  if (!editor) return;
  const song = editor.song;
  if (songTimelineBeats(song) === beats) return;
  song.timelineBeats = beats;
  markDirty();
  // Bar period changes — reroll active voices so padded loops match.
  rerollActiveVoicesForNewTimeline();
  // Rebuild the deck so the beat grid gets the new count.
  const body = $app.querySelector(".editor-body");
  const oldDeck = body && body.querySelector(".deck");
  if (body && oldDeck) {
    const newDeck = renderDeck(editor.song);
    body.replaceChild(newDeck, oldDeck);
    requestAnimationFrame(() => {
      for (const t of TRACKS) sizeDeckCanvas(t.id);
    });
  }
  for (const t of TRACKS) {
    drawWaveform(t.id);
    updateRowMarkers(t.id);
  }
  refreshTransport();
  persist({ silent: true });
}

function setTimelineMode(mode) {
  if (!editor) return;
  const song = editor.song;
  if (timelineMode(song) === mode) return;
  song.timelineMode = mode;
  markDirty();

  if (mode === "free") {
    Transport.stop();
  } else if (mode === "shared") {
    if (!Transport.isRunning() && Object.values(editor.playing).some(v => Object.keys(v).length > 0)) {
      Transport.start(Audio.nowCtx().currentTime);
    }
  }

  // Audio loop config changes between modes — reroll every playing voice.
  rerollActiveVoicesForNewTimeline();

  // Rebuild the deck so the beat marker grid is physically added (shared) or
  // removed (free). Audio sources and editor.playing state are untouched.
  const body = $app.querySelector(".editor-body");
  const oldDeck = body && body.querySelector(".deck");
  if (body && oldDeck) {
    const newDeck = renderDeck(editor.song);
    body.replaceChild(newDeck, oldDeck);
    requestAnimationFrame(() => {
      for (const t of TRACKS) sizeDeckCanvas(t.id);
    });
  }


  // Visuals: redraw waveforms (width changes) and markers (hidden in free).
  for (const t of TRACKS) {
    drawWaveform(t.id);
    updateRowMarkers(t.id);
  }
  refreshTransport();
  persist({ silent: true });
}

// Just update the active state on the transport buttons (quant, fit). Does NOT
// re-render or stop audio — playing voices keep going as the setting changes.
function refreshTransport() {
  if (!editor) return;
  const song = editor.song;
  document.querySelectorAll(".editor-head [data-quant]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.quant === song.quantize);
  });
  document.querySelectorAll(".editor-head [data-tlmode]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tlmode === timelineMode(song));
  });
  document.querySelectorAll(".editor-head [data-bars]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.bars === String(songTimelineBeats(song)));
  });
}

// ───── BPM selector ─────
// Performance mode shows BPM as a static label (no -/+, no tap, no input).
function renderBpmDisplay(song) {
  return el("div", { class: "bpm bpm-readonly" },
    el("span", { class: "label" }, "BPM"),
    el("span", { class: "bpm-static" }, String(song.bpm || DEFAULT_BPM)),
  );
}

function renderBpmSelector(song) {
  const MIN = 40, MAX = 240;
  let tapTimes = [];
  let autosaveTimer = null;

  const input = el("input", {
    type: "number", min: MIN, max: MAX, value: song.bpm,
    onkeydown: (e) => {
      if (e.key === "ArrowUp")   { e.preventDefault(); setBpm(currentBpm() + 1); }
      if (e.key === "ArrowDown") { e.preventDefault(); setBpm(currentBpm() - 1); }
    },
    oninput:  (e) => setBpm(parseInt(e.target.value, 10), { skipInputUpdate: true }),
    onchange: (e) => setBpm(parseInt(e.target.value, 10)),
    onblur:   (e) => setBpm(parseInt(e.target.value, 10)),
  });
  const tapBtn = el("button", { class: "tap", title: "tap to set tempo" }, "tap");
  tapBtn.addEventListener("click", onTap);

  function currentBpm() {
    const v = parseInt(input.value, 10);
    return Number.isFinite(v) ? v : song.bpm || DEFAULT_BPM;
  }

  function setBpm(v, opts = {}) {
    v = Math.max(MIN, Math.min(MAX, Number.isFinite(v) ? v : DEFAULT_BPM));
    if (song.bpm === v && !opts.force) {
      if (!opts.skipInputUpdate) input.value = v;
      return;
    }
    song.bpm = v;
    if (!opts.skipInputUpdate) input.value = v;
    markDirty();
    // Re-sync time-based effect params (delay tap = 1/4 note, vibrato LFO).
    Audio.updateBpm(v);
    // BPM changes the timeline duration, which is the loop period of every
    // currently-playing voice. Stop and retrigger active voices so they're
    // resampled at the new timeline length and stay in sync with the playhead.
    rerollActiveVoicesForNewTimeline();
    // Sample widths and bar positions depend on BPM — redraw active rows.
    for (const t of TRACKS) {
      if (editor.playing[t.id]) {
        drawWaveform(t.id);
        updateRowMarkers(t.id);
      }
    }
    // Auto-persist BPM (debounced) so it's saved without hitting the Save button.
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => persist({ silent: true }), 400);
  }

  function onTap() {
    const now = performance.now();
    // reset stale taps after a long gap (>2s) — start a new sequence
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
    tapTimes.push(now);
    if (tapTimes.length > 8) tapTimes.shift();
    tapBtn.classList.add("flash");
    setTimeout(() => tapBtn.classList.remove("flash"), 90);
    if (tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avg);
      setBpm(bpm);
    }
  }

  return el("div", { class: "bpm" },
    el("span", { class: "label" }, "BPM"),
    el("button", { onclick: () => setBpm(currentBpm() - 1), title: "decrease BPM" }, "−"),
    input,
    el("button", { onclick: () => setBpm(currentBpm() + 1), title: "increase BPM" }, "+"),
    tapBtn,
  );
}

function renderArea(song, track) {
  const tab = (editor?.areaTab?.[track.id]) || "samples";
  const effectFocus = editor?.areaEffectFocus?.[track.id] || null;

  // When zoomed into an effect's parameters, the head is just a "back"
  // button + the effect name — no tabs (tab switching exits the zoom).
  let head;
  if (tab === "effects" && effectFocus) {
    head = el("div", { class: "area-head effect-zoom-head" },
      el("button", {
        class: "effect-back-btn",
        onclick: () => closeEffectFocus(track),
        title: "back to effects",
      }, "← back"),
      el("span", { class: "area-name" }, effectFocus),
    );
  } else {
    head = el("div", { class: "area-head" },
      el("span", { class: "area-name" }, track.label),
      el("div", { class: "area-tabs" },
        el("button", {
          class: "area-tab" + (tab === "samples" ? " active" : ""),
          onclick: () => switchAreaTab(track, "samples"),
        }, "samples"),
        el("button", {
          class: "area-tab" + (tab === "effects" ? " active" : ""),
          onclick: () => switchAreaTab(track, "effects"),
        }, "effects"),
      ),
    );
  }

  let body;
  if (tab === "effects" && effectFocus) {
    body = renderEffectParams(song, track, effectFocus);
  } else if (tab === "effects") {
    body = renderEffectsPanel(song, track);
  } else {
    body = el("div", { class: "area-pads" },
      Array.from({ length: PADS_PER_TRACK }, (_, i) => renderPad(song, track, i))
    );
  }
  return el("section", { class: "area", style: `--row-color: ${track.color}` }, head, body);
}

function switchAreaTab(track, tab) {
  if (!editor) return;
  editor.areaTab[track.id] = tab;
  editor.areaEffectFocus[track.id] = null; // leaving the tab clears any zoom
  rerenderArea(track);
}

function closeEffectFocus(track) {
  if (!editor) return;
  editor.areaEffectFocus[track.id] = null;
  rerenderArea(track);
}

// Apply every effect value from the song to its per-track audio chain so
// playback honors the saved settings. Called on editor mount and whenever a
// knob value changes (per-knob path is used for that — this one is bulk).
function applySongEffectsToAudio(song) {
  for (const t of TRACKS) {
    const keys = trackEffectKeys(t.id);
    for (const k of keys) applyEffectToAudio(song, t.id, k);
  }
}

// Resolve the main knob value through each sub-parameter's automation
// endpoints and push the result into the Audio module. Effects with multiple
// sub-parameters (currently just reverb) get a dedicated path; everything
// else falls through to the simple single-knob mapping in Audio.
function applyEffectToAudio(song, trackId, name) {
  const knob = getEffect(song, trackId, name);
  if (name === "reverb") {
    const wet     = paramValueAt(song, trackId, "reverb", "wet",     knob);
    const size    = paramValueAt(song, trackId, "reverb", "size",    knob);
    const release = paramValueAt(song, trackId, "reverb", "release", knob);
    Audio.setReverbParams(trackId, wet, size, release);
    return;
  }
  if (name === "pump") {
    const comp      = paramValueAt(song, trackId, "pump", "compression", knob);
    const vol       = paramValueAt(song, trackId, "pump", "volume",      knob);
    const rate      = paramValueAt(song, trackId, "pump", "rate",        knob);
    const intensity = paramValueAt(song, trackId, "pump", "intensity",   knob);
    Audio.setPumpParams(trackId, comp, vol, rate, intensity);
    return;
  }
  Audio.setEffectParam(trackId, name, knob);
}

// ───── Effects panel + knob ─────
// Per-track effects panel: one row of knobs (reverb, echo, delay, drive,
// vibrato, filter, compressor [+ robot for vocals]). Each knob is a vertical
// pointer-drag dial that writes to song.effects[trackId][name] and pushes the
// value into Audio.setEffectParam live, so currently-playing voices respond
// immediately.
function renderEffectsPanel(song, track) {
  const keys = trackEffectKeys(track.id);
  const knobs = keys.map((name) => knob({
    label: name,
    value: getEffect(song, track.id, name),
    onChange: (v) => {
      setEffect(song, track.id, name, v);
      applyEffectToAudio(song, track.id, name);
      drawWaveform(track.id);
      markDirty();
      schedulePersist();
    },
    // Double-click → open the per-effect parameter editor (in-place inside
    // this area). Only effects with a parameter schema are editable; others
    // fall back to resetting the main knob.
    onDblClick: () => {
      if (getEffectParamsDef(name)) {
        editor.areaEffectFocus[track.id] = name;
        rerenderArea(track);
      } else {
        const def = EFFECT_DEFAULTS[name];
        setEffect(song, track.id, name, def);
        applyEffectToAudio(song, track.id, name);
        drawWaveform(track.id);
        markDirty();
        schedulePersist();
        rerenderArea(track);
      }
    },
  }));
  return el("div", { class: "area-effects" }, ...knobs);
}

// One knob. Drag vertically to change. Double-click to reset.
//   opts.label    — caption shown beneath the dial
//   opts.value    — initial 0..1
//   opts.onChange — fired as the knob is dragged
//   opts.onReset  — fired on double-click; returns the value to display
function knob(opts) {
  let value = Math.max(0, Math.min(1, opts.value ?? 0));
  const indicator = el("div", { class: "knob-indicator" });
  const dial = el("div", { class: "knob-dial" }, indicator);
  const valueLabel = el("div", { class: "knob-value" });
  const labelEl = el("div", { class: "knob-label" }, opts.label);
  function setRotation(v) {
    // -135deg at v=0, +135deg at v=1. translateX(-50%) keeps the indicator
    // horizontally centered on its left:50% anchor (see .knob-indicator CSS).
    const deg = -135 + v * 270;
    indicator.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  }
  function refresh() {
    setRotation(value);
    valueLabel.textContent = Math.round(value * 100);
  }
  refresh();
  let dragStartY = 0, dragStartV = 0;
  const onMove = (e) => {
    const dy = dragStartY - e.clientY;
    value = Math.max(0, Math.min(1, dragStartV + dy / 120));
    refresh();
    opts.onChange?.(value);
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    dial.classList.remove("dragging");
  };
  dial.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    dragStartY = e.clientY;
    dragStartV = value;
    dial.classList.add("dragging");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
  dial.addEventListener("dblclick", (e) => {
    e.preventDefault();
    // Caller decides what double-click does — opening a per-effect parameter
    // editor takes priority; falling back to reset for effects without one.
    if (typeof opts.onDblClick === "function") {
      opts.onDblClick();
      return;
    }
    const reset = opts.onReset?.();
    if (Number.isFinite(reset)) {
      value = Math.max(0, Math.min(1, reset));
      refresh();
    }
  });
  return el("div", { class: "knob" }, dial, labelEl, valueLabel);
}

// Persist song with a short debounce so rapid knob drags don't thrash
// localStorage. Marks the song dirty too. Used by the effects panel and any
// other rapid-update controls.
let _schedulePersistTimer = null;
function schedulePersist() {
  clearTimeout(_schedulePersistTimer);
  _schedulePersistTimer = setTimeout(() => persist({ silent: true }), 400);
}

// ───── Per-effect parameter editor (zoom view) ─────
// Renders one row per sub-parameter. Each row has a horizontal track showing
// the parameter's range, with two draggable handles: the LEFT handle is the
// value at main-knob 0, the RIGHT handle is the value at main-knob 1. The
// segment between them visualizes the automation curve.
function renderEffectParams(song, track, effect) {
  const defs = getEffectParamsDef(effect);
  if (!defs) return el("div", { class: "effect-params empty" }, "no parameters");

  // Live preview of the main knob value (what the user is actually hearing).
  // Adjusting it slides the "now playing" marker on every parameter bar and
  // pushes the resolved values into the audio chain — so the user can hear
  // the automation curve being swept in real time.
  const rows = [];
  const knobPreviewWrap = el("div", { class: "effect-mainknob-preview" });
  const mainKnobNode = knob({
    label: `${effect} (live)`,
    value: getEffect(song, track.id, effect),
    onChange: (v) => {
      setEffect(song, track.id, effect, v);
      applyEffectToAudio(song, track.id, effect);
      drawWaveform(track.id);
      markDirty();
      schedulePersist();
      // Update each parameter row's "current value" marker.
      for (const r of rows) r.refreshCurrent?.();
    },
  });
  knobPreviewWrap.appendChild(mainKnobNode);

  const paramRows = defs.map(def => paramRow(song, track, effect, def));
  rows.push(...paramRows);
  return el("div", { class: "effect-params" },
    knobPreviewWrap,
    ...paramRows.map(r => r.node),
  );
}

function paramRow(song, track, effect, def) {
  // Choice params (discrete toggles like pump.rate's 1/2 vs 1 beat) render
  // as buttons instead of a draggable bar.
  if (def.type === "choice") return paramRowChoice(song, track, effect, def);
  // Fader params (single-value sliders, not automation ranges) render as a
  // bar with one handle — see paramRowFader.
  if (def.type === "fader") return paramRowFader(song, track, effect, def);
  const range = getParamRange(song, track.id, effect, def.key);
  const track_el = el("div", { class: "param-track" });
  const lowHandle  = el("div", { class: "param-handle low",  title: "drag — automation endpoint" });
  const highHandle = el("div", { class: "param-handle high", title: "drag — automation endpoint" });
  const line       = el("div", { class: "param-line" });
  const currentDot = el("div", { class: "param-current-dot", title: "current value" });
  const lowLabel   = el("span", { class: "param-endpoint-value low"  });
  const highLabel  = el("span", { class: "param-endpoint-value high" });

  const minV = def.min, maxV = def.max;
  const valueToFrac = (v) => (v - minV) / (maxV - minV);
  const fmt = (v) => v.toFixed(2);
  function refresh() {
    const lf = Math.max(0, Math.min(1, valueToFrac(range.low)));
    const hf = Math.max(0, Math.min(1, valueToFrac(range.high)));
    const lo = Math.min(lf, hf), hi = Math.max(lf, hf);
    lowHandle.style.left  = `${lf * 100}%`;
    highHandle.style.left = `${hf * 100}%`;
    line.style.left  = `${lo * 100}%`;
    line.style.right = `${(1 - hi) * 100}%`;
    lowLabel.textContent  = fmt(range.low);
    highLabel.textContent = fmt(range.high);
    refreshCurrent();
  }
  function refreshCurrent() {
    // Position the "current value" marker. The sweep ALWAYS goes from the
    // leftmost handle (smallest endpoint) to the rightmost (largest), so as
    // the main knob turns up, the dot moves left → right on the bar.
    const knobVal = getEffect(song, track.id, effect);
    const lo = Math.min(range.low, range.high);
    const hi = Math.max(range.low, range.high);
    const v = lo + (hi - lo) * knobVal;
    const f = Math.max(0, Math.min(1, valueToFrac(v)));
    currentDot.style.left = `${f * 100}%`;
  }
  refresh();

  function attachDrag(handle, side) {
    let dragRect = null;
    const onMove = (e) => {
      if (!dragRect) return;
      const frac = Math.max(0, Math.min(1, (e.clientX - dragRect.left) / dragRect.width));
      const v = minV + frac * (maxV - minV);
      setParamSide(song, track.id, effect, def.key, side, v);
      refresh();
      // Push through to audio immediately so adjustments are heard live on
      // top of the currently-playing voices.
      applyEffectToAudio(song, track.id, effect);
      drawWaveform(track.id);
      markDirty();
      schedulePersist();
    };
    const onUp = () => {
      dragRect = null;
      handle.classList.remove("dragging");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragRect = track_el.getBoundingClientRect();
      handle.classList.add("dragging");
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    });
    // Double-click handle → snap to default for this side.
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const d = side === "low" ? def.defaultLow : def.defaultHigh;
      setParamSide(song, track.id, effect, def.key, side, d);
      refresh();
      applyEffectToAudio(song, track.id, effect);
      drawWaveform(track.id);
      markDirty();
      schedulePersist();
    });
  }
  attachDrag(lowHandle,  "low");
  attachDrag(highHandle, "high");

  track_el.appendChild(line);
  track_el.appendChild(currentDot);
  track_el.appendChild(lowHandle);
  track_el.appendChild(highHandle);

  const node = el("div", { class: "effect-param-row" },
    el("div", { class: "param-row-head" },
      el("span", { class: "param-label" }, def.label),
      el("span", { class: "param-range" }, `${fmt(minV)} → ${fmt(maxV)}`),
    ),
    el("div", { class: "param-bar-wrap" },
      lowLabel,
      track_el,
      highLabel,
    ),
  );
  return { node, refreshCurrent };
}

// Single-value fader: one draggable handle, no automation. The handle's
// position on the bar IS the parameter's value — main knob doesn't sweep it.
function paramRowFader(song, track, effect, def) {
  const range = getParamRange(song, track.id, effect, def.key);
  const track_el = el("div", { class: "param-track fader-track" });
  const fill   = el("div", { class: "param-fader-fill" });
  const handle = el("div", { class: "param-handle fader", title: def.label });
  const valueLabel = el("span", { class: "param-endpoint-value high" });

  const minV = def.min, maxV = def.max;
  const valueToFrac = (v) => (v - minV) / (maxV - minV);
  const fmt = (v) => v.toFixed(2);
  function refresh() {
    const f = Math.max(0, Math.min(1, valueToFrac(range.value)));
    handle.style.left = `${f * 100}%`;
    fill.style.right  = `${(1 - f) * 100}%`;
    valueLabel.textContent = fmt(range.value);
  }
  refresh();

  let dragRect = null;
  const onMove = (e) => {
    if (!dragRect) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - dragRect.left) / dragRect.width));
    range.value = minV + frac * (maxV - minV);
    refresh();
    applyEffectToAudio(song, track.id, effect);
    markDirty();
    schedulePersist();
  };
  const onUp = () => {
    dragRect = null;
    handle.classList.remove("dragging");
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
  };
  function startDrag(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRect = track_el.getBoundingClientRect();
    handle.classList.add("dragging");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    // Also jump to click position immediately.
    onMove(e);
  }
  handle.addEventListener("pointerdown", startDrag);
  track_el.addEventListener("pointerdown", startDrag);

  track_el.appendChild(fill);
  track_el.appendChild(handle);

  const node = el("div", { class: "effect-param-row" },
    el("div", { class: "param-row-head" },
      el("span", { class: "param-label" }, def.label),
      el("span", { class: "param-range" }, `${fmt(minV)} → ${fmt(maxV)}`),
    ),
    el("div", { class: "param-bar-wrap" },
      el("span", { class: "param-endpoint-value low" }),
      track_el,
      valueLabel,
    ),
  );
  // No "current value" marker — the handle itself is the value.
  return { node, refreshCurrent: () => {} };
}

// Choice-style parameter row: discrete buttons instead of a draggable bar.
// Each click writes the choice's numeric value into the slot and pushes the
// effect state into audio so the change is heard immediately.
function paramRowChoice(song, track, effect, def) {
  const range = getParamRange(song, track.id, effect, def.key);
  const buttons = [];
  function refresh() {
    for (const b of buttons) {
      const v = parseFloat(b.dataset.value);
      b.classList.toggle("active", Math.abs(v - range.value) < 1e-6);
    }
  }
  for (const choice of def.choices) {
    const btn = el("button", {
      class: "param-choice-btn",
      onclick: () => {
        range.value = choice.value;
        applyEffectToAudio(song, track.id, effect);
        markDirty();
        schedulePersist();
        refresh();
      },
    }, choice.label);
    btn.dataset.value = String(choice.value);
    buttons.push(btn);
  }
  refresh();
  const node = el("div", { class: "effect-param-row" },
    el("div", { class: "param-row-head" },
      el("span", { class: "param-label" }, def.label),
    ),
    el("div", { class: "param-choices" }, ...buttons),
  );
  // No "current value" marker — the chosen value is shown by the active
  // button, so refreshCurrent is a no-op.
  return { node, refreshCurrent: () => {} };
}

function renderPad(song, track, idx) {
  const pad = song.pads[track.id][idx];
  const padKey = `${track.id}:${idx}`;
  const isEdit = editor && editor.mode === "edit";
  // Reflect the "playing" highlight at render time so it survives area
  // re-renders (e.g. switching the effects tab off and back to samples).
  const isPlaying = Audio.isPadPlaying(padKey) || !!editor?.pendingApplies?.[padKey];

  const titleText = pad
    ? (isEdit ? `${pad.name} — drop a file to replace` : `${pad.name} — tap to play, drop a file to replace`)
    : "drop audio file or tap to load";

  const node = el("button", {
    class: "pad" + (pad ? " loaded" : "") + (isEdit ? " edit" : "") + (isPlaying ? " playing" : ""),
    style: `--row-color: ${track.color}`,
    title: titleText,
    onpointerdown: (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      onPadActivate(track, idx);
    },
    ondragover: (e) => { e.preventDefault(); node.classList.add("dragover"); },
    ondragleave: () => node.classList.remove("dragover"),
    ondrop: async (e) => {
      e.preventDefault();
      node.classList.remove("dragover");
      const file = e.dataTransfer.files?.[0];
      if (file) await assignSample(track, idx, file);
    },
  },
    // Sample name — centered, 3x size, no separate number label. In edit
    // mode clicking the name opens a prompt to rename the sample.
    pad ? el("span", {
            class: "pad-name",
            title: isEdit ? "click to rename" : pad.name,
            onclick: isEdit ? ((e) => { e.stopPropagation(); renamePad(track, idx); }) : undefined,
          }, pad.name)
        : null,
    // × delete button is edit-mode only — performance mode shouldn't risk an
    // accidental clear during a take.
    (pad && isEdit) ? el("span", {
            class: "pad-clear",
            title: "clear pad",
            onclick: (e) => { e.stopPropagation(); clearPad(track, idx); }
          }, "×")
        : null,
    // Edit mode: two interactive toggles (loop/shot and solo/stack) stacked at
    // the bottom of every loaded pad.
    // Performance mode: small static indicators showing the pad's saved settings.
    pad ? (isEdit
      ? el("div", { class: "pad-edit-controls", onpointerdown: (e) => e.stopPropagation() },
          el("div", { class: "pad-mode-toggle", title: "loop: plays continuously. shot: plays once and stops." },
            el("button", {
              class: padIsLoop(pad) ? "active" : "",
              onclick: (e) => { e.stopPropagation(); setPadMode(track, idx, "loop"); }
            }, "loop"),
            el("button", {
              class: !padIsLoop(pad) ? "active" : "",
              onclick: (e) => { e.stopPropagation(); setPadMode(track, idx, "shot"); }
            }, "shot"),
          ),
          el("div", { class: "pad-interact-toggle", title: "solo: launching this pad stops every other sample in this row. stack: plays alongside other samples in this row." },
            el("button", {
              class: padIsSolo(pad) ? "active" : "",
              onclick: (e) => { e.stopPropagation(); setPadInteraction(track, idx, "solo"); }
            }, "solo"),
            el("button", {
              class: !padIsSolo(pad) ? "active" : "",
              onclick: (e) => { e.stopPropagation(); setPadInteraction(track, idx, "stack"); }
            }, "stack"),
          ),
          el("div", { class: "pad-retap-toggle", title: "Tap behavior while this pad is playing — stop: just stops it. restart: stops and immediately retriggers it from the start." },
            el("button", {
              class: !padIsRestart(pad) ? "active" : "",
              onclick: (e) => { e.stopPropagation(); setPadRetap(track, idx, "stop"); }
            }, "stop"),
            el("button", {
              class: padIsRestart(pad) ? "active" : "",
              onclick: (e) => { e.stopPropagation(); setPadRetap(track, idx, "restart"); }
            }, "restart"),
          ),
        )
      : null
    ) : null,
  );
  node.dataset.padKey = padKey;
  return node;
}

function setPadMode(track, idx, mode) {
  const pad = editor?.song?.pads?.[track.id]?.[idx];
  if (!pad || padMode(pad) === mode) return;
  pad.mode = mode;
  markDirty();
  persist({ silent: true });
  rerenderArea(track);
}

function setPadInteraction(track, idx, interaction) {
  const pad = editor?.song?.pads?.[track.id]?.[idx];
  if (!pad || padInteraction(pad) === interaction) return;
  pad.interaction = interaction;
  markDirty();
  persist({ silent: true });
  rerenderArea(track);
}

function setPadRetap(track, idx, retap) {
  const pad = editor?.song?.pads?.[track.id]?.[idx];
  if (!pad || padRetap(pad) === retap) return;
  pad.retap = retap;
  markDirty();
  persist({ silent: true });
  rerenderArea(track);
}

function renamePad(track, idx) {
  const pad = editor?.song?.pads?.[track.id]?.[idx];
  if (!pad) return;
  const next = prompt("Sample name:", pad.name);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === pad.name) return;
  pad.name = trimmed;
  markDirty();
  persist({ silent: true });
  rerenderArea(track);
}

function renderDeck(song) {
  const shared = isTimelineShared(song);
  const rows = TRACKS.map(t => {
    const canvas = el("canvas", {});
    // Beat markers only exist in shared mode. In free mode there's no fixed
    // 8-beat structure — each row's period is set by the samples — so we
    // simply don't render the marker grid at all.
    const beatsCount = songTimelineBeats(song);
    const beats = shared
      ? el("div", {
          class: "deck-beats",
          style: `grid-template-columns: repeat(${beatsCount}, 1fr)`,
        },
          Array.from({ length: beatsCount }, (_, i) =>
            el("div", {
              class: "deck-beat" + ((i + 1) % BAR_BEATS === 0 ? " bar-boundary" : "")
            },
              el("span", { class: "beat-num" }, String(i + 1))
            )
          )
        )
      : null;
    const markers = el("div", { class: "deck-markers" });
    const playhead = el("div", { class: "deck-row-playhead" });
    editor.decks[t.id] = { canvas, beats, markers, playhead };
    const wrapKids = shared
      ? [canvas, beats, markers, playhead]
      : [canvas, markers, playhead];
    return el("div", { class: "deck-row", style: `--row-color: ${t.color}` },
      el("div", { class: "deck-label" }, t.label),
      el("div", { class: "deck-canvas-wrap" }, ...wrapKids)
    );
  });
  return el("div", { class: "deck" + (shared ? "" : " free-mode") }, ...rows);
}

function voicesOf(trackId) {
  const t = editor.playing[trackId];
  return t ? Object.values(t) : [];
}

function sizeDeckCanvas(trackId) {
  const d = editor.decks[trackId];
  if (!d) return;
  const wrap = d.canvas.parentElement;
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  d.canvas.width = Math.max(2, Math.floor(r.width * dpr));
  d.canvas.height = Math.max(2, Math.floor(r.height * dpr));
  drawWaveform(trackId);
  updateRowMarkers(trackId);
}

// Free mode dynamic beat grid: when voices are playing on a row, lay out a
// vertical grid showing every beat across the row's current audio span (at
// the song's BPM), with bar boundaries emphasized. Removed entirely when the
// row is empty.
function rebuildFreeBeats(trackId) {
  if (!editor || isTimelineShared(editor.song)) return;
  const d = editor.decks[trackId];
  if (!d || !d.canvas) return;
  const wrap = d.canvas.parentElement;
  if (!wrap) return;

  // Tear down any existing dynamic grid before rebuilding.
  if (d.beats && d.beats.parentElement) d.beats.parentElement.removeChild(d.beats);
  d.beats = null;

  const bounds = rowAudioBounds(trackId);
  if (!bounds) return; // no voices → no grid (the row stays bare)

  const bpm = (editor.song.bpm) || DEFAULT_BPM;
  const beatDur = 60 / bpm;
  if (!(beatDur > 0)) return;
  const beatCount = Math.max(1, Math.round(bounds.span / beatDur));
  if (!Number.isFinite(beatCount)) return;

  const beats = el("div", {
    class: "deck-beats free-beats",
    style: `grid-template-columns: repeat(${beatCount}, 1fr)`,
  },
    Array.from({ length: beatCount }, (_, i) => {
      const beatNum = i + 1;
      const isBar = beatNum % BAR_BEATS === 0;
      return el("div", { class: "deck-beat" + (isBar ? " bar-boundary" : "") },
        isBar ? el("span", { class: "beat-num" }, String(beatNum / BAR_BEATS)) : null
      );
    })
  );
  if (d.markers) wrap.insertBefore(beats, d.markers);
  else wrap.appendChild(beats);
  d.beats = beats;
}

function clearWaveform(trackId) {
  const d = editor.decks[trackId];
  if (!d) return;
  const ctx = d.canvas.getContext("2d");
  ctx.clearRect(0, 0, d.canvas.width, d.canvas.height);
}

function hideRowMarkers(trackId) {
  const d = editor.decks[trackId];
  if (!d) return;
  d.markers.replaceChildren();
}

// Draws every currently-playing voice's waveform on its row's timeline,
// each offset by its own start position and wrapping if it crosses the right edge.
async function drawWaveform(trackId) {
  const d = editor.decks[trackId];
  if (!d) return;
  // Refresh the free-mode beat grid whenever the row's state could have
  // changed (voices added/removed, BPM, mode-switch). Sync; no-op in shared.
  rebuildFreeBeats(trackId);
  const c = d.canvas;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);

  const voices = voicesOf(trackId);
  if (voices.length === 0) return;

  const shared = isTimelineShared(editor.song);
  const tlDur = shared ? timelineDuration() : null;
  const bounds = shared ? null : rowAudioBounds(trackId);
  if (shared && (!tlDur || tlDur <= 0)) return;
  if (!shared && !bounds) return;
  const rowDur = shared ? tlDur : bounds.span;

  const row = c.closest(".deck-row");
  const cssColor = getComputedStyle(row).getPropertyValue("--row-color").trim() || "#888";
  const mid = h / 2;

  // ── Single-pass uniform draw ──
  // Each pixel column gets *one* bar at *one* color. We first compute the
  // per-column max peak height across all voices, then do a single draw pass.
  // This guarantees overlapping samples look identical to a single sample —
  // no compositing math, no per-voice layering, no "older = dimmer" artifacts.
  const heights = new Float32Array(w);
  // In frequency view we also accumulate per-band peak energies per pixel
  // (the max contribution across voices). Each column's final color is a
  // weighted blend of these bands.
  const freqMode = editor?.viewMode === "freq";
  const bandLow  = freqMode ? new Float32Array(w) : null;
  const bandMid  = freqMode ? new Float32Array(w) : null;
  const bandHigh = freqMode ? new Float32Array(w) : null;

  // Free mode: oldest first so newer voices draw on top (doesn't matter for
  // color now but keeps z-order consistent if we ever care).
  const orderedVoices = shared
    ? voices
    : voices.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

  // For shared-mode long samples we need to know which "cycle" of the bar the
  // voice is in, so we can show the appropriate slice of its waveform.
  const audibleNow = (shared && Audio.hasCtx())
    ? Audio.nowCtx().currentTime - Audio.outputLatency()
    : 0;

  for (const state of orderedVoices) {
    const peaks = await Audio.getPeaks(state.sampleId);
    if (!peaks) continue;
    const bands = freqMode ? await Audio.getBandPeaks(state.sampleId) : null;
    const n = peaks.length;
    const isLoop = state.isLoop !== false;

    if (shared && state.duration > rowDur + 1e-4) {
      // ── Long sample (> 1 bar) in shared mode ──
      // The waveform scrolls across bar cycles: the part of the sample that
      // didn't fit on cycle N shows up at the *beginning* of cycle N+1.
      const elapsed = Math.max(0, audibleNow - (state.startedAt || 0));
      const offsetToWrap = (1 - state.startPos) * rowDur;
      let cycle = 0;
      if (elapsed >= offsetToWrap) {
        cycle = Math.floor((elapsed - offsetToWrap) / rowDur) + 1;
      }

      let segmentStart, segmentEnd, rowStartFrac, rowWidthFrac;
      if (cycle === 0) {
        segmentStart = 0;
        segmentEnd = offsetToWrap;
        rowStartFrac = state.startPos;
        rowWidthFrac = 1 - state.startPos;
      } else {
        segmentStart = (cycle - state.startPos) * rowDur;
        segmentEnd = segmentStart + rowDur;
        rowStartFrac = 0;
        rowWidthFrac = 1;
      }

      if (!isLoop) {
        if (segmentStart >= state.duration) continue; // sample fully played
        if (segmentEnd > state.duration) {
          segmentEnd = state.duration;
          rowWidthFrac = (segmentEnd - segmentStart) / rowDur;
        }
      }

      const startPx = rowStartFrac * w;
      const sampleWidthPx = rowWidthFrac * w;
      const cols = Math.max(1, Math.ceil(sampleWidthPx));
      for (let i = 0; i < cols; i++) {
        const posInSeg = i / sampleWidthPx;
        let audioPos = segmentStart + posInSeg * (segmentEnd - segmentStart);
        if (isLoop && state.duration > 0) {
          audioPos -= Math.floor(audioPos / state.duration) * state.duration;
        }
        const peakIdx = Math.min(n - 1, Math.max(0, Math.floor((audioPos / state.duration) * n)));
        const v = peaks[peakIdx] || 0;
        const bh = Math.max(1, v * (h * 0.9));
        const x = Math.floor(startPx + i);
        if (x < 0 || x >= w) continue;
        if (bh > heights[x]) heights[x] = bh;
        if (bands) {
          const lo = bands.low[peakIdx]  || 0;
          const md = bands.mid[peakIdx]  || 0;
          const hi = bands.high[peakIdx] || 0;
          if (lo > bandLow[x])  bandLow[x]  = lo;
          if (md > bandMid[x])  bandMid[x]  = md;
          if (hi > bandHigh[x]) bandHigh[x] = hi;
        }
      }
      continue;
    }

    // ── Short / equal-length samples (shared mode), AND free mode ──
    let widthFraction, startFrac, peakCount;
    if (shared) {
      widthFraction = Math.min(state.duration / rowDur, 1);
      startFrac = state.startPos;
      const visibleFraction = state.duration > rowDur ? (rowDur / state.duration) : 1;
      peakCount = Math.max(1, Math.floor(n * visibleFraction));
    } else {
      widthFraction = state.duration / rowDur;
      startFrac = (state.startedAt - bounds.start) / rowDur;
      peakCount = n;
    }

    const startPx = startFrac * w;
    const sampleWidthPx = widthFraction * w;
    const cols = Math.max(1, Math.ceil(sampleWidthPx));
    for (let i = 0; i < cols; i++) {
      const peakIdx = Math.min(peakCount - 1, Math.floor((i / sampleWidthPx) * peakCount));
      const v = peaks[peakIdx] || 0;
      const bh = Math.max(1, v * (h * 0.9));
      let x = startPx + i;
      if (shared) {
        if (x >= w) x -= w;
        if (x < 0)  x += w;
      } else {
        if (x >= w) break;
        if (x < 0)  continue;
      }
      const xi = Math.floor(x);
      if (xi < 0 || xi >= w) continue;
      if (bh > heights[xi]) heights[xi] = bh;
      if (bands) {
        const lo = bands.low[peakIdx]  || 0;
        const md = bands.mid[peakIdx]  || 0;
        const hi = bands.high[peakIdx] || 0;
        if (lo > bandLow[xi])  bandLow[xi]  = lo;
        if (md > bandMid[xi])  bandMid[xi]  = md;
        if (hi > bandHigh[xi]) bandHigh[xi] = hi;
      }
    }
  }

  // Apply per-track effect transformations to the heights array so the
  // drawn waveform visually reflects what the audio chain is doing —
  // delay taps, reverb tails, pump LFO swings, drive saturation, etc.
  applyEffectsToHeights(heights, w, h * 0.9, editor.song, trackId, rowDur);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (freqMode) {
    // Frequency view: each column is colored by a 3-band weighted blend.
    // Low = red-orange, mid = yellow, high = cyan/blue. The dominant band
    // controls the resulting hue; mixed content reads as warm-cream/white.
    const LOW_R = 255, LOW_G = 80,  LOW_B = 50;
    const MID_R = 240, MID_G = 220, MID_B = 80;
    const HI_R  = 80,  HI_G  = 200, HI_B  = 240;
    for (let x = 0; x < w; x++) {
      const bh = heights[x];
      if (bh <= 0) continue;
      const lo = bandLow[x], md = bandMid[x], hi = bandHigh[x];
      const total = lo + md + hi;
      let r, g, b;
      if (total > 1e-4) {
        r = (LOW_R * lo + MID_R * md + HI_R * hi) / total;
        g = (LOW_G * lo + MID_G * md + HI_G * hi) / total;
        b = (LOW_B * lo + MID_B * md + HI_B * hi) / total;
      } else {
        r = 180; g = 180; b = 180;
      }
      ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
      ctx.fillRect(x, Math.floor(mid - bh / 2), 1, Math.ceil(bh));
    }
  } else {
    // Track view: every painted pixel is exactly the row's CSS color.
    ctx.fillStyle = cssColor;
    for (let x = 0; x < w; x++) {
      const bh = heights[x];
      if (bh <= 0) continue;
      ctx.fillRect(x, Math.floor(mid - bh / 2), 1, Math.ceil(bh));
    }
  }
}

// ───── Visual effect post-processing ─────
// Walks the per-track effect chain (in roughly the same order as the audio
// chain) and applies plausible visual transformations to the heights array
// so the drawn waveform reflects the audible result. None of this is a
// faithful DSP simulation — it's a visual hint at what each effect does.
function applyEffectsToHeights(heights, w, hMax, song, trackId, rowDur) {
  if (!song || !rowDur || rowDur <= 0) return;
  const bpm = song.bpm || DEFAULT_BPM;

  // 1. Drive (tanh soft saturation) — pulls peaks toward the ceiling.
  const driveKnob = getEffect(song, trackId, "drive");
  if (driveKnob > 0) {
    const k = 1 + driveKnob * 30;
    const norm = Math.tanh(k);
    for (let x = 0; x < w; x++) {
      const n = heights[x] / hMax;
      if (n > 0) heights[x] = (Math.tanh(n * k) / norm) * hMax;
    }
  }

  // 2. Distortion (harder hard-clip) — squashes more aggressively.
  const distKnob = getEffect(song, trackId, "distortion");
  if (distKnob > 0) {
    const drive = 1 + distKnob * 20;
    const threshold = 1 - distKnob * 0.7;
    for (let x = 0; x < w; x++) {
      let v = (heights[x] / hMax) * drive;
      if (v > threshold) v = threshold + (v - threshold) / (1 + Math.pow((v - threshold) / 0.1, 2));
      heights[x] = Math.min(1, v) * hMax;
    }
  }

  // 3. Delay — single tap at 1/4 note with feedback. Lay decaying copies of
  // the original waveform offset by the tap interval.
  const delayKnob = getEffect(song, trackId, "delay");
  if (delayKnob > 0) {
    const tapSec = 60 / bpm;
    const tapPx = (tapSec / rowDur) * w;
    if (tapPx >= 1 && tapPx < w) {
      const orig = Float32Array.from(heights);
      let mult = delayKnob * 0.7;
      let off  = tapPx;
      while (mult > 0.04 && off < w) {
        const offInt = Math.floor(off);
        for (let x = offInt; x < w; x++) {
          const v = orig[x - offInt] * mult;
          if (v > heights[x]) heights[x] = v;
        }
        mult *= 0.25; off += tapPx;
      }
    }
  }

  // 4. Echo — longer tap (380ms) with more feedback. Same approach.
  const echoKnob = getEffect(song, trackId, "echo");
  if (echoKnob > 0) {
    const tapSec = 0.38;
    const tapPx = (tapSec / rowDur) * w;
    if (tapPx >= 1 && tapPx < w) {
      const orig = Float32Array.from(heights);
      let mult = echoKnob * 0.65;
      let off  = tapPx;
      while (mult > 0.04 && off < w) {
        const offInt = Math.floor(off);
        for (let x = offInt; x < w; x++) {
          const v = orig[x - offInt] * mult;
          if (v > heights[x]) heights[x] = v;
        }
        mult *= 0.5; off += tapPx;
      }
    }
  }

  // 5. Reverb tail — extends a decaying noise tail past the last loud pixel,
  // sized roughly by the release-time sub-parameter.
  const reverbKnob = getEffect(song, trackId, "reverb");
  if (reverbKnob > 0) {
    const wet     = paramValueAt(song, trackId, "reverb", "wet",     reverbKnob);
    const release = paramValueAt(song, trackId, "reverb", "release", reverbKnob);
    if (wet > 0) {
      // Find the last "loud" pixel of the dry signal.
      let endPx = -1, endH = 0;
      const loudThresh = hMax * 0.05;
      for (let x = w - 1; x >= 0; x--) {
        if (heights[x] > loudThresh) { endPx = x; endH = heights[x]; break; }
      }
      if (endPx >= 0 && endPx < w - 1) {
        const tailPxMax = Math.min(w - endPx - 1, (release / rowDur) * w);
        const tau = tailPxMax / 3;
        for (let i = 1; i <= tailPxMax; i++) {
          const xp = endPx + i;
          if (xp >= w) break;
          const env = Math.exp(-i / tau);
          const noise = pseudoRand(xp) * 0.65 + 0.35;
          const v = endH * Math.min(1, wet) * 0.55 * env * noise;
          if (v > heights[xp]) heights[xp] = v;
        }
      }
    }
  }

  // 6. Compressor — pulls values above an internal threshold toward it.
  const compKnob = getEffect(song, trackId, "compressor");
  if (compKnob > 0) {
    const threshold = 0.5;
    const ratio = 1 + compKnob * 6;
    for (let x = 0; x < w; x++) {
      const n = heights[x] / hMax;
      if (n > threshold) {
        heights[x] = (threshold + (n - threshold) / ratio) * hMax;
      }
    }
  }

  // 7. Volume — overall scale (0.5 = unity).
  const volKnob = getEffect(song, trackId, "volume");
  const volMult = volKnob * 2;
  if (Math.abs(volMult - 1) > 0.005) {
    for (let x = 0; x < w; x++) heights[x] *= volMult;
  }

  // 8. Pump — last, because it modulates the post-volume signal. Periodic
  // amplitude modulation aligned to the bar; on the peak of each LFO cycle
  // we also lift quiet pixels (visual proxy for "more compression").
  const pumpKnob = getEffect(song, trackId, "pump");
  if (pumpKnob > 0) {
    const volAmt    = paramValueAt(song, trackId, "pump", "volume",      pumpKnob);
    const compAmt   = paramValueAt(song, trackId, "pump", "compression", pumpKnob);
    const rate      = paramValueAt(song, trackId, "pump", "rate",        pumpKnob);
    const intensity = paramValueAt(song, trackId, "pump", "intensity",   pumpKnob);
    const cyclesPerBar = (rowDur * bpm / 60) * rate;
    const k = 1 + intensity * 9;
    const norm = Math.tanh(k);
    for (let x = 0; x < w; x++) {
      const cyclePos = (x / w * cyclesPerBar) % 1;
      // cos: +1 at cycle start (beat), -1 at cycle midpoint.
      const sineLFO = Math.cos(cyclePos * 2 * Math.PI);
      const shaped = Math.tanh(sineLFO * k) / norm;
      // Volume swing (±0.5 × volAmt around the current value).
      heights[x] *= (1 + volAmt * 0.5 * shaped);
      // "Compression" lift on the beat — pulls low pixels up so the wave
      // looks fatter at the peak.
      if (shaped > 0 && compAmt > 0) {
        const target = hMax * 0.7;
        if (heights[x] < target) {
          heights[x] += (target - heights[x]) * compAmt * shaped * 0.35;
        }
      }
    }
  }

  // Clamp to canvas-friendly bounds.
  for (let x = 0; x < w; x++) {
    if (heights[x] < 0) heights[x] = 0;
    else if (heights[x] > hMax) heights[x] = hMax;
  }
}

// Deterministic 0..1 noise per integer index — used so the reverb tail
// doesn't shimmer between redraws.
function pseudoRand(x) {
  const s = Math.sin(x * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// Green/red markers for every voice on the row. In shared mode the start
// position is the saved startPos. In free mode it's computed from the row's
// anchor (same as drawWaveform).
function updateRowMarkers(trackId) {
  const d = editor.decks[trackId];
  if (!d) return;
  d.markers.replaceChildren();
  const voices = voicesOf(trackId);
  if (voices.length === 0) return;

  const shared = isTimelineShared(editor.song);
  const bounds = shared ? null : rowAudioBounds(trackId);
  const rowDur = shared ? timelineDuration() : (bounds ? bounds.span : 0);
  if (rowDur <= 0) return;

  const orderedVoices = shared
    ? voices
    : voices.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

  // For long-sample marker visibility we need to know which cycle of the bar
  // each voice is currently on (same math drawWaveform uses).
  const audibleNow = (shared && Audio.hasCtx())
    ? Audio.nowCtx().currentTime - Audio.outputLatency()
    : 0;

  for (const state of orderedVoices) {
    let widthFraction, startFrac, endFrac;
    let showGreen = true, showRed = true;
    if (shared) {
      if (state.duration > rowDur + 1e-4) {
        // ── Long sample (> 1 bar) in shared mode ──
        // Green visible only on cycle 0 (the round where the sample actually
        // starts). Red visible only on the round where the sample actually
        // finishes its first play-through — *not* at the wrap-around position
        // on the rounds before. After the first play-through ends, no markers.
        startFrac = state.startPos;
        endFrac = ((state.startPos + state.duration / rowDur) % 1 + 1) % 1;
        if (Math.abs(endFrac - startFrac) < 0.005) {
          endFrac = (startFrac - 0.005 + 1) % 1;
        }
        widthFraction = 1;

        const elapsed = Math.max(0, audibleNow - (state.startedAt || 0));
        const offsetToWrap = (1 - state.startPos) * rowDur;
        const currentCycle = elapsed >= offsetToWrap
          ? Math.floor((elapsed - offsetToWrap) / rowDur) + 1
          : 0;
        // The first play-through finishes on this cycle:
        const endCycle = Math.floor(state.startPos + state.duration / rowDur);
        showGreen = (currentCycle === 0);
        showRed = (currentCycle === endCycle);
      } else {
        widthFraction = Math.min(state.duration / rowDur, 1);
        startFrac = state.startPos;
        endFrac = startFrac + widthFraction;
        if (endFrac > 1) endFrac -= 1;
        if (Math.abs(widthFraction - 1) < 0.001) {
          endFrac = (startFrac - 0.004 + 1) % 1;
        }
      }
    } else {
      widthFraction = state.duration / rowDur;
      startFrac = (state.startedAt - bounds.start) / rowDur;
      endFrac = startFrac + widthFraction;
      // Free mode: clip the red marker to the row's right edge (no wrap).
      if (endFrac > 1) endFrac = 1;
    }
    // Clamp marker positions so the full 2px bar is visible at the row edges
    // (otherwise a marker at 0% gets half-clipped by overflow:hidden, and a
    // marker at 100% goes off-screen entirely).
    const startLeft = startFrac <= 0
      ? "0px"
      : startFrac >= 1
        ? "calc(100% - 2px)"
        : `calc(${startFrac * 100}% - 1px)`;
    const endLeft = endFrac <= 0
      ? "0px"
      : endFrac >= 1
        ? "calc(100% - 2px)"
        : `calc(${endFrac * 100}% - 1px)`;
    if (showGreen) {
      d.markers.appendChild(el("div", {
        class: "deck-start-bar on",
        style: `left: ${startLeft}`,
      }));
    }
    if (showRed) {
      d.markers.appendChild(el("div", {
        class: "deck-end-bar on",
        style: `left: ${endLeft}`,
      }));
    }
  }
}

// ───── Triggering ─────
async function onPadActivate(track, idx) {
  const song = editor.song;
  const pad = song.pads[track.id][idx];
  if (!pad) {
    const file = await pickFile();
    if (file) await assignSample(track, idx, file);
    return;
  }
  if (editor.mode === "edit") {
    // Make it obvious why no sound: edit mode is for configuration, not playback.
    toast(`edit mode — switch to performance to play (▶)`);
    return;
  }
  triggerPad(track, idx);
}

function triggerPad(track, idx) {
  const song = editor.song;
  const pad = song.pads[track.id][idx];
  if (!pad) return;
  const padKey = `${track.id}:${idx}`;

  // Tap while playing — behavior depends on the pad's `retap` setting:
  //   "stop"    (default): tap stops the pad and returns.
  //   "restart": tap stops the current voice and falls through to retrigger.
  if (Audio.isPadPlaying(padKey) || editor.pendingApplies[padKey]) {
    stopPadAndUpdateVisuals(track.id, padKey);
    if (!padIsRestart(pad)) return;
  }

  // Touch the audio context inside this user-gesture chain.
  const ctx = Audio.nowCtx();
  if (ctx && ctx.state !== "running") {
    try { ctx.resume(); } catch {}
    reportAudioStateIfBlocked();
  }
  // Verbose diagnostic — toast + console — runs on every pad press so we can
  // see the exact state at the moment of trigger. (Temporary; we'll remove
  // when the audio issue is identified.)
  const ctxState = ctx?.state || "no-ctx";
  const hasBuf = Audio.hasBuffer(pad.sampleId);
  toast(`ctx:${ctxState} buf:${hasBuf ? "ok" : "no"} pad:${track.id}/${idx + 1}`);
  console.log("[triggerPad]", {
    track: track.id, idx, sampleId: pad.sampleId,
    ctxState, hasBuffer: hasBuf, mode: editor.mode,
  });

  // Fast path: buffer already decoded.
  if (Audio.hasBuffer(pad.sampleId)) {
    scheduleTrigger(track, idx, pad, padKey, Audio.getBufferDuration(pad.sampleId));
    return;
  }
  // Slow path: decode then trigger.
  Audio.loadSample(pad.sampleId).then((buf) => {
    if (!buf) { toast("could not load sample"); return; }
    if (!editor || editor.song !== song) return;
    scheduleTrigger(track, idx, pad, padKey, buf.duration);
  });
}

// In free mode, quantize is anchored to a "master" voice:
//   1. A voice on the drums track if any is playing — drums is the conductor.
//   2. Otherwise the oldest playing voice across all rows (= the sample that
//      has been going longest, i.e. the de-facto tempo reference).
//   3. Nothing playing yet → null (caller falls back to immediate trigger).
function findMasterVoice() {
  if (!editor) return null;
  // 1. Drums voice if any.
  const drumsVoices = editor.playing?.drums;
  if (drumsVoices) {
    let oldest = null;
    for (const k of Object.keys(drumsVoices)) {
      const v = drumsVoices[k];
      if (v && v.startedAt != null && (!oldest || v.startedAt < oldest.startedAt)) {
        oldest = v;
      }
    }
    if (oldest) return oldest;
  }
  // 2. Oldest voice across all tracks.
  let oldest = null;
  for (const trackId of Object.keys(editor.playing || {})) {
    const voices = editor.playing[trackId];
    if (!voices) continue;
    for (const k of Object.keys(voices)) {
      const v = voices[k];
      if (v && v.startedAt != null && (!oldest || v.startedAt < oldest.startedAt)) {
        oldest = v;
      }
    }
  }
  return oldest;
}

function scheduleTrigger(track, idx, pad, padKey, sampleDuration) {
  const song = editor.song;
  const shared = isTimelineShared(song);
  const ctx = Audio.nowCtx();
  const t  = ctx.currentTime;

  // Choke logic: only the per-pad "solo" setting decides whether to stop the
  // other voices on this row. Stack pads stack in BOTH timeline modes.
  if (padIsSolo(pad)) {
    const others = new Set();
    for (const k of Object.keys(editor.playing[track.id] || {})) {
      if (k !== padKey) others.add(k);
    }
    for (const k of Object.keys(editor.pendingApplies || {})) {
      if (k !== padKey && k.startsWith(track.id + ":")) others.add(k);
    }
    for (const k of others) stopPadAndUpdateVisuals(track.id, k);
  }

  // Compute audio scheduling time. Shared mode anchors quantize to the shared
  // transport. Free mode doesn't use the shared transport — quantize there uses
  // ctx.currentTime as the local origin.
  let when;
  if (shared) {
    if (!Transport.isRunning()) {
      when = t;
      Transport.start(when);
    } else if (song.quantize === "off") {
      when = t;
    } else {
      const beat = 60 / (song.bpm || DEFAULT_BPM);
      const grid = song.quantize === "1/2" ? beat * 2 : beat;
      const elapsed = t - Transport.songStartTime;
      const nextElapsed = Math.ceil(elapsed / grid) * grid;
      when = Transport.songStartTime + nextElapsed;
    }
  } else {
    if (song.quantize === "off") {
      when = t;
    } else {
      // Quantize in free mode is anchored to the "master" voice — drums if
      // any is playing, otherwise the oldest playing voice. Beat grid is laid
      // out from the master's startedAt, so taps snap to its musical beats.
      // If nothing is playing yet, the very first trigger fires immediately
      // (there's no existing tempo to align to).
      const beat = 60 / (song.bpm || DEFAULT_BPM);
      const grid = song.quantize === "1/2" ? beat * 2 : beat;
      const master = findMasterVoice();
      const origin = master ? master.startedAt : t;
      const elapsed = t - origin;
      when = origin + Math.ceil(elapsed / grid) * grid;
    }
  }

  // Where the shared bar will be at audible start (only meaningful in shared mode).
  // In free mode every sample starts at sample-position 0.
  const startPos = shared ? Transport.positionRaw(when) : 0;

  // Schedule audio. In shared mode we lock the loop to the 8-beat bar via
  // timelineDur (padding/truncating as needed). In free mode we play the sample
  // naturally — buf loops at its own duration.
  const isLoop = padIsLoop(pad);
  Audio.playSync(track.id, padKey, pad.sampleId, {
    when,
    loop: isLoop,
    timelineDur: shared ? timelineDuration() : undefined,
    fitToBar: shared,
    onEnd: isLoop ? null : () => {
      if (!editor) return;
      const v = editor.playing[track.id]?.[padKey];
      if (!v) return;
      // Mark as finished. The waveform (and green/red bars) stay on the row
      // until the bar reaches the end of the timeline — cleanupFinishedVoices
      // is what actually removes the entry when the bar wraps.
      v.finished = true;
      document.querySelector(`.pad[data-pad-key="${padKey}"]`)?.classList.remove("playing");
    },
  });

  // Defer the visual update to the moment the audio is actually audible.
  editor.pendingApplies[padKey] = {
    audibleAt: when,
    apply: () => {
      if (!editor.playing[track.id]) editor.playing[track.id] = {};
      editor.playing[track.id][padKey] = {
        sampleId: pad.sampleId,
        startPos,
        duration: sampleDuration,
        startedAt: when,
        isLoop: padIsLoop(pad),
      };
      drawWaveform(track.id);
      updateRowMarkers(track.id);
      document.querySelector(`.pad[data-pad-key="${padKey}"]`)?.classList.add("playing");
    },
  };
}

// When BPM changes, the bar period (= 8 beats at BPM) changes, and the loop
// period of every currently-playing voice has to follow. Stop each playing
// voice and re-launch it at the same playhead position with the new tlDur.
// ───── Free-mode layout ─────
// Each voice has a `startedAt` (audio-clock time when it was triggered) and a
// `duration`. The row's visual is laid out directly from those:
//
//   rowAudioStart = min(voice.startedAt)             across all voices on row
//   rowAudioEnd   = max(voice.startedAt + duration)  across all voices on row
//   rowSpan       = rowAudioEnd - rowAudioStart
//
//   voice.startPos = (voice.startedAt - rowAudioStart) / rowSpan
//   voice.width    = voice.duration / rowSpan
//
// Consequences (which is what the user asked for):
//   - The earliest-triggered voice has startPos = 0 (its waveform begins at
//     the row's left edge).
//   - Whichever voice ends latest in audio time has endPos = 1 (its waveform
//     ends at the row's right edge). If a longer earlier sample outlasts the
//     newer one, the *earlier* sample is the right-anchor.
//   - The junction between any two voices lands exactly at the playback
//     position of the older voice at the moment the newer one was triggered.
//   - The whole row's full waveform of each voice is drawn — earlier voices
//     can extend under newer ones (overlap shows additively).
//   - The bar moves at rowSpan rate, anchored at rowAudioStart, so within
//     each voice's region its position exactly tracks that voice's audio
//     (first iteration; loops drift after that as usual).

function rowAudioBounds(trackId) {
  const voices = editor?.playing?.[trackId];
  if (!voices) return null;
  let start = Infinity, end = -Infinity;
  for (const k of Object.keys(voices)) {
    const v = voices[k];
    if (v.startedAt == null || !(v.duration > 0)) continue;
    if (v.startedAt < start) start = v.startedAt;
    const e = v.startedAt + v.duration;
    if (e > end) end = e;
  }
  if (start === Infinity || end === -Infinity) return null;
  const span = end - start;
  if (span <= 0) return null;
  return { start, end, span };
}

function rowAnchor(trackId) {
  const b = rowAudioBounds(trackId);
  if (!b) return null;
  return { offset: b.start, duration: b.span };
}

function rowBarPosAt(trackId, audioTime) {
  const a = rowAnchor(trackId);
  if (!a) return 0;
  const elapsed = audioTime - a.offset;
  const m = ((elapsed % a.duration) + a.duration) % a.duration;
  return m / a.duration;
}

function rerollActiveVoicesForNewTimeline() {
  if (!editor || !Audio.hasCtx()) return;
  const ctx = Audio.nowCtx();
  const t = ctx.currentTime;
  const shared = isTimelineShared(editor.song);
  const tlDur = timelineDuration();
  for (const trackId of Object.keys(editor.playing)) {
    for (const padKey of Object.keys(editor.playing[trackId])) {
      const state = editor.playing[trackId][padKey];
      const idx = parseInt(padKey.split(":")[1], 10);
      const pad = editor.song.pads[trackId][idx];
      const isLoop = padIsLoop(pad);
      Audio.stopPad(padKey);
      Audio.playSync(trackId, padKey, state.sampleId, {
        when: t,
        loop: isLoop,
        timelineDur: shared ? tlDur : undefined,
        fitToBar: shared,
      });
      state.startedAt = t;
      state.startPos = shared ? Transport.positionRaw(t) : 0;
    }
  }
}

// Remove any voices on this row that have been marked `finished` (their audio
// naturally ended). Called when the row's bar wraps past the right edge — so
// the user sees the waveform stay until the bar reaches the end of the
// timeline, then it disappears at the next cycle.
function cleanupFinishedVoices(trackId) {
  if (!editor) return;
  const voices = editor.playing[trackId];
  if (!voices) return;
  let anyRemoved = false;
  for (const k of Object.keys(voices)) {
    if (voices[k].finished) {
      delete voices[k];
      anyRemoved = true;
    }
  }
  if (!anyRemoved) return;
  drawWaveform(trackId);
  updateRowMarkers(trackId);
}

function stopPadAndUpdateVisuals(trackId, padKey) {
  Audio.stopPad(padKey);
  delete editor.pendingApplies[padKey];

  if (editor.playing[trackId]) delete editor.playing[trackId][padKey];

  drawWaveform(trackId);
  updateRowMarkers(trackId);
  document.querySelector(`.pad[data-pad-key="${padKey}"]`)?.classList.remove("playing");
}

// Drive the shared playhead and any pending visual updates from the audio clock.
// Pending updates fire on the first frame where the audio is actually audible,
// so the green bar, the playhead, and the audible sound all coincide.
function tickPlayheads() {
  if (!editor) return;
  const hasCtx = Audio.hasCtx();
  const ctxTime = hasCtx ? Audio.nowCtx().currentTime : 0;
  const ol = hasCtx ? Audio.outputLatency() : 0;
  const audibleNow = ctxTime - ol;

  // Fire any pending visual updates whose audible time has arrived.
  if (hasCtx && editor.pendingApplies) {
    for (const padKey of Object.keys(editor.pendingApplies)) {
      const p = editor.pendingApplies[padKey];
      if (audibleNow >= p.audibleAt) {
        try { p.apply(); } catch {}
        delete editor.pendingApplies[padKey];
      }
    }
  }

  // Position each track's playhead. The driver depends on the timeline mode:
  //   shared → global Transport (same position for every row)
  //   free   → that track's current voice (one sample at a time)
  // Track the previous bar position per row so we can detect a "wrap" — when
  // the bar crosses the right edge back to the left — and clean up any
  // finished voices on that row at that moment.
  if (!editor.prevBarPos) editor.prevBarPos = {};
  const shared = isTimelineShared(editor.song);
  for (const t of TRACKS) {
    const d = editor.decks[t.id];
    if (!d?.playhead) continue;
    const w = d.canvas.parentElement.clientWidth;

    let pos = null;
    if (shared) {
      if (Transport.isRunning() && hasCtx) pos = Transport.positionAt(ctxTime);
    } else {
      const anchor = rowAnchor(t.id);
      if (anchor && hasCtx) {
        const elapsed = audibleNow - anchor.offset;
        const m = ((elapsed % anchor.duration) + anchor.duration) % anchor.duration;
        pos = m / anchor.duration;
      }
    }

    if (pos != null) {
      d.playhead.classList.add("on");
      d.playhead.style.transform = `translateX(${pos * w}px)`;
      const prev = editor.prevBarPos[t.id];
      const wrapped = prev != null && pos < prev - 0.5;
      if (wrapped) cleanupFinishedVoices(t.id);
      editor.prevBarPos[t.id] = pos;

      // Shared-mode long samples need their waveform repainted every time
      // their *cycle* advances — independent of bar-wrap detection precision.
      // We track each voice's last drawn cycle on the voice itself and
      // schedule a single drawWaveform when any voice's cycle changes.
      if (shared && hasCtx) {
        const tlDur = timelineDuration();
        const voices = editor.playing[t.id];
        let cycleChanged = false;
        if (voices && tlDur > 0) {
          for (const padKey of Object.keys(voices)) {
            const v = voices[padKey];
            if (!v || !(v.duration > tlDur + 1e-4)) continue;
            const elapsed = Math.max(0, audibleNow - (v.startedAt || 0));
            const offsetToWrap = (1 - (v.startPos || 0)) * tlDur;
            const cycle = elapsed >= offsetToWrap
              ? Math.floor((elapsed - offsetToWrap) / tlDur) + 1
              : 0;
            if (v._lastDrawnCycle !== cycle) {
              v._lastDrawnCycle = cycle;
              cycleChanged = true;
            }
          }
        }
        if (cycleChanged || wrapped) {
          drawWaveform(t.id);
          // Long-sample markers are cycle-aware (green only on round 0, red
          // only on the round the sample actually finishes), so they need
          // to refresh whenever a voice crosses into a new cycle.
          updateRowMarkers(t.id);
        }
      }
    } else {
      d.playhead.classList.remove("on");
      editor.prevBarPos[t.id] = null;
    }
  }
  editor.raf = requestAnimationFrame(tickPlayheads);
}

function stopAllAndReset() {
  Audio.stopAll();
  Transport.stop();
  if (!editor) return;
  editor.pendingApplies = {};
  for (const t of TRACKS) {
    editor.playing[t.id] = {};
    clearWaveform(t.id);
    hideRowMarkers(t.id);
  }
  document.querySelectorAll(".pad.playing").forEach(n => n.classList.remove("playing"));
}

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

async function assignSample(track, idx, file) {
  const song = editor.song;
  const existing = song.pads[track.id][idx];
  if (existing) { await deleteSample(existing.sampleId); Audio.evict(existing.sampleId); }
  // Was the song empty before this upload? If so we'll auto-set BPM from it.
  const wasEmpty = !hasAnySample(song);
  const sampleId = uid();
  try { await putSample(sampleId, file); }
  catch { toast("failed to store sample"); return; }
  song.pads[track.id][idx] = {
    sampleId,
    name: file.name.replace(/\.[^.]+$/, "").slice(0, 40),
  };
  markDirty();
  // refresh just that area to update the pad's loaded state
  rerenderArea(track);
  // preload buffer + peaks so the deck draw is instant later — and use the
  // decoded duration to auto-detect BPM if this was the very first sample.
  const buf = await Audio.loadSample(sampleId);
  if (buf) Audio.getPeaks(sampleId);
  if (wasEmpty && buf) {
    const detected = detectBpmFromDuration(buf.duration);
    if (detected && detected.bpm !== song.bpm) {
      song.bpm = detected.bpm;
      const bpmInput = document.querySelector(".bpm input");
      if (bpmInput) bpmInput.value = detected.bpm;
      toast(`BPM set to ${detected.bpm} (sample = ${detected.beats} beats)`);
      // Persist immediately — auto-set is a useful default to keep across reloads.
      persist({ silent: true });
    }
  }
}

function hasAnySample(song) {
  for (const arr of Object.values(song.pads)) {
    for (const p of arr) if (p) return true;
  }
  return false;
}

// Try 8, 4, 2, 16 beats (in that order) and pick the first one whose implied
// BPM lands in a musical range. 8 is the most common one-bar loop length, so
// it wins ties.
function detectBpmFromDuration(sec) {
  if (!sec || sec <= 0) return null;
  for (const beats of [8, 4, 2, 16]) {
    const bpm = (beats * 60) / sec;
    if (bpm >= 60 && bpm <= 200) return { bpm: Math.round(bpm), beats };
  }
  return null;
}

async function clearPad(track, idx) {
  const song = editor.song;
  const pad = song.pads[track.id][idx];
  if (!pad) return;
  const padKey = `${track.id}:${idx}`;
  // If this pad is currently playing or scheduled to start, stop it.
  if (Audio.isPadPlaying(padKey) || editor.pendingApplies[padKey]) {
    stopPadAndUpdateVisuals(track.id, padKey);
  } else if (editor.playing[track.id]?.[padKey]) {
    // Lingering "finished" voice (waveform on screen but audio already ended).
    delete editor.playing[track.id][padKey];
    drawWaveform(track.id);
    updateRowMarkers(track.id);
  }
  await deleteSample(pad.sampleId);
  Audio.evict(pad.sampleId);
  song.pads[track.id][idx] = null;
  markDirty();
  rerenderArea(track);
}

function rerenderArea(track) {
  // find the area DOM and replace
  const allAreas = document.querySelectorAll(".area");
  const stacks = document.querySelectorAll(".side-stack");
  const stack = stacks[track.side === "left" ? 0 : 1];
  if (!stack) return;
  const newArea = renderArea(editor.song, track);
  stack.replaceChild(newArea, stack.children[track.slot]);
  fitAllPadNames();
}

// Every edit autosaves. Calls schedulePersist() to debounce against rapid
// changes (e.g. knob drags) so localStorage doesn't get hammered, but the
// save still lands within ~400ms. No UI indicator — the user just trusts it.
function markDirty() {
  if (!editor) return;
  editor.dirty = true;
  schedulePersist();
}

function persist(opts = {}) {
  if (!editor) return;
  const songs = loadSongs();
  const i = songs.findIndex(s => s.id === editor.song.id);
  if (i === -1) return;
  editor.song.updatedAt = Date.now();
  songs[i] = editor.song;
  saveSongs(songs);
  editor.dirty = false;
}

// ───── Modal / toast ─────
function ensureHost(id, cls) {
  let h = document.getElementById(id);
  if (!h) { h = el("div", { class: cls, id }); document.body.appendChild(h); }
  return h;
}
function toast(msg, ms = 1500) {
  const host = ensureHost("toast-host", "toast-host");
  const t = el("div", { class: "toast" }, msg);
  host.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function promptModal({ title, body, placeholder, initial = "", okLabel = "ok", onSubmit, onCancel }) {
  const host = ensureHost("modal-host", "modal-host");
  const input = el("input", { type: "text", placeholder: placeholder || "", value: initial });
  const close = () => host.remove();
  const submit = () => { close(); onSubmit && onSubmit(input.value); };
  const cancel = () => { close(); onCancel && onCancel(); };
  host.replaceChildren(
    el("div", { class: "modal" },
      el("h3", {}, title),
      body ? el("p", {}, body) : null,
      input,
      el("div", { class: "modal-actions" },
        el("button", { class: "btn ghost", onclick: cancel }, "cancel"),
        el("button", { class: "btn primary", onclick: submit }, okLabel),
      )
    )
  );
  input.focus();
  input.select();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") cancel();
  });
}
function confirmModal({ title, body, okLabel = "ok", danger, onConfirm }) {
  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();
  host.replaceChildren(
    el("div", { class: "modal" },
      el("h3", {}, title),
      body ? el("p", {}, body) : null,
      el("div", { class: "modal-actions" },
        el("button", { class: "btn ghost", onclick: close }, "cancel"),
        el("button", {
          class: "btn " + (danger ? "danger" : "primary"),
          onclick: () => { close(); onConfirm && onConfirm(); }
        }, okLabel),
      )
    )
  );
}

// ───── Boot ─────
// Flush any debounced autosave so nothing is lost if the tab is closing
// during a rapid edit (knob drag, etc.). No more "you have unsaved changes"
// prompt — autosave makes it irrelevant.
window.addEventListener("beforeunload", () => {
  if (editor?.dirty) persist({ silent: true });
});

// Safari-friendly audio unlock. The handler stays attached forever and runs
// on every user gesture (bubble phase, default options). On each gesture:
//   1. Play a tiny inaudible oscillator — Safari often responds to oscillator
//      output where it ignores an empty buffer source.
//   2. Call ctx.resume() to flip "suspended"/"interrupted" → "running".
// We never auto-remove the listeners — even if resume() silently fails the
// first time, the next click/touch will retry.
(function setupAudioUnlock() {
  const evts = ["pointerdown", "touchstart", "touchend", "mousedown", "click", "keydown"];
  const handler = () => {
    const ctx = Audio.nowCtx();
    if (!ctx) return;
    // Brief inaudible oscillator. More reliable than an empty buffer on Safari.
    try {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g); g.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.005);
    } catch {}
    try { ctx.resume(); } catch {}
  };
  evts.forEach(evt => document.addEventListener(evt, handler));
})();

// Spacebar = global stop. Mirrors the "■ stop all" button. Ignored when the
// user is typing in an input/textarea/contenteditable so we don't hijack the
// BPM field or the song-rename input.
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (!editor) return;
  e.preventDefault();
  stopAllAndReset();
});

// Visible audio diagnostic — runs once when the editor mounts. If the audio
// context isn't running shortly after a user has interacted, show a toast so
// the user knows audio is blocked (rather than silently failing).
let _audioDiagnosticTimer = null;
function reportAudioStateIfBlocked() {
  if (_audioDiagnosticTimer) return;
  _audioDiagnosticTimer = setTimeout(() => {
    _audioDiagnosticTimer = null;
    if (!Audio.hasCtx()) return;
    const state = Audio.nowCtx().state;
    if (state !== "running") {
      toast(`audio context: ${state} — tap any pad once more`);
    }
  }, 300);
}

// Expose a couple of helpers on window so we can poke at audio state from the
// console (Safari sometimes needs this).
window.audioCtx = () => Audio.nowCtx();

// Manual audio test — run `testAudio()` in the DevTools console to play a
// 500ms beep. If you don't hear it, audio is blocked at the browser / system
// level (not the app code).
window.testAudio = function () {
  try {
    const ctx = Audio.nowCtx();
    console.log("testAudio: ctx.state =", ctx.state);
    if (ctx.state !== "running") {
      ctx.resume().then(() => console.log("after resume:", ctx.state));
    }
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 0.1;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => osc.stop(), 500);
    return "beep scheduled — ctx.state was " + ctx.state;
  } catch (e) {
    console.error("testAudio error", e);
    return "error: " + e.message;
  }
};

render();
