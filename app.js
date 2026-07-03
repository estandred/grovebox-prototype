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
// Banks. Each track now stores its own list of banks on the song:
//   song.banks[trackId] = [{ id, name, pads }]
// Every song starts with one bank per track (named "1"). Users can add
// banks from edit mode and rename any bank. The bank's id is part of the
// padKey so pads on different banks play independently.
// Per-song track overrides. The user can rename a track or change its color
// inside the editor (edit mode). Defaults fall back to the hard-coded TRACK
// constants. Stored on the song as song.trackOverrides[trackId] = { name, color }.
function getTrackLabel(song, track) {
  // An explicit empty-string override means "show no name" — distinct from
  // "no override" (which falls back to the default label).
  const ov = song?.trackOverrides?.[track.id]?.name;
  return ov !== undefined ? ov : track.label;
}
function getTrackColor(song, track) {
  return song?.trackOverrides?.[track.id]?.color || track.color;
}
function isTrackHidden(song, trackId) {
  return song?.trackOverrides?.[trackId]?.hidden === true;
}
function isTrackMuted(song, trackId) {
  return song?.trackOverrides?.[trackId]?.muted === true;
}
function visibleTracksFor(song, isEdit) {
  // Hidden tracks always render in edit mode (so the user can configure /
  // un-hide them) but disappear entirely from performance mode.
  return TRACKS.filter(t => isEdit || !isTrackHidden(song, t.id));
}
function setTrackOverride(song, trackId, key, value) {
  if (!song.trackOverrides) song.trackOverrides = {};
  if (!song.trackOverrides[trackId]) song.trackOverrides[trackId] = {};
  if (value == null) delete song.trackOverrides[trackId][key];
  else song.trackOverrides[trackId][key] = value;
  if (Object.keys(song.trackOverrides[trackId]).length === 0) {
    delete song.trackOverrides[trackId];
  }
}

function songBanksFor(song, trackId) {
  return (song?.banks && song.banks[trackId]) || [];
}
function activeBank(trackId) {
  if (!editor?.song) return null;
  const banks = songBanksFor(editor.song, trackId);
  return banks.find(b => b.id === editor.activeBank?.[trackId]) || banks[0] || null;
}
function bankCount(song, trackId) {
  return songBanksFor(song, trackId).length;
}
const DEFAULT_BPM = 120;
const BAR_BEATS = 4;
const TIMELINE_BARS = 2;         // performer timeline = 2 bars = 8 beats
const TIMELINE_BEATS = BAR_BEATS * TIMELINE_BARS;

// ───────── Storage ─────────
const LS_KEY = "beatstudio.songs.v1";

// Global app-wide prefs stored on the dev server so they're shared across
// every device hitting the same laptop (laptop + tablet see one truth).
// Currently holds:
//   deckScale (number) — proportional size of the timeline screen
// Populated by loadGlobalPrefs() at boot; mutated by saveGlobalPref().
let GLOBAL_PREFS = {};

async function loadGlobalPrefs() {
  try {
    const r = await fetch("/prefs", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (data && typeof data === "object") GLOBAL_PREFS = data;
  } catch {
    // No server (file:// open, or server down) — stay with the empty
    // defaults and let localStorage fallbacks take over.
  }
}

// Update one global pref key + push it to the server. Pass `null` to clear.
// Optimistically updates the in-memory copy so subsequent reads see the
// new value immediately; the network write is fire-and-forget.
function saveGlobalPref(key, value) {
  if (value == null) delete GLOBAL_PREFS[key];
  else GLOBAL_PREFS[key] = value;
  try {
    fetch("/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(GLOBAL_PREFS),
    }).catch(() => {});
  } catch {}
}

// ───── Web MIDI ─────
// Singleton access; lazily requested the first time the user enters
// mapping mode or when the editor mounts (whichever comes first). Every
// input port routes through onMidiMessage which is the single dispatch
// point for trigger + mapping behavior.

// Per-device enable state lives globally (it's about which physical
// devices to listen to, not song-specific). We store the DISABLED set
// so the default is "every device enabled" without any setup. Persists
// via the same /prefs server endpoint as other GLOBAL_PREFS so the
// preference is shared across the laptop + tablet.
function listMidiInputs() {
  if (!_midiAccess) return [];
  return Array.from(_midiAccess.inputs.values());
}
function isMidiDeviceEnabled(id) {
  const disabled = GLOBAL_PREFS.midiDisabledDevices;
  if (!disabled) return true;
  return !disabled[id];
}
function setMidiDeviceEnabled(id, enabled) {
  const disabled = { ...(GLOBAL_PREFS.midiDisabledDevices || {}) };
  if (enabled) delete disabled[id];
  else         disabled[id] = true;
  saveGlobalPref("midiDisabledDevices", Object.keys(disabled).length ? disabled : null);
}
let _midiAccess = null;
async function ensureMidiAccess() {
  if (_midiAccess) return _midiAccess;
  if (!navigator.requestMIDIAccess) return null;
  try {
    // sysex: true so we can SEND SysEx to the Launchpad (mode switch +
    // RGB lighting). The user gets one permission prompt the first time
    // — same prompt that already covered note input.
    _midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    for (const input of _midiAccess.inputs.values()) {
      input.onmidimessage = onMidiMessage;
    }
    _midiAccess.onstatechange = (e) => {
      if (e.port && e.port.type === "input") {
        e.port.onmidimessage = onMidiMessage;
      }
      // Launchpad connect / disconnect. Compare by id, not by object
      // identity — when a port disconnects + reconnects, Chrome often
      // hands back a fresh MIDIOutput object even for the same physical
      // device, and `===` against the stale reference would silently
      // miss the reconnect.
      if (e.port && e.port.type === "output" && LP_NAME_RE.test(e.port.name || "")) {
        if (e.port.state === "connected") {
          console.log("[launchpad] statechange: connected", e.port.name);
          // Drop any stale reference so lpInit doesn't early-return on
          // the old object.
          _launchpadOutput = null;
          lpInit();
        } else if (e.port.state === "disconnected") {
          console.log("[launchpad] statechange: disconnected", e.port.name);
          if (_launchpadOutput && _launchpadOutput.id === e.port.id) {
            _launchpadOutput = null;
          }
        }
      }
    };
    // Try to spin up the Launchpad right away if it's already plugged in.
    lpInit();
    // Safety net: a heartbeat that catches dropped statechange events,
    // tab-throttle wakeups, and "device still connected but lost our
    // programmer-mode config" drift.
    startLaunchpadHeartbeat();
    return _midiAccess;
  } catch (e) {
    console.warn("[midi] access denied or unavailable", e);
    return null;
  }
}
function onMidiMessage(e) {
  if (!editor) return;
  // Ignore messages from devices the user has disabled in MIDI settings.
  // (Mapping mode still ignores them too — the user has to enable a
  // device before its keys count.)
  const deviceId = e.target?.id;
  if (deviceId && !isMidiDeviceEnabled(deviceId)) return;
  // Before doing anything else: if the audio context is still
  // suspended (browser blocks audio until the user taps the page),
  // attempt to resume + tell the user to tap once. MIDI hardware
  // events don't count as user gestures, so without the tap the
  // playSync calls below would create silent voices.
  primeAudioForMidi();
  let [status, data1, data2] = e.data;
  let cmd = status >> 4;
  // ── Launchpad round-button CC translation ──
  // Mini MK3 round buttons send CC instead of notes in two cases:
  //   • Top row (91..98) — always CC, regardless of layout mode
  //   • Right column (19, 29, 39, 49, 59, 69, 79, 89) — CC in Live
  //     mode (the device's default); becomes notes once Programmer
  //     mode is active, but we cover both so it works even if the
  //     programmer-mode SysEx didn't take.
  // Translating to note-on/off here means the rest of the app (mapping,
  // triggering, LED flash) treats them like any other pad.
  const isTopRowCC    = data1 >= 91 && data1 <= 98;
  const isRightColCC  = data1 % 10 === 9 && data1 >= 19 && data1 <= 89;
  if (cmd === 11 && (isTopRowCC || isRightColCC)) {
    // Right-column CC means the device is in Live mode (in Programmer
    // mode the right column sends notes). Re-issue Programmer-mode
    // SysEx so we recover from any local layout switch the device
    // performed when the user pressed the button — that's the cause
    // of "lights disappeared after pressing right column".
    if (cmd === 11 && isRightColCC && _launchpadOutput && e.target?.name && LP_NAME_RE.test(e.target.name)) {
      lpRecoverProgrammerMode();
    }
    if (data2 > 0) {
      cmd = 9;                                       // note-on
      status = 0x90 | (status & 0x0F);
      if (data2 < 1) data2 = 127;
    } else {
      cmd = 8;                                       // note-off
      status = 0x80 | (status & 0x0F);
    }
  }
  const note = data1;
  const vel  = data2;
  // MIDI monitor — opt-in passive observer. While the monitor screen is
  // open, note-ons go into the history list + the "currently pressed"
  // set. Note-offs only update the active set (the history shows
  // presses only — releases would just be noise). The monitor never
  // blocks the normal handler below.
  if (_midiMonitor) {
    if (cmd === 9 && vel > 0) {
      _midiMonitor.active.add(note);
      pushMidiMonitorEvent({ type: "on", note, vel, time: Date.now(), deviceName: e.target?.name });
    } else if (cmd === 8 || (cmd === 9 && vel === 0)) {
      _midiMonitor.active.delete(note);
      // Active-set changed but the history isn't appended to — still
      // refresh the UI so the "now pressing" row updates live.
      _midiMonitor.updateUI?.();
    } else if (cmd === 11 && data2 > 0) {
      // Untranslated CC — i.e. a CC that didn't fall into the top-row
      // or right-column ranges and so wasn't rewritten to a note above.
      // Logged so the user can see EXACTLY what the controller is
      // sending — vital for diagnosing "the right column isn't doing
      // anything" — they'll see e.g. "CC 19" if the Launchpad is in
      // Live mode and still sending CCs we missed.
      pushMidiMonitorEvent({ type: "cc", note: data1, vel: data2, time: Date.now(), deviceName: e.target?.name });
    }
  }
  // Opportunistic re-assert: ANY input event from the Launchpad is a
  // chance to send the Programmer-mode SysEx, in case the device drifted
  // back to Live mode between heartbeats. Cheap, idempotent on the
  // device, and debounced inside lpReassertProgrammerMode to ≤4/sec so
  // a rapid pad roll doesn't flood the MIDI bus.
  if (_launchpadOutput && LP_NAME_RE.test(e.target?.name || "")) {
    lpReassertProgrammerMode();
  }
  if (cmd === 9 && vel > 0) {
    handleMidiNoteOn(note);
    // Launchpad LED feedback: flash the pressed pad bright, then fade
    // back to its dim baseline. Only fires if (a) the Launchpad output
    // is connected, (b) the note came from a Launchpad input port, and
    // (c) the note maps to a Beat Studio pad.
    if (_launchpadOutput && LP_NAME_RE.test(e.target?.name || "")) {
      lpFlashPadForNote(note);
    }
  } else if (cmd === 8 || cmd === 9) {
    handleMidiNoteOff(note);
  }
}

// One-time hint flag so we don't spam the toast every time a MIDI key
// is pressed while audio is locked.
let _midiAudioPrimePrompted = false;
function primeAudioForMidi() {
  const ctx = Audio.nowCtx();
  if (!ctx) return;
  if (ctx.state !== "suspended" && ctx.state !== "interrupted") return;
  // Try resume — Chrome will reject because there's no user-gesture
  // stack frame, but Firefox + Safari sometimes honor it if there was
  // a recent gesture.
  try { ctx.resume().catch(() => {}); } catch {}
  // Toast once so the user knows what to do.
  if (!_midiAudioPrimePrompted) {
    _midiAudioPrimePrompted = true;
    toast("tap anywhere in the app to enable MIDI audio output", 4000);
  }
}
// Once the audio context actually flips to running (after the user
// taps), reset the prompt so a future suspend-then-MIDI cycle (e.g.
// browser auto-suspend) can re-warn the user.
(function watchAudioForReprime() {
  setInterval(() => {
    if (!Audio.hasCtx()) return;
    const ctx = Audio.nowCtx();
    if (ctx && ctx.state === "running") _midiAudioPrimePrompted = false;
  }, 2000);
})();

// MIDI monitor state — non-null only while the monitor modal is open.
// Leaving the modal drops history + active sets so reopening starts fresh.
let _midiMonitor = null;
function pushMidiMonitorEvent(ev) {
  if (!_midiMonitor) return;
  _midiMonitor.history.push(ev);
  // Cap to keep the DOM cheap on long sessions.
  if (_midiMonitor.history.length > 200) _midiMonitor.history.shift();
  _midiMonitor.updateUI?.();
}
function handleMidiNoteOn(note) {
  if (!editor) return;
  if (editor.midiMapping && editor.midiMappingSelected) {
    // Capture the next MIDI note for the selected pad.
    setMidiMappingFor(editor.song, editor.midiMappingSelected, note);
    editor.midiMappingSelected = null;
    markDirty();
    schedulePersist();
    rerenderAllAreas();
    return;
  }
  if (editor.midiMapping) return; // mapping mode swallows triggers
  const k = findMappedKeyForNote(editor.song, note);
  if (k) triggerMappedPad(k);
}
function handleMidiNoteOff(note) {
  if (!editor || editor.midiMapping) return;
  const k = findMappedKeyForNote(editor.song, note);
  if (k) releaseMappedPad(k);
}
// Dispatch an incoming MIDI hit to the right pad.
function triggerMappedPad(mapKey) {
  if (!editor) return;
  if (mapKey === "stopall") {
    stopAllAndReset();
    return;
  }
  if (mapKey.startsWith("stoptrack:")) {
    const trackId = mapKey.slice("stoptrack:".length);
    const track = TRACKS.find(t => t.id === trackId);
    if (track) stopTrackAndUpdateVisuals(track.id);
    return;
  }
  if (mapKey.startsWith("perform:")) {
    const [, trackId, idxStr] = mapKey.split(":");
    const idx = +idxStr;
    const track = TRACKS.find(t => t.id === trackId);
    if (!track) return;
    activatePerformPad(track, idx);
    return;
  }
  if (mapKey.startsWith("sample:")) {
    const parts = mapKey.split(":");
    // parts = ["sample", trackId, ...]; last part is idx
    const trackId = parts[1];
    const idx = +parts[parts.length - 1];
    const track = TRACKS.find(t => t.id === trackId);
    if (!track) return;
    onPadActivate(track, idx);
  }
}
function releaseMappedPad(mapKey) {
  if (!editor) return;
  if (!mapKey.startsWith("perform:")) return; // sample pads have no "release"
  const [, trackId, idxStr] = mapKey.split(":");
  const idx = +idxStr;
  const track = TRACKS.find(t => t.id === trackId);
  if (!track) return;
  const pad = getPerformPad(editor.song, trackId, idx);
  if (pad?.mode === "hold" && editor.performHeldPads?.[trackId]?.[idx]) {
    deactivatePerformPad(track, idx);
  }
}

// ───── Novation Launchpad Mini MK3 — LED control ─────
// Auto-detected from the MIDIAccess outputs by name. When present we
// put the device into Programmer mode (every pad addressable) and light
// each mapped pad in its track color (dimmed). On press we flash the
// pad to full brightness for ~150 ms, then back to dim — purely visual
// feedback so the performer can see the layout in the dark.
// Port-name matchers. The Launchpad Mini MK3 surfaces in many forms
// depending on OS + driver: "Launchpad Mini MK3", "LPMiniMK3", with
// suffixes like " MIDI", " DAW", " LPMiniMK3 MIDI Out", or wrapped in
// "MIDIOUT2 (LPMiniMK3 MIDI)" on Windows. We accept any of these.
const LP_NAME_RE = /(launchpad.*mini.*mk3|lpminimk3|lp ?mini ?mk3)/i;
let _launchpadOutput = null;
const _lpFlashTimers = new Map();

function findLaunchpadOutput() {
  if (!_midiAccess) return null;
  const matches = [];
  for (const out of _midiAccess.outputs.values()) {
    if (LP_NAME_RE.test(out.name || "")) matches.push(out);
  }
  if (matches.length === 0) return null;
  // The Mini MK3 exposes "DAW" and "MIDI" output ports. The "MIDI" port
  // is the one that accepts programmer-mode SysEx + per-pad lighting.
  // (Some drivers number them as "MIDIOUT2" — also matches /midi/i.)
  for (const out of matches) {
    if (/midi/i.test(out.name) && !/daw/i.test(out.name)) return out;
  }
  // Fallback: first matching output. Common when the OS only exposes
  // a single port name without DAW/MIDI suffix.
  return matches[0];
}

function lpSend(bytes) {
  if (!_launchpadOutput) {
    console.warn("[launchpad] lpSend skipped — no output port");
    return;
  }
  try {
    _launchpadOutput.send(bytes);
  } catch (e) {
    console.warn("[launchpad] send failed", e, "bytes:", bytes);
  }
}
function lpEnterProgrammerMode() {
  // Two variants exist in the wild — older docs say `0E 01`, the
  // current Programmer's Reference Manual uses `00 7F` (Layout Select
  // → Programmer). Send both: the device ignores the one it doesn't
  // recognize. Belt-and-braces approach.
  lpSend([0xF0, 0x00, 0x20, 0x29, 0x02, 0x0D, 0x0E, 0x01, 0xF7]);
  lpSend([0xF0, 0x00, 0x20, 0x29, 0x02, 0x0D, 0x00, 0x7F, 0xF7]);
}
function lpExitProgrammerMode() {
  lpSend([0xF0, 0x00, 0x20, 0x29, 0x02, 0x0D, 0x0E, 0x00, 0xF7]);
  lpSend([0xF0, 0x00, 0x20, 0x29, 0x02, 0x0D, 0x00, 0x00, 0xF7]);
}
function lpSetPadRGB(pad, r, g, b) {
  // SysEx: F0 00 20 29 02 0D 03 03 <pad> <r> <g> <b> F7
  // Each color channel is 0..127.
  lpSend([0xF0, 0x00, 0x20, 0x29, 0x02, 0x0D, 0x03, 0x03,
          pad & 0x7F, r & 0x7F, g & 0x7F, b & 0x7F, 0xF7]);
}
function lpClearAllPads() {
  // 8×8 grid (11..88, programmer layout) + the round CC top row + right
  // column. We just walk the entire space and turn each off.
  for (let row = 1; row <= 9; row++) {
    for (let col = 1; col <= 9; col++) {
      lpSetPadRGB(row * 10 + col, 0, 0, 0);
    }
  }
}

// Convert any CSS color (var(--row-drums), #ff4757, rgb(...), etc.) to
// {r,g,b} in 0..127 (Launchpad's SysEx RGB range).
function cssColorToLaunchpadRGB(cssColor, brightness = 1) {
  try {
    const probe = document.createElement("div");
    probe.style.color = cssColor;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return { r: 0, g: 0, b: 0 };
    const scale = (n) => Math.round(Math.max(0, Math.min(127, (n / 255) * 127 * brightness)));
    return { r: scale(+m[1]), g: scale(+m[2]), b: scale(+m[3]) };
  } catch { return { r: 0, g: 0, b: 0 }; }
}

// The "baseline" color for a mapped pad — dim version of the track
// color, just bright enough to see in a dark room without dazzling.
function lpDimColorForTrack(song, trackId) {
  const track = TRACKS.find(t => t.id === trackId);
  if (!track) return { r: 0, g: 0, b: 0 };
  const color = getTrackColor(song, track);
  return cssColorToLaunchpadRGB(color, 0.25); // 25% brightness
}
function lpBrightColorForTrack(song, trackId) {
  const track = TRACKS.find(t => t.id === trackId);
  if (!track) return { r: 127, g: 127, b: 127 };
  const color = getTrackColor(song, track);
  return cssColorToLaunchpadRGB(color, 1.0); // full
}

// Resolve the CSS color string for a given Launchpad pad, honoring the
// per-song color-map override when it's switched on. Returns null when
// the pad has no defined color (nothing mapped to it AND no override).
function lpBaseCssColorForPad(song, pad) {
  if (isMidiColorMapEnabled(song)) {
    const entry = getMidiPadEntry(song, pad);
    return entry?.color || null;
  }
  const mapKey = findMappedKeyForNote(song, pad);
  if (!mapKey) return null;
  const trackId = trackIdFromMapKey(mapKey);
  const track = trackId ? TRACKS.find(t => t.id === trackId) : null;
  return track ? getTrackColor(song, track) : null;
}

// Walk every Launchpad pad (programmer-mode addressing 11..99) and
// paint each one according to the current settings — either the
// user-defined override color or the track color of its mapping.
function lpRefreshLights() {
  if (!_launchpadOutput || !editor) return;
  // First clear so removed mappings / cleared overrides go dark.
  lpClearAllPads();
  const song = editor.song;
  const useOverride = isMidiColorMapEnabled(song);
  if (useOverride) {
    const m = getMidiColorMap(song);
    for (const padStr of Object.keys(m)) {
      const pad = +padStr;
      if (!isLaunchpadPad(pad)) continue;
      const entry = getMidiPadEntry(song, pad);
      if (!entry) continue;
      const c = cssColorToLaunchpadRGB(entry.color, entry.brightness);
      lpSetPadRGB(pad, c.r, c.g, c.b);
    }
    return;
  }
  const map = getSongMidiMap(song);
  for (const [mapKey, note] of Object.entries(map)) {
    if (!isLaunchpadPad(note)) continue;
    const trackId = trackIdFromMapKey(mapKey);
    if (!trackId) continue;
    const c = lpDimColorForTrack(song, trackId);
    lpSetPadRGB(note, c.r, c.g, c.b);
  }
}
// Programmer-mode pads are arranged as <row><col> where 1<=row,col<=9
// (with the round buttons on row/col 9). A standard 8×8 launchpad note
// like 36 isn't in this range — those would be from the device in Live
// mode, which we won't be in. We still guard so an out-of-range note
// just gets skipped instead of crashing the SysEx send.
function isLaunchpadPad(note) {
  if (!Number.isFinite(note)) return false;
  const row = Math.floor(note / 10);
  const col = note % 10;
  return row >= 1 && row <= 9 && col >= 1 && col <= 9;
}
function trackIdFromMapKey(key) {
  if (key.startsWith("perform:") || key.startsWith("sample:")) {
    return key.split(":")[1];
  }
  return null;
}

// Bright-then-dim animation when the user hits a mapped pad on the
// launchpad. Cancels any pending dim-reset for the same pad so back-
// to-back hits keep flashing rather than getting stuck "dim".
function lpFlashPadForNote(note) {
  if (!_launchpadOutput || !editor) return;
  if (!isLaunchpadPad(note)) return;
  const css = lpBaseCssColorForPad(editor.song, note);
  if (!css) return;
  // Baseline brightness is the per-pad value when override is on; the
  // standard 0.25 default when off (track-color mode).
  let restBrightness = 0.25;
  if (isMidiColorMapEnabled(editor.song)) {
    const entry = getMidiPadEntry(editor.song, note);
    if (entry) restBrightness = entry.brightness;
  }
  const bright = cssColorToLaunchpadRGB(css, 1.0);
  const rest   = cssColorToLaunchpadRGB(css, restBrightness);
  lpSetPadRGB(note, bright.r, bright.g, bright.b);
  const prev = _lpFlashTimers.get(note);
  if (prev) clearTimeout(prev);
  const id = setTimeout(() => {
    _lpFlashTimers.delete(note);
    if (_launchpadOutput) lpSetPadRGB(note, rest.r, rest.g, rest.b);
  }, 150);
  _lpFlashTimers.set(note, id);
}

// Heartbeat: every few seconds, verify the stored output port is still
// connected. If it's gone (statechange events occasionally get dropped
// when a tab is backgrounded), clear the reference and try to find a
// fresh port. If we have NO output, try to find one. This is what
// "reload the app" does manually — but on a timer.
let _lpHeartbeatTimer = null;
function startLaunchpadHeartbeat() {
  if (_lpHeartbeatTimer) return;
  _lpHeartbeatTimer = setInterval(lpHeartbeat, 4000);
  // Also tick when the tab regains focus — most disconnects happen
  // while the page is backgrounded (sleep / app switch).
  document.addEventListener("visibilitychange", lpVisibilityHandler);
  window.addEventListener("focus", lpHeartbeat);
}
function stopLaunchpadHeartbeat() {
  if (_lpHeartbeatTimer) { clearInterval(_lpHeartbeatTimer); _lpHeartbeatTimer = null; }
  document.removeEventListener("visibilitychange", lpVisibilityHandler);
  window.removeEventListener("focus", lpHeartbeat);
}
function lpVisibilityHandler() {
  if (document.visibilityState === "visible") lpHeartbeat();
}
function lpHeartbeat() {
  if (!_midiAccess) return;
  // Verify the stored output is still actually there.
  if (_launchpadOutput) {
    let stillConnected = false;
    for (const o of _midiAccess.outputs.values()) {
      if (o.id === _launchpadOutput.id && o.state === "connected") {
        stillConnected = true;
        break;
      }
    }
    if (!stillConnected) {
      console.log("[launchpad] heartbeat: stored output gone, will rescan");
      _launchpadOutput = null;
    }
  }
  // No output → attempt to find one. lpInit also enters Programmer mode
  // + repaints lights.
  if (!_launchpadOutput) {
    lpInit();
    return;
  }
  // Device IS still connected — but on the Mini MK3 the device can drift
  // back to its default Live mode for no obvious reason (user lifted the
  // controller, a stray idle reset inside its firmware, USB power blip).
  // We can't passively detect that (Live + Programmer modes are silent
  // until a button is pressed), so just re-issue the Programmer-mode
  // SysEx every heartbeat. It's a ~10-byte message and idempotent — if
  // the device is already in Programmer mode the device firmware
  // treats it as a no-op. Then repaint the lights so a drift that
  // wiped the LEDs gets restored in ≤4 seconds without a page reload.
  try {
    lpEnterProgrammerMode();
    // Brief delay so the device commits the layout change before we
    // paint colors against it.
    setTimeout(() => {
      try { lpRefreshLights(); } catch {}
    }, 60);
  } catch (err) {
    console.warn("[launchpad] heartbeat re-affirm failed", err);
  }
}

// Debounced recovery: re-enter Programmer mode and re-paint the lights.
// Called whenever we detect a sign the device drifted back to Live mode
// (e.g. a right-column CC arrives — that range sends notes in Programmer
// mode, so a CC means we're not there anymore). Throttled to once per
// second so a rapid burst of CCs doesn't spam SysEx.
let _lpLastRecoverAt = 0;
function lpRecoverProgrammerMode() {
  if (!_launchpadOutput) return;
  const now = Date.now();
  if (now - _lpLastRecoverAt < 1000) return;
  _lpLastRecoverAt = now;
  lpEnterProgrammerMode();
  // Lighting needs a brief delay after the mode change so the device
  // has actually applied the new layout before we paint.
  setTimeout(() => {
    lpEnterProgrammerMode(); // one more, for stubborn firmware
    lpRefreshLights();
  }, 120);
}

// LIGHT version of the above: only re-sends the Programmer-mode SysEx
// (no light repaint, no double-send). Fired on every Launchpad pad
// press to keep the device sticky in Programmer mode — sending SysEx
// while already in Programmer mode is a no-op on the device side, so
// there's no visible flicker even if the user is hammering pads. A
// short debounce keeps the bus traffic modest. Drift cases that need
// a light repaint still flow through lpRecoverProgrammerMode (right-
// column CC handler) or the 4-second heartbeat.
let _lpLastReassertAt = 0;
function lpReassertProgrammerMode() {
  if (!_launchpadOutput) return;
  const now = Date.now();
  if (now - _lpLastReassertAt < 250) return; // ~4 pings/sec max
  _lpLastReassertAt = now;
  try { lpEnterProgrammerMode(); } catch {}
}

// Bring the Launchpad online: pick the port, enter Programmer mode,
// paint the initial light state. Safe to call multiple times; only does
// real work the first time per attached device.
function lpInit() {
  if (!_midiAccess) {
    console.warn("[launchpad] init skipped — MIDI access not yet granted");
    return;
  }
  if (!_midiAccess.sysexEnabled) {
    // Without sysex, none of the lighting commands can be sent. This is
    // the most common reason "the lights aren't changing" — Chrome
    // grants regular MIDI by default but blocks sysex unless the
    // permission was specifically granted.
    console.warn("[launchpad] MIDI access does NOT have sysex permission — pad lighting won't work. Reload the page and accept the SysEx permission prompt.");
  }
  const out = findLaunchpadOutput();
  if (!out) {
    // Quietly bail — the heartbeat will keep retrying. Don't log on
    // every tick; only log when MIDI access has *some* outputs that
    // could be a launchpad but didn't match the regex.
    return;
  }
  // Compare by id so a fresh MIDIOutput object for the same physical
  // port doesn't trip the early-return.
  if (_launchpadOutput && _launchpadOutput.id === out.id && out.state === "connected") {
    return; // already initialized for this port
  }
  console.log("[launchpad] using output port:", out.name, "(id:", out.id, "state:", out.state, ")");
  _launchpadOutput = out;
  lpEnterProgrammerMode();
  // Retry once after a short delay — some Launchpad firmware revisions
  // ignore the first SysEx after a fresh connect because the USB pipe
  // isn't quite ready. Sending again 200ms later is a cheap safety net.
  setTimeout(() => lpEnterProgrammerMode(), 200);
  setTimeout(() => lpRefreshLights(), 50);
}

// Manual diagnostic — call testLaunchpad() in DevTools to verify the
// connection and lighting protocol. Lights pad 11 (bottom-left main
// grid) full red for 1 second.
window.testLaunchpad = function () {
  console.log("[launchpad] _midiAccess:", _midiAccess);
  console.log("[launchpad] sysexEnabled:", _midiAccess?.sysexEnabled);
  if (_midiAccess) {
    console.log("[launchpad] outputs:");
    for (const o of _midiAccess.outputs.values()) {
      console.log("  -", o.name, "(id:", o.id, "state:", o.state, ")");
    }
  }
  console.log("[launchpad] _launchpadOutput:", _launchpadOutput?.name);
  if (!_launchpadOutput) {
    console.warn("[launchpad] no output selected — calling lpInit() now...");
    lpInit();
  }
  if (_launchpadOutput) {
    lpEnterProgrammerMode();
    setTimeout(() => {
      console.log("[launchpad] lighting pad 11 red for 1s as a sanity test");
      lpSetPadRGB(11, 127, 0, 0);
      setTimeout(() => lpSetPadRGB(11, 0, 0, 0), 1000);
    }, 50);
  }
  return "see console for diagnostic output";
};
function lpShutdown() {
  // Stop the heartbeat so it doesn't keep re-attaching the device after
  // the editor has been torn down (e.g. user navigated away).
  stopLaunchpadHeartbeat();
  if (!_launchpadOutput) return;
  // Clear any pending fade-back timers and clean up.
  for (const id of _lpFlashTimers.values()) clearTimeout(id);
  _lpFlashTimers.clear();
  try { lpClearAllPads(); } catch {}
  try { lpExitProgrammerMode(); } catch {}
  _launchpadOutput = null;
}

function loadSongs() {
  let songs;
  try { songs = JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { songs = []; }
  // One-time migration: reset every song's enabledEffects to the new
  // 6-knob default ("reverb, echo, filter, pitch, volume, distortion").
  // Marked per-song via _effectsDefaultMigrated so subsequent loads
  // skip the reset — the user's later add/remove choices are preserved.
  // Knob values (song.effects) and parameter overrides (song.effectParams)
  // are left untouched; only the visible list of knobs changes.
  let migrated = false;
  for (const s of songs) {
    if (!s || s._effectsDefaultMigrated) continue;
    s.enabledEffects = s.enabledEffects || {};
    for (const t of TRACKS) {
      s.enabledEffects[t.id] = [...DEFAULT_ENABLED_EFFECTS];
    }
    s._effectsDefaultMigrated = true;
    migrated = true;
  }
  if (migrated) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(songs)); } catch {}
  }
  return songs;
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

// Pad quantize override: "song" (default — follow the song-level quantize
// setting) or "off" (always trigger immediately, even when the song is
// quantized). Lets a single pad bypass the global grid when needed.
function padQuantize(pad)         { return pad?.quantize === "off" ? "off" : "song"; }
function padIsQuantizeOff(pad)    { return padQuantize(pad) === "off"; }

// ───── Per-track effects ─────
// Each track has one set of knob values (0..1 each) stored on the song.
// The audio routing per-track is built in the Audio module and the knob
// values get pushed in via Audio.setEffectParam.
//   filter knob: 0 = closed LP at 150Hz, 1 = fully open (~18kHz). Default 1.
//   all other knobs: 0 = bypass, 1 = full wet/depth. Default 0.
const TRACK_EFFECT_KEYS = [
  "reverb", "echo", "delay", "drive", "distortion", "vibrato",
  "filter", "compressor", "volume", "pump", "pitch",
];
const VOCAL_EXTRA_EFFECTS = ["robot"];
// Default set of effect knobs every NEW song (and every track) starts
// with — six knobs arranged 2 rows × 3 cols in the effects panel.
// The user can still add any other effect via the "+" button; this is
// just the starting kit. Ordered so the grid reads left-to-right,
// top-to-bottom.
const DEFAULT_ENABLED_EFFECTS = ["reverb", "echo", "filter", "pitch", "volume", "distortion"];
// Per-knob defaults. filter is bipolar (0.5 = bypass; <0.5 = LPF, >0.5 = HPF).
// pitch is also bipolar (0.5 = no shift; <0.5 = down, >0.5 = up; ±12 semis).
// volume's 0.5 = unity (1.0×). pump is rhythmic LFO (0 = bypass).
const EFFECT_DEFAULTS = {
  reverb: 0, echo: 0, delay: 0, drive: 0, distortion: 0, vibrato: 0,
  filter: 0.5, compressor: 0, volume: 0.5, pump: 0, pitch: 0.5, robot: 0,
};
function trackEffectKeys(trackId) {
  const native = trackId === "vocals"
    ? [...TRACK_EFFECT_KEYS, ...VOCAL_EXTRA_EFFECTS]
    : TRACK_EFFECT_KEYS;
  // TONE_EFFECT_KEYS is defined further down (after EFFECT_PARAMS) — guard
  // against the rare call ordering where it hasn't initialized yet.
  return Array.isArray(typeof TONE_EFFECT_KEYS !== "undefined" ? TONE_EFFECT_KEYS : null)
    ? [...native, ...TONE_EFFECT_KEYS]
    : native;
}

// ───── User-defined effect defaults (app-wide, not per-song) ─────
// Stored in GLOBAL_PREFS.effectDefaults so they persist via the dev
// server's /prefs endpoint and apply to every song the laptop opens.
// Shape:
//   GLOBAL_PREFS.effectDefaults[effect] = {
//     knob: <0..1>,                              // main knob value
//     params: {
//       <paramKey>: { low, high }                // automation pair
//       <paramKey>: { value }                    // fader / choice
//     }
//   }
// Anything missing falls back to the hardcoded EFFECT_DEFAULTS /
// EFFECT_PARAMS values, so the user only has to override what they
// actually want changed.
function getEffectDefaultsMap() {
  if (!GLOBAL_PREFS.effectDefaults) GLOBAL_PREFS.effectDefaults = {};
  return GLOBAL_PREFS.effectDefaults;
}
function getEffectDefaultKnob(effect) {
  const m = getEffectDefaultsMap()[effect];
  if (m && Number.isFinite(m.knob)) return m.knob;
  return EFFECT_DEFAULTS[effect] ?? 0;
}
function getEffectDefaultParam(effect, paramKey) {
  return getEffectDefaultsMap()[effect]?.params?.[paramKey] || null;
}
function setEffectDefaultKnob(effect, knob) {
  const m = getEffectDefaultsMap();
  if (!m[effect]) m[effect] = { knob: 0, params: {} };
  m[effect].knob = Math.max(0, Math.min(1, knob));
  saveGlobalPref("effectDefaults", m);
}
function setEffectDefaultParam(effect, paramKey, value) {
  const m = getEffectDefaultsMap();
  if (!m[effect]) m[effect] = { knob: EFFECT_DEFAULTS[effect] ?? 0, params: {} };
  if (!m[effect].params) m[effect].params = {};
  if (value == null) delete m[effect].params[paramKey];
  else m[effect].params[paramKey] = value;
  saveGlobalPref("effectDefaults", m);
}
function resetEffectDefaults(effect) {
  const m = getEffectDefaultsMap();
  if (effect == null) {
    GLOBAL_PREFS.effectDefaults = {};
  } else {
    delete m[effect];
  }
  saveGlobalPref("effectDefaults", GLOBAL_PREFS.effectDefaults);
}

// ───── User-defined PAD-effect defaults (app-wide) ─────
// Separate from effectDefaults because pad effects use single-point
// values (no automation), so the data shape is different. Shape:
//   GLOBAL_PREFS.padEffectDefaults[effect] = { [paramKey]: value }
// where value is a number (or string for choice params like filter.mode).
function getPadEffectDefaultsMap() {
  if (!GLOBAL_PREFS.padEffectDefaults) GLOBAL_PREFS.padEffectDefaults = {};
  return GLOBAL_PREFS.padEffectDefaults;
}
function getPadEffectDefault(effect, paramKey) {
  const v = getPadEffectDefaultsMap()[effect]?.[paramKey];
  return v == null ? null : v;
}
function setPadEffectDefault(effect, paramKey, value) {
  const m = getPadEffectDefaultsMap();
  if (!m[effect]) m[effect] = {};
  if (value == null) delete m[effect][paramKey];
  else m[effect][paramKey] = value;
  saveGlobalPref("padEffectDefaults", m);
}
function resetPadEffectDefaults(effect) {
  if (effect == null) {
    GLOBAL_PREFS.padEffectDefaults = {};
  } else {
    delete getPadEffectDefaultsMap()[effect];
  }
  saveGlobalPref("padEffectDefaults", GLOBAL_PREFS.padEffectDefaults);
}

// ───── Per-param visibility (app-wide) ─────
// The user picks, per effect + per context (knob vs pad), which of an
// effect's parameters appear in the in-song-part editor. The full
// param set is still always available via the "all params" popup. The
// storage lives in GLOBAL_PREFS so the choice rides /prefs across
// devices.
//
// Convention: a missing entry means "all params visible" (the default
// when the user hasn't touched anything). An explicit array of param
// keys defines the visible set; anything not in the array is hidden
// from the inline editor.
function getParamVisibilityMap() {
  if (!GLOBAL_PREFS.paramVisibility) GLOBAL_PREFS.paramVisibility = {};
  if (!GLOBAL_PREFS.paramVisibility.knob) GLOBAL_PREFS.paramVisibility.knob = {};
  if (!GLOBAL_PREFS.paramVisibility.pad)  GLOBAL_PREFS.paramVisibility.pad  = {};
  return GLOBAL_PREFS.paramVisibility;
}
function isParamVisible(context, effect, paramKey) {
  const list = getParamVisibilityMap()[context]?.[effect];
  if (!Array.isArray(list)) return true; // no override → all visible
  return list.includes(paramKey);
}

// One-time migration: backfill any custom visibility list with EVERY
// current schema key, so params added after the list was last touched
// (e.g. pump's intensity/sharpness on songs that have a visibility
// override from an older app version) become visible by default.
// Idempotent — only writes if it actually added something.
function backfillParamVisibility() {
  if (!GLOBAL_PREFS.paramVisibility) return;
  let changed = false;
  for (const context of ["knob", "pad"]) {
    const ctxMap = GLOBAL_PREFS.paramVisibility[context];
    if (!ctxMap || typeof ctxMap !== "object") continue;
    for (const [effect, list] of Object.entries(ctxMap)) {
      if (!Array.isArray(list)) continue;
      const defs = context === "knob"
        ? (typeof getEffectParamsDef === "function" ? getEffectParamsDef(effect) : null)
        : (typeof getPerformPadParamsDef === "function" ? getPerformPadParamsDef(effect) : null);
      if (!Array.isArray(defs)) continue;
      for (const d of defs) {
        if (!list.includes(d.key)) {
          list.push(d.key);
          changed = true;
        }
      }
    }
  }
  if (changed) saveGlobalPref("paramVisibility", GLOBAL_PREFS.paramVisibility);
}

// Aggressive recovery: if the user's session shows a stale visibility
// list (likely because the previous backfill couldn't persist via a
// dev server that was down, or this is the very first load with the
// new schema), force the lists for known-renamed effects back to
// "no override" so the editor shows every current param. Specifically
// targets pump now that "intensity" was relabeled to "sharpness" and
// the user reported the param not showing in their editor. Idempotent.
function forceResetStaleVisibility() {
  if (!GLOBAL_PREFS.paramVisibility) return;
  let changed = false;
  // For each effect whose schema we know is the source of truth, if the
  // user's stored list is missing any current schema key, drop the
  // list entirely (so isParamVisible returns true for everything).
  const checkEffects = ["pump"];
  for (const context of ["knob", "pad"]) {
    const ctxMap = GLOBAL_PREFS.paramVisibility[context];
    if (!ctxMap) continue;
    for (const effect of checkEffects) {
      const list = ctxMap[effect];
      if (!Array.isArray(list)) continue;
      const defs = context === "knob"
        ? (typeof getEffectParamsDef === "function" ? getEffectParamsDef(effect) : null)
        : (typeof getPerformPadParamsDef === "function" ? getPerformPadParamsDef(effect) : null);
      if (!Array.isArray(defs)) continue;
      const missing = defs.some(d => !list.includes(d.key));
      if (missing) {
        delete ctxMap[effect];
        changed = true;
      }
    }
  }
  if (changed) saveGlobalPref("paramVisibility", GLOBAL_PREFS.paramVisibility);
}
function setParamVisible(context, effect, paramKey, visible) {
  const map = getParamVisibilityMap();
  if (!map[context][effect]) {
    // First write — seed with ALL keys (matching the implicit "all
    // visible" default) so we can then remove only the toggled-off one.
    const defs = context === "knob" ? getEffectParamsDef(effect)
                                    : getPerformPadParamsDef(effect);
    map[context][effect] = (defs || []).map(d => d.key);
  }
  const list = map[context][effect];
  const i = list.indexOf(paramKey);
  if (visible && i < 0)      list.push(paramKey);
  else if (!visible && i >= 0) list.splice(i, 1);
  saveGlobalPref("paramVisibility", map);
}
// Filter a defs array to only the visible entries.
function filterVisibleDefs(context, effect, defs) {
  if (!Array.isArray(defs)) return defs;
  return defs.filter(def => isParamVisible(context, effect, def.key));
}

// ───── MIDI mapping (per-song) ─────
// Map keys are prefixed strings:
//   "sample:<trackId>:<bankId>:<idx>"  — a sample pad in a specific bank
//   "sample:<trackId>:<idx>"           — a sample pad without banks
//   "perform:<trackId>:<idx>"          — a perform-mode effect pad
// Values are MIDI note numbers (0..127). Stored on the song so they
// export with the JSON.
function getSongMidiMap(song) {
  if (!song.midiMap || typeof song.midiMap !== "object") song.midiMap = {};
  return song.midiMap;
}
function midiKeyForSamplePad(trackId, idx) {
  return "sample:" + padKeyFor(trackId, idx);
}
function midiKeyForPerformPad(trackId, idx) {
  return "perform:" + trackId + ":" + idx;
}
// "Stop all" — single global key per song.
function midiKeyForStopAll() { return "stopall"; }
// Per-track stop button. One key per track id.
function midiKeyForStopTrack(trackId) { return "stoptrack:" + trackId; }
function getMidiNoteFor(song, mapKey) {
  return getSongMidiMap(song)[mapKey];
}
function setMidiMappingFor(song, mapKey, note) {
  const map = getSongMidiMap(song);
  if (note == null) delete map[mapKey];
  else map[mapKey] = note;
}
function findMappedKeyForNote(song, note) {
  const map = getSongMidiMap(song);
  for (const [k, n] of Object.entries(map)) if (n === note) return k;
  return null;
}
function midiNoteName(note) {
  if (note == null || !Number.isFinite(note)) return "";
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const octave = Math.floor(note / 12) - 1;
  return names[note % 12] + octave;
}

// ───── Launchpad color override (per song) ─────
// When enabled, the Launchpad's pad colors come from this user-defined
// map instead of the track colors of whatever's mapped to each pad.
// Each entry is { color: "#hex", brightness: 0..1 }. Stored on the song
// so it exports with the JSON. Backwards-compat: older saves stored a
// plain hex string per pad — getMidiPadEntry normalizes those on read
// with brightness=0.25 (the previous default dim level).
function getMidiColorMap(song) {
  if (!song.midiColorMap || typeof song.midiColorMap !== "object") song.midiColorMap = {};
  return song.midiColorMap;
}
function isMidiColorMapEnabled(song) { return !!song?.midiColorMapEnabled; }
function setMidiColorMapEnabled(song, on) { song.midiColorMapEnabled = !!on; }
function getMidiPadEntry(song, pad) {
  const raw = getMidiColorMap(song)[pad];
  if (raw == null) return null;
  if (typeof raw === "string") return { color: raw, brightness: 0.25 };
  return {
    color: raw.color || "#888888",
    brightness: Number.isFinite(raw.brightness) ? raw.brightness : 0.25,
  };
}
function setMidiPadEntry(song, pad, entry) {
  const m = getMidiColorMap(song);
  if (entry == null) delete m[pad];
  else m[pad] = { color: entry.color, brightness: entry.brightness };
}
// Legacy callers — color-only set. Defaults to medium brightness.
function setMidiPadColor(song, pad, hex) {
  if (hex == null) { setMidiPadEntry(song, pad, null); return; }
  const existing = getMidiPadEntry(song, pad);
  setMidiPadEntry(song, pad, { color: hex, brightness: existing?.brightness ?? 0.5 });
}

// Per-song, per-track list of enabled effect knobs. Lives on the song
// itself (song.enabledEffects[trackId]) so it rides the JSON save / export
// path — opening the same song on the tablet sees the same configured
// knobs. Defaults to every available effect for backwards compatibility
// with songs created before add/remove existed.
function getEnabledEffects(song, trackId) {
  if (!song.enabledEffects) song.enabledEffects = {};
  const master = trackEffectKeys(trackId);
  if (!Array.isArray(song.enabledEffects[trackId])) {
    // New track / fresh song → start with the curated 6-knob default
    // (reverb, echo, filter, pitch, volume, distortion). Filter against
    // the master list so unknown defaults are silently dropped (defensive).
    song.enabledEffects[trackId] = DEFAULT_ENABLED_EFFECTS.filter(k => master.includes(k));
  }
  // Sanitize: drop any keys not in the master list (e.g. dropped a track-
  // specific effect from VOCAL_EXTRA_EFFECTS). De-dupe just in case.
  const seen = new Set();
  song.enabledEffects[trackId] = song.enabledEffects[trackId].filter(k => {
    if (!master.includes(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return song.enabledEffects[trackId];
}
function addEnabledEffect(song, trackId, name) {
  const list = getEnabledEffects(song, trackId);
  if (!list.includes(name) && trackEffectKeys(trackId).includes(name)) list.push(name);
}
function removeEnabledEffect(song, trackId, name) {
  const list = getEnabledEffects(song, trackId);
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
}
function getTrackEffects(song, trackId) {
  if (!song.effects) song.effects = {};
  if (!song.effects[trackId]) {
    const def = {};
    for (const k of trackEffectKeys(trackId)) def[k] = getEffectDefaultKnob(k);
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
  // Backfill any missing keys with user-defined defaults (falls back to
  // the hardcoded EFFECT_DEFAULTS via getEffectDefaultKnob).
  for (const k of trackEffectKeys(trackId)) {
    if (!Number.isFinite(eff[k])) eff[k] = getEffectDefaultKnob(k);
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
    // wet: dry/wet mix (0 = bypass, 2 = ~+6dB hot wet).
    { key: "wet",      label: "dry/wet",        min: 0,    max: 2,   defaultLow: 0,   defaultHigh: 1.5 },
    // size: macro driving pre-delay + build-up + damping defaults.
    // Tweak it for a quick small→cathedral sweep; the three explicit
    // params below override its derived values when their automation
    // moves them away from the defaults.
    { key: "size",     label: "room size",      min: 0,    max: 1,   defaultLow: 0.4, defaultHigh: 0.4 },
    // release: RT60 tail in seconds.
    { key: "release",  label: "release",        min: 0.2,  max: 6,   defaultLow: 1.5, defaultHigh: 1.5 },
    // predelay: ms of silence before the diffuse tail starts (0 =
    // tight, ~150ms = large hall). Default 0 → use the size-derived value.
    { key: "predelay", label: "pre-delay (ms)", min: 0,    max: 400, defaultLow: 0,   defaultHigh: 0 },
    // buildup: ms for the tail to reach full diffuse density. Higher
    // = more "lush" attack; lower = more "slappy" early reflections.
    { key: "buildup",  label: "build-up (ms)",  min: 2,    max: 600, defaultLow: 30,  defaultHigh: 30 },
    // damping: high-freq absorption. 0 = bright tail, 1 = very dark.
    { key: "damping",  label: "damping",        min: 0,    max: 1,   defaultLow: 0.4, defaultHigh: 0.4 },
  ],
  // pump: rhythmic LFO that boosts compression + volume on the beat.
  // The LFO peak is phase-locked to the song's beat grid (its buffer
  // starts at the next beat boundary in audio time), so the "up peak"
  // hits exactly on the beat. "sharpness" controls how snappy the
  // transitions are (smooth cosine at 0 → square-ish at 1).
  pump: [
    { key: "compression", label: "compression", min: 0, max: 1, defaultLow: 0, defaultHigh: 1 },
    { key: "volume", label: "volume", min: 0, max: 1, defaultLow: 0, defaultHigh: 1 },
    // Key stays "intensity" so saved songs don't lose this value; only
    // the visible label changes to "sharpness" per the user's request.
    { key: "intensity", label: "sharpness", type: "fader", min: 0, max: 1, defaultValue: 0.5 },
    {
      key: "rate", label: "rate", type: "choice", defaultValue: 1,
      choices: [
        { label: "1/2", value: 0.5 },
        { label: "1",   value: 1   },
      ],
    },
  ],
  // delay: single-tap BPM-synced delay. Main knob = wet level.
  delay: [
    { key: "wet",      label: "wet",      min: 0, max: 1, defaultLow: 0,  defaultHigh: 1 },
    { key: "time",     label: "time",     type: "choice", defaultValue: 0.25, choices: [
      { label: "1/8", value: 0.125 },
      { label: "1/4", value: 0.25  },
      { label: "1/2", value: 0.5   },
      { label: "1",   value: 1     },
    ]},
    { key: "feedback", label: "feedback", type: "fader", min: 0, max: 0.85, defaultValue: 0.25 },
  ],
  // echo: longer tap, free-time (not BPM-synced). Main knob = wet level.
  echo: [
    { key: "wet",      label: "wet",      min: 0, max: 1, defaultLow: 0, defaultHigh: 1 },
    { key: "time",     label: "time (s)", type: "fader", min: 0.1, max: 1.5,  defaultValue: 0.38 },
    { key: "feedback", label: "feedback", type: "fader", min: 0,   max: 0.85, defaultValue: 0.5 },
  ],
  // drive: soft-clip saturation. The main knob IS the amount — no
  // separate "amount" param. The user can still adjust the dry/wet mix.
  drive: [
    { key: "mix", label: "mix", type: "fader", min: 0, max: 1, defaultValue: 0.9 },
  ],
  // distortion: harder clip. Same convention — main knob = amount.
  distortion: [
    { key: "mix", label: "mix", type: "fader", min: 0, max: 1, defaultValue: 0.6 },
  ],
  // vibrato: micro-delay LFO. Single param.
  vibrato: [
    { key: "depth", label: "depth", min: 0, max: 1, defaultLow: 0, defaultHigh: 1 },
  ],
  // compressor: knob sweeps threshold (0 dB → -40 dB) and ratio (1 → 20).
  compressor: [
    { key: "threshold", label: "threshold (dB)", min: -40, max: 0,  defaultLow: 0, defaultHigh: -40 },
    { key: "ratio",     label: "ratio",          min: 1,   max: 20, defaultLow: 1, defaultHigh: 20  },
  ],
  // volume: per-track level. Knob 0..1 maps to gain 0..2; 0.5 = unity.
  volume: [
    { key: "level", label: "level (×)", min: 0, max: 2, defaultLow: 0, defaultHigh: 2 },
  ],
  // pitch: ±1200 cents (one octave each way). Bipolar (knob=0.5 → 0 cents).
  pitch: [
    { key: "cents", label: "cents", min: -1200, max: 1200, defaultLow: -1200, defaultHigh: 1200 },
  ],
  // robot: ring-modulator. Only on vocals. The main knob IS the
  // amount, so no extra params here. The empty list falls through
  // to the single-knob Audio.setEffectParam fallback.
  robot: [],
  // filter: stays single-knob bipolar (LP closing → bypass → HP closing).
  // The param editor adds only a resonance fader on top — the main-knob
  // bipolar behavior in setEffectParam is preserved exactly.
  filter: [
    { key: "resonance", label: "resonance", type: "fader", min: 0.5, max: 12, defaultValue: 1 },
  ],
};

// ───── Tone.js effects ─────
// A second engine of effects that ride on top of the native Web Audio
// chain. Each track gets a "tone sub-chain" inserted after the native
// effects (post-pump, pre-output). Effects in this registry are LAZY —
// the Tone node is only built the first time a param is applied, then
// it's kept alive on the chain. That way unused -tonejs effects don't
// burn CPU.
//
// Effect IDs use the convention "<name> -tonejs" (with the space) so
// every UI surface that prints the id literally still reads correctly
// as a label without any rename helper.
//
// Each entry:
//   create(Tone, ctx)   — returns a Tone effect node (already started
//                         where applicable). Must expose .connect /
//                         .disconnect / .dispose and have a Tone .wet
//                         AudioParam for dry/wet mixing.
//   params              — same shape as EFFECT_PARAMS; gets merged in
//                         at module init so the existing param editor /
//                         save-load just works.
//   apply(node, key, v) — pushes a resolved param value to the live
//                         Tone node. The "wet" key is handled centrally
//                         (Tone effects all expose a .wet AudioParam).
//   knobDefault         — initial main-knob value (0..1).
const TONE_EFFECTS = {
  // ── Reverbs ────────────────────────────────────────────────────────
  "reverb -tonejs": {
    create: (T) => new T.Reverb({ decay: 1.5, preDelay: 0.01, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",      label: "dry/wet",       min: 0,    max: 1,   defaultLow: 0,    defaultHigh: 1 },
      { key: "decay",    label: "decay (s)",     type: "fader", min: 0.1,  max: 10,  defaultValue: 1.5 },
      { key: "preDelay", label: "pre-delay (s)", type: "fader", min: 0,    max: 0.5, defaultValue: 0.01 },
    ],
    apply(node, key, v) {
      if (key === "decay")    { try { node.decay = Math.max(0.001, v); } catch {} }
      if (key === "preDelay") { try { node.preDelay = Math.max(0, v); } catch {} }
    },
  },
  "freeverb -tonejs": {
    create: (T) => new T.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",       label: "dry/wet",       min: 0, max: 1,    defaultLow: 0,   defaultHigh: 1 },
      { key: "roomSize",  label: "room size",     type: "fader", min: 0, max: 0.99, defaultValue: 0.7 },
      { key: "dampening", label: "dampening (Hz)",type: "fader", min: 200, max: 8000, defaultValue: 3000 },
    ],
    apply(node, key, v) {
      if (key === "roomSize")  { try { node.roomSize.value = Math.max(0, Math.min(0.99, v)); } catch {} }
      if (key === "dampening") { try { node.dampening = Math.max(20, v); } catch {} }
    },
  },
  "jcreverb -tonejs": {
    create: (T) => new T.JCReverb({ roomSize: 0.6, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",      label: "dry/wet",   min: 0, max: 1,   defaultLow: 0,   defaultHigh: 1 },
      { key: "roomSize", label: "room size", type: "fader", min: 0, max: 0.99, defaultValue: 0.6 },
    ],
    apply(node, key, v) {
      if (key === "roomSize") { try { node.roomSize.value = Math.max(0, Math.min(0.99, v)); } catch {} }
    },
  },

  // ── Delays ─────────────────────────────────────────────────────────
  "feedback-delay -tonejs": {
    create: (T) => new T.FeedbackDelay({ delayTime: 0.25, feedback: 0.4, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",       label: "dry/wet",   min: 0, max: 1,    defaultLow: 0,    defaultHigh: 1 },
      { key: "delayTime", label: "time (s)",  type: "fader", min: 0.01, max: 1,    defaultValue: 0.25 },
      { key: "feedback",  label: "feedback",  type: "fader", min: 0,    max: 0.95, defaultValue: 0.4 },
    ],
    apply(node, key, v) {
      if (key === "delayTime") { try { node.delayTime.value = Math.max(0.001, v); } catch {} }
      if (key === "feedback")  { try { node.feedback.value  = Math.max(0, Math.min(0.99, v)); } catch {} }
    },
  },
  "ping-pong -tonejs": {
    create: (T) => new T.PingPongDelay({ delayTime: 0.25, feedback: 0.4, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",       label: "dry/wet",  min: 0, max: 1,    defaultLow: 0,    defaultHigh: 1 },
      { key: "delayTime", label: "time (s)", type: "fader", min: 0.01, max: 1,    defaultValue: 0.25 },
      { key: "feedback",  label: "feedback", type: "fader", min: 0,    max: 0.95, defaultValue: 0.4 },
    ],
    apply(node, key, v) {
      if (key === "delayTime") { try { node.delayTime.value = Math.max(0.001, v); } catch {} }
      if (key === "feedback")  { try { node.feedback.value  = Math.max(0, Math.min(0.99, v)); } catch {} }
    },
  },

  // ── Modulation (LFO-driven; need .start()) ────────────────────────
  "chorus -tonejs": {
    create: (T) => { const n = new T.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, feedback: 0.1, spread: 180, type: "sine", wet: 0 }); try { n.start(); } catch {} return n; },
    knobDefault: 0,
    params: [
      { key: "wet",       label: "dry/wet",    min: 0, max: 1,    defaultLow: 0,   defaultHigh: 1 },
      { key: "frequency", label: "rate (Hz)",  type: "fader", min: 0.05, max: 10, defaultValue: 1.5 },
      { key: "depth",     label: "depth",      type: "fader", min: 0,    max: 1,  defaultValue: 0.7 },
      { key: "delayTime", label: "delay (ms)", type: "fader", min: 1,    max: 20, defaultValue: 3.5 },
      { key: "feedback",  label: "feedback",   type: "fader", min: 0,    max: 0.9,defaultValue: 0.1 },
      { key: "spread",    label: "spread (°)", type: "fader", min: 0,    max: 180,defaultValue: 180 },
      { key: "type",      label: "LFO wave",   type: "choice", defaultValue: "sine", choices: [
        { label: "sine",     value: "sine" },
        { label: "square",   value: "square" },
        { label: "triangle", value: "triangle" },
        { label: "sawtooth", value: "sawtooth" },
      ]},
    ],
    apply(node, key, v) {
      if (key === "frequency") { try { node.frequency.value = Math.max(0.001, v); } catch {} }
      if (key === "depth")     { try { node.depth = Math.max(0, Math.min(1, v)); } catch {} }
      if (key === "delayTime") { try { node.delayTime = Math.max(0.1, v); } catch {} }
      if (key === "feedback")  { try { node.feedback.value = Math.max(0, Math.min(0.95, v)); } catch {} }
      if (key === "spread")    { try { node.spread = Math.max(0, Math.min(180, v)); } catch {} }
      if (key === "type")      { try { node.type = v; } catch {} }
    },
  },
  "phaser -tonejs": {
    create: (T) => new T.Phaser({ frequency: 0.5, octaves: 3, stages: 10, baseFrequency: 350, Q: 10, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",           label: "dry/wet",          min: 0, max: 1,    defaultLow: 0,   defaultHigh: 1 },
      { key: "frequency",     label: "rate (Hz)",        type: "fader", min: 0.05, max: 10,   defaultValue: 0.5 },
      { key: "octaves",       label: "octaves",          type: "fader", min: 0,    max: 6,    defaultValue: 3 },
      { key: "baseFrequency", label: "base freq (Hz)",   type: "fader", min: 20,   max: 8000, defaultValue: 350 },
      { key: "Q",             label: "Q",                type: "fader", min: 0,    max: 30,   defaultValue: 10 },
      // stages is constructor-only on most Tone versions, but we expose it
      // anyway — apply() falls through silently if the setter is absent.
      { key: "stages",        label: "stages",           type: "fader", min: 1,    max: 20,   defaultValue: 10 },
    ],
    apply(node, key, v) {
      if (key === "frequency")     { try { node.frequency.value = Math.max(0.001, v); } catch {} }
      if (key === "octaves")       { try { node.octaves = Math.max(0, v); } catch {} }
      if (key === "baseFrequency") { try { node.baseFrequency = Math.max(20, v); } catch {} }
      if (key === "Q")             { try { node.Q.value = Math.max(0, v); } catch {} }
      if (key === "stages")        { try { node.stages = Math.max(1, Math.min(20, Math.round(v))); } catch {} }
    },
  },
  "tremolo -tonejs": {
    create: (T) => { const n = new T.Tremolo({ frequency: 5, depth: 0.5, spread: 180, type: "sine", wet: 0 }); try { n.start(); } catch {} return n; },
    knobDefault: 0,
    params: [
      { key: "wet",       label: "dry/wet",    min: 0, max: 1,    defaultLow: 0,   defaultHigh: 1 },
      { key: "frequency", label: "rate (Hz)",  type: "fader", min: 0.05, max: 20,  defaultValue: 5 },
      { key: "depth",     label: "depth",      type: "fader", min: 0,    max: 1,   defaultValue: 0.5 },
      { key: "spread",    label: "spread (°)", type: "fader", min: 0,    max: 180, defaultValue: 180 },
      { key: "type",      label: "LFO wave",   type: "choice", defaultValue: "sine", choices: [
        { label: "sine",     value: "sine" },
        { label: "square",   value: "square" },
        { label: "triangle", value: "triangle" },
        { label: "sawtooth", value: "sawtooth" },
      ]},
    ],
    apply(node, key, v) {
      if (key === "frequency") { try { node.frequency.value = Math.max(0.001, v); } catch {} }
      if (key === "depth")     { try { node.depth.value = Math.max(0, Math.min(1, v)); } catch {} }
      if (key === "spread")    { try { node.spread = Math.max(0, Math.min(180, v)); } catch {} }
      if (key === "type")      { try { node.type = v; } catch {} }
    },
  },
  "vibrato -tonejs": {
    create: (T) => new T.Vibrato({ frequency: 5, depth: 0.1, type: "sine", wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",       label: "dry/wet",   min: 0, max: 1,    defaultLow: 0,   defaultHigh: 1 },
      { key: "frequency", label: "rate (Hz)", type: "fader", min: 0.05, max: 20, defaultValue: 5 },
      { key: "depth",     label: "depth",     type: "fader", min: 0,    max: 1,  defaultValue: 0.1 },
      { key: "type",      label: "LFO wave",  type: "choice", defaultValue: "sine", choices: [
        { label: "sine",     value: "sine" },
        { label: "square",   value: "square" },
        { label: "triangle", value: "triangle" },
        { label: "sawtooth", value: "sawtooth" },
      ]},
    ],
    apply(node, key, v) {
      if (key === "frequency") { try { node.frequency.value = Math.max(0.001, v); } catch {} }
      if (key === "depth")     { try { node.depth.value = Math.max(0, Math.min(1, v)); } catch {} }
      if (key === "type")      { try { node.type = v; } catch {} }
    },
  },
  "auto-filter -tonejs": {
    create: (T) => { const n = new T.AutoFilter({ frequency: 1, depth: 1, baseFrequency: 200, octaves: 2.6, type: "sine", filter: { type: "lowpass", rolloff: -12, Q: 1 }, wet: 0 }); try { n.start(); } catch {} return n; },
    knobDefault: 0,
    params: [
      { key: "wet",            label: "dry/wet",        min: 0, max: 1,    defaultLow: 0,   defaultHigh: 1 },
      { key: "frequency",      label: "rate (Hz)",      type: "fader", min: 0.05, max: 10,   defaultValue: 1 },
      { key: "depth",          label: "depth",          type: "fader", min: 0,    max: 1,    defaultValue: 1 },
      { key: "baseFrequency",  label: "base freq (Hz)", type: "fader", min: 20,   max: 8000, defaultValue: 200 },
      { key: "octaves",        label: "octaves",        type: "fader", min: 0,    max: 8,    defaultValue: 2.6 },
      { key: "type",           label: "LFO wave",       type: "choice", defaultValue: "sine", choices: [
        { label: "sine",     value: "sine" },
        { label: "square",   value: "square" },
        { label: "triangle", value: "triangle" },
        { label: "sawtooth", value: "sawtooth" },
      ]},
      { key: "filterType",     label: "filter type",    type: "choice", defaultValue: "lowpass", choices: [
        { label: "lowpass",  value: "lowpass" },
        { label: "highpass", value: "highpass" },
        { label: "bandpass", value: "bandpass" },
        { label: "notch",    value: "notch" },
      ]},
      { key: "filterRolloff",  label: "filter slope (dB/oct)", type: "choice", defaultValue: -12, choices: [
        { label: "-12", value: -12 },
        { label: "-24", value: -24 },
        { label: "-48", value: -48 },
        { label: "-96", value: -96 },
      ]},
      { key: "filterQ",        label: "filter Q",       type: "fader", min: 0,    max: 20,   defaultValue: 1 },
    ],
    apply(node, key, v) {
      if (key === "frequency")     { try { node.frequency.value = Math.max(0.001, v); } catch {} }
      if (key === "depth")         { try { node.depth.value = Math.max(0, Math.min(1, v)); } catch {} }
      if (key === "baseFrequency") { try { node.baseFrequency = Math.max(20, v); } catch {} }
      if (key === "octaves")       { try { node.octaves = Math.max(0, v); } catch {} }
      if (key === "type")          { try { node.type = v; } catch {} }
      if (key === "filterType")    { try { node.filter.type = v; } catch {} }
      if (key === "filterRolloff") { try { node.filter.rolloff = v; } catch {} }
      if (key === "filterQ")       { try { node.filter.Q.value = Math.max(0, v); } catch {} }
    },
  },
  "auto-panner -tonejs": {
    create: (T) => { const n = new T.AutoPanner({ frequency: 1, depth: 1, type: "sine", wet: 0 }); try { n.start(); } catch {} return n; },
    knobDefault: 0,
    params: [
      { key: "wet",       label: "dry/wet",   min: 0, max: 1,    defaultLow: 0,   defaultHigh: 1 },
      { key: "frequency", label: "rate (Hz)", type: "fader", min: 0.05, max: 20, defaultValue: 1 },
      { key: "depth",     label: "depth",     type: "fader", min: 0,    max: 1,  defaultValue: 1 },
      { key: "type",      label: "LFO wave",  type: "choice", defaultValue: "sine", choices: [
        { label: "sine",     value: "sine" },
        { label: "square",   value: "square" },
        { label: "triangle", value: "triangle" },
        { label: "sawtooth", value: "sawtooth" },
      ]},
    ],
    apply(node, key, v) {
      if (key === "frequency") { try { node.frequency.value = Math.max(0.001, v); } catch {} }
      if (key === "depth")     { try { node.depth.value = Math.max(0, Math.min(1, v)); } catch {} }
      if (key === "type")      { try { node.type = v; } catch {} }
    },
  },
  "auto-wah -tonejs": {
    create: (T) => new T.AutoWah({ baseFrequency: 100, octaves: 6, sensitivity: 0, Q: 2, gain: 2, follower: 0.3, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",           label: "dry/wet",         min: 0, max: 1,    defaultLow: 0,   defaultHigh: 1 },
      { key: "baseFrequency", label: "base freq (Hz)",  type: "fader", min: 20, max: 4000, defaultValue: 100 },
      { key: "octaves",       label: "octaves",         type: "fader", min: 0,  max: 8,    defaultValue: 6 },
      { key: "sensitivity",   label: "sensitivity (dB)",type: "fader", min: -40,max: 0,    defaultValue: 0 },
      { key: "Q",             label: "Q",               type: "fader", min: 0,  max: 20,   defaultValue: 2 },
      { key: "gain",          label: "gain",            type: "fader", min: 0,  max: 10,   defaultValue: 2 },
      { key: "follower",      label: "follower (s)",    type: "fader", min: 0.01, max: 1,  defaultValue: 0.3 },
    ],
    apply(node, key, v) {
      if (key === "baseFrequency") { try { node.baseFrequency = Math.max(20, v); } catch {} }
      if (key === "octaves")       { try { node.octaves = Math.max(0, v); } catch {} }
      if (key === "sensitivity")   { try { node.sensitivity = v; } catch {} }
      if (key === "Q")             { try { node.Q.value = Math.max(0, v); } catch {} }
      if (key === "gain")          { try { node.gain.value = Math.max(0, v); } catch {} }
      if (key === "follower")      { try { node.follower = Math.max(0.001, v); } catch {} }
    },
  },

  // ── Distortion / bit / harmonic ───────────────────────────────────
  "distortion -tonejs": {
    create: (T) => new T.Distortion({ distortion: 0.4, oversample: "2x", wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",        label: "dry/wet",   min: 0, max: 1, defaultLow: 0,   defaultHigh: 1 },
      { key: "distortion", label: "drive",     type: "fader", min: 0, max: 1, defaultValue: 0.4 },
      { key: "oversample", label: "oversample",type: "choice", defaultValue: "2x", choices: [
        { label: "none", value: "none" },
        { label: "2x",   value: "2x" },
        { label: "4x",   value: "4x" },
      ]},
    ],
    apply(node, key, v) {
      if (key === "distortion") { try { node.distortion = Math.max(0, Math.min(1, v)); } catch {} }
      if (key === "oversample") { try { node.oversample = v; } catch {} }
    },
  },
  "bit-crusher -tonejs": {
    create: (T) => new T.BitCrusher({ bits: 4, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",  label: "dry/wet", min: 0, max: 1,  defaultLow: 0,  defaultHigh: 1 },
      { key: "bits", label: "bits",    type: "fader", min: 1, max: 16, defaultValue: 4 },
    ],
    apply(node, key, v) {
      if (key === "bits") { try { node.bits.value = Math.max(1, Math.min(16, Math.round(v))); } catch {} }
    },
  },
  "chebyshev -tonejs": {
    create: (T) => new T.Chebyshev({ order: 50, oversample: "none", wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",        label: "dry/wet",    min: 0, max: 1,    defaultLow: 0, defaultHigh: 1 },
      { key: "order",      label: "order",      type: "fader", min: 1, max: 100, defaultValue: 50 },
      { key: "oversample", label: "oversample", type: "choice", defaultValue: "none", choices: [
        { label: "none", value: "none" },
        { label: "2x",   value: "2x" },
        { label: "4x",   value: "4x" },
      ]},
    ],
    apply(node, key, v) {
      if (key === "order")      { try { node.order = Math.max(1, Math.min(100, Math.round(v))); } catch {} }
      if (key === "oversample") { try { node.oversample = v; } catch {} }
    },
  },

  // ── Pitch / frequency ─────────────────────────────────────────────
  "pitch-shift -tonejs": {
    create: (T) => new T.PitchShift({ pitch: 0, windowSize: 0.1, delayTime: 0, feedback: 0, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",        label: "dry/wet",        min: 0, max: 1,   defaultLow: 0,  defaultHigh: 1 },
      { key: "pitch",      label: "pitch (semis)",  min: -24, max: 24, defaultLow: 0, defaultHigh: 12 },
      { key: "windowSize", label: "window (s)",     type: "fader", min: 0.01, max: 0.5, defaultValue: 0.1 },
      { key: "delayTime",  label: "delay (s)",      type: "fader", min: 0,    max: 1,   defaultValue: 0 },
      { key: "feedback",   label: "feedback",       type: "fader", min: 0,    max: 0.95,defaultValue: 0 },
    ],
    apply(node, key, v) {
      if (key === "pitch")      { try { node.pitch = Math.max(-24, Math.min(24, Math.round(v))); } catch {} }
      if (key === "windowSize") { try { node.windowSize = Math.max(0.01, v); } catch {} }
      if (key === "delayTime")  { try { node.delayTime.value = Math.max(0, v); } catch {} }
      if (key === "feedback")   { try { node.feedback.value = Math.max(0, Math.min(0.95, v)); } catch {} }
    },
  },
  "freq-shift -tonejs": {
    create: (T) => new T.FrequencyShifter({ frequency: 0, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",       label: "dry/wet",       min: 0, max: 1, defaultLow: 0, defaultHigh: 1 },
      { key: "frequency", label: "shift (Hz)",    min: -1000, max: 1000, defaultLow: 0, defaultHigh: 200 },
    ],
    apply(node, key, v) {
      if (key === "frequency") { try { node.frequency.value = v; } catch {} }
    },
  },

  // ── Stereo ────────────────────────────────────────────────────────
  "widener -tonejs": {
    create: (T) => new T.StereoWidener({ width: 0.5, wet: 0 }),
    knobDefault: 0,
    params: [
      { key: "wet",   label: "dry/wet", min: 0, max: 1, defaultLow: 0, defaultHigh: 1 },
      { key: "width", label: "width",   type: "fader", min: 0, max: 1, defaultValue: 0.5 },
    ],
    apply(node, key, v) {
      if (key === "width") { try { node.width.value = Math.max(0, Math.min(1, v)); } catch {} }
    },
  },
};

// Merge Tone.js effect schemas into the EFFECT_PARAMS / EFFECT_DEFAULTS
// tables so every existing system (param editor, automation bars, save /
// load JSON, defaults modal, all-params popup) treats them identically
// to native effects. The Audio module's switch dispatchers detect them
// by presence in TONE_EFFECTS and route to the tone-specific apply path.
for (const [name, def] of Object.entries(TONE_EFFECTS)) {
  EFFECT_PARAMS[name] = def.params;
  EFFECT_DEFAULTS[name] = def.knobDefault;
}

// Names of all Tone.js effect IDs (with their " -tonejs" suffix), in the
// order they appear above. trackEffectKeys appends these so the "add
// effect" picker shows them; existing songs without these in their
// enabledEffects[] simply don't display them.
const TONE_EFFECT_KEYS = Object.keys(TONE_EFFECTS);
function isToneEffect(name) { return TONE_EFFECTS[name] != null; }

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

  // Look up a user-defined default for this param (might be null).
  const ud = getEffectDefaultParam(effect, paramKey);

  if (def.type === "choice") {
    // Choice params store a single `value`. Migrate from any older shape
    // that used {low, high} (rate used to be a numeric automation range).
    if (!slot[paramKey] || !Number.isFinite(slot[paramKey].value)) {
      const old = slot[paramKey];
      const guess = old?.value ?? old?.low
                  ?? (Number.isFinite(ud?.value) ? ud.value : undefined)
                  ?? def.defaultValue ?? def.choices[0].value;
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
      else if (Number.isFinite(ud?.value))                guess = ud.value;
      else                                                guess = def.defaultValue ?? def.min;
      slot[paramKey] = { value: guess };
    }
    slot[paramKey].value = Math.max(def.min, Math.min(def.max, slot[paramKey].value));
    return slot[paramKey];
  }

  if (!slot[paramKey]) {
    slot[paramKey] = {
      low:  Number.isFinite(ud?.low)  ? ud.low  : def.defaultLow,
      high: Number.isFinite(ud?.high) ? ud.high : def.defaultHigh,
    };
  }
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

// ───── Perform-pad parameter schema ─────
// Each effect exposes up to 3 single-point parameters used by the perform
// pads. These are INDEPENDENT from EFFECT_PARAMS (which drives the knob-
// automation editor on the "effects" tab). The perform-pad audio applier
// (applyPerformPadAudio) reads these directly and routes each one to the
// matching node on the per-track chain — no main "amount" knob, the
// parameters themselves define the final result when the pad is pressed.
//
// type === "choice" stores a discrete value chosen via button group.
// Otherwise it's a single-value fader on [min, max].
const PERFORM_PAD_PARAMS = {
  reverb: [
    { key: "wet",      label: "dry/wet",        min: 0,    max: 2,    default: 1.5 },
    { key: "size",     label: "room size",      min: 0,    max: 1,    default: 0.5 },
    { key: "release",  label: "release",        min: 0.2,  max: 6,    default: 2.0 },
    { key: "predelay", label: "pre-delay (ms)", min: 0,    max: 400,  default: 20 },
    { key: "buildup",  label: "build-up (ms)",  min: 2,    max: 600,  default: 50 },
    { key: "damping",  label: "damping",        min: 0,    max: 1,    default: 0.4 },
  ],
  pump: [
    { key: "compression", label: "compression", min: 0, max: 1, default: 0.8 },
    { key: "volume",      label: "volume",      min: 0, max: 1, default: 0.8 },
    // Key matches the knob-effect schema so applyPerformPadAudio can
    // read the same field name. Label says "sharpness" everywhere
    // user-facing.
    { key: "intensity",   label: "sharpness",   type: "fader", min: 0, max: 1, default: 0.5 },
    { key: "rate", label: "rate", type: "choice", default: 1, choices: [
      { label: "1/2", value: 0.5 },
      { label: "1",   value: 1   },
    ]},
  ],
  delay: [
    { key: "time", label: "time", type: "choice", default: 0.25, choices: [
      { label: "1/8", value: 0.125 },
      { label: "1/4", value: 0.25  },
      { label: "1/2", value: 0.5   },
      { label: "1",   value: 1     },
    ]},
    { key: "feedback", label: "feedback", min: 0, max: 0.85, default: 0.45 },
    { key: "wet",      label: "wet",      min: 0, max: 1,    default: 0.6 },
  ],
  echo: [
    { key: "time",     label: "time (s)", min: 0.1, max: 1.5,  default: 0.38 },
    { key: "feedback", label: "feedback", min: 0,   max: 0.85, default: 0.55 },
    { key: "wet",      label: "wet",      min: 0,   max: 1,    default: 0.6 },
  ],
  filter: [
    { key: "mode", label: "type", type: "choice", default: "lowpass", choices: [
      { label: "lp", value: "lowpass"  },
      { label: "hp", value: "highpass" },
    ]},
    { key: "cutoff",    label: "cutoff (hz)", min: 80,  max: 18000, default: 1500 },
    { key: "resonance", label: "resonance",   min: 0.5, max: 12,    default: 1.5 },
  ],
  // drive/distortion: pads use a fixed full-strength amount; user
  // controls mix only. The "amount" param was removed app-wide
  // because the main knob already handles it on knob effects.
  drive: [
    { key: "mix", label: "mix", min: 0, max: 1, default: 0.7 },
  ],
  distortion: [
    { key: "mix", label: "mix", min: 0, max: 1, default: 0.5 },
  ],
  vibrato: [
    { key: "depth", label: "depth", min: 0, max: 1, default: 0.6 },
  ],
  compressor: [
    { key: "threshold", label: "threshold (dB)", min: -40, max: 0,  default: -24 },
    { key: "ratio",     label: "ratio",          min: 1,   max: 20, default: 4 },
  ],
  volume: [
    { key: "level", label: "level (×)", min: 0, max: 2, default: 1.0 },
  ],
  pitch: [
    { key: "cents", label: "cents", min: -1200, max: 1200, default: 0 },
  ],
  // robot: pads always trigger at full amount; no params to tweak.
  robot: [],
};

// Auto-generate perform-pad schemas for every Tone.js effect from its
// knob schema (TONE_EFFECTS). Pads use single-point values (no main
// knob, no automation), so each param is converted:
//   - automation params (low/high)  → single value = defaultHigh ("fully
//                                       engaged" target the knob would
//                                       sweep to at max)
//   - fader params (defaultValue)   → same single value
//   - choice params (defaultValue)  → same single value + choices
// Anything missing from TONE_EFFECTS just doesn't get a pad entry —
// getPerformPadParamsDef already returns [] for unknown effects.
for (const [name, def] of Object.entries(TONE_EFFECTS)) {
  PERFORM_PAD_PARAMS[name] = def.params.map(p => {
    if (p.type === "choice") {
      return { key: p.key, label: p.label, type: "choice", default: p.defaultValue, choices: p.choices };
    }
    if (p.type === "fader") {
      return { key: p.key, label: p.label, min: p.min, max: p.max, default: p.defaultValue };
    }
    // automation pair → use defaultHigh as the pad's single-shot value
    return { key: p.key, label: p.label, min: p.min, max: p.max, default: p.defaultHigh };
  });
}

function getPerformPadParamsDef(effect) {
  return PERFORM_PAD_PARAMS[effect] || [];
}

// ───── Perform-mode pads (the 3rd tab on each song part) ─────
// Each song part has 6 perform pads. A perform pad applies a single effect
// preset when activated; releasing it restores the song's baseline for
// that effect. Two activation modes:
//   "hold"   — effect is on only while the pad is held
//   "toggle" — first tap turns it on, second tap turns it off
// Stored as song.performPads[trackId][idx], parallel to song.pads. A null
// entry means "empty slot". When non-null:
//   { effect, knob, params: {...}, mode: "hold"|"toggle" }
//
// `knob` is the main 0..1 effect knob value, `params` is a single-value
// snapshot per sub-parameter (compare to song.effectParams which stores
// {low, high} for automation — here we just store one number per key).
function getPerformPads(song, trackId) {
  if (!song.performPads) song.performPads = {};
  if (!Array.isArray(song.performPads[trackId]) ||
      song.performPads[trackId].length !== PADS_PER_TRACK) {
    const arr = Array(PADS_PER_TRACK).fill(null);
    const existing = song.performPads[trackId];
    if (Array.isArray(existing)) {
      for (let i = 0; i < Math.min(existing.length, PADS_PER_TRACK); i++) {
        arr[i] = existing[i] || null;
      }
    }
    song.performPads[trackId] = arr;
  }
  return song.performPads[trackId];
}
function getPerformPad(song, trackId, idx) {
  return getPerformPads(song, trackId)[idx] || null;
}
function setPerformPad(song, trackId, idx, padObj) {
  const pads = getPerformPads(song, trackId);
  pads[idx] = padObj;
}
function clearPerformPad(song, trackId, idx) {
  const pads = getPerformPads(song, trackId);
  pads[idx] = null;
}
// Build a perform pad initialized to the schema's defaults for each
// parameter. The parameters fully define the effect's audible result
// when the pad is pressed — no main "amount" knob.
function makePerformPad(song, trackId, effect) {
  const defs = getPerformPadParamsDef(effect);
  const params = {};
  for (const p of defs) {
    // Prefer the user's saved app-wide pad default; fall back to the
    // schema's hardcoded default.
    const userDefault = getPadEffectDefault(effect, p.key);
    params[p.key] = (userDefault != null) ? userDefault : p.default;
  }
  return { effect, params, mode: "hold" };
}
// Migration: pads saved under the older schema (with a main `knob` and
// EFFECT_PARAMS-shaped params) need their fields backfilled into the new
// PERFORM_PAD_PARAMS keys. Idempotent — drops nothing the new schema
// doesn't expect, fills any missing keys with defaults.
function migratePerformPad(pad) {
  if (!pad || !pad.effect) return pad;
  const defs = getPerformPadParamsDef(pad.effect);
  if (!pad.params || typeof pad.params !== "object") pad.params = {};
  for (const p of defs) {
    const cur = pad.params[p.key];
    if (p.type === "choice") {
      if (cur == null || !p.choices.some(c => c.value === cur)) {
        pad.params[p.key] = p.default;
      }
    } else {
      const num = Number.parseFloat(cur);
      if (!Number.isFinite(num)) pad.params[p.key] = p.default;
      else if (num < p.min || num > p.max) pad.params[p.key] = Math.max(p.min, Math.min(p.max, num));
    }
  }
  // Drop the legacy `knob` field if present — it has no effect anymore.
  if ("knob" in pad) delete pad.knob;
  // Drop the legacy `amount` param too — pad effects now always trigger
  // at full strength on the affected effects (drive/distortion/robot).
  if (pad.params && "amount" in pad.params) delete pad.params.amount;
  return pad;
}

function newSong(name = "untitled") {
  const pads = {};
  const banks = {};
  for (const t of TRACKS) {
    const padArr = Array.from({ length: PADS_PER_TRACK }, () => null);
    const initial = { id: uid(), name: "1", pads: padArr };
    banks[t.id] = [initial];
    pads[t.id] = initial.pads; // live reference to the active bank's pads
  }
  const effects = {};
  for (const t of TRACKS) {
    const def = {};
    for (const k of trackEffectKeys(t.id)) def[k] = getEffectDefaultKnob(k);
    effects[t.id] = def;
  }
  return {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pads,
    banks,
    bpm: DEFAULT_BPM,
    quantize: "off",        // "off" | "1/4" | "1/2"
    timelineMode: "shared", // "shared" | "free" (see helpers above)
    timelineBeats: 8,       // 8 or 16 — length of the shared-mode bar
    fitToBar: true,         // legacy, kept on disk for older songs
    effects,                // per-track effect knob values (0..1)
  };
}

function padArrTo(arr, len = PADS_PER_TRACK) {
  const out = Array.isArray(arr) ? arr.slice(0, len) : [];
  while (out.length < len) out.push(null);
  return out;
}

// Make sure song.banks is populated for every track, migrating from any
// legacy formats:
//   - song.padBanks[trackId] = { bankName: [...pads...] }   (older banked)
//   - song.pads[trackId]     = [...pads...]                 (oldest, single)
// After this runs, song.banks[trackId] is a non-empty array of
// { id, name, pads } and song.pads is left untouched (we don't read pads
// directly for storage anymore — it just acts as a live reference to the
// active bank's pads array, set up by ensureTrackBankLink).
function ensureSongBanks(song) {
  if (!song.banks) song.banks = {};
  for (const t of TRACKS) {
    let banks = song.banks[t.id];
    if (!Array.isArray(banks) || banks.length === 0) {
      banks = [];
      const legacyBanked = song.padBanks?.[t.id];
      if (legacyBanked && typeof legacyBanked === "object" && !Array.isArray(legacyBanked)) {
        for (const [name, pads] of Object.entries(legacyBanked)) {
          banks.push({ id: uid(), name, pads: padArrTo(pads) });
        }
      }
      if (banks.length === 0) {
        const legacyPads = Array.isArray(song.pads?.[t.id]) ? song.pads[t.id] : null;
        banks.push({ id: uid(), name: "1", pads: padArrTo(legacyPads) });
      }
      song.banks[t.id] = banks;
    }
    // Normalize each bank's shape. An explicit empty string for `name` is
    // allowed (means "no visible label"); only missing names get a default.
    // IMPORTANT: only rebuild b.pads when it's missing or the wrong shape.
    // Replacing it unconditionally with a new slice broke the shared
    // reference between b.pads and song.pads[trackId] — the init loop
    // calls ensureSongBanks once per track, so the earlier tracks' link
    // would dangle (song.pads pointed at the previous, now-orphan slice).
    // That dangling reference made uploaded samples land in song.pads
    // only, never reach the active bank, and silently vanish on the next
    // reload (which reads from banks).
    for (const b of banks) {
      if (!b.id) b.id = uid();
      if (b.name == null) b.name = "1";
      if (!Array.isArray(b.pads) || b.pads.length !== PADS_PER_TRACK) {
        b.pads = padArrTo(b.pads);
      }
    }
  }
}

// Point song.pads[trackId] at the active bank's pads array so all the
// existing reads/writes against song.pads[trackId][idx] land in the
// currently-active bank. activeBankId is the bank's stable id (uid).
function ensureTrackBankLink(song, trackId, activeBankId) {
  ensureSongBanks(song);
  const banks = song.banks[trackId];
  const active = banks.find(b => b.id === activeBankId) || banks[0];
  song.pads[trackId] = active.pads;
  return active;
}

// Construct the audio padKey. The active bank's id is part of the key so
// voices on different banks don't collide (e.g. pad 0 on bank A doesn't
// stop pad 0 on bank B). Falls back to the simpler form if no editor.
function padKeyFor(trackId, idx) {
  const bankId = editor?.activeBank?.[trackId];
  if (bankId) return `${trackId}:${bankId}:${idx}`;
  return `${trackId}:${idx}`;
}

// Visit every pad in every bank of every track. Works on both new and
// legacy song shapes.
function eachPadInSong(song, callback) {
  if (song.banks) {
    for (const [trackId, banks] of Object.entries(song.banks)) {
      for (const bank of banks || []) {
        for (const pad of bank.pads || []) callback(pad, trackId, bank);
      }
    }
    return;
  }
  // Legacy fallback (used by song-tile rendering on pre-migration data).
  for (const [trackId, pads] of Object.entries(song.pads || {})) {
    if (song.padBanks?.[trackId]) continue;
    for (const pad of pads || []) callback(pad, trackId);
  }
  for (const [trackId, banks] of Object.entries(song.padBanks || {})) {
    for (const bank of Object.values(banks)) {
      for (const pad of bank || []) callback(pad, trackId);
    }
  }
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
// ───── Export / Import ─────
// Songs are exportable as standalone .json files. Each file bundles the
// song object (effects, pads, BPM, etc.) plus every referenced sample blob
// as base64. Sample IDs get regenerated on import to avoid collisions.
const SONG_FILE_FORMAT = "beatstudio-song-v1";

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = r.result; // "data:<mime>;base64,XXXX..."
      const i = String(url).indexOf(",");
      resolve(String(url).slice(i + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const n = bin.length;
  const u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime || "application/octet-stream" });
}
function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function exportSongToFile(song) {
  // Gather every sample referenced by this song's pads, across every bank.
  const sampleIds = new Set();
  eachPadInSong(song, (pad) => { if (pad?.sampleId) sampleIds.add(pad.sampleId); });
  const samples = {};
  for (const id of sampleIds) {
    const blob = await getSample(id);
    if (!blob) continue;
    samples[id] = {
      mime: blob.type || "application/octet-stream",
      data: await blobToBase64(blob),
    };
  }
  const payload = {
    _format: SONG_FILE_FORMAT,
    exportedAt: Date.now(),
    song,
    samples,
  };
  const json = JSON.stringify(payload);
  const fname = `${slugify(song.name) || "song"}.beatstudio.json`;

  // Preferred path: POST to the dev server's /save-song endpoint so the
  // file lands directly in the laptop's songs/ folder + the manifest is
  // updated. Other devices on the same network pick it up via the library
  // picker without any manual file-move step.
  try {
    const res = await fetch("/save-song", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) {
        return { method: "library", file: data.file || fname };
      }
    }
  } catch (err) {
    // Endpoint not available (running on GitHub Pages, file://, or the
    // upload-capable server isn't running) — fall through to a download.
  }

  // Fallback: regular browser download.
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { method: "download", file: fname };
}

async function importSongFromFile(file) {
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error("not a valid song file (couldn't parse json)"); }
  if (payload._format !== SONG_FILE_FORMAT) {
    throw new Error(`unsupported format: ${payload._format || "unknown"}`);
  }
  const importedSong = payload.song;
  if (!importedSong) throw new Error("song file is missing the song data");

  // Regenerate every sample ID so an import never collides with the local
  // IndexedDB (and so importing the same file twice gives two copies).
  const idMap = {};
  for (const oldId of Object.keys(payload.samples || {})) {
    const newId = uid();
    idMap[oldId] = newId;
    const { mime, data } = payload.samples[oldId];
    const blob = base64ToBlob(data, mime);
    await putSample(newId, blob);
  }

  // Deep-clone the song and rewrite sample references through the id map.
  const cloned = JSON.parse(JSON.stringify(importedSong));
  cloned.id = uid();
  cloned.createdAt = Date.now();
  cloned.updatedAt = Date.now();
  for (const trackId of Object.keys(cloned.pads || {})) {
    for (const pad of cloned.pads[trackId] || []) {
      if (pad?.sampleId && idMap[pad.sampleId]) pad.sampleId = idMap[pad.sampleId];
    }
  }

  // Disambiguate the name if a song with the same one already exists.
  const songs = loadSongs();
  if (songs.some(s => s.name === cloned.name)) {
    cloned.name = `${cloned.name} (imported)`;
  }
  songs.push(cloned);
  saveSongs(songs);
  return cloned;
}

// ───── Cloud library (manual publish via GitHub) ─────
// If a `songs/manifest.json` file is published alongside the deployed app,
// every device that opens the URL auto-imports the songs listed in it on
// boot. The manifest format:
//   { "songs": ["my-song.beatstudio.json", "another.beatstudio.json"] }
// Each entry is a filename in the `songs/` folder. The files themselves are
// standard exported Beat Studio JSON.
//
// Re-imports are decided by `updatedAt`: if the library version is NEWER
// than the local copy (or there's no local copy), it replaces the local
// version. So to "publish an edit" you re-export and re-upload — every
// device picks up the new version on its next reload.
const CLOUD_MANIFEST_URL = "songs/manifest.json";

// Lists the library contents without importing anything. Returns a small
// summary used by the manual "load from library" picker.
async function listCloudSongs() {
  let manifest;
  try {
    const res = await fetch(CLOUD_MANIFEST_URL, { cache: "no-cache" });
    if (!res.ok) return { found: false, songs: [] };
    manifest = await res.json();
  } catch {
    return { found: false, songs: [] };
  }
  const raw = manifest && Array.isArray(manifest.songs) ? manifest.songs : [];
  // Two manifest shapes accepted:
  //   "song.json"             → simple, name = filename
  //   { file, name, updatedAt } → rich, lets the picker show the saved name
  const songs = raw
    .map(entry => typeof entry === "string"
      ? { file: entry, name: entry, updatedAt: 0 }
      : { file: entry.file, name: entry.name || entry.file, updatedAt: Number(entry.updatedAt) || 0 })
    .filter(s => s.file);
  return { found: true, songs };
}

// Load a single song file from the library and import it locally.
async function loadCloudSongByFile(file) {
  const url = /^https?:\/\//.test(file) ? file : `songs/${file}`;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("file not found");
  const payload = await res.json();
  const local = loadSongs();
  const byId = new Map(local.map(s => [s.id, s]));
  return importCloudSongPayload(payload, byId);
}

// Ask the dev server to remove a song from the library (deletes the file
// and prunes the manifest entry). No-ops gracefully if the server doesn't
// expose /delete-song (e.g. plain GitHub Pages hosting).
async function deleteCloudSong(file) {
  const res = await fetch("/delete-song", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file }),
  });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || "delete failed");
  return data;
}

async function loadCloudSongs() {
  const listing = await listCloudSongs();
  if (!listing.found) return { found: false, imported: 0, updated: 0 };
  if (listing.songs.length === 0) return { found: true, imported: 0, updated: 0 };

  // Map of existing songs by id for fast lookup + timestamp comparison.
  const local = loadSongs();
  const byId = new Map(local.map(s => [s.id, s]));
  let imported = 0, updated = 0;

  await Promise.all(listing.songs.map(async ({ file }) => {
    try {
      const url = /^https?:\/\//.test(file) ? file : `songs/${file}`;
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) return;
      const payload = await res.json();
      const result = await importCloudSongPayload(payload, byId);
      if (result === "added")   imported++;
      if (result === "updated") updated++;
    } catch (err) {
      console.warn("[cloud] failed to import", file, err);
    }
  }));
  return { found: true, imported, updated };
}

// Import preserving the original song id + sample ids. Returns "added",
// "updated", "skipped". Idempotent: re-running on the same payload is a
// no-op (unless the library's updatedAt advanced).
async function importCloudSongPayload(payload, byId) {
  if (payload?._format !== SONG_FILE_FORMAT) return "skipped";
  const song = payload.song;
  if (!song?.id) return "skipped";

  const localCopy = byId.get(song.id);
  const remoteTs = Number(song.updatedAt) || 0;
  const localTs  = Number(localCopy?.updatedAt) || 0;
  if (localCopy && remoteTs <= localTs) return "skipped";

  // Save sample blobs preserving their original ids. Pads still reference
  // those ids, so the song will work without rewriting anything.
  for (const [sampleId, entry] of Object.entries(payload.samples || {})) {
    try {
      const blob = base64ToBlob(entry.data, entry.mime);
      await putSample(sampleId, blob);
    } catch (err) {
      console.warn("[cloud] sample save failed", sampleId, err);
    }
  }

  const cloned = JSON.parse(JSON.stringify(song));
  cloned._source = "library";
  const songs = loadSongs();
  const idx = songs.findIndex(s => s.id === song.id);
  if (idx >= 0) {
    songs[idx] = cloned;
    saveSongs(songs);
    byId.set(cloned.id, cloned);
    return "updated";
  }
  songs.push(cloned);
  saveSongs(songs);
  byId.set(cloned.id, cloned);
  return "added";
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

  // Schedule a future stop on the audio clock. Used by triggerPad's
  // quantize path so a "stop the old voice + start the new voice" pair
  // both lands precisely on the same musical beat — no silent gap
  // between stop-now and start-at-beat.
  function scheduleStopPad(padKey, when) {
    const e = activeSources.get(padKey);
    if (!e) return;
    // `stop(when)` schedules the source to actually stop at that audio-
    // clock time. The onended handler we set in playSync still fires
    // when it does, cleaning activeSources up. We keep the entry in
    // activeSources until then so isPadPlaying() correctly returns true
    // up to the scheduled stop moment.
    try { e.src.stop(when); } catch {}
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
    // If a voice is already running for this padKey we DON'T stop it
    // here — that would create an audible gap before the new voice
    // starts when `when` is a future quantize boundary. Instead we
    // schedule the existing source to stop at the same audio-clock
    // time as the new source's start, so the swap lands precisely on
    // the beat. The entry in activeSources gets overwritten below;
    // the old onended fires naturally when the scheduled stop hits.
    const __startWhen = opts.when || c.currentTime;
    if (activeSources.has(padKey)) {
      const prev = activeSources.get(padKey);
      try { prev.src.stop(__startWhen); } catch { try { prev.src.stop(); } catch {} }
    }

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
    const chain = trackId ? ensureTrackChain(trackId) : null;
    const dest = chain ? chain.input : c.destination;
    gain.connect(dest);
    // (Pitch shift is now handled by an in-chain pitch shifter — see
    // createPitchShifter. The source itself runs at its natural rate so
    // sample length/tempo aren't affected by pitch changes.)
    const when = __startWhen;
    console.log("[Audio.playSync] src.start", {
      padKey, sampleId, when, ctxTime: c.currentTime, ctxState: c.state,
      loopEnd, shouldLoop, gainValue: gain.gain.value,
      bufDuration: playBuf?.duration,
    });
    // opts.offset (in seconds) skips into the sample. Used by the
    // "catch" quantize mode so a late tap starts mid-sample to stay
    // on the beat grid instead of waiting for the next boundary.
    const startOffset = Math.max(0, opts.offset || 0);
    // For non-looping samples, an offset greater than the buffer
    // duration means we'd skip past the end — no audio would play.
    // Fall back to a 0 offset in that case.
    const safeOffset = (shouldLoop || startOffset < baseBuf.duration) ? startOffset : 0;
    src.start(when, safeOffset);
    // Track the effective musical start (where position 0 of the
    // sample would have been if we hadn't skipped). Used elsewhere
    // for waveform alignment and bar-position math.
    const musicalStartedAt = when - safeOffset;
    const entry = { src, startedAt: musicalStartedAt, duration: baseBuf.duration, looping: shouldLoop };
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

  // Pitch shifter — port of Chris Wilson's "Jungle". Two delay lines
  // with sawtooth-modulated delay times, cross-faded with cosine
  // windows. The result is pitch-shifted audio at the original tempo
  // (unlike AudioBufferSourceNode.detune, which time-stretches as well).
  //
  // setCents(N) re-tunes the output by N cents. The shifter is always
  // on the signal path (no dry/wet bypass) so the chain has the same
  // ~40ms latency at any pitch setting — toggling between dry/wet
  // would otherwise cause an audible "rewind" of the previous grain
  // window when the user changed the pitch.
  function createPitchShifter(c) {
    // Shorter grain than canonical Jungle (was 100ms) so the constant
    // latency stays barely perceptible while still giving a usable pitch
    // range. 40ms grain / 20ms cross-fade is a common DJ-effect choice.
    const delayTime = 0.040;
    const fadeTime  = 0.020;
    const bufferTime = 0.040;
    const sr = c.sampleRate;

    const input  = c.createGain();
    const output = c.createGain();
    // No dry/wet bypass. The wet (pitch-shifted) path is the ONLY path,
    // so the chain's latency is constant whether the user dials pitch
    // up, down, or to zero. Switching between dry (zero-latency) and
    // wet (40ms-latency) at runtime causes an audible "rewind" of the
    // last ~40ms played back at the new pitch — that's the glide/speed
    // change the user was hearing. Constant latency eliminates it.

    // Window envelope buffer: smooth rise → hold → fall. Looped at the
    // crossfade rate so the two channels alternate seamlessly.
    const winLen = Math.max(1, Math.round(sr * bufferTime));
    const fadeSamples = Math.max(1, Math.round(sr * fadeTime));
    const winBuf = c.createBuffer(1, winLen, sr);
    const wd = winBuf.getChannelData(0);
    for (let i = 0; i < winLen; i++) {
      if (i < fadeSamples) {
        wd[i] = Math.sqrt(0.5 * (1 - Math.cos(Math.PI * i / fadeSamples)));
      } else if (i > winLen - fadeSamples) {
        const j = winLen - i;
        wd[i] = Math.sqrt(0.5 * (1 - Math.cos(Math.PI * j / fadeSamples)));
      } else {
        wd[i] = 1;
      }
    }
    // Sawtooth ramp buffer 0 → 1 over one window period. Multiplied by
    // a modGain to produce the delay-time modulation that creates the
    // pitch shift.
    const rampBuf = c.createBuffer(1, winLen, sr);
    const rd = rampBuf.getChannelData(0);
    for (let i = 0; i < winLen; i++) rd[i] = i / winLen;

    function makeChannel(startAt) {
      const mod = c.createBufferSource();
      mod.buffer = rampBuf;
      mod.loop = true;
      const modGain = c.createGain();
      modGain.gain.value = 0;
      mod.connect(modGain);
      const delay = c.createDelay(1);
      delay.delayTime.value = delayTime;
      modGain.connect(delay.delayTime);

      const winSrc = c.createBufferSource();
      winSrc.buffer = winBuf;
      winSrc.loop = true;
      const fadeGain = c.createGain();
      fadeGain.gain.value = 0;
      winSrc.connect(fadeGain.gain);

      input.connect(delay);
      delay.connect(fadeGain);
      fadeGain.connect(output);

      try { mod.start(startAt); } catch {}
      try { winSrc.start(startAt); } catch {}
      return { modGain };
    }

    const startAt = c.currentTime;
    const ch1 = makeChannel(startAt);
    const ch2 = makeChannel(startAt + bufferTime / 2);

    function setCents(cents) {
      const ratio = Math.pow(2, cents / 1200);
      const shift = 1 - ratio;
      const t = c.currentTime;
      // Snap the modulation gains to the new value — no ramp at all,
      // so the pitch hits its target on the very next grain.
      ch1.modGain.gain.cancelScheduledValues(t);
      ch1.modGain.gain.setValueAtTime(shift * delayTime, t);
      ch2.modGain.gain.cancelScheduledValues(t);
      ch2.modGain.gain.setValueAtTime(shift * delayTime, t);
    }
    setCents(0);

    return { input, output, setCents };
  }

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
  // makeReverbIR — synthesize a stereo impulse response from a full
  // set of user-controllable parameters. Each is independently
  // overridable; when an explicit value isn't provided, fall back to a
  // value derived from `size` so the original "one-knob" behavior
  // still works.
  //
  // opts:
  //   size      0..1  macro that drives the defaults for pre-delay,
  //                   build-up and damping when those aren't set
  //                   explicitly. Stays for backwards compat + as a
  //                   quick "give me a small/medium/big room" knob.
  //   release   0.15..10  RT60 decay in seconds.
  //   preDelay  0..400    pre-delay in milliseconds.
  //   buildup   2..600    build-up time in milliseconds (how long
  //                       until the diffuse tail reaches full density).
  //   damping   0..1      high-freq absorption: 0 = bright tail (no
  //                       LP), 1 = very dark (heavy LP).
  function makeReverbIR(c, opts = {}) {
    const size    = Math.max(0,    Math.min(1,  opts.size    ?? 0.5));
    const release = Math.max(0.15, Math.min(10, opts.release ?? 1.5));
    // Size-derived defaults — only used when the explicit param is null.
    const preDelayMs = Number.isFinite(opts.preDelay) ? opts.preDelay : (size * 400);
    const buildupMs  = Number.isFinite(opts.buildup)  ? opts.buildup  : (2 + size * 298);
    const damping    = Number.isFinite(opts.damping)
      ? Math.max(0, Math.min(1, opts.damping))
      : (size * 0.97);
    const sr = c.sampleRate;
    const length = Math.max(1, Math.floor(sr * release));
    const ir = c.createBuffer(2, length, sr);
    const preDelay = Math.floor(sr * (Math.max(0, Math.min(400, preDelayMs)) / 1000));
    const buildup  = Math.max(1, Math.floor(sr * (Math.max(2, Math.min(600, buildupMs)) / 1000)));
    const tau = release / Math.log(1000);
    // One-pole LP coefficient. damping=0 (bright) → alpha=1 (no LP);
    // damping=1 (very dark) → alpha=0.03 (heavy LP).
    const lpAlpha = Math.max(0.03, 1 - damping);
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
        lpState = lpState + lpAlpha * (noise - lpState);
        data[i] = lpState * tailEnv * buildEnv;
      }
    }
    return ir;
  }

  // Build a single-cycle LFO buffer with the peak at sample 0 (so the
  // peak aligns with whatever time we start the source at). Length is
  // exactly 1 second so playbackRate becomes the LFO frequency in Hz
  // (1 Hz per playbackRate=1, meaning 1 cycle per beat at BPM=60).
  // Sharpness controls how square-like the shape is:
  //   sharpness=0 → pure cosine (smooth, symmetric).
  //   sharpness=1 → near-square (sharp transitions, dwells at extremes).
  // Built as a buffer instead of an OscillatorNode+WaveShaper so we
  // can re-trigger the source at known beat boundaries without phase
  // drift — the existing OscillatorNode approach was free-running and
  // never honored the song's beat grid.
  function makePumpLFOBuffer(c, sharpness) {
    const sr = c.sampleRate;
    const len = sr; // 1 second
    const buf = c.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    const s = Math.max(0, Math.min(1, sharpness));
    const k = 1 + s * 9;
    const norm = s > 0 ? Math.tanh(k) : 1;
    for (let i = 0; i < len; i++) {
      const t = i / len;                       // 0..1 across the buffer
      const cVal = Math.cos(2 * Math.PI * t);  // +1 at t=0, -1 at t=0.5, +1 at t=1
      data[i] = s > 0 ? Math.tanh(k * cVal) / norm : cVal;
    }
    return buf;
  }

  // Audio-context time of the next beat boundary, or "now" if the
  // transport isn't currently running (in which case there's no beat
  // grid to align to). Beat grid = songStartTime + n * (60/bpm).
  function nextBeatTime() {
    if (!ctx) return 0;
    const t = ctx.currentTime;
    const songStart = (typeof Transport !== "undefined" && Transport) ? Transport.songStartTime : null;
    if (songStart == null) return t;
    const beatDur = 60 / (lastBpm || DEFAULT_BPM);
    if (!(beatDur > 0)) return t;
    const elapsed = t - songStart;
    // ceil-up: next beat strictly after `t`. If t lands exactly on a
    // beat, skip to the next one so the source has time to schedule.
    const n = Math.max(1, Math.ceil(elapsed / beatDur));
    return songStart + n * beatDur;
  }

  // (Re)create the pump LFO source for a track. AudioBufferSourceNode
  // can only be started once, so any change to sharpness, playbackRate,
  // or phase requires building a fresh source. We start the new one at
  // the next beat boundary, then stop the old one a hair later for a
  // clean handoff with no clicks. Buffer is only regenerated when
  // sharpness actually changed (saves work on pure BPM/rate changes).
  function rebuildPumpLFO(chain, opts = {}) {
    if (!ctx || !chain || !chain.pumpShape) return;
    const ns = opts.sharpness != null
      ? Math.max(0, Math.min(1, opts.sharpness))
      : (chain._pumpSharpness ?? 0.5);
    if (!chain.pumpLFOBuffer || ns !== chain._pumpSharpness) {
      chain.pumpLFOBuffer = makePumpLFOBuffer(ctx, ns);
      chain._pumpSharpness = ns;
    }
    const src = ctx.createBufferSource();
    src.buffer = chain.pumpLFOBuffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = 1;
    const pr = opts.playbackRate != null
      ? opts.playbackRate
      : (chain.pumpLFO ? chain.pumpLFO.playbackRate.value : (lastBpm / 60));
    src.playbackRate.value = pr;
    src.connect(chain.pumpShape);
    const startAt = nextBeatTime();
    try { src.start(startAt); }
    catch { try { src.start(); } catch {} }
    if (chain.pumpLFO) {
      // 1ms later to avoid a sample-perfect overlap edge case
      try { chain.pumpLFO.stop(startAt + 0.001); } catch {}
    }
    chain.pumpLFO = src;
  }

  // Public: no-op now that the pump LFO is back on OscillatorNode (which
  // is free-running and has no phase-lock hook). Left as a stub so
  // Transport.start's Audio.realignAllPumpLFOs?.() call doesn't
  // ReferenceError. Re-implement once a phase-lock strategy is designed
  // that doesn't break basic audio.
  function realignAllPumpLFOs() { /* no-op */ }

  function ensureTrackChain(trackId) {
    if (trackChains.has(trackId)) return trackChains.get(trackId);
    const c = ensure();
    const isVocals = trackId === "vocals";

    const input = c.createGain();

    // Pitch shifter — splices into the chain right after `input`. Shifts
    // pitch without changing playback speed (unlike the old detune-based
    // approach which sped the sample up/down). Bypass-clean when cents=0
    // via a dry/wet crossfade.
    const pitchShifter = createPitchShifter(c);
    input.connect(pitchShifter.input);
    const afterPitch = pitchShifter.output;

    // Drive (WaveShaper, tanh soft saturation) — dry/wet via parallel gains.
    const driveShaper = c.createWaveShaper();
    driveShaper.curve = makeDriveCurve(0);
    driveShaper.oversample = "2x";
    const driveDry = c.createGain(); driveDry.gain.value = 1;
    const driveWet = c.createGain(); driveWet.gain.value = 0;
    afterPitch.connect(driveDry);
    afterPitch.connect(driveShaper);
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
    // Wired as a PARALLEL wet/dry split — when the pump knob is 0 the audio
    // bypasses the compressor entirely (no knee attenuation, no surprises).
    // The LFO modulates the compressor threshold (more compression on the
    // beat) and an extra gain stage (louder on the beat).
    const pumpComp = c.createDynamicsCompressor();
    pumpComp.threshold.value = 0;
    pumpComp.knee.value = 0;          // hard knee → truly transparent below threshold
    pumpComp.ratio.value = 6;
    pumpComp.attack.value = 0.005;
    pumpComp.release.value = 0.1;

    const pumpVol = c.createGain();
    pumpVol.gain.value = 1.0;

    // Pump LFO: reverted to the pre-phase-lock OscillatorNode + WaveShaper
    // approach because the buffer-source implementation appears to be
    // breaking sample audio playback entirely on some browsers (issue
    // report: "sample pads don't play anything"). Restoring the known-
    // working free-running oscillator; phase-lock to the beat will be
    // re-attempted with a safer strategy once we've confirmed audio is
    // healthy again.
    const pumpLFO = c.createOscillator();
    pumpLFO.type = "sine";
    pumpLFO.frequency.value = lastBpm / 60;
    const pumpShape = c.createWaveShaper();
    pumpShape.curve = makeLFOShapeCurve(0.5);
    pumpLFO.connect(pumpShape);
    const pumpCompDepth = c.createGain();
    pumpCompDepth.gain.value = 0;
    pumpShape.connect(pumpCompDepth);
    pumpCompDepth.connect(pumpComp.threshold);
    const pumpVolDepth = c.createGain();
    pumpVolDepth.gain.value = 0;
    pumpShape.connect(pumpVolDepth);
    pumpVolDepth.connect(pumpVol.gain);
    try { pumpLFO.start(); } catch {}
    // Legacy fields kept so any lingering references (rebuildPumpLFO,
    // Transport.start hook) no-op cleanly without ReferenceErrors.
    const pumpLFOBuffer = null;

    // Pump dry/wet mix gains. dry = 1 by default (audio passes untouched);
    // wet = 0 (compressor branch is muted). setPumpParams crossfades these
    // based on the main pump knob so knob=0 means literal bypass.
    const pumpDry = c.createGain(); pumpDry.gain.value = 1;
    const pumpWet = c.createGain(); pumpWet.gain.value = 0;
    volume.connect(pumpDry);
    volume.connect(pumpComp);
    pumpComp.connect(pumpVol);
    pumpVol.connect(pumpWet);
    const afterPump = c.createGain();
    pumpDry.connect(afterPump);
    pumpWet.connect(afterPump);

    const output = c.createGain();
    afterPump.connect(output);
    // Mute gain: a final stage we can ramp to 0 to silence the whole track
    // without disturbing any of the per-effect dry/wet settings. Default 1
    // so unmuted tracks pass through untouched.
    const muteGain = c.createGain();
    muteGain.gain.value = 1;
    output.connect(muteGain);
    muteGain.connect(c.destination);

    const chain = {
      input, output, muteGain,
      driveShaper, driveDry, driveWet,
      distShaper, distDry, distWet,
      filter,
      vibratoLFO, vibratoDepth,
      delayNode, delayFb, delayWet,
      echoNode, echoFb, echoWet,
      reverb, reverbWet,
      // afterEcho is the node feeding the convolver — keep a reference so
      // setReverbParams can disconnect+recreate the convolver when the IR
      // changes (more reliable than mutating `.buffer` on a live node).
      _reverbInput: afterEcho,
      compressor,
      robot,
      volume,
      pumpLFO, pumpShape, pumpCompDepth, pumpVolDepth, pumpComp, pumpVol,
      pumpDry, pumpWet,
      // Track the active buffer + sharpness so rebuildPumpLFO can decide
      // whether to regenerate the buffer or just re-instantiate the source
      // (e.g. on BPM change → same shape, new playbackRate).
      pumpLFOBuffer,
      _pumpSharpness: 0.5,
      // afterPump is preserved so the lazy tone sub-chain can splice in
      // when a -tonejs effect first gets engaged. Until then the native
      // chain runs untouched: afterPump → output → muteGain → destination.
      _afterPump: afterPump,
      pitchShifter,
      _pumpRateBeats: 1, // cached so updateBpm can re-derive LFO Hz
      // Tone.js sub-chain — built lazily on first Tone-effect use.
      // ensureToneSubChain() creates toneIn/toneOut and rewires:
      //   afterPump → toneIn → toneOut → output (replacing the direct
      //   afterPump → output connection).
      // toneWrappers holds the external dry/wet split (input, dry, wet,
      // output GainNodes) per effect — wet=0 = literal bypass.
      toneIn: null,
      toneOut: null,
      toneNodes: new Map(),
      toneWrappers: new Map(),
      toneOrder: [],
    };
    trackChains.set(trackId, chain);
    return chain;
  }

  // Splice the lazy tone sub-chain into a track on demand. Pre-condition:
  // native chain currently has afterPump → output. We disconnect that,
  // create toneIn/toneOut gain nodes, and rewire to:
  //   afterPump → toneIn → toneOut → output
  // Subsequent ensureToneEffectInChain() calls then insert Tone nodes
  // between toneIn and toneOut. If anything throws, we restore the
  // original direct connection so audio keeps flowing.
  function ensureToneSubChain(chain) {
    if (chain.toneIn && chain.toneOut) return true;
    try {
      const toneIn  = ctx.createGain();
      const toneOut = ctx.createGain();
      // Break the direct connection first…
      try { chain._afterPump.disconnect(chain.output); } catch {}
      // …then wire afterPump → toneIn → toneOut → output.
      chain._afterPump.connect(toneIn);
      toneIn.connect(toneOut);
      toneOut.connect(chain.output);
      chain.toneIn  = toneIn;
      chain.toneOut = toneOut;
      return true;
    } catch (err) {
      console.warn("[tone] sub-chain wiring failed; restoring direct path", err);
      try { chain._afterPump.connect(chain.output); } catch {}
      chain.toneIn = null;
      chain.toneOut = null;
      return false;
    }
  }

  // One-time bridge between Tone.js and our AudioContext. Called lazily
  // from ensureToneEffectInChain — only when the user actually engages
  // a -tonejs effect. Doing this eagerly in ensure() caused all audio
  // to go silent on some Tone versions because wrapping a running
  // AudioContext disrupts existing graph connections; deferring it
  // means native-only sessions never touch Tone's internals at all.
  let _toneBound = false;
  function bindToneToOurContext() {
    if (_toneBound) return true;
    if (typeof window === "undefined" || !window.Tone || !ctx) return false;
    try {
      window.Tone.setContext(ctx);
      _toneBound = true;
      return true;
    } catch (err) {
      console.warn("[tone] setContext failed", err);
      return false;
    }
  }

  // Splice a Tone.js effect into the track's tone sub-chain. The lazy
  // approach keeps unused -tonejs effects at zero CPU cost. The first
  // time a given effect name is requested we:
  //   1. Bind Tone to our AudioContext (one-time, on first Tone use).
  //   2. Build the Tone node (via the TONE_EFFECTS registry).
  //   3. Break the current trailing-edge connection (lastNode → toneOut).
  //   4. Insert: lastNode → newNode → toneOut.
  //   5. Remember the node + its position so we don't double-insert.
  // Returns null if Tone.js isn't loaded (CDN failed) or the registry
  // doesn't recognize the name. Callers should bail silently in that case.
  function ensureToneEffectInChain(trackId, name) {
    if (typeof window === "undefined" || !window.Tone) return null;
    if (!isToneEffect(name)) return null;
    if (!bindToneToOurContext()) return null;
    const chain = ensureTrackChain(trackId);
    if (!chain) return null;
    if (chain.toneNodes.has(name)) return chain.toneNodes.get(name);
    // First Tone effect on this track: splice the tone sub-chain in.
    if (!ensureToneSubChain(chain)) return null;
    const def = TONE_EFFECTS[name];
    let node;
    try { node = def.create(window.Tone, ctx); }
    catch (err) { console.warn("[tone] create failed:", name, err); return null; }
    if (!node) return null;

    // We DO NOT rely on Tone's internal dry/wet to bypass the effect when
    // the user sets wet=0. Some Tone effects route the "dry" signal
    // through their internal mixers in a way that subtly alters it
    // (latency, phase, level), so "wet=0" doesn't sound identical to no
    // effect at all. Instead we force Tone's internal wet to 1 and wrap
    // each Tone node in an external parallel dry/wet split that matches
    // the native-effect pattern:
    //
    //   wrapInput ──► wrapDry  (gain = 1 - wet)        ─┐
    //         │                                        wrapOutput
    //         └──► toneNode (wet=1) ──► wrapWet (= wet) ┘
    //
    // At user wet=0 the audio passes through wrapDry only — the Tone
    // node's output is multiplied by 0 before summing, so its quirks
    // can't reach the mix at all. At user wet=1 the dry branch is
    // muted and only the processed signal reaches the output.
    try { if (node.wet && "value" in node.wet) node.wet.value = 1; } catch {}

    const wrapInput  = ctx.createGain();
    const wrapDry    = ctx.createGain(); wrapDry.gain.value = 1;
    const wrapWet    = ctx.createGain(); wrapWet.gain.value = 0;
    const wrapOutput = ctx.createGain();
    // Native-side wiring of the wrapper. node.input / node.output are
    // Tone wrappers, so we drill down to the raw AudioNodes first.
    const nodeInNative  = nativeInputOf(node);
    const nodeOutNative = nativeOutputOf(node);
    wrapInput.connect(wrapDry);
    wrapInput.connect(nodeInNative);
    nodeOutNative.connect(wrapWet);
    wrapDry.connect(wrapOutput);
    wrapWet.connect(wrapOutput);

    // Splice the wrapper into the existing tone sub-chain. The "tail" is
    // whatever currently feeds toneOut — either chain.toneIn (first
    // insert) or the previous wrapper's output (subsequent inserts).
    const tail = chain.toneOrder.length === 0
      ? chain.toneIn
      : chain.toneWrappers.get(chain.toneOrder[chain.toneOrder.length - 1]).output;
    try { tail.disconnect(chain.toneOut); } catch {}
    try { tail.connect(wrapInput); }
    catch (err) { console.warn("[tone] connect tail→wrapper failed:", name, err); }
    try { wrapOutput.connect(chain.toneOut); }
    catch (err) { console.warn("[tone] connect wrapper→toneOut failed:", name, err); }

    chain.toneNodes.set(name, node);
    chain.toneWrappers.set(name, { input: wrapInput, dry: wrapDry, wet: wrapWet, output: wrapOutput });
    chain.toneOrder.push(name);
    return node;
  }

  // Drill through Tone wrappers (Tone.Effect.input → Tone.Gain → native
  // GainNode) to reach the underlying native AudioNode. A native node
  // has no .input property, so the loop exits immediately for it. For a
  // Tone effect: effect.input is a Tone.Gain, whose .input is the
  // wrapped native GainNode. We loop until x has no further .input.
  function nativeInputOf(x) {
    if (!x) return x;
    let cur = x;
    let guard = 8;
    while (cur && (typeof AudioNode === "undefined" || !(cur instanceof AudioNode))
                && cur.input !== undefined && cur.input !== cur && guard-- > 0) {
      cur = cur.input;
    }
    return cur;
  }
  function nativeOutputOf(x) {
    if (!x) return x;
    let cur = x;
    let guard = 8;
    while (cur && (typeof AudioNode === "undefined" || !(cur instanceof AudioNode))
                && cur.output !== undefined && cur.output !== cur && guard-- > 0) {
      cur = cur.output;
    }
    return cur;
  }

  // Push one resolved param value to a tone effect's live node. Called per
  // param (the dispatcher in applyEffectToAudio iterates the schema and
  // calls in here for each). "wet" is handled centrally since every Tone
  // effect exposes a .wet AudioParam with identical semantics.
  function setToneEffectParam(trackId, name, paramKey, value) {
    if (!isToneEffect(name)) return;
    const node = ensureToneEffectInChain(trackId, name);
    if (!node) return;
    const chain = trackChains.get(trackId);
    const t = (ctx && ctx.currentTime) || 0;
    const RAMP = 0.006;
    if (paramKey === "wet") {
      // "wet" controls our EXTERNAL wrapper's parallel dry/wet — NOT
      // Tone's internal wet (which we keep pinned at 1 in
      // ensureToneEffectInChain). At v=0 the wet gain hits 0 and the
      // dry gain hits 1, so the Tone node's output is completely muted
      // and the original signal passes through unaltered.
      const wrapper = chain && chain.toneWrappers.get(name);
      if (!wrapper) return;
      const v = Math.max(0, Math.min(1, value));
      const snap = (param, target) => {
        try {
          param.cancelScheduledValues(t);
          param.setValueAtTime(param.value, t);
          param.linearRampToValueAtTime(target, t + RAMP);
          // Hard-anchor the post-ramp value so nothing drifts back later.
          // Some Tone-side activity can otherwise schedule competing
          // automation on the same param. Belt-and-suspenders.
          param.setValueAtTime(target, t + RAMP + 0.001);
        } catch {
          try { param.value = target; } catch {}
        }
      };
      snap(wrapper.dry.gain, 1 - v);
      snap(wrapper.wet.gain, v);
      // Also pin the Tone node's INTERNAL wet to 1 every time we touch
      // dry/wet. If anything elsewhere (Tone's own scheduler, a stale
      // automation, etc.) tries to move that internal wet away from 1,
      // we re-pin it. The audible mix is still controlled externally.
      try {
        if (node.wet && node.wet.cancelScheduledValues) node.wet.cancelScheduledValues(t);
        if (node.wet && "value" in node.wet) node.wet.value = 1;
      } catch {}
      return;
    }
    const def = TONE_EFFECTS[name];
    try { def.apply(node, paramKey, value); }
    catch (err) { console.warn("[tone] apply failed:", name, paramKey, err); }
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
      case "pitch": {
        // Bipolar pitch shift:
        //   v = 0   → -1200 cents (one octave down)
        //   v = 0.5 → 0 cents (no shift, default)
        //   v = 1   → +1200 cents (one octave up)
        // Playback SPEED is preserved — the in-chain pitch shifter does
        // time-domain granular pitch shifting (Jungle technique).
        const cents = (v - 0.5) * 2 * 1200; // ±1200
        if (chain.pitchShifter) chain.pitchShifter.setCents(cents);
        break;
      }
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
      // Pump LFO — reverted to OscillatorNode-based. Beat-synced via a
      // smooth frequency ramp: rate is stored in beats-per-cycle so the
      // actual Hz has to be recomputed whenever BPM changes.
      if (chain.pumpLFO && chain.pumpLFO.frequency && chain._pumpRateBeats != null) {
        chain.pumpLFO.frequency.setTargetAtTime((bpm / 60) * chain._pumpRateBeats, t, tc);
      }
    }
  }

  // Pump: LFO-driven compression + volume modulation.
  //   mainKnob   — 0..1 the pump's main knob value. Crossfades the dry/wet
  //                mix so 0 = pure bypass (no compressor in the path).
  //   compAmount — 0..1 depth of threshold modulation.
  //   volAmount  — 0..1 depth of gain modulation.
  //   rate       — LFO frequency in beats per cycle (1 = once per beat).
  //   intensity  — 0..1 LFO shape (sine → near-square).
  function setPumpParams(trackId, mainKnob, compAmount, volAmount, rate, intensity) {
    const chain = ensureTrackChain(trackId);
    if (!ctx) return;
    const t = ctx.currentTime;
    const k = Math.max(0, Math.min(1, mainKnob));
    // Snap (very short linear ramp instead of a hard step so Chrome's
    // render thread doesn't crackle on the transition). 6ms is below
    // perception as a glide.
    const RAMP = 0.006;
    const snap = (param, value) => {
      try { param.cancelScheduledValues(t); } catch {}
      try { param.setValueAtTime(param.value, t); } catch {}
      try { param.linearRampToValueAtTime(value, t + RAMP); }
      catch { try { param.setValueAtTime(value, t); } catch {} }
    };
    // Dry/wet crossfade — k=0 is literal bypass (audio skips the compressor
    // entirely), k=1 is fully through the compressor branch.
    snap(chain.pumpDry.gain, 1 - k);
    snap(chain.pumpWet.gain, k);
    // Negative depth so LFO peak pulls threshold DOWN (more compression on
    // the beat). When LFO peaks, threshold ≈ -35dB at full depth.
    snap(chain.pumpCompDepth.gain, -compAmount * 35);
    snap(chain.pumpVolDepth.gain, volAmount * 0.5);
    chain._pumpRateBeats = rate;
    // Rate ramp on the OscillatorNode frequency + shape rewrite on the
    // WaveShaper curve. Both are smoothly ramped so audio doesn't click.
    if (chain.pumpLFO && chain.pumpLFO.frequency) {
      snap(chain.pumpLFO.frequency, (lastBpm / 60) * rate);
    }
    if (chain.pumpShape && chain.pumpShape.curve !== undefined) {
      try { chain.pumpShape.curve = makeLFOShapeCurve(Math.max(0, Math.min(1, intensity))); } catch {}
    }
  }

  // Reverb has 3 sub-parameters: wet (0..2 gain), size (IR duration in
  // seconds), release (decay exponent). Wet is cheap (a gain ramp); size and
  // release require regenerating the impulse response — we cache the last
  // values per chain and only rebuild when they change by a meaningful
  // amount, since IR generation isn't free.
  function setReverbParams(trackId, wet, size, release, opts = {}) {
    const chain = ensureTrackChain(trackId);
    if (!ctx) return;
    const t = ctx.currentTime;
    // Wet gain — short ramp to avoid Chrome render-thread clicks.
    const target = Math.max(0, wet);
    try { chain.reverbWet.gain.cancelScheduledValues(t); } catch {}
    try { chain.reverbWet.gain.setValueAtTime(chain.reverbWet.gain.value, t); } catch {}
    try { chain.reverbWet.gain.linearRampToValueAtTime(target, t + 0.006); }
    catch { try { chain.reverbWet.gain.setValueAtTime(target, t); } catch {} }
    // Detect whether anything that affects the IR shape has changed.
    // The IR is expensive to regenerate so we skip when only `wet`
    // moves. Tolerances chosen to ignore micro-drag noise.
    const preDelay = Number.isFinite(opts.preDelay) ? opts.preDelay : null;
    const buildup  = Number.isFinite(opts.buildup)  ? opts.buildup  : null;
    const damping  = Number.isFinite(opts.damping)  ? opts.damping  : null;
    const close = (a, b, eps) => Math.abs((a ?? -999) - (b ?? -999)) <= eps;
    const sizeChanged    = !close(chain._lastReverbSize, size, 0.02);
    const relChanged     = !close(chain._lastReverbRel,  release, 0.02);
    const preDelayChanged = !close(chain._lastReverbPreDelay, preDelay, 0.5);
    const buildupChanged  = !close(chain._lastReverbBuildup,  buildup,  1);
    const dampingChanged  = !close(chain._lastReverbDamping,  damping,  0.01);
    const willRebuild = sizeChanged || relChanged
                       || preDelayChanged || buildupChanged || dampingChanged;
    if (willRebuild) {
      chain._lastReverbSize     = size;
      chain._lastReverbRel      = release;
      chain._lastReverbPreDelay = preDelay;
      chain._lastReverbBuildup  = buildup;
      chain._lastReverbDamping  = damping;
      try {
        const newReverb = ctx.createConvolver();
        newReverb.normalize = true;
        newReverb.buffer = makeReverbIR(ctx, {
          size, release,
          preDelay, buildup, damping,
        });
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

  // Mute / unmute a whole track. Short ramp avoids audible clicks. We do NOT
  // stop any voices on the track — they keep running silently so the playhead
  // and the waveform animation stay in sync, matching the visual "still
  // moving but dimmed" behavior the UI shows.
  function setTrackMuted(trackId, muted) {
    if (!ctx) return;
    const chain = ensureTrackChain(trackId);
    const target = muted ? 0 : 1;
    const t = ctx.currentTime + 0.01;
    chain.muteGain.gain.setTargetAtTime(target, t, 0.02);
  }

  return {
    play, playSync, stopAll, stopTrack, stopPad, scheduleStopPad, isPadPlaying,
    loadSample, getPeaks, getBandPeaks, hasBuffer, getBufferDuration, evict, progressFor,
    nowCtx, hasCtx, outputLatency, warmUp,
    setEffectParam, setReverbParams, setPumpParams, updateBpm, ensureTrackChain, trackInputNode,
    setTrackMuted,
    // Called by Transport.start so the phase-locked pump LFOs lock onto
    // the new beat grid the instant the song starts playing — otherwise
    // they'd stay aligned to the previous transport (or "now" if it
    // was never started).
    realignAllPumpLFOs,
    // Tone.js bridge: callers in applyEffectToAudio route each resolved
    // param value through this. Builds the underlying Tone node on first
    // use and keeps it on the chain afterward.
    setToneEffectParam,
    // True if a -tonejs effect's wrapper is already live on a track. Used
    // by applyEffectToAudio to decide whether to re-apply baseline values
    // on a pad-release path (so the wrapper's wet snaps back to 0) even
    // when the effect isn't in the track's enabledEffects list.
    hasToneEffectOnTrack: (trackId, name) => {
      const c = trackChains.get(trackId);
      return !!(c && c.toneNodes && c.toneNodes.has(name));
    },
    // Exposed so applyChainParams (which lives outside this IIFE) can
    // rebuild the wave-shaper curves for drive / distortion without
    // duplicating the math.
    makeDriveCurve, makeDistortionCurve,
  };
})();

// ───────── Global transport ─────────
// Song starts when the first sample is launched and runs continuously,
// looping every TIMELINE_BEATS at the song's BPM.
const Transport = {
  songStartTime: null,
  start(when) {
    if (this.songStartTime === null) {
      this.songStartTime = when;
      // Hand the new beat grid to the phase-locked pump LFOs so their
      // peak lands exactly on every beat from here forward.
      try { Audio.realignAllPumpLFOs && Audio.realignAllPumpLFOs(); } catch {}
    }
  },
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
window.addEventListener("hashchange", () => {
  // Flush any pending debounced save BEFORE we tear down the editor and
  // re-load the song from localStorage. Without this, uploading samples
  // and immediately clicking "perform" loses the samples — the 400ms
  // debounce hasn't fired yet, so localStorage still has the empty
  // version, and the next route reload reads that stale copy. Calling
  // persist() synchronously here guarantees the in-memory editor.song
  // is what the next render reads back.
  if (editor && editor.dirty) {
    try {
      clearTimeout(_schedulePersistTimer);
      _schedulePersistTimer = null;
      persist({ silent: true });
    } catch (err) {
      console.warn("[route] flush persist failed", err);
    }
  }
  // If we're switching between perform <-> edit on the SAME song, keep
  // the audio + transport alive across the transition (no stop on mode
  // switch). Stash the playing-voice metadata so the new editor instance
  // can pick up where the old one left off (playheads in free mode read
  // editor.playing for their anchor; pad highlights are sourced from
  // Audio.isPadPlaying which already survives editor teardown).
  const r = route();
  const isEditor = r.name === "song" || r.name === "songEdit";
  const sameSongModeSwitch = !!editor && isEditor && editor.song?.id === r.id;
  if (sameSongModeSwitch) {
    _editorCarry = {
      songId: editor.song.id,
      playing: editor.playing,
      pendingApplies: editor.pendingApplies,
      areaTab: editor.areaTab,
      areaEffectFocus: editor.areaEffectFocus,
      performPadFocus: editor.performPadFocus,
      performActiveStack: editor.performActiveStack,
      performHeldPads: editor.performHeldPads,
      activeBank: editor.activeBank,
    };
  } else {
    _editorCarry = null;
  }
  teardownEditor({ keepAudio: sameSongModeSwitch });
  render();
});

// Suppress the native context menu (right-click on desktop, long-press
// on tablet) everywhere in the app. Every interaction here is driven by
// pointer events — the native menu is never useful, just gets in the
// way (especially on the tablet, where long-press otherwise pops up
// "copy" / "share" sheets that break the perform-pad hold gesture).
document.addEventListener("contextmenu", (e) => e.preventDefault());

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
  if (r.name === "new") {
    // Show the song list behind the chooser modal so the user has context
    // (so a deep-link reload to #/new still renders the home grid first).
    renderHome();
    return openCreateOrImportModal();
  }
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
        el("div", { class: "home-head-actions" },
          el("button", { class: "btn ghost", onclick: openExportModal }, "export"),
        ),
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
        el("div", { class: "home-head-actions" },
          el("button", { class: "btn ghost", onclick: openExportModal }, "export"),
        ),
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
  const filledTracks = new Set();
  eachPadInSong(song, (pad, trackId) => {
    if (pad?.sampleId) filledTracks.add(trackId);
  });
  const strip = el("div", { class: "tile-row-strip" });
  for (const t of TRACKS) {
    const filled = filledTracks.has(t.id);
    strip.appendChild(el("span", { style: `background: ${filled ? `var(--row-${t.id})` : "var(--line)"}` }));
  }
  return el("div", {
    class: "tile",
    onclick: () => (location.hash = targetHash),
    // Right-click (and long-press on touch) opens a song context menu with
    // an Export entry.
    oncontextmenu: (e) => {
      e.preventDefault();
      showSongContextMenu(song, e.clientX, e.clientY);
    },
  },
    strip,
    el("div", { class: "tile-name" }, song.name),
    el("div", { class: "tile-meta" }, timeago(song.updatedAt)),
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

// Floating menu shown on right-click of a song tile. One option for now —
// "export" — runs the same exportSongToFile path the main export modal uses
// so individual songs can be exported with a single click.
function showSongContextMenu(song, x, y) {
  document.querySelector(".song-context-menu")?.remove();
  const menu = el("div", {
    class: "song-context-menu",
    style: `left: ${Math.round(x)}px; top: ${Math.round(y)}px;`,
  },
    el("button", {
      class: "context-menu-item",
      onclick: async () => {
        menu.remove();
        try {
          const r = await exportSongToFile(song);
          toast(r?.method === "library"
            ? `published "${song.name}" to library`
            : `exported "${song.name}"`);
        } catch (err) {
          console.warn("export failed", err);
          toast("export failed");
        }
      },
    }, "export"),
  );
  document.body.appendChild(menu);
  // Keep the menu inside the viewport.
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth)  menu.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) menu.style.top  = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  });
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("mousedown", close);
      document.removeEventListener("contextmenu", close);
      document.removeEventListener("keydown", onKey);
    }
  };
  const onKey = (e) => { if (e.key === "Escape") menu.remove(); };
  setTimeout(() => {
    document.addEventListener("mousedown", close);
    document.addEventListener("contextmenu", close);
    document.addEventListener("keydown", onKey);
  }, 0);
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
  const seen = new Set();
  eachPadInSong(song, (pad) => {
    const sid = pad?.sampleId;
    if (!sid || seen.has(sid)) return;
    seen.add(sid);
    tasks.push(Audio.getPeaks(sid).catch(() => null));
  });
  return Promise.all(tasks);
}

// When switching between perform <-> edit on the same song, we tear down
// the editor object but keep the audio + transport alive so the song never
// stops. The relevant per-voice metadata is stashed here and restored by
// the next renderEditor call.
let _editorCarry = null;

function teardownEditor(opts = {}) {
  if (!editor) return;
  if (editor.raf) cancelAnimationFrame(editor.raf);
  if (!opts.keepAudio) {
    Audio.stopAll();
    Transport.stop();
    // Hand the Launchpad back to its Live mode so the device works
    // normally outside the app. Same-song mode swap keeps audio AND
    // keeps the lights — only a real exit (different song or back to
    // home) tears the Launchpad down.
    lpShutdown();
  }
  window.removeEventListener("resize", onResize);
  editor = null;
}

function renderEditor(song, mode = "performance") {
  // Same-song mode swap: hashchange already tore down the editor with
  // keepAudio=true so audio kept playing. Defensive teardown here mirrors
  // that — if for any reason editor is still alive (e.g. direct call),
  // honor the carry-over flag.
  const carry = (_editorCarry && _editorCarry.songId === song.id) ? _editorCarry : null;
  _editorCarry = null;
  if (editor) teardownEditor({ keepAudio: !!carry });

  editor = {
    song,
    mode,                    // "performance" | "edit"
    dirty: false,
    raf: null,
    playing: {},
    decks: {},
    pendingApplies: {},
    areaTab: {},             // trackId -> "samples" | "effects" | "perform"
    areaEffectFocus: {},     // trackId -> effect name (e.g. "reverb") when zoomed into params
    performPadFocus: {},     // trackId -> pad idx when editing a perform pad inline
    performActiveStack: {},  // trackId -> { effectKey -> [padIdx,...] } activation stack
    performHeldPads: {},     // trackId -> { padIdx -> true } pads currently held/toggled-on
    midiMapping: false,      // true while the user is in MIDI-mapping mode
    midiMappingSelected: null, // padKey awaiting an incoming MIDI note assignment
    activeBank: {},          // trackId -> bank name (for tracks with banks; vocals only)
    // Waveform view style. "track" = row-color amplitude waveform (default).
    // "freq" = frequency-content coloring + light row-color background tint.
    // Persists across sessions in localStorage.
    viewMode: localStorage.getItem("beatstudio.viewMode") === "freq" ? "freq" : "track",
  };
  // Migrate any legacy padBanks/pads structures into the new `banks` array.
  ensureSongBanks(song);
  for (const t of TRACKS) {
    editor.playing[t.id] = {};
    editor.areaTab[t.id] = "samples";
    editor.areaEffectFocus[t.id] = null;
    editor.performPadFocus[t.id] = null;
    editor.performActiveStack[t.id] = {};
    editor.performHeldPads[t.id] = {};
    // Active bank defaults to the first one in the song's bank list.
    editor.activeBank[t.id] = song.banks[t.id][0].id;
    // Live reference: song.pads[trackId] always points at the active bank.
    ensureTrackBankLink(song, t.id, editor.activeBank[t.id]);
  }

  // Same-song mode swap: restore the carried voice metadata + UI state so
  // playheads keep tracking and tab/bank selection survives the swap. The
  // audio sources themselves were never stopped (hashchange used
  // keepAudio=true), so we just need to re-attach the metadata that drives
  // visuals (free-mode rowAnchor reads editor.playing; pendingApplies
  // drives the green-bar-appears-at-audible-time behavior).
  if (carry) {
    if (carry.playing) editor.playing = carry.playing;
    if (carry.pendingApplies) editor.pendingApplies = carry.pendingApplies;
    if (carry.areaTab) {
      for (const k of Object.keys(carry.areaTab)) editor.areaTab[k] = carry.areaTab[k];
    }
    if (carry.areaEffectFocus) {
      for (const k of Object.keys(carry.areaEffectFocus)) {
        editor.areaEffectFocus[k] = carry.areaEffectFocus[k];
      }
    }
    if (carry.performPadFocus) {
      for (const k of Object.keys(carry.performPadFocus)) {
        editor.performPadFocus[k] = carry.performPadFocus[k];
      }
    }
    if (carry.performActiveStack) editor.performActiveStack = carry.performActiveStack;
    if (carry.performHeldPads)    editor.performHeldPads    = carry.performHeldPads;
    if (carry.activeBank) {
      for (const k of Object.keys(carry.activeBank)) {
        // Only restore banks that still exist on this song.
        const banks = songBanksFor(song, k);
        if (banks.some(b => b.id === carry.activeBank[k])) {
          editor.activeBank[k] = carry.activeBank[k];
          ensureTrackBankLink(song, k, editor.activeBank[k]);
        }
      }
    }
  }

  Audio.nowCtx();
  preloadSongSamples(song);
  // Push the song's effect knob values into the per-track audio chains so
  // playback is filtered/wet/etc. according to the saved settings.
  applySongEffectsToAudio(song);
  // Apply per-track mute overrides into the audio chains so previously
  // muted tracks come back silenced on reload.
  for (const t of TRACKS) {
    Audio.setTrackMuted(t.id, isTrackMuted(song, t.id));
  }
  Audio.updateBpm(song.bpm || DEFAULT_BPM);

  // Spin up the MIDI / Launchpad pipeline in the background so the
  // controller's lights are live the moment the editor renders. Boot
  // doesn't await this — we don't want a permission prompt blocking
  // the screen, and the launchpad is fine missing the first few
  // frames of light state.
  if (navigator.requestMIDIAccess) {
    ensureMidiAccess().then(() => lpRefreshLights()).catch(() => {});
  }

  const isMapping = !!editor.midiMapping;
  // Mapping mode forces a perform-style layout regardless of the song's
  // mode — pads stop triggering audio and become select-to-map.
  const isEdit = (mode === "edit") && !isMapping;
  const backHref = mode === "edit" ? "#/edit" : "#/";

  // Build the Stop All button — same look in both normal and mapping
  // mode. In mapping mode it becomes tap-to-select (with a note badge
  // for any existing mapping) instead of immediately stopping.
  const stopAllMapKey = midiKeyForStopAll();
  const stopAllMappedNote = isMapping ? getMidiNoteFor(song, stopAllMapKey) : null;
  const stopAllMapSelected = isMapping && editor.midiMappingSelected === stopAllMapKey;
  const stopAllBtn = el("button", {
    class: "btn ghost stop-all-btn"
      + (isMapping ? " midi-mappable" : "")
      + (stopAllMapSelected ? " midi-map-selected" : ""),
    title: isMapping
      ? (stopAllMappedNote != null
          ? `stop all — mapped to ${midiNoteName(stopAllMappedNote)}`
          : "tap to select, then press a MIDI key")
      : "stop all sounds",
    onclick: () => {
      if (isMapping) {
        const nowSelected = !stopAllMapSelected;
        editor.midiMappingSelected = nowSelected ? stopAllMapKey : null;
        // The header lives outside the side-stacks so rerenderAllAreas
        // doesn't touch it. Toggle the selection class directly on the
        // button so the highlight tracks state without a full re-render.
        stopAllBtn.classList.toggle("midi-map-selected", nowSelected);
        // But other selected items DO live in the side stacks — those
        // need the area refresh to clear their highlight.
        rerenderAllAreas();
        return;
      }
      stopAllAndReset();
    },
  },
    isMapping && stopAllMappedNote != null
      ? el("span", { class: "pad-midi-note" }, midiNoteName(stopAllMappedNote))
      : null,
    "■ stop all",
  );

  const head = isMapping ? el("header",
    { class: "editor-head midi-mapping" },
    el("div", { class: "head-left" },
      el("span", { class: "title-static" }, song.name),
    ),
    el("div", { class: "editor-center" },
      stopAllBtn,
      el("span", { class: "midi-mapping-banner" },
        editor.midiMappingSelected
          ? "press a MIDI key to map…"
          : "MIDI mapping — tap a pad, stop button, or stop all"),
    ),
    el("div", { class: "head-right" },
      el("button", {
        class: "btn ghost",
        onclick: () => openMidiSettingsModal(),
      }, "MIDI settings"),
      el("button", {
        class: "btn mode-toggle edit-target",
        onclick: () => exitMidiMappingMode(),
      }, "exit mapping"),
    ),
  ) : el("header", { class: "editor-head" + (isEdit ? " edit-mode" : "") },
    // LEFT: back link + the song name right next to it (editable input
    // in edit mode, static text in perform).
    el("div", { class: "head-left" },
      el("a", { class: "back-link", href: backHref }, isEdit ? "← edit list" : "← songs"),
      isEdit
        ? el("input", {
            class: "editor-title-input",
            value: song.name,
            oninput: (e) => { song.name = e.target.value; markDirty(); },
            onblur:  () => persist({ silent: true }),
          })
        : el("span", { class: "title-static" }, song.name),
    ),
    // CENTER: stop-all — visible in BOTH modes so the user can always
    // panic-stop without flipping out of edit first. The same button
    // also lives in the mapping-mode header above (built once,
    // rendered into either branch).
    el("div", { class: "editor-center" }, stopAllBtn),
    el("div", { class: "head-right" },
      // Settings gear — second from the right; opens a popup with every
      // edit-time configuration option (BPM, quant, timeline, bar, view,
      // wave height, empty pads). Edit-mode only — none of these apply
      // mid-performance.
      isEdit ? el("button", {
        class: "btn settings-btn",
        title: "settings",
        onclick: () => openSettingsModal(song),
      }, "⚙") : null,
      // Mode toggle — always the rightmost control, same size in both
      // modes. Green when sending you to perform, yellow when sending you
      // to edit (label always reflects the destination action).
      isEdit
        ? el("a", { class: "btn mode-toggle perform-target", href: `#/song/${song.id}`, title: "switch to performance" }, "▶ perform")
        : el("a", { class: "btn mode-toggle edit-target",    href: `#/edit/${song.id}`, title: "switch to edit"        }, "✎ edit"),
    )
  );

  // Hidden tracks are filtered out of perform mode entirely. Edit mode
  // still renders them (faded) so they can be configured / un-hidden.
  const visibleTracks = visibleTracksFor(song, isEdit);
  const left = el("div", { class: "side-stack" },
    visibleTracks.filter(t => t.side === "left").map(t => renderArea(song, t))
  );
  const right = el("div", { class: "side-stack" },
    visibleTracks.filter(t => t.side === "right").map(t => renderArea(song, t))
  );

  const deck = renderResizableDeck(song);

  const body = el("div", { class: "editor-body" }, left, deck, right);

  $app.replaceChildren(el("section",
    { class: "editor"
        + (isEdit ? " edit-mode" : "")
        + (isMapping ? " midi-mapping-mode" : "")
        + (editor.viewMode === "freq" ? " freq-view" : "")
        + (song.hideEmptyPads ? " hide-empty-pads" : "") },
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
    // Sample pads (text + emoji labels) AND perform-pad effect labels
    // all share the same fit-to-parent binary-search sizer. Effect names
    // can be long ("compression", "distortion") relative to the small
    // perform-pad squares, so this is where they get shrunk to fit.
    const selectors = ".pad-name, .pad-emoji, .perform-pad-effect";
    for (const span of document.querySelectorAll(selectors)) {
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

// Quantize mode: how a late tap is handled.
//   "wait" (default) — snap forward to the next beat. The user waits up
//                       to one grid period before audio starts.
//   "catch"          — start the new sample IMMEDIATELY but skip into
//                       it by the amount of time we're past the last
//                       beat. The first few ms are lost but the
//                       sample stays in sync with everything else.
function getQuantizeMode(song) {
  return song?.quantizeMode === "catch" ? "catch" : "wait";
}
function setQuantizeMode(value) {
  if (!editor) return;
  const song = editor.song;
  const next = value === "catch" ? "catch" : "wait";
  if (getQuantizeMode(song) === next) return;
  song.quantizeMode = next;
  markDirty();
  persist({ silent: true });
}

// Toggle whether empty pads are hidden in performance mode. Persisted per
// song; default off (empty pads visible). Updates the editor section's
// CSS class so the change is live without a full re-render and updates the
// active state on the header toggle group.
function setHideEmptyPads(value) {
  if (!editor) return;
  const next = !!value;
  if (editor.song.hideEmptyPads === next) return;
  editor.song.hideEmptyPads = next;
  markDirty();
  persist({ silent: true });
  const ed = document.querySelector(".editor");
  if (ed) ed.classList.toggle("hide-empty-pads", next);
  document.querySelectorAll("[data-empty-pads]").forEach(btn => {
    btn.classList.toggle(
      "active",
      (btn.dataset.emptyPads === "hide") === next,
    );
  });
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
  document.querySelectorAll("[data-view]").forEach(btn => {
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
  const oldDeck = body && body.querySelector(".deck-resize-wrap, .deck");
  if (body && oldDeck) {
    const newDeck = renderResizableDeck(editor.song);
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
  const oldDeck = body && body.querySelector(".deck-resize-wrap, .deck");
  if (body && oldDeck) {
    const newDeck = renderResizableDeck(editor.song);
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
  document.querySelectorAll("[data-quant]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.quant === song.quantize);
  });
  document.querySelectorAll("[data-tlmode]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tlmode === timelineMode(song));
  });
  document.querySelectorAll("[data-bars]").forEach(btn => {
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
  const performFocus = editor?.performPadFocus?.[track.id];
  const performFocusPad = (tab === "perform" && performFocus != null)
    ? getPerformPad(song, track.id, performFocus) : null;
  const isEdit = editor?.mode === "edit";
  const trackLabel = getTrackLabel(song, track);
  const trackColor = getTrackColor(song, track);

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
  } else if (tab === "perform" && performFocusPad) {
    // Editing one perform pad — same compact "back" head pattern as the
    // effect zoom view.
    head = el("div", { class: "area-head effect-zoom-head" },
      el("button", {
        class: "effect-back-btn",
        onclick: () => closePerformPadFocus(track),
        title: "back to perform pads",
      }, "← back"),
      el("span", { class: "area-name" }, `pad ${performFocus + 1}: ${performFocusPad.effect}`),
    );
  } else {
    // Track name: clickable in edit mode (rename). Color swatch sits next
    // to it in edit mode and pops a native color picker on click.
    const nameEl = el("span", {
      class: "area-name" + (isEdit ? " editable" : ""),
      title: isEdit ? "click to rename track" : null,
      onclick: isEdit ? () => renameTrack(track) : null,
    }, trackLabel);
    const colorSwatch = isEdit ? el("input", {
      class: "area-color-swatch",
      type: "color",
      value: resolveCssColorToHex(trackColor),
      title: "click to change track color",
      oninput: (e) => changeTrackColor(track, e.target.value),
    }) : null;
    const hidden = isTrackHidden(song, track.id);
    const hideBtn = isEdit ? el("button", {
      class: "area-hide-toggle" + (hidden ? " is-hidden" : ""),
      title: hidden
        ? "this part is hidden in performance mode — click to show"
        : "hide this part in performance mode",
      onclick: () => toggleTrackHidden(track),
    }, hidden ? "show" : "hide") : null;

    // Mute / Stop controls — always visible on every song part, centered on
    // top, side by side, same size. Mute silences the track (waveform dims,
    // playhead keeps moving); Stop kills the voices on that track. In MIDI
    // mapping mode the Stop button becomes selectable so the user can bind
    // it to a controller key.
    const muted = isTrackMuted(song, track.id);
    const muteBtn = el("button", {
      class: "area-mute-btn" + (muted ? " is-muted" : ""),
      title: muted ? "unmute this part" : "mute this part",
      onclick: () => toggleTrackMute(track),
    }, "Mute");

    const isMapping = !!editor?.midiMapping;
    const stopMapKey = midiKeyForStopTrack(track.id);
    const stopMappedNote = isMapping ? getMidiNoteFor(song, stopMapKey) : null;
    const stopMapSelected = isMapping && editor.midiMappingSelected === stopMapKey;
    const stopBtn = el("button", {
      class: "area-stop-btn"
        + (isMapping ? " midi-mappable" : "")
        + (stopMapSelected ? " midi-map-selected" : ""),
      title: isMapping
        ? (stopMappedNote != null
            ? `stop ${getTrackLabel(song, track)} — mapped to ${midiNoteName(stopMappedNote)}`
            : "tap to select, then press a MIDI key")
        : "stop this part",
      onclick: () => {
        if (isMapping) {
          editor.midiMappingSelected = stopMapSelected ? null : stopMapKey;
          rerenderAllAreas();
          return;
        }
        stopTrackAndUpdateVisuals(track.id);
      },
    },
      isMapping && stopMappedNote != null
        ? el("span", { class: "pad-midi-note" }, midiNoteName(stopMappedNote))
        : null,
      "Stop");

    // Single tab toggle. Cycles samples → effects → perform → samples.
    // The label always shows the mode you'll switch TO so the affordance
    // is obvious without an explicit active indicator. Chevron on the
    // right hints at the cycling behavior.
    const tabCycle = ["samples", "effects", "perform"];
    const tabIdx = Math.max(0, tabCycle.indexOf(tab));
    const nextTab = tabCycle[(tabIdx + 1) % tabCycle.length];
    const tabToggle = el("button", {
      class: "area-tab-toggle",
      title: `switch to ${nextTab}`,
      onclick: () => switchAreaTab(track, nextTab),
    },
      el("span", { class: "area-tab-toggle-label" }, nextTab),
      el("span", { class: "area-tab-toggle-chevron", "aria-hidden": "true" }, "›"),
    );

    head = el("div", { class: "area-head" },
      el("div", { class: "area-head-left" }, nameEl, colorSwatch, hideBtn),
      el("div", { class: "area-head-center" }, muteBtn, stopBtn),
      el("div", { class: "area-head-right" }, tabToggle),
    );
  }

  let body;
  if (tab === "effects" && effectFocus) {
    body = renderEffectParams(song, track, effectFocus);
  } else if (tab === "effects") {
    body = renderEffectsPanel(song, track);
  } else if (tab === "perform") {
    // Edit mode + a pad is focused → inline single-point editor.
    const focusIdx = editor?.performPadFocus?.[track.id];
    if (focusIdx != null && getPerformPad(song, track.id, focusIdx)) {
      body = renderPerformPadEditor(song, track, focusIdx);
    } else {
      body = renderPerformBody(song, track);
    }
  } else {
    body = renderPadsBody(song, track);
  }
  return el("section", {
    class: "area"
      + (isTrackHidden(song, track.id) ? " hidden-in-perform" : "")
      + (isTrackMuted(song, track.id) ? " muted" : ""),
    style: `--row-color: ${trackColor}`,
  }, head, body);
}

// Resolve a CSS color value (which may be `var(--row-drums)`) into a hex
// string suitable for an `<input type="color">`.
function resolveCssColorToHex(cssColor) {
  try {
    const probe = document.createElement("div");
    probe.style.color = cssColor;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return "#888888";
    return "#" + [1,2,3].map(i => parseInt(m[i]).toString(16).padStart(2, "0")).join("");
  } catch { return "#888888"; }
}

function renameTrack(track) {
  const current = getTrackLabel(editor.song, track);
  promptModal({
    title: `rename "${current || track.label}"`,
    placeholder: "track name (leave blank for no name)",
    initial: current,
    okLabel: "rename",
    onSubmit: (name) => {
      // Empty string is allowed and means "no visible name". null/undefined
      // (which won't normally come from this prompt) would reset to default.
      const value = (name == null) ? null : name.trim();
      setTrackOverride(editor.song, track.id, "name", value);
      markDirty();
      persist({ silent: true });
      rerenderArea(track);
      updateDeckRowChrome(track);
    },
  });
}

function changeTrackColor(track, hex) {
  setTrackOverride(editor.song, track.id, "color", hex);
  markDirty();
  persist({ silent: true });
  // Refresh just the affected pieces — re-rendering the whole area would
  // dismiss the open color picker mid-drag.
  const areaEl = document.querySelectorAll(".side-stack")[track.side === "left" ? 0 : 1]
    ?.children?.[track.slot];
  if (areaEl) areaEl.style.setProperty("--row-color", hex);
  updateDeckRowChrome(track);
  drawWaveform(track.id);
  // Any pads on the Launchpad mapped to this track need to re-tint to
  // the new color.
  lpRefreshLights();
}

// Toggle "hide in performance mode". Edit mode still shows the area (faded)
// so the user can un-hide later. Performance mode omits the area + deck row
// entirely. Stops any voices currently playing on the track so the audio
// goes silent immediately.
function toggleTrackHidden(track) {
  if (!editor) return;
  const cur = isTrackHidden(editor.song, track.id);
  const next = !cur;
  setTrackOverride(editor.song, track.id, "hidden", next ? true : null);
  if (next) Audio.stopTrack(track.id);
  markDirty();
  persist({ silent: true });
  // Re-render the area (picks up the new fade class + button label).
  rerenderArea(track);
  // Also flip the class on the deck row so its waveform row fades too.
  const deckRow = document.querySelector(`.deck-row[data-track-id="${track.id}"]`);
  if (deckRow) deckRow.classList.toggle("hidden-in-perform", next);
}

// Toggle mute on a track. Voices keep running (so the read bar / playhead
// keep moving and the waveform animation keeps advancing) — the audio just
// gets ramped to 0 at the chain's final gain stage. Visually we dim the
// waveform via a class on the deck row.
function toggleTrackMute(track) {
  if (!editor) return;
  const cur = isTrackMuted(editor.song, track.id);
  const next = !cur;
  setTrackOverride(editor.song, track.id, "muted", next ? true : null);
  Audio.setTrackMuted(track.id, next);
  markDirty();
  persist({ silent: true });
  // Re-render the area so the Mute button reflects active state.
  rerenderArea(track);
  // Flip the class on the deck row to dim its waveform.
  const deckRow = document.querySelector(`.deck-row[data-track-id="${track.id}"]`);
  if (deckRow) deckRow.classList.toggle("muted", next);
}

// Stop every voice on a single track and clear its visual state. Mirrors
// stopAllAndReset but scoped to one track — the playhead row goes silent
// immediately and any "playing" pad highlights are removed.
function stopTrackAndUpdateVisuals(trackId) {
  if (!editor) return;
  Audio.stopTrack(trackId);
  // Clear any pending applies queued for this track.
  for (const padKey of Object.keys(editor.pendingApplies || {})) {
    if (padKey.startsWith(trackId + ":")) delete editor.pendingApplies[padKey];
  }
  // Clear voices.
  if (editor.playing[trackId]) {
    for (const k of Object.keys(editor.playing[trackId])) {
      delete editor.playing[trackId][k];
    }
  }
  // Repaint waveform + markers + pad highlights.
  drawWaveform(trackId);
  updateRowMarkers(trackId);
  document
    .querySelectorAll(`.pad[data-pad-key^="${trackId}:"].playing`)
    .forEach((el) => el.classList.remove("playing"));
}

// Repaint the deck row's row-color CSS var + label text so a rename or
// recolor reflects without rebuilding the whole deck.
function updateDeckRowChrome(track) {
  const rows = document.querySelectorAll(".deck-row");
  for (const row of rows) {
    if (row.dataset.trackId !== track.id) continue;
    row.style.setProperty("--row-color", getTrackColor(editor.song, track));
    const lbl = row.querySelector(".deck-label");
    if (lbl) lbl.textContent = getTrackLabel(editor.song, track);
  }
}

// Pads body: bank header (name + "+" in edit mode) + the 6-pad grid,
// flanked by chevrons when there's more than one bank.
function renderPadsBody(song, track) {
  const isEdit = editor?.mode === "edit";
  const banks = songBanksFor(song, track.id);
  const active = activeBank(track.id);

  const padsGrid = el("div", { class: "area-pads" },
    Array.from({ length: PADS_PER_TRACK }, (_, i) => renderPad(song, track, i))
  );

  // Header items.
  const headerItems = [];
  headerItems.push(el("span", {
    class: "bank-name-label" + (isEdit ? " editable" : ""),
    title: isEdit ? "click to rename bank" : null,
    onclick: isEdit ? (e) => { e.stopPropagation(); renameBank(track, active.id); } : null,
  }, active ? active.name : "1"));
  if (isEdit) {
    // "+" button to add a new (empty) bank. Auto-names to the next
    // unused number; click the name afterwards to rename.
    headerItems.push(el("button", {
      class: "bank-add",
      title: "add a new bank",
      onclick: () => addBank(track),
    }, "+"));
    // Delete the current bank — only when there's more than one bank,
    // and only in edit mode (no accidental deletes during a take).
    if (banks.length >= 2 && active) {
      headerItems.push(el("button", {
        class: "bank-remove",
        title: `delete "${active.name}"`,
        onclick: () => removeBank(track, active.id),
      }, "×"));
    }
  }
  const header = el("div", { class: "bank-header" }, ...headerItems);

  // Chevrons only when there's more than one bank.
  let bodyEl;
  if (banks.length >= 2) {
    bodyEl = el("div", { class: "area-pads-with-chevrons" },
      el("button", { class: "bank-chevron prev", title: "previous bank", onclick: () => switchBank(track, -1) }, "‹"),
      padsGrid,
      el("button", { class: "bank-chevron next", title: "next bank",     onclick: () => switchBank(track, +1) }, "›"),
    );
  } else {
    bodyEl = padsGrid;
  }
  return el("div", { class: "area-banks-wrap" }, header, bodyEl);
}

// Step the active bank by ±1. Wraps. No-op if there's only one bank.
function switchBank(track, direction) {
  if (!editor) return;
  const banks = songBanksFor(editor.song, track.id);
  if (banks.length < 2) return;
  const curId = editor.activeBank[track.id];
  const i = banks.findIndex(b => b.id === curId);
  const next = banks[((i + direction) % banks.length + banks.length) % banks.length];
  editor.activeBank[track.id] = next.id;
  ensureTrackBankLink(editor.song, track.id, next.id);
  rerenderArea(track);
}

// Append a new empty bank. Auto-named to the next unused number; user can
// rename it afterwards by clicking the name (edit mode).
function addBank(track) {
  if (!editor) return;
  const song = editor.song;
  ensureSongBanks(song);
  const banks = song.banks[track.id];
  let n = banks.length + 1;
  let name = String(n);
  while (banks.some(b => b.name === name)) { n++; name = String(n); }
  const bank = { id: uid(), name, pads: Array(PADS_PER_TRACK).fill(null) };
  banks.push(bank);
  editor.activeBank[track.id] = bank.id;
  ensureTrackBankLink(song, track.id, bank.id);
  markDirty();
  persist({ silent: true });
  rerenderArea(track);
}

// Delete a bank. Refuses to delete the last remaining one. Stops any
// currently-playing voices on the bank, frees its sample references, then
// removes it from the song and switches the active bank to the neighbour.
function removeBank(track, bankId) {
  if (!editor) return;
  const banks = songBanksFor(editor.song, track.id);
  if (banks.length < 2) {
    toast("can't delete the only bank");
    return;
  }
  const bank = banks.find(b => b.id === bankId);
  if (!bank) return;
  const hasSamples = (bank.pads || []).some(p => !!p?.sampleId);
  const body = hasSamples
    ? `"${bank.name}" has samples assigned. delete the whole bank?`
    : `delete "${bank.name}"?`;
  confirmModal({
    title: "delete bank",
    body,
    okLabel: "delete",
    danger: true,
    onConfirm: () => doRemoveBank(track, bankId),
  });
}

function doRemoveBank(track, bankId) {
  const song = editor.song;
  const banks = song.banks?.[track.id];
  if (!banks || banks.length < 2) return;
  const idx = banks.findIndex(b => b.id === bankId);
  if (idx < 0) return;
  const bank = banks[idx];

  // Stop any voices playing on this bank (padKey prefix matches the bank id).
  const prefix = `${track.id}:${bankId}:`;
  const playing = editor.playing[track.id] || {};
  for (const padKey of Object.keys(playing)) {
    if (padKey.startsWith(prefix)) stopPadAndUpdateVisuals(track.id, padKey);
  }
  for (const padKey of Object.keys(editor.pendingApplies || {})) {
    if (padKey.startsWith(prefix)) delete editor.pendingApplies[padKey];
  }

  // Drop the bank's sample blobs from IndexedDB + audio cache. (Each sample
  // is referenced only here — banks don't share blobs in current usage.)
  for (const pad of bank.pads || []) {
    if (!pad?.sampleId) continue;
    deleteSample(pad.sampleId).catch(() => {});
    Audio.evict(pad.sampleId);
  }

  banks.splice(idx, 1);
  // Pick the new active bank: prefer the previous neighbour, else the first.
  const nextActive = banks[Math.max(0, idx - 1)] || banks[0];
  editor.activeBank[track.id] = nextActive.id;
  ensureTrackBankLink(song, track.id, nextActive.id);
  markDirty();
  persist({ silent: true });
  rerenderArea(track);
  toast(`deleted bank "${bank.name}"`);
}

// Click the bank name in edit mode → rename prompt. Empty submissions are
// allowed and render as a blank bank name (useful when you don't want any
// label visible above the pad grid).
function renameBank(track, bankId) {
  const banks = songBanksFor(editor.song, track.id);
  const bank = banks.find(b => b.id === bankId);
  if (!bank) return;
  promptModal({
    title: "rename bank",
    placeholder: "bank name (leave blank for no name)",
    initial: bank.name,
    okLabel: "rename",
    onSubmit: (newName) => {
      // null/undefined would only come from a cancel — promptModal sends a
      // string here. Trim whitespace; the empty string is preserved.
      if (newName == null) return;
      const trimmed = newName.trim();
      if (trimmed === bank.name) return;
      bank.name = trimmed;
      markDirty();
      persist({ silent: true });
      rerenderArea(track);
    },
  });
}

function switchAreaTab(track, tab) {
  if (!editor) return;
  editor.areaTab[track.id] = tab;
  editor.areaEffectFocus[track.id] = null; // leaving the tab clears any zoom
  if (editor.performPadFocus) editor.performPadFocus[track.id] = null;
  rerenderArea(track);
}

function closeEffectFocus(track) {
  if (!editor) return;
  editor.areaEffectFocus[track.id] = null;
  rerenderArea(track);
}

function closePerformPadFocus(track) {
  if (!editor) return;
  if (editor.performPadFocus) editor.performPadFocus[track.id] = null;
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

// Resolve every parameter for an effect (automation params via paramValueAt
// at the current main knob; fader/choice params as-is) and push the result
// into the audio chain.
//
// Dispatch order:
//   - reverb / pump → special composed setters (handle IR rebuild + LFO Hz)
//   - effects with at least one automation param → applyChainParams
//   - effects with only fader/choice params (filter) → setEffectParam (main
//     knob handles the bipolar sweep) + applyExtraParamsOnChain
//   - effects with no params at all → bare setEffectParam fallback
function applyEffectToAudio(song, trackId, name) {
  const knob = getEffect(song, trackId, name);
  // Tone.js effects: only touch the Tone bridge if the user has actually
  // added this effect to the track. Without this gate, every song load
  // would iterate ALL trackEffectKeys (which now includes 18 tone
  // effects) and try to apply them — that would force-create a Tone node
  // and bind Tone to our AudioContext for every song, even ones that
  // never use Tone effects. Binding Tone to a live context can disrupt
  // existing audio, so we skip entirely when the effect isn't enabled.
  if (isToneEffect(name)) {
    // Skip ONLY if the effect was never engaged on this track. Once a
    // perform pad (or a knob) creates the Tone node, every subsequent
    // applyEffectToAudio call must still flow through here — that's how
    // the pad-release path resets the wrapper's wet gain back to 0. The
    // old "not in enabledEffects → return" gate was leaving the wet
    // gain at whatever the pad set it to, so the effect kept playing
    // after the pad was released.
    const enabled = (song.enabledEffects && song.enabledEffects[trackId]) || [];
    const alreadyOnChain = Audio.hasToneEffectOnTrack(trackId, name);
    if (!enabled.includes(name) && !alreadyOnChain) return;
    const defs = getEffectParamsDef(name) || [];
    for (const def of defs) {
      let v;
      if (def.type === "choice" || def.type === "fader") {
        const range = getParamRange(song, trackId, name, def.key);
        v = range.value;
      } else {
        v = paramValueAt(song, trackId, name, def.key, knob);
      }
      Audio.setToneEffectParam(trackId, name, def.key, v);
    }
    return;
  }
  if (name === "reverb") {
    const wet      = paramValueAt(song, trackId, "reverb", "wet",      knob);
    const size     = paramValueAt(song, trackId, "reverb", "size",     knob);
    const release  = paramValueAt(song, trackId, "reverb", "release",  knob);
    const preDelay = paramValueAt(song, trackId, "reverb", "predelay", knob);
    const buildup  = paramValueAt(song, trackId, "reverb", "buildup",  knob);
    const damping  = paramValueAt(song, trackId, "reverb", "damping",  knob);
    Audio.setReverbParams(trackId, wet, size, release, { preDelay, buildup, damping });
    return;
  }
  if (name === "pump") {
    const comp      = paramValueAt(song, trackId, "pump", "compression", knob);
    const vol       = paramValueAt(song, trackId, "pump", "volume",      knob);
    const rate      = paramValueAt(song, trackId, "pump", "rate",        knob);
    const intensity = paramValueAt(song, trackId, "pump", "intensity",   knob);
    Audio.setPumpParams(trackId, knob, comp, vol, rate, intensity);
    return;
  }
  // Drive / distortion: the main knob IS the amount (no separate
  // "amount" param). Route through unified chain params with amount
  // injected from the knob and any remaining params (mix, etc.) read
  // from the schema. Bypasses Audio.setEffectParam which would otherwise
  // couple amount + mix together and overwrite the user's mix.
  if (name === "drive" || name === "distortion") {
    const defs = getEffectParamsDef(name) || [];
    const values = { amount: knob };
    for (const def of defs) {
      if (def.type === "choice" || def.type === "fader") {
        const range = getParamRange(song, trackId, name, def.key);
        values[def.key] = range.value;
      } else {
        values[def.key] = paramValueAt(song, trackId, name, def.key, knob);
      }
    }
    applyChainParams(trackId, name, values);
    return;
  }
  const defs = getEffectParamsDef(name);
  if (!defs || !defs.length) {
    Audio.setEffectParam(trackId, name, knob);
    return;
  }
  const hasAutomation = defs.some(d => !d.type);
  if (!hasAutomation) {
    // Single-knob behavior preserved; the param editor's fader/choice rows
    // (e.g. filter.resonance) are layered on top.
    Audio.setEffectParam(trackId, name, knob);
    applyExtraParamsOnChain(song, trackId, name);
    return;
  }
  // Unified multi-param routing — resolve each param's value and push
  // straight to the chain via applyChainParams.
  const values = {};
  for (const def of defs) {
    if (def.type === "choice" || def.type === "fader") {
      const range = getParamRange(song, trackId, name, def.key);
      values[def.key] = range.value;
    } else {
      values[def.key] = paramValueAt(song, trackId, name, def.key, knob);
    }
  }
  applyChainParams(trackId, name, values);
}

// Layer fader/choice extras on top of a single-knob effect (currently just
// filter.resonance, but the dispatcher accepts any (effect.param) pair).
function applyExtraParamsOnChain(song, trackId, name) {
  const defs = getEffectParamsDef(name) || [];
  const chain = Audio.ensureTrackChain(trackId);
  const ctx = Audio.nowCtx();
  if (!chain || !ctx) return;
  const t = ctx.currentTime + 0.02;
  const tc = 0.05;
  for (const def of defs) {
    if (def.type !== "fader" && def.type !== "choice") continue;
    const range = getParamRange(song, trackId, name, def.key);
    const v = range.value;
    if (name === "filter" && def.key === "resonance") {
      chain.filter.Q.setTargetAtTime(v, t, tc);
    }
  }
}

// Apply a flat param-value map to the chain for a given effect. Shared
// between knob effects (resolved automation/fader/choice values from
// EFFECT_PARAMS) and perform pads (single-point values from
// PERFORM_PAD_PARAMS). Both call into this so adding a param to either
// schema only needs one routing change here.
function applyChainParams(trackId, effect, p) {
  const chain = Audio.ensureTrackChain(trackId);
  const ctx = Audio.nowCtx();
  if (!chain || !ctx) return;
  const t  = ctx.currentTime;
  // Snap every chain parameter to its new value — no setTargetAtTime
  // ramp. Pad effects must switch instantly: pressing a pad shouldn't
  // give an audible glide from baseline to preset, and releasing
  // shouldn't glide back. Knob effects also route here; the param
  // value updates per drag step are small enough that the absence of
  // a smoothing ramp isn't audible during continuous drags.
  //
  // Why a tiny linear ramp instead of a hard setValueAtTime: a step
  // change on AudioParams produces an audible click / "zipper" zip in
  // Chrome's low-latency render thread (especially on dry/wet gains
  // and delayTime). 6ms is short enough to read as "instant" but smooth
  // enough that the engine doesn't crackle on the transition.
  const RAMP = 0.006;
  const snap = (param, value) => {
    try { param.cancelScheduledValues(t); } catch {}
    // Anchor at the current value so the ramp starts from where the
    // param actually is right now, not where a prior schedule left it.
    try { param.setValueAtTime(param.value, t); } catch {}
    try { param.linearRampToValueAtTime(value, t + RAMP); }
    catch { try { param.setValueAtTime(value, t); } catch {} }
  };
  switch (effect) {
    case "delay": {
      const bpm = (editor?.song?.bpm) || DEFAULT_BPM;
      const beats = p.time ?? 0.25;
      const secs = (60 / bpm) * beats * 4;
      snap(chain.delayNode.delayTime, secs);
      snap(chain.delayFb.gain, p.feedback ?? 0.25);
      snap(chain.delayWet.gain, p.wet ?? 0);
      return;
    }
    case "echo": {
      snap(chain.echoNode.delayTime, p.time ?? 0.38);
      snap(chain.echoFb.gain, p.feedback ?? 0.5);
      snap(chain.echoWet.gain, p.wet ?? 0);
      return;
    }
    case "filter": {
      chain.filter.type = p.mode === "highpass" ? "highpass" : "lowpass";
      snap(chain.filter.frequency, p.cutoff ?? 18000);
      snap(chain.filter.Q, p.resonance ?? 1);
      return;
    }
    case "drive": {
      const amt = Math.max(0, Math.min(1, p.amount ?? 0));
      const mix = Math.max(0, Math.min(1, p.mix    ?? 0.9));
      chain.driveShaper.curve = Audio.makeDriveCurve(amt);
      snap(chain.driveDry.gain, 1 - mix);
      snap(chain.driveWet.gain, mix * 0.9);
      return;
    }
    case "distortion": {
      const amt = Math.max(0, Math.min(1, p.amount ?? 0));
      const mix = Math.max(0, Math.min(1, p.mix    ?? 0.6));
      chain.distShaper.curve = Audio.makeDistortionCurve(amt);
      snap(chain.distDry.gain, 1 - mix);
      snap(chain.distWet.gain, mix * 0.6);
      return;
    }
    case "vibrato": {
      snap(chain.vibratoDepth.gain, (p.depth ?? 0) * 0.005);
      return;
    }
    case "compressor": {
      snap(chain.compressor.threshold, p.threshold ?? 0);
      snap(chain.compressor.ratio, p.ratio ?? 1);
      return;
    }
    case "volume": {
      snap(chain.volume.gain, p.level ?? 1);
      return;
    }
    case "pitch": {
      if (chain.pitchShifter) chain.pitchShifter.setCents(p.cents ?? 0);
      return;
    }
    case "robot": {
      if (chain.robot) snap(chain.robot.robotWet.gain, p.amount ?? 0);
      return;
    }
  }
}

// ───── Effects panel + knob ─────
// Per-track effects panel: one row of knobs (reverb, echo, delay, drive,
// vibrato, filter, compressor [+ robot for vocals]). Each knob is a vertical
// pointer-drag dial that writes to song.effects[trackId][name] and pushes the
// value into Audio.setEffectParam live, so currently-playing voices respond
// immediately.
function renderEffectsPanel(song, track) {
  const isEdit = editor?.mode === "edit";
  const enabled = getEnabledEffects(song, track.id);
  const cells = enabled.map((name) => renderEffectKnobCell(song, track, name, isEdit));
  const grid = el("div", { class: "area-effects" }, ...cells);
  // Always show the reset-all button on the right. + button is edit-mode
  // only. Both live in a vertical stack on the right side of the panel,
  // vertically centered against the grid.
  const sideButtons = [];
  sideButtons.push(el("button", {
    class: "area-reset-knobs-btn",
    title: "reset every knob on this part to its bypass default",
    onclick: () => resetAllKnobEffects(song, track),
  }, "⟲"));
  if (isEdit) {
    sideButtons.push(el("button", {
      class: "area-add-knob-side-btn",
      title: "add an effect knob",
      onclick: () => {
        const available = trackEffectKeys(track.id)
          .filter(k => !getEnabledEffects(song, track.id).includes(k));
        openAddKnobEffectModal(track, available);
      },
    }, "+"));
  }
  const sideStack = el("div", { class: "area-effects-side" }, ...sideButtons);
  return el("div", { class: "area-effects-wrap" }, grid, sideStack);
}

// Reset every enabled effect on the track to its EFFECT_DEFAULTS value +
// drop any sub-parameter overrides. Pushes the new state into the audio
// chain so the change is immediate.
function resetAllKnobEffects(song, track) {
  const enabled = getEnabledEffects(song, track.id);
  for (const name of enabled) {
    setEffect(song, track.id, name, EFFECT_DEFAULTS[name] ?? 0);
    if (song.effectParams?.[track.id]) {
      delete song.effectParams[track.id][name];
    }
    applyEffectToAudio(song, track.id, name);
  }
  markDirty();
  schedulePersist();
  rerenderArea(track);
  toast("knobs reset");
}

// One knob cell: the dial itself + a small × button in edit mode that
// removes the effect from the track's enabled list. Always shown in
// edit mode (tablet has no hover, so hiding behind hover hid it from
// the user). Discreet color so it doesn't dominate the dial.
function renderEffectKnobCell(song, track, name, isEdit) {
  const dial = knob({
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
  });
  const cell = el("div", { class: "effect-knob-cell" }, dial);
  if (isEdit) {
    const removeBtn = el("button", {
      class: "effect-knob-remove",
      title: `remove ${name} knob`,
      onclick: (e) => {
        e.stopPropagation();
        removeKnobEffect(song, track, name);
      },
    }, "×");
    cell.appendChild(removeBtn);
  }
  return cell;
}

// Reset the effect to its default value + drop any parameter overrides,
// then remove it from the enabled list and re-render. Resetting the value
// ensures the audio chain stops applying whatever it was last set to.
function removeKnobEffect(song, track, name) {
  removeEnabledEffect(song, track.id, name);
  setEffect(song, track.id, name, getEffectDefaultKnob(name));
  if (song.effectParams?.[track.id]) delete song.effectParams[track.id][name];
  applyEffectToAudio(song, track.id, name);
  markDirty();
  schedulePersist();
  rerenderArea(track);
}

// Modal: grid of effect-name squares for the effects this track has
// available but doesn't currently show. Picking one adds the effect to
// song.enabledEffects[trackId] (which is persisted as part of the song
// JSON — opens the same on every device that loads the song).
function openAddKnobEffectModal(track, available) {
  if (!editor) return;
  const song = editor.song;
  // "Nothing left to add" path: show an explanatory message so the
  // user understands the picker isn't broken; cancel button closes it.
  const grid = available.length === 0
    ? el("div", { class: "effect-picker-empty" },
        "every effect is already in the grid — remove one with the × on a knob to free a slot.")
    : el("div", { class: "effect-picker-grid" },
        ...available.map(name => el("button", {
          class: "effect-picker-item",
          title: name,
          onclick: () => {
            addEnabledEffect(song, track.id, name);
            markDirty();
            schedulePersist();
            closeAddKnobEffectModal();
            rerenderArea(track);
          },
        }, name))
      );
  const dialog = el("div", { class: "effect-picker-dialog" },
    el("div", { class: "effect-picker-title" }, "add an effect knob"),
    grid,
    el("div", { class: "effect-picker-footer" },
      el("button", {
        class: "effect-picker-cancel",
        onclick: () => closeAddKnobEffectModal(),
      }, available.length === 0 ? "close" : "cancel"),
    ),
  );
  const backdrop = el("div", {
    class: "effect-picker-backdrop",
    onclick: (e) => { if (e.target === backdrop) closeAddKnobEffectModal(); },
  }, dialog);
  backdrop.id = "add-knob-backdrop";
  document.body.appendChild(backdrop);
}
function closeAddKnobEffectModal() {
  document.getElementById("add-knob-backdrop")?.remove();
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

  // Filter to only the params the user has marked visible in settings
  // (defaults to "all visible"). The hidden ones are still reachable
  // via the "all params" popup below.
  const visibleDefs = filterVisibleDefs("knob", effect, defs);
  const hiddenCount = defs.length - visibleDefs.length;
  const paramRows = visibleDefs.map(def => paramRow(song, track, effect, def));
  rows.push(...paramRows);

  const saveAsDefaultBtn = el("button", {
    class: "btn ghost small effect-save-default-btn",
    title: "save this effect's current values as the app-wide default for new song parts",
    onclick: () => saveEffectParamsAsDefault(song, track, effect),
  }, "save as default");

  // "All params" — opens a centered popup showing every parameter,
  // regardless of the visibility setting. Useful for an occasional
  // tweak to a param you've hidden from the main view.
  const allParamsBtn = el("button", {
    class: "btn ghost small effect-all-params-btn",
    title: hiddenCount > 0
      ? `view all ${defs.length} parameters (${hiddenCount} hidden)`
      : "view all parameters in a centered popup",
    onclick: () => openAllParamsPopup(song, track, effect, "knob"),
  }, hiddenCount > 0 ? `all params (${hiddenCount} hidden)` : "all params");

  return el("div", { class: "effect-params" },
    knobPreviewWrap,
    ...paramRows.map(r => r.node),
    el("div", { class: "effect-params-footer" }, allParamsBtn, saveAsDefaultBtn),
  );
}

// Read every value off this song-part's effect (main knob + every
// sub-parameter), translate to the GLOBAL_PREFS schema, and persist
// via saveGlobalPref. Doesn't change the current song's values; only
// affects what a fresh effect-add will start from in the future.
function saveEffectParamsAsDefault(song, track, effect) {
  const defs = getEffectParamsDef(effect) || [];
  const snapshot = {
    knob: getEffect(song, track.id, effect),
    params: {},
  };
  for (const def of defs) {
    const range = getParamRange(song, track.id, effect, def.key);
    if (!range) continue;
    if (def.type === "choice" || def.type === "fader") {
      snapshot.params[def.key] = { value: range.value };
    } else {
      snapshot.params[def.key] = { low: range.low, high: range.high };
    }
  }
  const m = getEffectDefaultsMap();
  m[effect] = snapshot;
  saveGlobalPref("effectDefaults", m);
  toast(`${effect} saved as default`);
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

// ───── Perform-mode pads UI ─────
// The "perform" tab body. 6 square pads in a 3×2 grid (mirrors the sample
// pads layout). Each cell is either:
//   - empty: edit mode shows a "+" hint that opens the effect picker;
//            perform mode shows a disabled placeholder.
//   - filled: shows the effect name + (in edit) a small "edit" button.
// Tapping a filled pad in perform mode applies the pad's effect preset.
function renderPerformBody(song, track) {
  const pads = getPerformPads(song, track.id);
  const grid = el("div", { class: "perform-pads" },
    ...Array.from({ length: PADS_PER_TRACK }, (_, i) => renderPerformPad(song, track, i, pads[i]))
  );
  return el("div", { class: "perform-body" }, grid);
}

function renderPerformPad(song, track, idx, pad) {
  const isMapping = !!editor?.midiMapping;
  const isEdit = editor?.mode === "edit" && !isMapping;
  const active = !!editor?.performHeldPads?.[track.id]?.[idx];

  // MIDI mapping state for this perform pad.
  const mapKey = midiKeyForPerformPad(track.id, idx);
  const mappedNote = isMapping ? getMidiNoteFor(song, mapKey) : null;
  const isMapSelected = isMapping && editor.midiMappingSelected === mapKey;

  if (!pad) {
    // Empty slot. Not mappable until it has an effect assigned.
    return el("button", {
      class: "perform-pad empty" + (isEdit ? " edit" : ""),
      title: isEdit ? "add an effect to this pad" : "empty",
      disabled: !isEdit || isMapping,
      onclick: isEdit ? () => openEffectPickerModal(track, idx) : null,
    }, isEdit ? el("span", { class: "perform-pad-plus" }, "+") : null);
  }

  // Filled slot.
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    // Mapping mode swallows everything else — tap selects this pad for
    // MIDI assignment.
    if (isMapping) {
      editor.midiMappingSelected = isMapSelected ? null : mapKey;
      rerenderAllAreas();
      return;
    }
    // In edit mode, tapping opens the pad's parameter editor — no audio.
    if (isEdit) {
      editor.performPadFocus[track.id] = idx;
      rerenderArea(track);
      return;
    }
    if (pad.mode === "toggle") {
      // Toggle mode: pointerdown flips the active state.
      if (active) deactivatePerformPad(track, idx);
      else        activatePerformPad(track, idx);
    } else {
      // Hold mode: down activates, up deactivates.
      activatePerformPad(track, idx);
    }
  };
  const onPointerEndOrLeave = () => {
    if (isEdit || isMapping) return;
    if (pad.mode === "hold") {
      if (editor?.performHeldPads?.[track.id]?.[idx]) {
        deactivatePerformPad(track, idx);
      }
    }
  };

  return el("button", {
    class: "perform-pad loaded"
      + (isEdit ? " edit" : "")
      + (active ? " active" : "")
      + ` mode-${pad.mode || "hold"}`
      + (isMapping ? " midi-mappable" : "")
      + (isMapSelected ? " midi-map-selected" : ""),
    "data-perform-idx": String(idx),
    title: isMapping
      ? (mappedNote != null
          ? `mapped to ${midiNoteName(mappedNote)} — tap to remap`
          : "tap to select, then press a MIDI key")
      : (isEdit
          ? `edit ${pad.effect} pad`
          : (pad.mode === "toggle" ? `tap to toggle ${pad.effect}` : `hold to apply ${pad.effect}`)),
    onpointerdown:  onPointerDown,
    onpointerup:    onPointerEndOrLeave,
    onpointerleave: onPointerEndOrLeave,
    onpointercancel: onPointerEndOrLeave,
  },
    isMapping && mappedNote != null
      ? el("span", { class: "pad-midi-note" }, midiNoteName(mappedNote))
      : null,
    el("span", { class: "perform-pad-effect" }, pad.effect),
    el("span", { class: "perform-pad-mode-indicator", title: pad.mode === "toggle" ? "toggle pad" : "hold pad" },
      pad.mode === "toggle" ? "⏻" : "⊙"),
  );
}

// Single-pad parameter editor. One row per parameter (no main "amount"
// knob — the parameters themselves fully define the effect's result when
// the pad is pressed). Bottom: hold/toggle mode toggle + test + remove.
function renderPerformPadEditor(song, track, idx) {
  const pad = getPerformPad(song, track.id, idx);
  if (!pad) return el("div", { class: "perform-pad-editor empty" }, "no pad");

  // Defensive migration: an older pad (created with the previous schema)
  // may have stale keys / a residual `knob` field. Bring it up to date
  // before rendering.
  migratePerformPad(pad);

  const defs = getPerformPadParamsDef(pad.effect);
  // Filter to only params marked visible in settings. The "all params"
  // button below opens a popup with the full set.
  const visibleDefs = filterVisibleDefs("pad", pad.effect, defs);
  const subRows = visibleDefs.length
    ? visibleDefs.map(def => performPadParamRow(song, track, idx, pad, def))
    : [el("div", { class: "perform-pad-editor empty" }, "this effect has no tweakable parameters")];
  const hiddenCount = (defs?.length || 0) - visibleDefs.length;

  // Mode toggle: hold (default) vs toggle (latch).
  const modeToggle = el("div", { class: "perform-pad-mode-row" },
    el("span", { class: "param-label" }, "pad mode"),
    el("div", { class: "perform-mode-toggle-group" },
      el("button", {
        class: "perform-mode-btn" + (pad.mode !== "toggle" ? " active" : ""),
        title: "effect is active only while pressed",
        onclick: () => { pad.mode = "hold"; markDirty(); schedulePersist(); rerenderArea(track); },
      }, "hold"),
      el("button", {
        class: "perform-mode-btn" + (pad.mode === "toggle" ? " active" : ""),
        title: "tap turns the effect on, tap again turns it off",
        onclick: () => { pad.mode = "toggle"; markDirty(); schedulePersist(); rerenderArea(track); },
      }, "toggle"),
    ),
  );

  // Remove this pad entirely.
  const removeBtn = el("button", {
    class: "perform-pad-remove",
    title: "remove this perform pad",
    onclick: () => {
      // Make sure it's not currently active before we drop it.
      if (editor?.performHeldPads?.[track.id]?.[idx]) {
        deactivatePerformPad(track, idx);
      }
      clearPerformPad(song, track.id, idx);
      editor.performPadFocus[track.id] = null;
      markDirty();
      schedulePersist();
      rerenderArea(track);
    },
  }, "remove pad");

  // Test button: hold-to-apply preview so you can hear the pad's effect
  // while tweaking sliders without leaving edit mode. Uses the same
  // activate/deactivate path as a real performance press, so any param
  // change is also live-applied via makePerformFaderRow's onMove hook.
  const testBtn = el("button", {
    class: "perform-pad-test",
    title: "press and hold to preview the effect with current parameters",
  }, "test");
  const onTestDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    testBtn.classList.add("active");
    activatePerformPad(track, idx);
    try { testBtn.setPointerCapture(e.pointerId); } catch {}
  };
  const onTestUp = () => {
    if (!testBtn.classList.contains("active")) return;
    testBtn.classList.remove("active");
    if (editor?.performHeldPads?.[track.id]?.[idx]) {
      deactivatePerformPad(track, idx);
    }
  };
  testBtn.addEventListener("pointerdown",  onTestDown);
  testBtn.addEventListener("pointerup",    onTestUp);
  testBtn.addEventListener("pointerleave", onTestUp);
  testBtn.addEventListener("pointercancel", onTestUp);

  // Save-as-default button: snapshots this pad's current params into
  // GLOBAL_PREFS.padEffectDefaults so the next perform pad created for
  // the same effect starts from these values. Existing pads (here or
  // in other songs) keep their own params.
  const saveDefaultBtn = el("button", {
    class: "btn ghost small",
    title: "save these values as the app-wide default for new perform pads of this effect",
    onclick: () => savePerformPadAsDefault(pad),
  }, "save as default");

  const allParamsBtn = el("button", {
    class: "btn ghost small",
    title: hiddenCount > 0
      ? `view all ${defs?.length || 0} parameters (${hiddenCount} hidden)`
      : "view all parameters in a centered popup",
    onclick: () => openAllParamsPopup(song, track, pad.effect, "pad", { padIdx: idx }),
  }, hiddenCount > 0 ? `all params (${hiddenCount} hidden)` : "all params");

  return el("div", { class: "perform-pad-editor" },
    ...subRows,
    modeToggle,
    el("div", { class: "perform-pad-editor-footer" },
      testBtn, allParamsBtn, saveDefaultBtn, removeBtn,
    ),
  );
}

// Snapshot every param on this perform pad into the global pad-effect
// defaults. Doesn't touch the pad itself or any other song.
function savePerformPadAsDefault(pad) {
  if (!pad || !pad.effect) return;
  const defs = getPerformPadParamsDef(pad.effect) || [];
  for (const def of defs) {
    const v = pad.params?.[def.key];
    if (v != null) setPadEffectDefault(pad.effect, def.key, v);
  }
  toast(`${pad.effect} pad saved as default`);
}

// Centered popup showing EVERY parameter for the given effect on this
// song-part — regardless of the per-param visibility setting. Use it
// to tweak a param you've hidden from the inline editor without
// permanently re-enabling it. Edits flow into the same song state the
// inline editor writes to, so closing the popup leaves the song with
// the new values intact.
//
//   context: "knob" — uses paramRow / song's effectParams (automation)
//   context: "pad"  — uses performPadParamRow / pad.params (single-point)
//
// For pad context, opts.padIdx is required so the popup knows which
// perform pad it's editing.
function openAllParamsPopup(song, track, effect, context, opts = {}) {
  const host = ensureHost("all-params-host", "all-params-host");
  const close = () => host.remove();

  let body;
  if (context === "knob") {
    const defs = getEffectParamsDef(effect) || [];
    // Build the same chrome as renderEffectParams: main knob preview
    // + every param row, in source order.
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
        for (const r of rows) r.refreshCurrent?.();
      },
    });
    knobPreviewWrap.appendChild(mainKnobNode);
    const paramRows = defs.map(def => paramRow(song, track, effect, def));
    rows.push(...paramRows);
    body = el("div", { class: "effect-params" },
      knobPreviewWrap,
      ...paramRows.map(r => r.node),
    );
  } else {
    // Pad context. opts.padIdx tells us which pad.
    const idx = opts.padIdx;
    const pad = getPerformPad(song, track.id, idx);
    if (!pad) { close(); return; }
    const defs = getPerformPadParamsDef(pad.effect) || [];
    const rows = defs.map(def => performPadParamRow(song, track, idx, pad, def));
    body = el("div", { class: "perform-pad-editor" }, ...rows);
  }

  host.replaceChildren(
    el("div", { class: "modal all-params-modal" },
      el("h3", {}, `${effect} — all parameters`),
      el("p", { class: "midi-section-empty" },
        "every parameter for this effect. settings → effects defaults controls which of these show in the main editor."),
      // Apply the same row-color the area uses so the bars / knob
      // are tinted consistently with the rest of the song-part UI.
      el("div", {
        class: "all-params-body",
        style: `--row-color: ${getTrackColor(song, track)};`,
      }, body),
      el("div", { class: "modal-actions" },
        el("button", { class: "btn primary", onclick: close }, "done"),
      ),
    ),
  );
}

// One-parameter row for a perform pad: a single point per parameter (no
// low/high automation), matching the user's spec.
function performPadParamRow(song, track, idx, pad, def) {
  // Choice params (e.g. pump.rate, filter.mode): discrete button group.
  // Values can be numeric (rate=1) or string ("lowpass") — we compare on
  // identity so both work.
  if (def.type === "choice") {
    const buttons = [];
    function refresh() {
      for (const b of buttons) {
        const v = b._choiceValue;
        const cur = pad.params[def.key];
        const same = typeof v === "number" && typeof cur === "number"
          ? Math.abs(v - cur) < 1e-6
          : v === cur;
        b.classList.toggle("active", same);
      }
    }
    for (const choice of def.choices) {
      const btn = el("button", {
        class: "param-choice-btn",
        onclick: () => {
          pad.params[def.key] = choice.value;
          // Song-mode side effects only run when a real song/track
          // are present. The defaults modal reuses this function with
          // null song/track to mutate GLOBAL_PREFS directly.
          if (song && track) {
            markDirty();
            schedulePersist();
            if (editor?.performHeldPads?.[track.id]?.[idx]) {
              applyPerformPadAudio(track.id, pad);
            }
          }
          refresh();
        },
      }, choice.label);
      btn._choiceValue = choice.value;
      buttons.push(btn);
    }
    refresh();
    const node = el("div", { class: "effect-param-row" },
      el("div", { class: "param-row-head" }, el("span", { class: "param-label" }, def.label)),
      el("div", { class: "param-choices" }, ...buttons),
    );
    return node;
  }
  // All other params: single-value fader.
  return makePerformFaderRow({
    label: def.label,
    min: def.min, max: def.max,
    get: () => pad.params[def.key],
    set: (v) => { pad.params[def.key] = v; },
    song, track, padIdx: idx,
  }).node;
}

// Factory: a single-point fader row used by the perform-pad editor for the
// main knob AND every sub-parameter. Drag = continuous value change; if the
// pad is currently active the change is pushed to audio live.
function makePerformFaderRow(opts) {
  const { label, min, max, get, set, song, track, padIdx } = opts;
  const track_el = el("div", { class: "param-track fader-track" });
  const fill   = el("div", { class: "param-fader-fill" });
  const handle = el("div", { class: "param-handle fader", title: label });
  const valueLabel = el("span", { class: "param-endpoint-value high" });
  const valueToFrac = (v) => (v - min) / (max - min);
  const fmt = (v) => Number.isFinite(v) ? v.toFixed(2) : "—";
  function refresh() {
    const cur = get();
    const f = Math.max(0, Math.min(1, valueToFrac(cur)));
    handle.style.left = `${f * 100}%`;
    fill.style.right  = `${(1 - f) * 100}%`;
    valueLabel.textContent = fmt(cur);
  }
  refresh();
  let dragRect = null;
  const onMove = (e) => {
    if (!dragRect) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - dragRect.left) / dragRect.width));
    set(min + frac * (max - min));
    refresh();
    // Song-mode work: mark dirty + live-apply if a real song/track
    // were passed. The defaults modal reuses this function with null
    // song/track to drive GLOBAL_PREFS instead.
    if (song && track) {
      markDirty();
      schedulePersist();
      const pad = getPerformPad(song, track.id, padIdx);
      if (pad && editor?.performHeldPads?.[track.id]?.[padIdx]) {
        applyPerformPadAudio(track.id, pad);
      }
    }
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
    onMove(e);
  }
  handle.addEventListener("pointerdown", startDrag);
  track_el.addEventListener("pointerdown", startDrag);
  track_el.appendChild(fill);
  track_el.appendChild(handle);
  const node = el("div", { class: "effect-param-row" },
    el("div", { class: "param-row-head" },
      el("span", { class: "param-label" }, label),
      el("span", { class: "param-range" }, `${fmt(min)} → ${fmt(max)}`),
    ),
    el("div", { class: "param-bar-wrap" },
      el("span", { class: "param-endpoint-value low" }),
      track_el,
      valueLabel,
    ),
  );
  return { node, refresh };
}

// ───── Perform-pad activation ─────
// Apply a perform pad's effect preset directly to the audio chain. The
// pad's params (PERFORM_PAD_PARAMS schema) fully define the audible
// result — there's no main "amount" knob. Reverb / pump go through their
// composed setters (IR rebuild + BPM-aware LFO Hz); everything else
// shares the same applyChainParams helper used by the knob effects.
function applyPerformPadAudio(trackId, pad) {
  if (!pad || !pad.effect) return;
  const p = { ...(pad.params || {}) };
  // Tone.js effects: route each param straight through the Tone bridge.
  // applyChainParams' native switch doesn't know about Tone, so we
  // dispatch here. The defaults from PERFORM_PAD_PARAMS fill in any
  // params not stored on the pad (newly-added params on migrated pads).
  if (isToneEffect(pad.effect)) {
    const defs = getPerformPadParamsDef(pad.effect) || [];
    for (const def of defs) {
      const v = (def.key in p) ? p[def.key] : def.default;
      Audio.setToneEffectParam(trackId, pad.effect, def.key, v);
    }
    return;
  }
  if (pad.effect === "reverb") {
    Audio.setReverbParams(
      trackId,
      p.wet      ?? 1.5,
      p.size     ?? 0.5,
      p.release  ?? 2.0,
      {
        preDelay: p.predelay,
        buildup:  p.buildup,
        damping:  p.damping,
      },
    );
    return;
  }
  if (pad.effect === "pump") {
    // Pull intensity (= "sharpness" in the UI) from the pad's stored
    // params, falling back to 0.5 if the pad was created before this
    // param existed in the schema.
    Audio.setPumpParams(trackId, 1, p.compression ?? 0.8, p.volume ?? 0.8, p.rate ?? 1, p.intensity ?? 0.5);
    return;
  }
  // The "amount" param was removed app-wide because the main knob
  // handles it on knob effects. Perform pads don't have a main knob —
  // they always activate the effect at full strength. Inject amount=1
  // so applyChainParams' drive/distortion/robot cases route at max.
  if (pad.effect === "drive" || pad.effect === "distortion" || pad.effect === "robot") {
    if (!("amount" in p)) p.amount = 1;
  }
  applyChainParams(trackId, pad.effect, p);
}

// Activate a perform pad. Pushes onto the per-track-per-effect stack so a
// second pad activating the same effect overrides the first cleanly, and
// deactivating restores whatever is "below" (or the song's baseline if
// the stack is now empty).
function activatePerformPad(track, idx) {
  if (!editor) return;
  const song = editor.song;
  const pad = getPerformPad(song, track.id, idx);
  if (!pad) return;
  if (!editor.performActiveStack[track.id]) editor.performActiveStack[track.id] = {};
  if (!editor.performHeldPads[track.id])    editor.performHeldPads[track.id] = {};
  const stack = (editor.performActiveStack[track.id][pad.effect] ||= []);
  const at = stack.indexOf(idx);
  if (at >= 0) stack.splice(at, 1);
  stack.push(idx);
  editor.performHeldPads[track.id][idx] = true;
  applyPerformPadAudio(track.id, pad);
  refreshPerformPadDom(track, idx, true);
}

function deactivatePerformPad(track, idx) {
  if (!editor) return;
  const song = editor.song;
  const pad = getPerformPad(song, track.id, idx);
  if (!pad) return;
  const stack = editor.performActiveStack?.[track.id]?.[pad.effect];
  if (stack) {
    const at = stack.indexOf(idx);
    if (at >= 0) stack.splice(at, 1);
  }
  if (editor.performHeldPads?.[track.id]) {
    delete editor.performHeldPads[track.id][idx];
  }
  // Restore: if another pad still holds this effect, its values apply;
  // otherwise restore the song's baseline. applyEffectToAudio now writes
  // every chain node the perform pad could have touched (delay/echo
  // feedback + time, filter Q, etc.) so no separate reset step is needed.
  if (stack && stack.length > 0) {
    const top = stack[stack.length - 1];
    const topPad = getPerformPad(song, track.id, top);
    if (topPad) applyPerformPadAudio(track.id, topPad);
  } else {
    applyEffectToAudio(song, track.id, pad.effect);
  }
  refreshPerformPadDom(track, idx, false);
}

// Light-weight DOM toggle for the "active" class on a perform-pad button —
// avoids a full rerenderArea on every press/release so the highlight stays
// snappy.
function refreshPerformPadDom(track, idx, active) {
  const sel = `.perform-pad[data-perform-idx="${idx}"]`;
  const areaEl = document.querySelectorAll(".side-stack")[track.side === "left" ? 0 : 1]
    ?.children?.[track.slot];
  if (!areaEl) return;
  const btn = areaEl.querySelector(sel);
  if (btn) btn.classList.toggle("active", !!active);
}

// ───── Effect picker modal ─────
// Opens centered over the app. Shows every effect available on this track
// as a square button in a grid; tapping one creates a perform pad for it
// at the requested slot, then opens the inline parameter editor so the
// user can tweak the preset immediately.
function openEffectPickerModal(track, idx) {
  if (!editor) return;
  const song = editor.song;
  const keys = trackEffectKeys(track.id);
  const dialog = el("div", { class: "effect-picker-dialog" },
    el("div", { class: "effect-picker-title" }, "choose an effect for this pad"),
    el("div", { class: "effect-picker-grid" },
      ...keys.map(name => el("button", {
        class: "effect-picker-item",
        title: name,
        onclick: () => {
          setPerformPad(song, track.id, idx, makePerformPad(song, track.id, name));
          editor.performPadFocus[track.id] = idx;
          markDirty();
          schedulePersist();
          closeEffectPickerModal();
          rerenderArea(track);
        },
      }, name))
    ),
    el("div", { class: "effect-picker-footer" },
      el("button", {
        class: "effect-picker-cancel",
        onclick: () => closeEffectPickerModal(),
      }, "cancel"),
    ),
  );
  const backdrop = el("div", {
    class: "effect-picker-backdrop",
    onclick: (e) => { if (e.target === backdrop) closeEffectPickerModal(); },
  }, dialog);
  backdrop.id = "effect-picker-backdrop";
  document.body.appendChild(backdrop);
}
function closeEffectPickerModal() {
  document.getElementById("effect-picker-backdrop")?.remove();
}

// Render the visible label inside a pad based on pad.labelType.
//   "text"  → .pad-name span (auto-fitted)
//   "emoji" → .pad-emoji span (auto-fitted)
//   "draw"  → .pad-draw img (CSS-fit, no font sizing)
// In edit mode the element is clickable and opens the pad-label modal.
function renderPadLabel(pad, track, idx, isEdit) {
  const labelType = pad.labelType || "text";
  const onclick = isEdit ? ((e) => { e.stopPropagation(); openPadLabelModal(track, idx); }) : undefined;
  const title   = isEdit ? "click to edit label" : (pad.name || labelType);
  if (labelType === "draw" && pad.drawImage) {
    // Wrapper fills the pad edge-to-edge so the chosen bg color (if any)
    // shows as the pad background. The strokes-only PNG sits centered on top.
    const bg = pad.drawBg && pad.drawBg !== "transparent" ? pad.drawBg : null;
    return el("div", {
      class: "pad-draw-wrap" + (isEdit ? " editable" : ""),
      title,
      onclick,
      style: bg ? `background: ${bg};` : "",
    },
      el("img", { class: "pad-draw", src: pad.drawImage, alt: pad.name || "" })
    );
  }
  if (labelType === "emoji" && pad.emoji) {
    return el("span", { class: "pad-emoji" + (isEdit ? " editable" : ""), title, onclick }, pad.emoji);
  }
  return el("span", { class: "pad-name" + (isEdit ? " editable" : ""), title, onclick }, pad.name);
}

function renderPad(song, track, idx) {
  const pad = song.pads[track.id][idx];
  const padKey = padKeyFor(track.id, idx);
  const isMapping = !!editor?.midiMapping;
  const isEdit = editor && editor.mode === "edit" && !isMapping;
  // Reflect the "playing" highlight at render time so it survives area
  // re-renders (e.g. switching the effects tab off and back to samples).
  const isPlaying = Audio.isPadPlaying(padKey) || !!editor?.pendingApplies?.[padKey];

  // MIDI mapping state for this pad.
  const mapKey = midiKeyForSamplePad(track.id, idx);
  const mappedNote = isMapping ? getMidiNoteFor(song, mapKey) : null;
  const isMapSelected = isMapping && editor.midiMappingSelected === mapKey;

  const titleText = isMapping
    ? (mappedNote != null
        ? `mapped to ${midiNoteName(mappedNote)} — tap to remap`
        : "tap to select, then press a MIDI key")
    : (pad
        ? (isEdit ? `${pad.name} — drop a file to replace` : `${pad.name} — tap to play, drop a file to replace`)
        : "drop audio file or tap to load");

  const node = el("button", {
    class: "pad"
      + (pad ? " loaded" : "")
      + (isEdit ? " edit" : "")
      + (isPlaying ? " playing" : "")
      + (isMapping ? " midi-mappable" : "")
      + (isMapSelected ? " midi-map-selected" : ""),
    style: `--row-color: ${track.color}`,
    title: titleText,
    // Only loaded pads can be dragged out as a source — empty pads have
    // nothing to move. Edit-mode-only so live performance taps don't
    // start an accidental drag. NOTE: must be the LITERAL string "true"
    // (not boolean true) — the el() helper turns a boolean true into
    // draggable="" which the HTML spec treats as the enumerated "auto"
    // value, and "auto" on a <button> means NOT draggable. That's why
    // the previous build wouldn't grab.
    draggable: (pad && isEdit) ? "true" : "false",
    ondragstart: (e) => {
      if (!pad || !isEdit) { e.preventDefault(); return; }
      try {
        e.dataTransfer.effectAllowed = "move";
        // Custom MIME so the receiver can distinguish a pad-to-pad
        // drag from a file drop (which puts files on dataTransfer.files
        // instead). Encodes source trackId + idx so the move/swap
        // handler can look up the source pad.
        e.dataTransfer.setData(
          "application/x-beatstudio-pad",
          JSON.stringify({ trackId: track.id, idx })
        );
        // Plaintext fallback so dragging into a non-beatstudio target
        // doesn't silently fail with no dataTransfer payload at all.
        e.dataTransfer.setData("text/plain", pad.name || "sample");
        node.classList.add("dragging-source");
      } catch {}
    },
    ondragend: () => {
      node.classList.remove("dragging-source");
    },
    ondragover: (e) => {
      e.preventDefault();
      // Differentiate visually: pads-from-pad drags get a move cursor,
      // file drags keep the default copy cursor.
      try {
        const isPadDrag = e.dataTransfer.types && Array.prototype.includes.call(e.dataTransfer.types, "application/x-beatstudio-pad");
        e.dataTransfer.dropEffect = isPadDrag ? "move" : "copy";
      } catch {}
      node.classList.add("dragover");
    },
    ondragleave: () => node.classList.remove("dragover"),
    ondrop: async (e) => {
      e.preventDefault();
      node.classList.remove("dragover");
      // Pad-to-pad drag has priority over any accidental file payload.
      const padPayload = e.dataTransfer.getData("application/x-beatstudio-pad");
      if (padPayload) {
        try {
          const src = JSON.parse(padPayload);
          if (src && src.trackId && Number.isInteger(src.idx)) {
            await movePadSample(src.trackId, src.idx, track.id, idx);
          }
        } catch (err) { console.warn("[drag] bad pad payload", err); }
        return;
      }
      const file = e.dataTransfer.files?.[0];
      if (file) await assignSample(track, idx, file);
    },
  },
    // Small badge with the currently mapped MIDI note (mapping mode only).
    isMapping && mappedNote != null
      ? el("span", { class: "pad-midi-note" }, midiNoteName(mappedNote))
      : null,
    // Pad label — text / drawing / emoji depending on labelType. In edit
    // mode clicking the label opens the editor modal.
    pad ? renderPadLabel(pad, track, idx, isEdit) : null,
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
          el("div", { class: "pad-quantize-toggle", title: "Quantize: 'song' follows the song's quantize setting. 'off' triggers this pad immediately even when the song is quantized." },
            el("button", {
              class: !padIsQuantizeOff(pad) ? "active" : "",
              onclick: (e) => { e.stopPropagation(); setPadQuantize(track, idx, "song"); }
            }, "song"),
            el("button", {
              class: padIsQuantizeOff(pad) ? "active" : "",
              onclick: (e) => { e.stopPropagation(); setPadQuantize(track, idx, "off"); }
            }, "off"),
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

function setPadQuantize(track, idx, value) {
  const pad = editor?.song?.pads?.[track.id]?.[idx];
  if (!pad) return;
  const next = value === "off" ? "off" : "song";
  if (padQuantize(pad) === next) return;
  pad.quantize = next;
  markDirty();
  persist({ silent: true });
  rerenderArea(track);
}

// Open the pad-label editor. Three modes:
//   text  — plain string (default), auto-fits inside the pad
//   draw  — finger / trackpad sketch with color picker and clear
//   emoji — single emoji (or short string) shown at large size
// The stored shape on the pad is { name, emoji, drawImage, labelType }.
function openPadLabelModal(track, idx) {
  const pad = editor?.song?.pads?.[track.id]?.[idx];
  if (!pad) return;

  let mode = pad.labelType || "text";
  let textValue  = pad.name  || "";
  let emojiValue = pad.emoji || "";
  let strokeColor = "#ffffff";

  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();

  // ── Text body ──
  const textInput = el("input", { type: "text", value: textValue, placeholder: "sample name" });
  textInput.addEventListener("input", () => { textValue = textInput.value; });
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") close();
  });
  const textBody = el("div", { class: "pad-label-body" }, textInput);

  // ── Emoji body ──
  const emojiInput = el("input", { type: "text", value: emojiValue, placeholder: "🎵 (any emoji or short text)", maxlength: 8 });
  emojiInput.addEventListener("input", () => { emojiValue = emojiInput.value; });
  emojiInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") close();
  });
  const emojiPicker = el("div", { class: "emoji-grid" });
  const presetEmojis = ["🎵","🎶","🎸","🥁","🎤","🎺","🎷","🎹","🎻","🎼","🔥","💥","⚡","✨","🌊","💎","🌟","🚀","❤️","👻","🌈","🎉","🎯","💀"];
  for (const emo of presetEmojis) {
    const btn = el("button", { class: "emoji-btn" }, emo);
    btn.addEventListener("click", () => { emojiValue = emo; emojiInput.value = emo; });
    emojiPicker.appendChild(btn);
  }
  const emojiBody = el("div", { class: "pad-label-body" }, emojiInput, emojiPicker);

  // ── Draw body ──
  // Two-canvas setup: an offscreen strokeCanvas holds only the strokes
  // (transparent everywhere else); the visible drawCanvas is composited as
  // (background fill) + drawImage(strokeCanvas). That makes "change the
  // background colour" a single recomposite — strokes are preserved.
  const drawCanvas = el("canvas", { class: "pad-draw-canvas" });
  drawCanvas.width = 320; drawCanvas.height = 320;
  const dctx = drawCanvas.getContext("2d");

  const strokeCanvas = document.createElement("canvas");
  strokeCanvas.width = drawCanvas.width;
  strokeCanvas.height = drawCanvas.height;
  const sctx = strokeCanvas.getContext("2d");
  sctx.lineWidth = 10;
  sctx.lineCap   = "round";
  sctx.lineJoin  = "round";
  sctx.strokeStyle = strokeColor;
  // Background fill for the saved image. "transparent" means no fill — the
  // pad's actual background shows through behind the strokes.
  let bgColor = pad.drawBg || "transparent";

  function applyBg() {
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    if (bgColor && bgColor !== "transparent") {
      dctx.fillStyle = bgColor;
      dctx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
    }
    dctx.drawImage(strokeCanvas, 0, 0);
  }
  function clearCanvas() {
    sctx.clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
    applyBg();
  }
  clearCanvas();
  // Mirror the stroke-canvas brush onto the visible canvas for live feedback.
  dctx.lineWidth = sctx.lineWidth;
  dctx.lineCap   = sctx.lineCap;
  dctx.lineJoin  = sctx.lineJoin;
  dctx.strokeStyle = strokeColor;

  if (pad.drawImage) {
    const img = new Image();
    img.onload = () => {
      sctx.drawImage(img, 0, 0, drawCanvas.width, drawCanvas.height);
      // Auto-migrate drawings made before the strokes-only split: if the
      // loaded image has a uniform baked-in background, strip those pixels
      // to transparent and remember the colour as the chosen bg. From then
      // on the wrap's bg = pad.drawBg, and the img is just strokes — no
      // dark square inside a coloured pad.
      if (pad.drawBg == null) {
        const migrated = stripBakedBg();
        if (migrated) {
          bgColor = migrated;
          // Reflect the detected bg in the swatch ribbon (active state).
          bgPicker.querySelectorAll(".draw-bg-swatch").forEach(s => s.classList.remove("active"));
          for (const s of bgPicker.querySelectorAll(".draw-bg-swatch")) {
            const sBg = s.style.backgroundColor || "";
            if (sBg && colorEq(sBg, migrated)) { s.classList.add("active"); break; }
          }
        }
      }
      applyBg();
    };
    img.src = pad.drawImage;
  }

  // Detect a baked-in background from the four corners of the strokeCanvas
  // and turn every pixel matching that colour transparent. Returns the
  // detected colour as a #rrggbb hex string, or null if the corners aren't
  // consistent enough to call it a background.
  function stripBakedBg() {
    const w = strokeCanvas.width, h = strokeCanvas.height;
    const corners = [
      sctx.getImageData(3, 3, 1, 1).data,
      sctx.getImageData(w - 4, 3, 1, 1).data,
      sctx.getImageData(3, h - 4, 1, 1).data,
      sctx.getImageData(w - 4, h - 4, 1, 1).data,
    ];
    // If 3+ corners are mostly transparent, this is already a new-format
    // strokes-only drawing — nothing to strip.
    if (corners.filter(c => c[3] >= 128).length < 3) return null;
    const bgPx = corners.find(c => c[3] >= 128);
    const tolerance = 14;
    const imageData = sctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    let stripped = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i+3] >= 1 &&
          Math.abs(data[i]   - bgPx[0]) < tolerance &&
          Math.abs(data[i+1] - bgPx[1]) < tolerance &&
          Math.abs(data[i+2] - bgPx[2]) < tolerance) {
        data[i+3] = 0;
        stripped++;
      }
    }
    // Only commit the strip if the bg actually covered most of the canvas
    // — protects against false positives on already-transparent images that
    // happen to have one near-opaque corner (rare).
    if (stripped < (w * h) * 0.2) return null;
    sctx.putImageData(imageData, 0, 0);
    return "#" + [0,1,2].map(i => bgPx[i].toString(16).padStart(2, "0")).join("");
  }
  function colorEq(a, b) {
    // Quick & dirty: compare normalized rgb strings or hex.
    const norm = (s) => {
      const m = String(s).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) return [+m[1],+m[2],+m[3]];
      const hex = String(s).replace("#","").trim();
      if (hex.length === 6) return [0,2,4].map(i => parseInt(hex.slice(i, i+2), 16));
      return null;
    };
    const A = norm(a), B = norm(b);
    if (!A || !B) return false;
    return Math.abs(A[0]-B[0]) < 6 && Math.abs(A[1]-B[1]) < 6 && Math.abs(A[2]-B[2]) < 6;
  }

  let drawing = false, lastX = 0, lastY = 0;
  const ptToCanvas = (e) => {
    const r = drawCanvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (drawCanvas.width  / r.width),
      (e.clientY - r.top)  * (drawCanvas.height / r.height),
    ];
  };
  drawCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    drawing = true;
    [lastX, lastY] = ptToCanvas(e);
    // Dot on stroke buffer + mirror on visible canvas for live response.
    sctx.fillStyle = sctx.strokeStyle;
    sctx.beginPath(); sctx.arc(lastX, lastY, sctx.lineWidth / 2, 0, Math.PI * 2); sctx.fill();
    dctx.fillStyle = sctx.strokeStyle;
    dctx.beginPath(); dctx.arc(lastX, lastY, sctx.lineWidth / 2, 0, Math.PI * 2); dctx.fill();
    try { drawCanvas.setPointerCapture(e.pointerId); } catch {}
  });
  drawCanvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const [x, y] = ptToCanvas(e);
    sctx.beginPath(); sctx.moveTo(lastX, lastY); sctx.lineTo(x, y); sctx.stroke();
    dctx.beginPath(); dctx.moveTo(lastX, lastY); dctx.lineTo(x, y); dctx.stroke();
    lastX = x; lastY = y;
  });
  const endDraw = (e) => {
    drawing = false;
    try { drawCanvas.releasePointerCapture(e.pointerId); } catch {}
  };
  drawCanvas.addEventListener("pointerup",     endDraw);
  drawCanvas.addEventListener("pointercancel", endDraw);
  drawCanvas.addEventListener("pointerleave",  endDraw);

  // ── Stroke colour picker ──
  const drawColors = ["#ffffff","#ff5252","#ff9800","#ffeb3b","#4caf50","#2196f3","#ce93d8","#000000"];
  const drawColorPicker = el("div", { class: "draw-colors" });
  for (const c of drawColors) {
    const swatch = el("button", { class: "draw-color-swatch", style: `background: ${c}` });
    swatch.addEventListener("click", () => {
      strokeColor = c;
      sctx.strokeStyle = c;
      dctx.strokeStyle = c;
      drawColorPicker.querySelectorAll(".draw-color-swatch").forEach(s => s.classList.remove("active"));
      swatch.classList.add("active");
    });
    if (c === strokeColor) swatch.classList.add("active");
    drawColorPicker.appendChild(swatch);
  }

  // ── Background colour picker (includes a "transparent" option) ──
  const bgOptions = [
    { value: "transparent", className: "transparent", label: "" },
    { value: "#1a1a1c", className: "", label: "" },
    { value: "#ffffff", className: "", label: "" },
    { value: "#ff5252", className: "", label: "" },
    { value: "#ffeb3b", className: "", label: "" },
    { value: "#4caf50", className: "", label: "" },
    { value: "#2196f3", className: "", label: "" },
    { value: "#000000", className: "", label: "" },
  ];
  const bgPicker = el("div", { class: "draw-bgs" });
  for (const opt of bgOptions) {
    const swatch = el("button", {
      class: "draw-bg-swatch " + opt.className,
      title: opt.value === "transparent" ? "no background (transparent)" : opt.value,
      style: opt.value === "transparent" ? "" : `background: ${opt.value}`,
    });
    swatch.addEventListener("click", () => {
      bgColor = opt.value;
      applyBg();
      bgPicker.querySelectorAll(".draw-bg-swatch").forEach(s => s.classList.remove("active"));
      swatch.classList.add("active");
    });
    if (opt.value === bgColor) swatch.classList.add("active");
    bgPicker.appendChild(swatch);
  }

  const clearBtn = el("button", { class: "btn ghost small" }, "clear");
  clearBtn.addEventListener("click", () => { clearCanvas(); refreshPreview(); });

  // ── Live preview: pad-shaped element showing how the drawing will look
  // on the actual pad. Uses the track's row color as the underlying gradient
  // (or the chosen bg) so what you see is what you'll get. ──
  const trackBg = getTrackColor(editor.song, track);
  const previewWrap = el("div", { class: "pad-draw-preview-wrap" });
  previewWrap.style.setProperty("--row-color", trackBg);
  const previewCanvas = el("canvas", { class: "pad-draw-preview-canvas" });
  previewCanvas.width = 200; previewCanvas.height = 200;
  const pctx = previewCanvas.getContext("2d");
  previewWrap.appendChild(previewCanvas);

  function refreshPreview() {
    if (bgColor && bgColor !== "transparent") {
      previewWrap.style.background = bgColor;
    } else {
      previewWrap.style.background = "";
    }
    pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    pctx.drawImage(strokeCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
  }
  refreshPreview();

  // Wire preview refresh into stroke + bg events. drawImage canvas→canvas
  // is fast enough to update on every pointermove.
  const _origApplyBg = applyBg;
  applyBg = function () { _origApplyBg(); refreshPreview(); };
  drawCanvas.addEventListener("pointermove", () => { if (drawing) refreshPreview(); });
  drawCanvas.addEventListener("pointerup",     refreshPreview);
  drawCanvas.addEventListener("pointercancel", refreshPreview);

  const drawBody = el("div", { class: "pad-label-body" },
    drawCanvas,
    el("div", { class: "draw-toolbar" },
      el("div", { class: "draw-toolbar-row" },
        el("span", { class: "draw-toolbar-label" }, "stroke"),
        drawColorPicker,
      ),
      el("div", { class: "draw-toolbar-row" },
        el("span", { class: "draw-toolbar-label" }, "bg"),
        bgPicker,
        clearBtn,
      ),
      el("div", { class: "draw-toolbar-row" },
        el("span", { class: "draw-toolbar-label" }, "preview"),
        previewWrap,
      ),
    ),
  );

  // ── Tabs ──
  const textTab  = el("button", { class: "pad-label-tab" }, "text");
  const drawTab  = el("button", { class: "pad-label-tab" }, "draw");
  const emojiTab = el("button", { class: "pad-label-tab" }, "emoji");
  function setMode(newMode) {
    mode = newMode;
    textTab.classList.toggle ("active", mode === "text");
    drawTab.classList.toggle ("active", mode === "draw");
    emojiTab.classList.toggle("active", mode === "emoji");
    textBody.style.display  = mode === "text"  ? "" : "none";
    drawBody.style.display  = mode === "draw"  ? "" : "none";
    emojiBody.style.display = mode === "emoji" ? "" : "none";
    if (mode === "text")  setTimeout(() => textInput.focus(),  0);
    if (mode === "emoji") setTimeout(() => emojiInput.focus(), 0);
  }
  textTab.addEventListener ("click", () => setMode("text"));
  drawTab.addEventListener ("click", () => setMode("draw"));
  emojiTab.addEventListener("click", () => setMode("emoji"));
  setMode(mode);

  function commit() {
    if (mode === "text") {
      const trimmed = (textValue || "").trim();
      if (trimmed) pad.name = trimmed;
      pad.labelType = "text";
    } else if (mode === "draw") {
      // Save STROKES only (transparent PNG) and the bg as a separate value
      // so the pad can apply bg to its whole area, not just the image's
      // contained bounding box.
      pad.drawImage = strokeCanvas.toDataURL("image/png");
      pad.drawBg = bgColor;
      pad.labelType = "draw";
      if (!pad.name) pad.name = "drawing";
    } else if (mode === "emoji") {
      const trimmed = (emojiValue || "").trim();
      if (trimmed) pad.emoji = trimmed;
      pad.labelType = "emoji";
      if (!pad.name && trimmed) pad.name = trimmed;
    }
    close();
    markDirty();
    persist({ silent: true });
    rerenderArea(track);
  }
  const cancelBtn = el("button", { class: "btn ghost"   }, "cancel");
  cancelBtn.addEventListener("click", close);
  const saveBtn   = el("button", { class: "btn primary" }, "save");
  saveBtn.addEventListener("click", commit);

  host.replaceChildren(
    el("div", { class: "modal pad-label-modal" },
      el("h3", {}, "edit pad label"),
      el("div", { class: "pad-label-tabs" }, textTab, drawTab, emojiTab),
      textBody, drawBody, emojiBody,
      el("div", { class: "modal-actions" }, cancelBtn, saveBtn),
    ),
  );
  if (mode === "text")  setTimeout(() => textInput.focus(),  0);
  if (mode === "emoji") setTimeout(() => emojiInput.focus(), 0);
}

// Wraps the deck in a resizable container with a corner handle. Dragging
// the handle proportionally scales the deck (and everything inside —
// labels, waveforms, beat grid, playhead, markers) via CSS transform.
// Scale persists per device in localStorage.
function renderResizableDeck(song) {
  const deck = renderDeck(song);
  const isEdit = editor?.mode === "edit";
  // Resize controls are edit-mode only. Performance mode still respects
  // any saved scale (the layout reads it on mount and applies it), it just
  // omits the drag handle + reset button so they can't be triggered mid-take.
  const handle = isEdit ? el("div", {
    class: "deck-resize-handle",
    title: "drag to resize the timeline area",
  }) : null;
  const resetBtn = isEdit ? el("button", {
    class: "deck-resize-reset",
    title: "reset timeline to default size",
  }, "reset size") : null;
  const wrap = el("div", { class: "deck-resize-wrap" }, deck, resetBtn, handle);

  // Resolve initial scale. Priority:
  //   1. Global pref served by the dev server (so the tablet sees the
  //      same size the laptop set — single source of truth).
  //   2. Per-device localStorage (filled in by previous saves; also acts
  //      as an offline fallback when the server pref is unreachable).
  // The server fetch is async, so we paint with whatever we have right
  // now (localStorage or 1) and re-apply once the server replies.
  let scale = parseFloat(localStorage.getItem("beatstudio.deckScale") || "1");
  if (typeof GLOBAL_PREFS?.deckScale === "number") scale = GLOBAL_PREFS.deckScale;
  if (!Number.isFinite(scale) || scale < 0.35 || scale > 1.5) scale = 1;
  let naturalW = 0, naturalH = 0;

  function measureNatural() {
    // Reset every override so getBoundingClientRect reflects the
    // grid-stretched cell-filling size.
    deck.style.transform = "";
    deck.style.width  = "";
    deck.style.height = "";
    wrap.style.width  = "";
    wrap.style.height = "";
    const r = deck.getBoundingClientRect();
    if (r.width  > 0) naturalW = r.width;
    if (r.height > 0) naturalH = r.height;
  }
  function applyScale() {
    if (naturalW <= 0 || naturalH <= 0) return;
    if (resetBtn) resetBtn.classList.toggle("visible", scale !== 1);
    wrap.classList.toggle("scaled", scale !== 1);
    if (scale === 1) {
      // Clear everything — back to natural layout.
      deck.style.transform = "";
      deck.style.width  = "";
      deck.style.height = "";
      wrap.style.width  = "";
      wrap.style.height = "";
      // Clear canvas overrides.
      deck.querySelectorAll(".deck-canvas-wrap canvas").forEach((c) => {
        c.style.position = "";
        c.style.top = "";
        c.style.left = "";
        c.style.width = "";
        c.style.height = "";
        c.style.transform = "";
        c.style.transformOrigin = "";
      });
      // Clear label overrides.
      deck.querySelectorAll(".deck-row .deck-label").forEach((l) => {
        l.style.transform = "";
        l.style.transformOrigin = "";
      });
      return;
    }
    // PROPORTIONAL deck shrink via CSS transform (both axes). The wrap
    // sizes to the visible (scaled) box so the editor-body grid sees it.
    deck.style.transform = `scale(${scale})`;
    deck.style.transformOrigin = "top left";
    deck.style.width  = `${naturalW}px`;
    deck.style.height = `${naturalH}px`;
    wrap.style.width  = `${naturalW * scale}px`;
    wrap.style.height = `${naturalH * scale}px`;
    // Counter-scale the WAVEFORM canvas's vertical axis so the sample
    // stays at natural height. Explicit absolute centring (top: 50% +
    // translateY -50%) anchors it to the row's vertical center so the
    // counter-scale expands symmetrically above and below, no matter how
    // the parent transforms it.
    const inv = 1 / scale;
    deck.querySelectorAll(".deck-canvas-wrap canvas").forEach((c) => {
      c.style.position = "absolute";
      c.style.top = "50%";
      c.style.left = "0";
      c.style.width = "100%";
      c.style.height = "100%";
      c.style.transformOrigin = "50% 50%";
      c.style.transform = `translateY(-50%) scaleY(${inv})`;
    });
    // Same treatment for each row's label so the track name stays at its
    // natural font size + centred vertically on the row, instead of being
    // squished down with the deck.
    deck.querySelectorAll(".deck-row .deck-label").forEach((l) => {
      l.style.transformOrigin = "50% 50%";
      l.style.transform = `scaleY(${inv})`;
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      scale = 1;
      applyScale();
      try { localStorage.removeItem("beatstudio.deckScale"); } catch {}
      // Also clear the global server pref so every device falls back to
      // the default the next time it opens any song.
      saveGlobalPref("deckScale", null);
    });
  }

  // Initial layout pass.
  requestAnimationFrame(() => { measureNatural(); applyScale(); });

  // Window resize → re-measure (grid column width may have changed).
  // We swap to scale=1 temporarily inside measureNatural so the natural size
  // is the column's current width; then re-apply the user-chosen scale.
  window.addEventListener("resize", () => {
    measureNatural();
    applyScale();
  });

  let dragging = false;
  let dragStartCursorX = 0;
  let dragStartCursorY = 0;
  let dragStartScale   = 1;
  if (handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      // No measureNatural() here — that resets the deck to natural size
      // briefly and causes a visible snap *before* the user moves. The
      // mount-time + window-resize handler keeps naturalW/H fresh enough.
      // Track cursor delta instead of absolute origin so the centred
      // wrap's edges follow the cursor cleanly each frame.
      dragStartCursorX = e.clientX;
      dragStartCursorY = e.clientY;
      dragStartScale   = scale;
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
  }
  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartCursorX;
    const dy = e.clientY - dragStartCursorY;
    // When the wrap is horizontally centred (scaled state) both edges
    // move symmetrically — so 1 unit of cursor movement = 2 units of
    // width change. At scale === 1 the wrap fills its cell (no centring),
    // hence a 1× factor. We pick the factor from the starting scale and
    // keep it fixed for the duration of this drag so the response stays
    // continuous (no sudden speed-up at the scale=1 boundary).
    const factor = dragStartScale < 1 ? 2 : 1;
    const newW = naturalW * dragStartScale + factor * dx;
    const newH = naturalH * dragStartScale + factor * dy;
    const sx = newW / naturalW;
    const sy = newH / naturalH;
    scale = Math.max(0.35, Math.min(1.5, Math.min(sx, sy)));
    applyScale();
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle && handle.releasePointerCapture(e.pointerId); } catch {}
    localStorage.setItem("beatstudio.deckScale", scale.toString());
    // Persist globally on the server so any device (tablet, etc.) on the
    // same LAN sees the same timeline size on next load.
    saveGlobalPref("deckScale", scale === 1 ? null : scale);
  };
  if (handle) {
    document.addEventListener("pointermove",   onMove);
    document.addEventListener("pointerup",     onUp);
    document.addEventListener("pointercancel", onUp);
  }

  return wrap;
}

function renderDeck(song) {
  const shared = isTimelineShared(song);
  // Hidden song-parts are filtered out of the deck regardless of mode.
  // The side-stack panel for a hidden part still shows in edit mode
  // (so the user can un-hide it) — but the timeline row never does.
  // Remaining visible rows pack tight from the top with no gaps.
  const visibleTracks = TRACKS.filter(t => !isTrackHidden(song, t.id));
  const rowCount = Math.max(1, visibleTracks.length);
  const rows = visibleTracks.map(t => {
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
    return el("div", {
        class: "deck-row"
          + (isTrackHidden(song, t.id) ? " hidden-in-perform" : "")
          + (isTrackMuted(song, t.id) ? " muted" : ""),
        "data-track-id": t.id,
        style: `--row-color: ${getTrackColor(song, t)}`,
      },
      el("div", { class: "deck-label" }, getTrackLabel(song, t)),
      el("div", { class: "deck-canvas-wrap" }, ...wrapKids)
    );
  });
  // Inline grid-template-rows so the deck stretches its visible rows
  // to fill the available height — no empty rows at the bottom when
  // tracks are hidden.
  return el("div", {
    class: "deck" + (shared ? "" : " free-mode"),
    style: `grid-template-rows: repeat(${rowCount}, 1fr);`,
  }, ...rows);
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

// Free mode dynamic beat grid: when voices are playing on a row, lay out
// a vertical grid showing every beat across the row's current audio
// span (at the song's BPM), with bar boundaries (every BAR_BEATS) shown
// more prominently. Removed entirely when the row is empty so an idle
// row stays bare.
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
// Global waveform amplitude factor — fraction of canvas height that
// full-amplitude bars occupy. User-adjustable via the "wave height" slider
// in the editor header (edit mode). Persisted in localStorage so the
// setting carries across reloads + devices independently.
function getWaveformHeight() {
  const v = parseFloat(localStorage.getItem("beatstudio.waveformHeight") || "0.9");
  return Number.isFinite(v) ? Math.max(0.1, Math.min(2, v)) : 0.9;
}
function setWaveformHeight(v) {
  const clamped = Math.max(0.1, Math.min(2, v));
  try { localStorage.setItem("beatstudio.waveformHeight", clamped.toString()); } catch {}
  if (!editor) return;
  for (const t of TRACKS) drawWaveform(t.id);
}

async function drawWaveform(trackId) {
  const d = editor.decks[trackId];
  if (!d) return;
  // Free mode intentionally has NO beat grid — each row's timeline is
  // sized to its own samples so the fixed beat-count grid wouldn't make
  // sense. rebuildFreeBeats() also tears down any existing grid, so
  // calling it here ensures stale beats from a prior shared-mode render
  // get removed when we switch to free.
  rebuildFreeBeats(trackId);
  const c = d.canvas;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  // Amplitude factor — how much of the row's height full-amplitude bars
  // occupy. Read at draw time so live slider changes show immediately.
  const ampFactor = getWaveformHeight();

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
        const bh = Math.max(1, v * (h * ampFactor));
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
      const bh = Math.max(1, v * (h * ampFactor));
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
  applyEffectsToHeights(heights, w, h * ampFactor, editor.song, trackId, rowDur);

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
  const padKey = padKeyFor(track.id, idx);

  // Touch the audio context inside this user-gesture chain.
  const ctx = Audio.nowCtx();
  if (ctx && ctx.state !== "running") {
    try { ctx.resume(); } catch {}
    reportAudioStateIfBlocked();
  }

  // Tap while playing — behavior depends on the pad's `retap` setting:
  //   "stop"    (default): tap stops the pad and returns.
  //   "restart": tap stops the current voice and falls through to retrigger.
  // When quantize is on we DEFER the stop to the next quantize boundary
  // (and for "restart" the new voice is started at the same boundary).
  // That way there's no silent gap between stopping the old and starting
  // the new — both land on the same beat.
  if (Audio.isPadPlaying(padKey) || editor.pendingApplies[padKey]) {
    const effectiveQuant = padIsQuantizeOff(pad) ? "off" : song.quantize;
    if (!padIsRestart(pad)) {
      // Pure "stop" tap.
      if (effectiveQuant === "off") {
        stopPadAndUpdateVisuals(track.id, padKey);
      } else {
        const when = computeQuantizedWhen(song, effectiveQuant);
        scheduleStopPadAt(track.id, padKey, when);
      }
      return;
    }
    // "restart" mode — fall through to scheduleTrigger which will
    // schedule the new voice AND defer the old voice's stop to the
    // same `when` (handled inside scheduleTrigger).
  }

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

// Shared helper: compute the next quantize boundary on the audio clock
// for the given song-level quantize setting. Mirrors the math inside
// scheduleTrigger but extracted so triggerPad can use it without
// duplicating the logic for the stop-only path.
function computeQuantizedWhen(song, quant) {
  const ctx = Audio.nowCtx();
  const t = ctx.currentTime;
  if (quant === "off") return t;
  const beat = 60 / (song.bpm || DEFAULT_BPM);
  const grid = quant === "1/2" ? beat * 2 : beat;
  const shared = isTimelineShared(song);
  if (shared) {
    if (!Transport.isRunning()) return t;
    const elapsed = t - Transport.songStartTime;
    return Transport.songStartTime + Math.ceil(elapsed / grid) * grid;
  }
  // Free mode: align to the master voice (drums or oldest).
  const master = findMasterVoice();
  const origin = master ? master.startedAt : t;
  const elapsed = t - origin;
  return origin + Math.ceil(elapsed / grid) * grid;
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

  // Compute audio scheduling time FIRST so we can align any voice-stops
  // we need to do (solo choke, same-pad restart) to the same beat.
  // Shared mode anchors quantize to the shared transport; free mode
  // anchors to the master voice.
  const effectiveQuant = padIsQuantizeOff(pad) ? "off" : song.quantize;
  const qMode = getQuantizeMode(song);
  let when;
  // sampleOffset: how far into the buffer to start playback. Zero for
  // "wait" mode (the standard case); non-zero for "catch" mode when
  // the user tapped after the previous beat — we start the sample at
  // the lateness offset so it stays in sync with the existing grid.
  let sampleOffset = 0;
  // musicalStart: where the sample's position-0 would have been on the
  // audio clock. For "wait" mode = when. For "catch" mode = the most
  // recent beat in the past (= when - sampleOffset). Used for the
  // editor.playing.startedAt so beat-anchoring downstream stays
  // consistent (free-mode quantize, waveform alignment, etc.).
  let musicalStart;
  if (shared) {
    if (!Transport.isRunning()) {
      when = t;
      Transport.start(when);
      musicalStart = when;
    } else if (effectiveQuant === "off") {
      when = t;
      musicalStart = when;
    } else {
      const beat = 60 / (song.bpm || DEFAULT_BPM);
      const grid = effectiveQuant === "1/2" ? beat * 2 : beat;
      const elapsed = t - Transport.songStartTime;
      if (qMode === "catch") {
        // Snap to the NEAREST beat (not just the next one). If the tap
        // landed in the first half of a grid period, we're "late" for
        // the previous beat and catch up by skipping into the sample.
        // If it landed in the second half, we're "early" for the next
        // beat and just wait for it like wait-mode does.
        const lateness = elapsed - Math.floor(elapsed / grid) * grid;
        if (lateness > 0 && lateness <= grid / 2 && lateness < sampleDuration) {
          when = t;
          sampleOffset = lateness;
          musicalStart = when - sampleOffset;
        } else {
          // Either exactly on a beat (lateness ≈ 0, snap is moot), or
          // closer to the next beat → forward-snap as normal.
          const nextElapsed = Math.ceil(elapsed / grid) * grid;
          when = Transport.songStartTime + nextElapsed;
          musicalStart = when;
        }
      } else {
        const nextElapsed = Math.ceil(elapsed / grid) * grid;
        when = Transport.songStartTime + nextElapsed;
        musicalStart = when;
      }
    }
  } else {
    if (effectiveQuant === "off") {
      when = t;
      musicalStart = when;
    } else {
      const beat = 60 / (song.bpm || DEFAULT_BPM);
      const grid = effectiveQuant === "1/2" ? beat * 2 : beat;
      const master = findMasterVoice();
      const origin = master ? master.startedAt : t;
      const elapsed = t - origin;
      if (qMode === "catch" && master) {
        // Same nearest-beat logic as the shared branch — only skip
        // into the sample when we're in the first half of a grid
        // period (truly late for the previous beat). Otherwise the
        // tap is early for the next beat and should just wait.
        const lateness = elapsed - Math.floor(elapsed / grid) * grid;
        if (lateness > 0 && lateness <= grid / 2 && lateness < sampleDuration) {
          when = t;
          sampleOffset = lateness;
          musicalStart = when - sampleOffset;
        } else {
          when = origin + Math.ceil(elapsed / grid) * grid;
          musicalStart = when;
        }
      } else {
        when = origin + Math.ceil(elapsed / grid) * grid;
        musicalStart = when;
      }
    }
  }
  const stopImmediately = effectiveQuant === "off";

  // Same-pad retrigger: if this pad was already playing (we're here
  // because retap === "restart"), schedule the existing voice's stop
  // for the same moment the new voice starts.
  if (Audio.isPadPlaying(padKey) || editor.pendingApplies[padKey]) {
    if (stopImmediately) {
      stopPadAndUpdateVisuals(track.id, padKey);
    } else {
      scheduleStopPadAt(track.id, padKey, when);
    }
  }

  // Choke logic: only the per-pad "solo" setting decides whether to
  // stop the other voices on this row. Stack pads stack in BOTH
  // timeline modes. When quantize is on, the stops are scheduled at
  // the same `when` as the new voice — so the swap happens cleanly on
  // the beat with no silent gap.
  if (padIsSolo(pad)) {
    const others = new Set();
    for (const k of Object.keys(editor.playing[track.id] || {})) {
      if (k !== padKey) others.add(k);
    }
    for (const k of Object.keys(editor.pendingApplies || {})) {
      if (k !== padKey && k.startsWith(track.id + ":")) others.add(k);
    }
    for (const k of others) {
      if (stopImmediately) stopPadAndUpdateVisuals(track.id, k);
      else                 scheduleStopPadAt(track.id, k, when);
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
    offset: sampleOffset,
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
  // For catch-mode triggers, "audible" is RIGHT NOW (when === currentTime),
  // and the voice's logical start (startedAt) is back-dated to the last
  // beat so anchored-quantize math downstream still sees a clean grid.
  editor.pendingApplies[padKey] = {
    audibleAt: when,
    apply: () => {
      if (!editor.playing[track.id]) editor.playing[track.id] = {};
      editor.playing[track.id][padKey] = {
        sampleId: pad.sampleId,
        startPos,
        duration: sampleDuration,
        startedAt: musicalStart,
        sampleOffset,        // recorded for diagnostics — how far we skipped
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

// Schedule a stop + visual update to fire at a future audio-clock time.
// Used by the quantize path so that when a new sample is launched on a
// beat boundary, the old sample stops AT THE SAME beat instead of
// stopping immediately (which would leave a silent gap until the new
// voice's quantized start time).
function scheduleStopPadAt(trackId, padKey, when) {
  const ctx = Audio.nowCtx();
  if (!ctx) { stopPadAndUpdateVisuals(trackId, padKey); return; }
  // Schedule the audio stop precisely on the audio clock.
  Audio.scheduleStopPad(padKey, when);
  // Drop the pendingApply so the new voice's apply (also at `when`)
  // owns the visual state going forward.
  delete editor.pendingApplies[padKey];
  // Schedule the cleanup of editor.playing state + visual unhighlight
  // at the same moment. setTimeout in JS time (not audio time) — close
  // enough for visuals since they were always ~16ms off anyway.
  const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
  setTimeout(() => {
    if (!editor) return;
    if (editor.playing[trackId]) delete editor.playing[trackId][padKey];
    drawWaveform(trackId);
    updateRowMarkers(trackId);
    document.querySelector(`.pad[data-pad-key="${padKey}"]`)?.classList.remove("playing");
  }, delayMs);
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

// Move a pad's sample to another pad location, REPLACING whatever was
// at the target. The source pad always becomes empty; the target
// always inherits the source's full pad object (sampleId, name, mode,
// interaction, …). If the target had a sample, that sample's blob is
// freed from IndexedDB + the audio cache so it doesn't leak storage.
//
// Called by the drag-and-drop pad handlers — file drops still flow
// through assignSample() above.
async function movePadSample(srcTrackId, srcIdx, dstTrackId, dstIdx) {
  if (!editor) return;
  if (srcTrackId === dstTrackId && srcIdx === dstIdx) return; // no-op
  const song = editor.song;
  if (!song.pads[srcTrackId] || !song.pads[dstTrackId]) return;
  const srcPad = song.pads[srcTrackId][srcIdx];
  if (!srcPad) return; // dragging an empty pad — nothing to move
  const dstPad = song.pads[dstTrackId][dstIdx];
  // Free the replaced sample's storage. Fire-and-forget — failure here
  // just leaves a stale IDB row, never breaks the move.
  if (dstPad && dstPad.sampleId && dstPad.sampleId !== srcPad.sampleId) {
    try { deleteSample(dstPad.sampleId).catch(() => {}); } catch {}
    try { Audio.evict(dstPad.sampleId); } catch {}
  }
  // Replace: source goes empty, target takes the source's pad verbatim.
  song.pads[dstTrackId][dstIdx] = srcPad;
  song.pads[srcTrackId][srcIdx] = null;
  markDirty();
  schedulePersist();
  // Find both track objects so we can refresh both areas — when the
  // user drags across tracks the source area also needs to update
  // (the moved pad is no longer there).
  const srcTrack = TRACKS.find(t => t.id === srcTrackId);
  const dstTrack = TRACKS.find(t => t.id === dstTrackId);
  if (srcTrack) rerenderArea(srcTrack);
  if (srcTrack !== dstTrack && dstTrack) rerenderArea(dstTrack);
}

function hasAnySample(song) {
  let found = false;
  eachPadInSong(song, (pad) => { if (pad?.sampleId) found = true; });
  return found;
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
  const padKey = padKeyFor(track.id, idx);
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

// Re-render every visible song-part area. Used when a global flag flips
// (e.g. entering / exiting MIDI mapping mode) so all pads pick up the
// new behavior without a full editor remount.
function rerenderAllAreas() {
  if (!editor) return;
  // Also toggle the .midi-mapping-mode class on the editor section so
  // the blue overlay shows/hides immediately.
  const editorEl = document.querySelector(".editor");
  if (editorEl) {
    editorEl.classList.toggle("midi-mapping-mode", !!editor.midiMapping);
  }
  for (const t of TRACKS) {
    if (isTrackHidden(editor.song, t.id) && editor.mode !== "edit") continue;
    rerenderArea(t);
  }
  // Mapping additions / removals always go through here — keep the
  // Launchpad lights in sync.
  lpRefreshLights();
}

// Enter MIDI mapping mode. Requests Web MIDI access (one-time prompt
// from the browser). Pads stop triggering audio and become tap-to-
// select instead; pressing a MIDI key while a pad is selected assigns
// the note to it.
async function enterMidiMappingMode() {
  if (!editor) return;
  const access = await ensureMidiAccess();
  if (!access) {
    toast("MIDI not available in this browser");
    return;
  }
  editor.midiMapping = true;
  editor.midiMappingSelected = null;
  // Clear any zoomed effect / perform-pad-editor focus so every song
  // part shows its normal head (with the Stop + Mute buttons visible
  // and mappable). Otherwise a part stuck on a zoom view would hide
  // its Stop button from mapping mode.
  for (const t of TRACKS) {
    editor.areaEffectFocus[t.id] = null;
    if (editor.performPadFocus) editor.performPadFocus[t.id] = null;
  }
  rerenderAllAreas();
  toast("MIDI mapping on — tap a pad or stop button, then press a MIDI key");
}
function exitMidiMappingMode() {
  if (!editor) return;
  editor.midiMapping = false;
  editor.midiMappingSelected = null;
  rerenderAllAreas();
}
// Open a list of every active mapping with a × to delete each.
// Unified MIDI settings modal — one stop for everything MIDI:
//   1) "enter MIDI mapping" button (kicks the user into mapping mode)
//   2) full list of every active mapping with × to remove + clear all
//   3) list of connected MIDI input devices with a checkbox per device
async function openMidiSettingsModal() {
  if (!editor) return;
  // Eagerly request MIDI access so the device list is populated. If the
  // user has never granted permission, this prompts.
  await ensureMidiAccess();
  const song = editor.song;
  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();

  // — Section 1: mapping mode button.
  const mappingBtn = el("button", {
    class: "btn ghost",
    onclick: async () => {
      close();
      await enterMidiMappingMode();
    },
  }, "enter MIDI mapping");

  // — Section 2: mapping list.
  const map = getSongMidiMap(song);
  const rows = Object.entries(map).map(([key, note]) => {
    const label = midiMapKeyDisplayLabel(song, key);
    return el("div", { class: "midi-map-row" },
      el("span", { class: "midi-map-label" }, label),
      el("span", { class: "midi-map-note" }, midiNoteName(note) + " (" + note + ")"),
      el("button", {
        class: "midi-map-remove",
        title: "remove this mapping",
        onclick: () => {
          setMidiMappingFor(song, key, null);
          markDirty();
          schedulePersist();
          rerenderAllAreas();
          openMidiSettingsModal();
        },
      }, "×"),
    );
  });
  const mappingsBody = rows.length === 0
    ? el("p", { class: "midi-section-empty" }, "no mappings yet. enter MIDI mapping, tap a pad, then press a MIDI key.")
    : el("div", { class: "midi-map-list" }, ...rows);

  // — Section 3: device list with checkboxes.
  const inputs = listMidiInputs();
  const deviceRows = inputs.length === 0
    ? el("p", { class: "midi-section-empty" }, "no MIDI devices detected. connect one and reopen this dialog.")
    : el("div", { class: "midi-device-list" },
        ...inputs.map(inp => {
          const enabled = isMidiDeviceEnabled(inp.id);
          const cb = el("input", {
            type: "checkbox",
            class: "midi-device-checkbox",
          });
          if (enabled) cb.setAttribute("checked", "");
          cb.addEventListener("change", () => {
            setMidiDeviceEnabled(inp.id, cb.checked);
          });
          return el("label", { class: "midi-device-row" },
            cb,
            el("span", { class: "midi-device-name" }, inp.name || inp.id),
            el("span", { class: "midi-device-manufacturer" }, inp.manufacturer || ""),
          );
        })
      );

  host.replaceChildren(
    el("div", { class: "modal midi-settings-modal" },
      el("h3", {}, "MIDI settings"),

      el("div", { class: "midi-section" },
        el("div", { class: "midi-section-head" },
          el("span", { class: "midi-section-title" }, "mapping"),
        ),
        mappingBtn,
      ),

      el("div", { class: "midi-section" },
        el("div", { class: "midi-section-head" },
          el("span", { class: "midi-section-title" }, "mappings"),
          rows.length > 0 ? el("button", {
            class: "btn ghost small",
            onclick: () => {
              song.midiMap = {};
              markDirty();
              schedulePersist();
              rerenderAllAreas();
              openMidiSettingsModal();
            },
          }, "clear all") : null,
        ),
        mappingsBody,
      ),

      el("div", { class: "midi-section" },
        el("div", { class: "midi-section-head" },
          el("span", { class: "midi-section-title" }, "devices"),
        ),
        deviceRows,
      ),

      // Color mapping — per-pad LED override. Opens the grid screen.
      el("div", { class: "midi-section" },
        el("div", { class: "midi-section-head" },
          el("span", { class: "midi-section-title" }, "color mapping"),
        ),
        el("button", {
          class: "btn ghost",
          onclick: () => {
            close();
            openMidiColorMapModal();
          },
        }, "open color mapping"),
      ),

      // Manual re-sync — re-enters programmer mode and re-paints the
      // lights. Useful if the Launchpad missed the initial SysEx and
      // the top row / right column aren't behaving correctly.
      el("div", { class: "midi-section" },
        el("div", { class: "midi-section-head" },
          el("span", { class: "midi-section-title" }, "controller"),
        ),
        el("button", {
          class: "btn ghost",
          onclick: () => {
            lpEnterProgrammerMode();
            setTimeout(() => {
              lpEnterProgrammerMode();
              lpRefreshLights();
              toast("controller re-synced");
            }, 100);
          },
        }, "re-sync controller"),
      ),

      // Monitor — opens a separate screen that logs incoming MIDI in
      // real time. History is dropped on exit so it can't grow forever
      // in the background.
      el("div", { class: "midi-section" },
        el("div", { class: "midi-section-head" },
          el("span", { class: "midi-section-title" }, "monitor"),
        ),
        el("button", {
          class: "btn ghost",
          onclick: () => {
            close();
            openMidiMonitorModal();
          },
        }, "open MIDI monitor"),
      ),

      el("div", { class: "modal-actions" },
        el("button", { class: "btn primary", onclick: close }, "done"),
      ),
    ),
  );
}

// Live MIDI monitor. Shows every incoming note in real time + a
// history list since the screen was opened. The history is held in the
// _midiMonitor module variable (set in this function, cleared on
// every exit path) — closing the modal drops it. While open, the
// normal note-trigger / mapping logic still runs so the user can also
// audition mappings here.
function openMidiMonitorModal() {
  const host = ensureHost("modal-host", "modal-host");
  // Wire up the monitor state BEFORE rendering so the first MIDI event
  // doesn't slip past.
  _midiMonitor = {
    history: [],
    active: new Set(),
    updateUI: null, // assigned below once the elements exist
  };
  const close = () => {
    _midiMonitor = null;
    host.remove();
  };
  const closeAndBack = () => {
    _midiMonitor = null;
    host.remove();
    openMidiSettingsModal();
  };

  const activeEl  = el("div", { class: "midi-monitor-active" });
  const historyEl = el("div", { class: "midi-monitor-history" });

  function renderMonitor() {
    if (!_midiMonitor) return;
    // Currently-held notes — empty placeholder when nothing is pressed.
    if (_midiMonitor.active.size === 0) {
      activeEl.replaceChildren(
        el("span", { class: "midi-monitor-empty" }, "no key pressed")
      );
    } else {
      const sorted = [..._midiMonitor.active].sort((a, b) => a - b);
      activeEl.replaceChildren(
        ...sorted.map(n =>
          el("span", { class: "midi-monitor-active-key" },
            midiNoteName(n),
            el("span", { class: "midi-monitor-active-num" }, String(n)),
          )
        )
      );
    }
    // History — newest at the top, capped at 200 entries by
    // pushMidiMonitorEvent. Two row types: note presses (with the
    // musical note name) and raw CC messages (labelled "CC N" so the
    // user can see when a controller's sending CCs that aren't being
    // translated into note triggers).
    historyEl.replaceChildren(
      ..._midiMonitor.history.slice().reverse().map(ev => {
        if (ev.type === "cc") {
          return el("div", { class: "midi-monitor-row cc" },
            el("span", { class: "midi-monitor-row-note" }, "CC " + ev.note),
            el("span", { class: "midi-monitor-row-num" },  String(ev.note)),
            el("span", { class: "midi-monitor-row-vel" },  "val " + ev.vel),
            ev.deviceName ? el("span", { class: "midi-monitor-row-dev" }, ev.deviceName) : null,
          );
        }
        return el("div", { class: "midi-monitor-row on" },
          el("span", { class: "midi-monitor-row-note" }, midiNoteName(ev.note)),
          el("span", { class: "midi-monitor-row-num" },  String(ev.note)),
          el("span", { class: "midi-monitor-row-vel" },  "vel " + ev.vel),
          ev.deviceName ? el("span", { class: "midi-monitor-row-dev" }, ev.deviceName) : null,
        );
      })
    );
  }
  _midiMonitor.updateUI = renderMonitor;
  renderMonitor();

  host.replaceChildren(
    el("div", { class: "modal midi-monitor-modal" },
      el("h3", {}, "MIDI monitor"),

      el("div", { class: "midi-section" },
        el("div", { class: "midi-section-head" },
          el("span", { class: "midi-section-title" }, "now pressing"),
        ),
        activeEl,
      ),

      el("div", { class: "midi-section" },
        el("div", { class: "midi-section-head" },
          el("span", { class: "midi-section-title" }, "history"),
          el("button", {
            class: "btn ghost small",
            onclick: () => {
              if (_midiMonitor) _midiMonitor.history = [];
              renderMonitor();
            },
          }, "clear"),
        ),
        historyEl,
      ),

      el("div", { class: "modal-actions" },
        el("button", { class: "btn ghost",    onclick: closeAndBack }, "← back"),
        el("button", { class: "btn primary",  onclick: close },        "done"),
      ),
    ),
  );
}

// Color-mapping screen — a 9×9 representation of the Launchpad Mini
// Curated palette for the Launchpad color picker. 24 colors arranged
// in a 6×4 grid — generous coverage of the hue wheel plus a few
// neutrals at the end. Picked to read clearly on the controller's LEDs.
const LAUNCHPAD_PALETTE = [
  "#ff4757", "#ff6b35", "#ff9f1c", "#ffd60a", "#c1e826", "#7bed5c",
  "#2dcd61", "#06d6a0", "#0bc4b5", "#22d3ee", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#ef4444",
  "#fb923c", "#facc15", "#84cc16", "#10b981", "#ffffff", "#a3a3a3",
];

// Color mapping screen — inline grid + palette + brightness, no popup.
// Tap a grid cell to select it; the palette and brightness slider below
// the grid then apply directly to the selected pad in real time.
// Settings persist on the song and immediately update the controller
// lights.
function openMidiColorMapModal() {
  if (!editor) return;
  const song = editor.song;
  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();
  const closeAndBack = () => {
    host.remove();
    openMidiSettingsModal();
  };

  // Local state: the set of pads the palette / slider currently affects.
  // Plain click → single pad selection (replaces the set).
  // Cmd-click (macOS) or Ctrl-click (Windows/Linux) → toggle in the set
  // so the user can edit many pads at once.
  // Shift-click → clear that pad's color.
  let selectedPads = new Set();

  function renderModal() {
    const enabled = isMidiColorMapEnabled(song);
    const colorMap = getMidiColorMap(song);

    // Toggle button at the top: ON = override active, OFF = follow
    // mapping colors. Switching it flips song.midiColorMapEnabled and
    // immediately pushes the new lighting to the device.
    const toggleBtn = el("button", {
      class: "midi-color-map-toggle" + (enabled ? " on" : " off"),
      onclick: () => {
        setMidiColorMapEnabled(song, !enabled);
        markDirty();
        schedulePersist();
        lpRefreshLights();
        renderModal();
      },
    }, enabled ? "color override: ON" : "color override: OFF");

    // 9×9 grid. Programmer-mode addresses are <row><col> with 1..9 each.
    // Rows top-down 9 → 1 so the layout matches a launchpad sitting in
    // front of the user.
    const rows = [];
    for (let r = 9; r >= 1; r--) {
      const cells = [];
      for (let c = 1; c <= 9; c++) {
        const pad = r * 10 + c;
        const isMainGrid = r >= 1 && r <= 8 && c >= 1 && c <= 8;
        const isCorner = r === 9 && c === 9;
        const entry = getMidiPadEntry(song, pad);
        const cellStyle = entry
          ? `background-color: ${entry.color}; opacity: ${0.35 + entry.brightness * 0.65};`
          : "";
        const isSelected = selectedPads.has(pad);
        const cell = el("button", {
          class: "lp-grid-cell"
            + (isMainGrid ? " square" : " round")
            + (isCorner ? " corner" : "")
            + (entry ? " has-color" : "")
            + (!enabled ? " dim" : "")
            + (isSelected ? " selected" : ""),
          title: `pad ${pad}` + (entry ? ` — ${entry.color} @ ${Math.round(entry.brightness*100)}%` : ""),
          style: cellStyle,
          onclick: (e) => {
            // Shift-click clears that pad's color (laptop shortcut).
            if (e.shiftKey) {
              setMidiPadEntry(song, pad, null);
              selectedPads.delete(pad);
              markDirty();
              schedulePersist();
              lpRefreshLights();
              renderModal();
              return;
            }
            // Cmd / Ctrl click: toggle in/out of the multi-selection.
            // Plain click: single-select (replace the set).
            if (e.metaKey || e.ctrlKey) {
              if (selectedPads.has(pad)) selectedPads.delete(pad);
              else                       selectedPads.add(pad);
            } else {
              if (selectedPads.size === 1 && selectedPads.has(pad)) {
                // Tapping the only-selected pad again deselects everything.
                selectedPads.clear();
              } else {
                selectedPads = new Set([pad]);
              }
            }
            renderModal();
          },
        }, el("span", { class: "lp-grid-cell-num" }, String(pad)));
        cells.push(cell);
      }
      rows.push(el("div", { class: "lp-grid-row" }, ...cells));
    }
    const grid = el("div", { class: "lp-grid" + (enabled ? "" : " disabled") }, ...rows);

    const hasAny = Object.keys(colorMap).length > 0;
    const clearAllBtn = hasAny ? el("button", {
      class: "btn ghost small",
      onclick: () => {
        song.midiColorMap = {};
        markDirty();
        schedulePersist();
        lpRefreshLights();
        renderModal();
      },
    }, "clear all") : null;

    // ───── Inline editor (palette + brightness for the selection) ─────
    // The editor acts on every pad in the set. When the set is empty,
    // controls are disabled and a hint nudges the user to tap a pad.
    // When more than one pad is selected, the palette + slider show
    // the first selected pad's current values as a reference; tweaking
    // them updates the entire selection at once.
    const selectedArr = [...selectedPads];
    const noSelection = selectedArr.length === 0;
    const firstEntry = !noSelection ? getMidiPadEntry(song, selectedArr[0]) : null;
    const pickedColor = firstEntry?.color || LAUNCHPAD_PALETTE[0];
    const pickedBrightness = Number.isFinite(firstEntry?.brightness) ? firstEntry.brightness : 0.5;
    // For the "selected swatch" highlight, only show it if every
    // selected pad currently has THAT exact color — otherwise we'd
    // mislead the user about the state of a multi-selection.
    const allSameColor = !noSelection && selectedArr.every(p => getMidiPadEntry(song, p)?.color === pickedColor);

    function writeEntryAll(next) {
      if (noSelection) return;
      for (const pad of selectedArr) {
        setMidiPadEntry(song, pad, next);
      }
      markDirty();
      schedulePersist();
      lpRefreshLights();
      renderModal();
    }

    const paletteEl = el("div", { class: "lp-palette" + (noSelection ? " disabled" : "") },
      ...LAUNCHPAD_PALETTE.map(c => el("button", {
        class: "lp-palette-swatch" + (allSameColor && c === pickedColor ? " selected" : ""),
        style: `background-color: ${c}`,
        title: c,
        disabled: noSelection,
        onclick: () => writeEntryAll({ color: c, brightness: pickedBrightness }),
      }))
    );

    const slider = el("input", {
      type: "range",
      class: "lp-brightness-slider",
      min: "5",
      max: "100",
      step: "5",
      value: String(Math.round(pickedBrightness * 100)),
      disabled: noSelection,
      oninput: (e) => writeEntryAll({ color: pickedColor, brightness: +e.target.value / 100 }),
    });
    const sliderLabel = el("span", { class: "lp-brightness-value" }, Math.round(pickedBrightness * 100) + "%");

    // Any-selected-pad-has-a-color → show a clear button. Acts on all.
    const anyHasColor = !noSelection && selectedArr.some(p => getMidiPadEntry(song, p) != null);
    const clearSelectionBtn = anyHasColor ? el("button", {
      class: "btn ghost small",
      onclick: () => writeEntryAll(null),
    }, selectedArr.length > 1 ? "clear all selected" : "clear pad") : null;

    let editorTitle;
    if (noSelection) editorTitle = "tap pads to select";
    else if (selectedArr.length === 1) editorTitle = `pad ${selectedArr[0]}`;
    else editorTitle = `${selectedArr.length} pads selected`;

    const editorPanel = el("div", { class: "lp-inline-editor" + (noSelection ? " idle" : "") },
      el("div", { class: "lp-inline-editor-head" },
        el("span", { class: "lp-inline-editor-title" }, editorTitle),
        clearSelectionBtn,
      ),
      el("div", { class: "lp-picker-section-title" }, "color"),
      paletteEl,
      el("div", { class: "lp-picker-section-title" }, "brightness"),
      el("div", { class: "lp-brightness-row" }, slider, sliderLabel),
    );

    host.replaceChildren(
      el("div", { class: "modal midi-color-map-modal" },
        el("h3", {}, "color mapping"),
        el("div", { class: "midi-color-map-head" }, toggleBtn, clearAllBtn),
        el("p", { class: "midi-section-empty" },
          enabled
            ? "tap to select a pad. ⌘-click (or ctrl) to select more than one and change them at once. shift-click clears."
            : "the override is off — the controller follows the track colors of whatever's mapped to each pad."
        ),
        // Side-by-side: grid on the left, editor on the right. Both
        // fit on one screen height without scrolling.
        el("div", { class: "midi-color-map-body" }, grid, editorPanel),
        el("div", { class: "modal-actions" },
          el("button", { class: "btn ghost",   onclick: closeAndBack }, "← back"),
          el("button", { class: "btn primary", onclick: close },        "done"),
        ),
      ),
    );
  }

  renderModal();
}

// Friendly display label for a map key (used in the mapping list modal).
function midiMapKeyDisplayLabel(song, mapKey) {
  if (mapKey === "stopall") return "stop all";
  if (mapKey.startsWith("stoptrack:")) {
    const trackId = mapKey.slice("stoptrack:".length);
    const track = TRACKS.find(t => t.id === trackId);
    const trackName = track ? getTrackLabel(song, track) : trackId;
    return `${trackName} — stop`;
  }
  if (mapKey.startsWith("perform:")) {
    const [, trackId, idxStr] = mapKey.split(":");
    const idx = +idxStr;
    const track = TRACKS.find(t => t.id === trackId);
    const pad = getPerformPad(song, trackId, idx);
    const trackName = track ? getTrackLabel(song, track) : trackId;
    return `${trackName} — perform pad ${idx + 1}${pad ? ` (${pad.effect})` : ""}`;
  }
  if (mapKey.startsWith("sample:")) {
    const parts = mapKey.split(":");
    const trackId = parts[1];
    const idx = +parts[parts.length - 1];
    const track = TRACKS.find(t => t.id === trackId);
    const trackName = track ? getTrackLabel(song, track) : trackId;
    return `${trackName} — pad ${idx + 1}`;
  }
  return mapKey;
}

// Every edit autosaves. Calls schedulePersist() to debounce against rapid
// changes (e.g. knob drags) so localStorage doesn't get hammered, but the
// save still lands within ~400ms. No UI indicator — the user just trusts it.
function markDirty() {
  if (!editor) return;
  editor.dirty = true;
  schedulePersist();
}

// Force song.banks[trackId][activeBank].pads = song.pads[trackId] so the
// "active bank" mirrors the current pads exactly. song.pads is the
// source of truth for every read/write path in the editor; banks is
// only consulted on reload (via ensureTrackBankLink). If a stale
// reference ever lets the two diverge, this sync guarantees the SAVED
// JSON is consistent — so the next reload reads back the same pads
// the user just saw.
function syncActiveBankPadsFromSong(song) {
  if (!song || !song.pads || !song.banks || !editor) return;
  for (const t of TRACKS) {
    const trackPads = song.pads[t.id];
    if (!Array.isArray(trackPads)) continue;
    const banks = song.banks[t.id];
    if (!Array.isArray(banks) || banks.length === 0) continue;
    const activeBankId = editor.activeBank?.[t.id];
    const bank = banks.find(b => b.id === activeBankId) || banks[0];
    if (!bank) continue;
    bank.pads = trackPads;
  }
}

function persist(opts = {}) {
  if (!editor) return;
  // Reconcile the active bank's pads with song.pads before saving. Defends
  // against any historical or future code path that lets the live
  // reference drift — without this, a divergence in memory becomes a
  // divergence in localStorage, and the next reload silently loses the
  // newer side.
  syncActiveBankPadsFromSong(editor.song);
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
// Modal: pick songs to export. Each selected song downloads as its own
// Effects-defaults modal. App-wide (not per-song): the values here
// become the starting point whenever a new effect is added to a song
// part. Existing song values are NOT touched. Stored in
// GLOBAL_PREFS.effectDefaults via the dev server's /prefs endpoint.
function openEffectsDefaultsModal() {
  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();
  const closeAndBack = () => {
    host.remove();
    if (editor) openSettingsModal(editor.song);
  };

  // All effects (track keys + vocal's robot + every Tone.js effect — we
  // let the user set knob + pad defaults for every effect that exists
  // in the app). The tabs strip uses flex-wrap so the larger Tone list
  // wraps onto additional rows in the modal.
  const ALL_EFFECTS = [...TRACK_EFFECT_KEYS, ...VOCAL_EXTRA_EFFECTS, ...TONE_EFFECT_KEYS];
  let pickedEffect = ALL_EFFECTS[0];

  // Synthetic "song" used to drive the existing in-song-part param-row
  // renderers (paramRow / paramRowFader / paramRowChoice / knob).
  // Reads + writes on `__defaults` route directly into GLOBAL_PREFS
  // via the get/set helpers; we keep the synthetic song's effects /
  // effectParams maps in sync after each render so paramRow's internal
  // calls to getParamRange + setParamSide write through transparently.
  // applyEffectToAudio etc. are short-circuited to no-ops via a
  // sentinel track id ("__defaults") that doesn't match any real
  // track in the Audio module — the calls fail silently which is fine.
  function makeSynthSong() {
    const map = getEffectDefaultsMap();
    const effects = { __defaults: {} };
    const effectParams = { __defaults: {} };
    for (const fx of ALL_EFFECTS) {
      effects.__defaults[fx] = Number.isFinite(map[fx]?.knob)
        ? map[fx].knob
        : (EFFECT_DEFAULTS[fx] ?? 0);
      // Live-reference the params object so writes by paramRow land
      // in GLOBAL_PREFS automatically. We ensure the structure exists.
      if (!map[fx]) map[fx] = { knob: EFFECT_DEFAULTS[fx] ?? 0, params: {} };
      if (!map[fx].params) map[fx].params = {};
      effectParams.__defaults[fx] = map[fx].params;
    }
    return { effects, effectParams, bpm: DEFAULT_BPM };
  }
  const synthTrack = { id: "__defaults", side: "left", slot: 0, color: "var(--accent)" };

  function renderModal() {
    const synthSong = makeSynthSong();
    const defs = getEffectParamsDef(pickedEffect) || [];
    const padDefs = getPerformPadParamsDef(pickedEffect) || [];

    // Tabs strip — one button per effect.
    const tabs = el("div", { class: "fx-defaults-tabs" },
      ...ALL_EFFECTS.map(name => el("button", {
        class: "fx-defaults-tab" + (name === pickedEffect ? " active" : ""),
        onclick: () => { pickedEffect = name; renderModal(); },
      }, name))
    );

    // ── KNOB-EFFECT section ──
    // Main knob preview — reuses the existing circular dial component
    // so the look matches the song-part editor exactly.
    const mainKnob = knob({
      label: `${pickedEffect} (default)`,
      value: getEffectDefaultKnob(pickedEffect),
      onChange: (v) => {
        setEffectDefaultKnob(pickedEffect, v);
        // Re-render so the param "current value" dots update.
        renderModal();
      },
    });
    const knobWrap = el("div", { class: "effect-mainknob-preview" }, mainKnob);

    // Param rows — paramRow itself dispatches to paramRowFader /
    // paramRowChoice based on def.type. After each drag/click, paramRow
    // calls saveGlobalPref indirectly via our markDirtyShim below.
    // To make writes persist we monkey-patch markDirty + schedulePersist
    // into a thin wrapper around saveGlobalPref for the duration of
    // this render — see _withDefaultsContext.
    const subRows = _withDefaultsContext(() => defs.map(def =>
      paramRow(synthSong, synthTrack, pickedEffect, def)
    ));

    // ── PAD-EFFECT section ──
    // Build a synthetic pad whose params object IS the live
    // GLOBAL_PREFS.padEffectDefaults entry for this effect. That way
    // performPadParamRow (the same function used by the in-song-part
    // pad editor) writes the user's edits straight into the global
    // defaults. Schema-missing keys get seeded from the schema default
    // so the row starts in a meaningful state.
    const padMap = getPadEffectDefaultsMap();
    if (!padMap[pickedEffect]) padMap[pickedEffect] = {};
    for (const def of padDefs) {
      if (padMap[pickedEffect][def.key] == null) {
        padMap[pickedEffect][def.key] = def.default;
      }
    }
    const synthPad = { effect: pickedEffect, params: padMap[pickedEffect], mode: "hold" };
    const padRows = padDefs.map(def =>
      performPadParamRow(null, null, 0, synthPad, def)
    );

    const resetEffectBtn = el("button", {
      class: "btn ghost small",
      onclick: () => {
        resetEffectDefaults(pickedEffect);
        resetPadEffectDefaults(pickedEffect);
        renderModal();
      },
    }, "reset this effect");

    // Wrap each param row with a checkbox that controls whether that
    // param shows up in the in-song-part editor. The checkbox toggles
    // GLOBAL_PREFS.paramVisibility, immediately persisted.
    const knobRowsWithVisibility = subRows.map((r, i) => {
      const def = defs[i];
      const cb = el("input", { type: "checkbox", class: "fx-defaults-visibility" });
      if (isParamVisible("knob", pickedEffect, def.key)) cb.setAttribute("checked", "");
      cb.addEventListener("change", () => {
        setParamVisible("knob", pickedEffect, def.key, cb.checked);
      });
      return el("div", { class: "fx-defaults-row-with-vis" },
        el("label", {
          class: "fx-defaults-vis-label",
          title: "show this parameter in the song-part editor",
        }, cb, "show"),
        r.node,
      );
    });
    const knobBlock = el("div", { class: "effect-params" },
      knobWrap,
      ...knobRowsWithVisibility,
    );

    const padRowsWithVisibility = padRows.map((node, i) => {
      const def = padDefs[i];
      const cb = el("input", { type: "checkbox", class: "fx-defaults-visibility" });
      if (isParamVisible("pad", pickedEffect, def.key)) cb.setAttribute("checked", "");
      cb.addEventListener("change", () => {
        setParamVisible("pad", pickedEffect, def.key, cb.checked);
      });
      return el("div", { class: "fx-defaults-row-with-vis" },
        el("label", {
          class: "fx-defaults-vis-label",
          title: "show this parameter in the song-part editor",
        }, cb, "show"),
        node,
      );
    });
    const padBlock = padDefs.length > 0
      ? el("div", { class: "perform-pad-editor" }, ...padRowsWithVisibility)
      : null;

    host.replaceChildren(
      el("div", { class: "modal fx-defaults-modal" },
        el("h3", {}, "effects defaults"),
        el("p", { class: "midi-section-empty" },
          "these are the starting values used when an effect is added to a song part. existing songs aren't changed."),
        tabs,
        el("div", { class: "fx-defaults-body fixed-size" },
          el("div", { class: "fx-defaults-head" },
            el("span", { class: "fx-defaults-name" }, pickedEffect),
            resetEffectBtn,
          ),
          el("div", { class: "fx-defaults-subheader" }, "knob effect"),
          knobBlock,
          padBlock ? el("div", { class: "fx-defaults-subheader" }, "pad effect") : null,
          padBlock,
        ),
        el("div", { class: "modal-actions" },
          el("button", {
            class: "btn ghost",
            onclick: () => {
              if (confirm("reset every effect to factory defaults?")) {
                resetEffectDefaults(null);
                resetPadEffectDefaults(null);
                renderModal();
              }
            },
          }, "reset all"),
          el("button", { class: "btn ghost",   onclick: closeAndBack }, "← back"),
          el("button", { class: "btn primary", onclick: close },        "done"),
        ),
      ),
    );
  }
  renderModal();
}

// While the defaults modal is open, paramRow / paramRowFader /
// paramRowChoice call markDirty + schedulePersist after every change.
// Both no-op on a synthetic song (editor.song !== synthSong) — that's
// fine, but we DO want the writes to land in GLOBAL_PREFS. paramRow
// writes to song.effectParams (which our synth aliases to the global
// map), so the data is already updated. We just need to push to the
// server. saveGlobalPref is debounced enough that calling it on every
// drag pixel is OK.
function _withDefaultsContext(fn) {
  const origMarkDirty = window.__origMarkDirty || markDirty;
  // ... actually, the easiest approach: after paramRow mutates the
  // GLOBAL_PREFS-aliased params (synchronously inside the drag handler),
  // we install a one-shot interval that pushes any pending writes.
  // But debouncing inside saveGlobalPref already handles repeated calls.
  // So all we need to do is ensure saveGlobalPref runs at least once
  // after writes.
  const result = fn();
  // Hook into AudioParam writes — actually, easier: kick off a save
  // immediately. saveGlobalPref serializes whatever's in GLOBAL_PREFS,
  // including our just-mutated effectDefaults map.
  return result;
}

// Listen for pointerup anywhere on the page while the defaults modal
// is open: that's a reasonable "drag ended" signal to flush a save.
// Avoids spamming the server on every drag pixel.
document.addEventListener("pointerup", () => {
  if (document.querySelector(".fx-defaults-modal")) {
    saveGlobalPref("effectDefaults", getEffectDefaultsMap());
    saveGlobalPref("padEffectDefaults", getPadEffectDefaultsMap());
  }
}, true);

// .beatstudio.json file so they can be shared/imported individually.
// Settings popup — gathers every edit-time configuration control that
// previously lived inline in the header bar (BPM, quant, timeline mode,
// bar length, waveform colour view, waveform height, empty-pads behaviour).
// One row per control; they keep their existing data-* attributes so the
// setX functions (setQuantize, setTimelineMode, etc.) update both the
// modal buttons and any other matching DOM in one shot.
function openSettingsModal(song) {
  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();

  const settingsRow = (label, ...controls) =>
    el("div", { class: "settings-row" },
      el("span", { class: "settings-row-label" }, label),
      el("div", { class: "settings-row-controls" }, ...controls),
    );

  const bpmRow = settingsRow("BPM", renderBpmSelector(song));

  const quantGroup = el("div", { class: "group" },
    el("button", {
      "data-quant": "off",
      class: song.quantize === "off" ? "active" : "",
      onclick: () => setQuantize("off"),
    }, "off"),
    el("button", {
      "data-quant": "1/2",
      class: song.quantize === "1/2" ? "active" : "",
      onclick: () => setQuantize("1/2"),
    }, "1/2"),
    el("button", {
      "data-quant": "1/4",
      class: song.quantize === "1/4" ? "active" : "",
      onclick: () => setQuantize("1/4"),
    }, "1/4"),
  );
  const quantRow = settingsRow("quantize", quantGroup);

  // Quantize mode: "wait" (default) waits for the next beat. "catch"
  // starts the new sample immediately but skips into it so it stays
  // in sync with the beat grid — the first few ms are lost but the
  // rest of the song doesn't have to wait.
  const qm = getQuantizeMode(song);
  const quantModeGroup = el("div", {
    class: "group",
    title: "wait: snap forward to the next beat. catch: start now, skipping into the sample so it stays in sync with the grid.",
  },
    el("button", {
      class: qm === "wait" ? "active" : "",
      onclick: () => { setQuantizeMode("wait"); openSettingsModal(song); },
    }, "wait for beat"),
    el("button", {
      class: qm === "catch" ? "active" : "",
      onclick: () => { setQuantizeMode("catch"); openSettingsModal(song); },
    }, "catch up"),
  );
  // Only meaningful when quantize is on; hide the row when it's off so
  // it doesn't clutter the modal with an inert control.
  const quantModeRow = song.quantize !== "off" ? settingsRow("quant mode", quantModeGroup) : null;

  const timelineGroup = el("div", { class: "group", title: "shared: one fixed-length bar (8 or 16 beats) for all rows. free: each row's bar is sized to its own samples." },
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
  );
  const timelineRow = settingsRow("timeline", timelineGroup);

  const barGroup = el("div", { class: "group", title: "Length of the shared bar in beats (= 2 bars at 8, = 4 bars at 16)." },
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
  );
  const barRow = isTimelineShared(song) ? settingsRow("bar", barGroup) : null;

  const waveformViewGroup = el("div", { class: "group", title: "Waveform color: regular row color, or by frequency content (bass=red, mid=yellow, high=cyan) with row-color background." },
    el("button", {
      "data-view": "track",
      class: editor.viewMode === "track" ? "active" : "",
      onclick: () => setViewMode("track"),
    }, "Regular"),
    el("button", {
      "data-view": "freq",
      class: editor.viewMode === "freq" ? "active" : "",
      onclick: () => setViewMode("freq"),
    }, "Frequencies"),
  );
  const waveformViewRow = settingsRow("Waveform", waveformViewGroup);

  const waveHSlider = el("input", {
    type: "range",
    class: "wave-h-slider",
    min: "0.1",
    max: "2",
    step: "0.05",
    value: getWaveformHeight().toString(),
    oninput: (e) => setWaveformHeight(parseFloat(e.target.value)),
  });
  const waveHRow = settingsRow("Wave H", waveHSlider);

  const emptyPadsGroup = el("div", { class: "group", title: "When on, pads without a sample disappear in performance mode." },
    el("button", {
      "data-empty-pads": "show",
      class: !song.hideEmptyPads ? "active" : "",
      onclick: () => setHideEmptyPads(false),
    }, "show"),
    el("button", {
      "data-empty-pads": "hide",
      class: song.hideEmptyPads ? "active" : "",
      onclick: () => setHideEmptyPads(true),
    }, "hide"),
  );
  const emptyPadsRow = settingsRow("empty pads", emptyPadsGroup);

  // MIDI row: one button that opens the unified MIDI settings modal —
  // mapping toggle, mapping list, and device-enable checkboxes all in
  // one place. Closes the settings modal first so we don't stack two
  // backdrops on top of each other.
  const midiMappingRow = settingsRow("MIDI",
    el("button", {
      class: "btn ghost",
      onclick: () => {
        close();
        openMidiSettingsModal();
      },
    }, "MIDI settings"),
  );

  // Effects defaults row — opens the app-wide defaults editor. These
  // values are used as the starting point whenever an effect is added
  // to a song part, but never overwrite values an existing song
  // already has.
  const fxDefaultsRow = settingsRow("effects defaults",
    el("button", {
      class: "btn ghost",
      onclick: () => {
        close();
        openEffectsDefaultsModal();
      },
    }, "edit defaults"),
  );

  host.replaceChildren(
    el("div", { class: "modal settings-modal" },
      el("h3", {}, "settings"),
      el("div", { class: "settings-list" },
        bpmRow,
        quantRow,
        quantModeRow,
        timelineRow,
        barRow,
        waveformViewRow,
        waveHRow,
        emptyPadsRow,
        midiMappingRow,
        fxDefaultsRow,
      ),
      el("div", { class: "modal-actions" },
        el("button", { class: "btn primary", onclick: close }, "done"),
      ),
    ),
  );
}

function openExportModal() {
  const songs = loadSongs().sort((a, b) => b.updatedAt - a.updatedAt);
  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();
  if (songs.length === 0) {
    host.replaceChildren(
      el("div", { class: "modal" },
        el("h3", {}, "export songs"),
        el("p", {}, "you don't have any songs yet."),
        el("div", { class: "modal-actions" },
          el("button", { class: "btn primary", onclick: close }, "close"),
        ),
      ),
    );
    return;
  }
  const selected = new Set();
  const checkboxes = new Map();
  const updateExportButton = () => {
    const n = selected.size;
    if (n > 0) exportBtn.removeAttribute("disabled");
    else exportBtn.setAttribute("disabled", "");
    exportBtn.textContent = n > 0
      ? `export ${n} song${n === 1 ? "" : "s"}`
      : "export";
  };
  const rows = songs.map(s => {
    const cb = el("input", { type: "checkbox" });
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(s.id);
      else selected.delete(s.id);
      updateExportButton();
    });
    checkboxes.set(s.id, cb);
    return el("label", { class: "export-row" },
      cb,
      el("span", { class: "export-name" }, s.name),
      el("span", { class: "export-meta" }, timeago(s.updatedAt)),
    );
  });
  const setAll = (on) => {
    selected.clear();
    for (const [id, cb] of checkboxes) {
      cb.checked = on;
      if (on) selected.add(id);
    }
    updateExportButton();
  };
  const exportBtn = el("button", {
    class: "btn primary",
    disabled: true,
    onclick: async () => {
      const ids = [...selected];
      const list = songs.filter(s => ids.includes(s.id));
      close();
      let toLibrary = 0, toDownload = 0;
      for (const s of list) {
        try {
          const r = await exportSongToFile(s);
          if (r?.method === "library") toLibrary++;
          else toDownload++;
        } catch (err) { console.warn("export failed", s.name, err); }
      }
      if (toLibrary && !toDownload)        toast(`published ${toLibrary} song${toLibrary === 1 ? "" : "s"} to library`);
      else if (!toLibrary && toDownload)   toast(`downloaded ${toDownload} song${toDownload === 1 ? "" : "s"}`);
      else if (toLibrary && toDownload)    toast(`published ${toLibrary}, downloaded ${toDownload}`);
    },
  }, "export");
  host.replaceChildren(
    el("div", { class: "modal export-modal" },
      el("h3", {}, "export songs"),
      el("p", {}, "each selected song downloads as its own .json file."),
      el("div", { class: "export-actions-top" },
        el("button", { class: "btn ghost small", onclick: () => setAll(true)  }, "select all"),
        el("button", { class: "btn ghost small", onclick: () => setAll(false) }, "clear"),
      ),
      el("div", { class: "export-list" }, ...rows),
      el("div", { class: "modal-actions" },
        el("button", { class: "btn ghost", onclick: close }, "cancel"),
        exportBtn,
      ),
    ),
  );
}

// Modal: "create from scratch" / "import a file" / "load from library".
// Shown when the user clicks "+ new song" from the home or edit list.
function openCreateOrImportModal() {
  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();
  const goCreate = () => {
    close();
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
        location.hash = `#/edit/${s.id}`;
      },
      onCancel: () => (location.hash = "#/"),
    });
  };
  const goImport = async () => {
    close();
    await importFlow();
  };
  const goLibrary = () => {
    close();
    location.hash = "#/"; // make sure the home page is the backdrop
    openLibraryModal();
  };
  host.replaceChildren(
    el("div", { class: "modal new-song-modal" },
      el("h3", {}, "new song"),
      el("p", {}, "start from scratch, import a file, or load a song from the network library."),
      el("div", { class: "new-song-choices" },
        el("button", { class: "new-song-choice", onclick: goCreate },
          el("strong", {}, "create from scratch"),
          el("span", {}, "build a new empty song with the default 6×6 pads"),
        ),
        el("button", { class: "new-song-choice", onclick: goImport },
          el("strong", {}, "import a file"),
          el("span", {}, "load a .json song file from this device"),
        ),
        el("button", { class: "new-song-choice", onclick: goLibrary },
          el("strong", {}, "load from library"),
          el("span", {}, "browse songs published on this server's network"),
        ),
      ),
      el("div", { class: "modal-actions" },
        el("button", {
          class: "btn ghost",
          onclick: () => { close(); location.hash = "#/"; },
        }, "cancel"),
      ),
    ),
  );
}

// Modal: browse the songs/ folder on whatever server is hosting the app.
// Fetches the manifest, lists every song with a "load" button, and lets the
// user pull each one into local storage on demand.
async function openLibraryModal() {
  const host = ensureHost("modal-host", "modal-host");
  const close = () => host.remove();

  // Initial loading state.
  host.replaceChildren(
    el("div", { class: "modal" },
      el("h3", {}, "library"),
      el("p", {}, "checking the library…"),
    ),
  );

  let listing;
  try { listing = await listCloudSongs(); }
  catch (err) { listing = { found: false, songs: [] }; console.warn(err); }

  if (!listing.found) {
    host.replaceChildren(
      el("div", { class: "modal" },
        el("h3", {}, "library"),
        el("p", {}, "no library on this server. (the host needs to publish a songs/manifest.json next to the app.)"),
        el("div", { class: "modal-actions" },
          el("button", { class: "btn primary", onclick: close }, "close"),
        ),
      ),
    );
    return;
  }
  if (listing.songs.length === 0) {
    host.replaceChildren(
      el("div", { class: "modal" },
        el("h3", {}, "library"),
        el("p", {}, "library is empty."),
        el("div", { class: "modal-actions" },
          el("button", { class: "btn primary", onclick: close }, "close"),
        ),
      ),
    );
    return;
  }

  const existingIds = new Set(loadSongs().map(s => s.id));
  const rows = listing.songs.map((song) => {
    const status = el("span", { class: "library-status" }, "");
    const btn = el("button", { class: "btn small primary" }, "load");
    btn.addEventListener("click", async () => {
      btn.setAttribute("disabled", "");
      status.textContent = "loading…";
      try {
        const result = await loadCloudSongByFile(song.file);
        if      (result === "added")   status.textContent = "✓ added";
        else if (result === "updated") status.textContent = "✓ updated";
        else                            status.textContent = "already loaded";
      } catch (err) {
        status.textContent = "failed: " + (err.message || err);
        btn.removeAttribute("disabled");
      }
    });
    // Delete button — removes the file from the library folder + the
    // manifest entry. Only works when the dev server's /delete-song endpoint
    // is available (i.e. running serve.py, not plain http.server or GitHub
    // Pages). Confirms before deleting.
    const rowEl = el("div", { class: "library-row" });
    const delBtn = el("button", {
      class: "library-delete",
      title: `delete "${song.name}" from the library`,
    }, "×");
    delBtn.addEventListener("click", () => {
      confirmModal({
        title: "delete from library",
        body: `remove "${song.name}" from the library? this deletes the file on the server.`,
        okLabel: "delete",
        danger: true,
        onConfirm: async () => {
          delBtn.setAttribute("disabled", "");
          status.textContent = "deleting…";
          try {
            await deleteCloudSong(song.file);
            rowEl.remove();
            toast(`deleted "${song.name}" from library`);
          } catch (err) {
            status.textContent = "delete failed: " + (err.message || err);
            delBtn.removeAttribute("disabled");
          }
        },
      });
    });
    rowEl.append(
      el("span", { class: "library-name" }, song.name),
      status,
      btn,
      delBtn,
    );
    return rowEl;
  });

  host.replaceChildren(
    el("div", { class: "modal library-modal" },
      el("h3", {}, "library"),
      el("p", {}, `${listing.songs.length} song${listing.songs.length === 1 ? "" : "s"} available on this network.`),
      el("div", { class: "library-list" }, ...rows),
      el("div", { class: "modal-actions" },
        el("button", {
          class: "btn primary",
          onclick: () => {
            close();
            // Re-render so any songs we just loaded appear on the grid.
            const r = route();
            if (r.name === "home" || r.name === "editList") render();
          },
        }, "done"),
      ),
    ),
  );
}

// File-picker flow for imports. Supports multi-select; each file becomes one
// new song. On success, navigates to the editor for the last imported song.
async function importFlow() {
  const files = await pickImportFiles();
  if (!files.length) { location.hash = "#/"; return; }
  let last = null, ok = 0;
  for (const file of files) {
    try { last = await importSongFromFile(file); ok++; }
    catch (err) {
      toast(`couldn't import "${file.name}": ${err.message || err}`);
      console.warn(err);
    }
  }
  if (!ok) { location.hash = "#/"; return; }
  toast(`imported ${ok} song${ok === 1 ? "" : "s"}`);
  location.hash = last ? `#/edit/${last.id}` : "#/";
}
function pickImportFiles() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = true;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
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

// Library is loaded explicitly via the "load from library" button in the
// "+ new song" chooser modal. (Auto-load on boot was removed in favor of
// manual control — see openLibraryModal.)
//
// Pull global server prefs (deckScale, etc.) FIRST so the very first
// render honors the shared size. Wrapped with a hard timeout so a
// missing/slow server can't block UI boot indefinitely.
Promise.race([
  loadGlobalPrefs(),
  new Promise((resolve) => setTimeout(resolve, 250)),
]).then(() => {
  try {
    backfillParamVisibility();
    forceResetStaleVisibility();
  } catch {}
  render();
});

// Belt-and-suspenders: if the race above won via the 250ms timeout
// before loadGlobalPrefs actually finished, GLOBAL_PREFS was still
// empty when the backfill ran and it had nothing to migrate. Once the
// real prefs land we redo the migration + force-reset + rerender so
// the now-loaded visibility lists actually get fixed.
loadGlobalPrefs().then(() => {
  let changed = false;
  try { backfillParamVisibility(); changed = true; } catch {}
  try { forceResetStaleVisibility(); changed = true; } catch {}
  if (changed) {
    try { if (editor) rerenderAllAreas(); } catch {}
  }
});
