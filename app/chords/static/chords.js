// Pure-browser Chord Parser, Transposer, and BandHelper Formatter
// Inspired by menees/Chords (Chords-Over-Text <-> ChordPro) tailored for BandHelper

const SHARP_SCALE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_SCALE = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const NOTE_TO_SEMITONE = {
  C: 0, 'B#': 0,
  'C#': 1, Db: 1,
  D: 2,
  'D#': 3, Eb: 3,
  E: 4, Fb: 4,
  F: 5, 'E#': 5,
  'F#': 6, Gb: 6,
  G: 7,
  'G#': 8, Ab: 8,
  A: 9,
  'A#': 10, Bb: 10,
  B: 11, Cb: 11,
};

const FLAT_KEYS = new Set([
  'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
  'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm',
]);

const CHORD_REGEX = /^([A-G])(#|b|♯|♭)?(?:maj|min|m|M|dim|aug|sus|add|\+|°|ø)?(?:[0-9]{1,2})?(?:(?:maj|min|m|M|dim|aug|sus|add|\+|-|#|b)?[0-9]{0,2})*(?:\([^)]+\))?(?:\/([A-G])(#|b|♯|♭)?)?$/;
const NO_CHORD_REGEX = /^(N\.?C\.?|\/|%|x\d+|\(\d+x\)|\(\s*x\d+\s*\))$/i;

const KNOWN_SECTION_WORDS = /^(verse|chorus|pre-?chorus|post-?chorus|bridge|intro|outro|ending|coda|solo|guitar solo|instrumental|interlude|tag|turnaround|refrain|hook|vamp|break|breakdown|modulation|key change|prechorus|rap|spoken|ad-lib|link)(\s+\d+)?(\s*\([^)]*\))?$/i;

function normalizeAccidentals(note) {
  return note.replace(/♯/g, '#').replace(/♭/g, 'b');
}

export function isChordToken(rawToken) {
  if (!rawToken) return false;
  const cleaned = normalizeAccidentals(
    rawToken.replace(/^[\[(|]+/, '').replace(/[\])|.,:;*]+$/, '')
  );
  if (!cleaned) return false;
  if (NO_CHORD_REGEX.test(cleaned)) return true;
  return CHORD_REGEX.test(cleaned);
}

export function isChordLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Exclude lines that are clearly ChordPro directives or bracketed section headers
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return false;
  if (/^\[[^\]]+\]$/.test(trimmed) && !isChordToken(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  let realChordCount = 0;

  for (const tok of tokens) {
    if (tok === '|' || tok === '||' || tok === '|:' || tok === ':|') continue;
    if (NO_CHORD_REGEX.test(tok)) continue;
    if (!isChordToken(tok)) return false;
    realChordCount++;
  }

  return realChordCount > 0;
}

export function isTabLine(line) {
  const trimmed = line.trim();
  return /^[eBGDAE]\|[-0-9hbp/\\~xs().\s|]+$/.test(trimmed);
}

export function classifySectionType(label) {
  const lower = label.toLowerCase();
  if (/\bverse\b/.test(lower)) return 'verse';
  if (/\bchorus\b|\brefrain\b/.test(lower) && !/\bpre-?chorus\b/.test(lower)) return 'chorus';
  if (/\bbridge\b/.test(lower)) return 'bridge';
  if (/\btab\b/.test(lower)) return 'tab';
  return 'other';
}

export function parseSectionHeader(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Bracketed section header like [Verse 1], [Chorus], [Bridge]
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]:?$/);
  if (bracketMatch) {
    const inner = bracketMatch[1].trim();
    if (!isChordToken(inner) && !isChordLine(inner)) {
      return { label: inner, type: classifySectionType(inner) };
    }
  }

  // Colon section header like "Verse 1:" or "Guitar Solo:"
  const colonMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9\s-]{1,30}):$/);
  if (colonMatch) {
    const inner = colonMatch[1].trim();
    if (!/^(title|song|artist|by|key|tempo|bpm|time|time signature|capo|duration|tuning)$/i.test(inner)) {
      return { label: inner, type: classifySectionType(inner) };
    }
  }

  // Standalone known section line like "VERSE 1" or "Chorus"
  if (KNOWN_SECTION_WORDS.test(trimmed)) {
    return { label: trimmed, type: classifySectionType(trimmed) };
  }

  return null;
}

export function transposeNote(note, semitones, preferFlat = false) {
  if (!note || semitones === 0) return note;
  const norm = normalizeAccidentals(note);
  const root = norm.charAt(0).toUpperCase() + norm.slice(1);
  const semi = NOTE_TO_SEMITONE[root];
  if (semi === undefined) return note;
  const target = ((semi + semitones) % 12 + 12) % 12;
  return preferFlat ? FLAT_SCALE[target] : SHARP_SCALE[target];
}

export function shouldUseFlats(targetKey, accidentalMode) {
  if (accidentalMode === 'flat') return true;
  if (accidentalMode === 'sharp') return false;
  if (targetKey && FLAT_KEYS.has(normalizeAccidentals(targetKey))) return true;
  return false;
}

export function transposeChord(chordStr, semitones, accidentalMode = 'auto', targetKey = '') {
  if (!semitones) return chordStr;
  const norm = normalizeAccidentals(chordStr);
  if (/^(N\.?C\.?|\/|%)$/i.test(norm)) return chordStr;

  const preferFlat =
    accidentalMode === 'flat'
      ? true
      : accidentalMode === 'sharp'
        ? false
        : targetKey
          ? shouldUseFlats(targetKey, 'auto')
          : norm.includes('b');

  // Match root note, quality/extensions, and optional /bass note
  const match = norm.match(/^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/);
  if (!match) return chordStr;

  const [, root, suffix, bass] = match;
  const newRoot = transposeNote(root, semitones, preferFlat);
  const newBass = bass ? '/' + transposeNote(bass, semitones, preferFlat) : '';
  return `${newRoot}${suffix}${newBass}`;
}

export function transposeKey(keyStr, semitones, accidentalMode = 'auto') {
  if (!keyStr || !semitones) return keyStr;
  const norm = normalizeAccidentals(keyStr.trim());
  const m = norm.match(/^([A-G](?:#|b)?)(m|min|minor|maj|major)?$/i);
  if (!m) return keyStr;
  const root = m[1];
  const minorSuffix = m[2] && m[2].toLowerCase().startsWith('m') && !m[2].toLowerCase().startsWith('maj') ? 'm' : '';
  // Pick flat/sharp sensibly for key signature
  const semi = NOTE_TO_SEMITONE[root.charAt(0).toUpperCase() + root.slice(1)];
  if (semi === undefined) return keyStr;
  const targetIdx = ((semi + semitones) % 12 + 12) % 12;
  let preferFlat = accidentalMode === 'flat';
  if (accidentalMode === 'auto') {
    const candidateFlat = FLAT_SCALE[targetIdx] + minorSuffix;
    preferFlat = FLAT_KEYS.has(candidateFlat);
  }
  return transposeNote(root, semitones, preferFlat) + minorSuffix;
}

/**
 * Align a chords-over-lyrics pair into an inline ChordPro segment list:
 * returns array of { type: 'text', value } | { type: 'chord', value }
 */
function alignChordLineOverLyrics(chordLine, lyricLine) {
  const tokens = [];
  const regex = /\S+/g;
  let match;
  while ((match = regex.exec(chordLine)) !== null) {
    const raw = match[0];
    if (raw === '|' || raw === '||') continue;
    // Strip wrapping parens if it's a chord like (G)
    const stripped = raw.replace(/^\|+/, '').replace(/\|+$/, '');
    if (stripped) {
      tokens.push({ token: stripped, index: match.index });
    }
  }

  const segments = [];
  let cursor = 0;

  for (const { token, index } of tokens) {
    const isChord = isChordToken(token);
    if (index >= lyricLine.length) {
      if (cursor < lyricLine.length) {
        segments.push({ type: 'text', value: lyricLine.slice(cursor) });
        cursor = lyricLine.length;
      }
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && (lastSeg.type === 'chord' || (lastSeg.type === 'text' && !lastSeg.value.endsWith(' ')))) {
        segments.push({ type: 'text', value: ' ' });
      }
      segments.push(isChord ? { type: 'chord', value: token } : { type: 'text', value: token });
    } else {
      if (index > cursor) {
        segments.push({ type: 'text', value: lyricLine.slice(cursor, index) });
        cursor = index;
      }
      segments.push(isChord ? { type: 'chord', value: token } : { type: 'text', value: token });
    }
  }

  if (cursor < lyricLine.length) {
    segments.push({ type: 'text', value: lyricLine.slice(cursor) });
  }

  return segments;
}

/**
 * Parse an already-inline ChordPro line like "[D]Bring him [G]peace" into segments
 */
function parseInlineChordProLine(line) {
  const segments = [];
  const regex = /\[([^\]]+)\]/g;
  let lastIdx = 0;
  let match;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIdx) {
      segments.push({ type: 'text', value: line.slice(lastIdx, match.index) });
    }
    segments.push({ type: 'chord', value: match[1].trim() });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < line.length) {
    segments.push({ type: 'text', value: line.slice(lastIdx) });
  }
  return segments;
}

/**
 * Parse a duration string like "3:45", "1:02:05", "3m 45s", or "195" (seconds) into total seconds.
 */
export function parseDurationToSeconds(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;

  // h:mm:ss or m:ss
  const colonParts = str.split(':');
  if (colonParts.length === 2 || colonParts.length === 3) {
    const nums = colonParts.map((p) => Number(p.trim()));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (colonParts.length === 2) return Math.round(nums[0] * 60 + nums[1]);
    return Math.round(nums[0] * 3600 + nums[1] * 60 + nums[2]);
  }

  // e.g. "3m 45s" or "3m"
  const minSecMatch = str.match(/^(\d+)\s*m(?:in)?(?:\s*(\d+)\s*s(?:ec)?)?$/i);
  if (minSecMatch) {
    const mins = Number(minSecMatch[1]);
    const secs = minSecMatch[2] ? Number(minSecMatch[2]) : 0;
    return mins * 60 + secs;
  }

  // Plain seconds e.g. "15" or "15s"
  const secMatch = str.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?$/i);
  if (secMatch) {
    return Math.round(Number(secMatch[1]));
  }

  return null;
}

/**
 * Format total seconds into "m:ss" (or "h:mm:ss" if >= 1 hour).
 */
export function formatSecondsToDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return '';
  const clamped = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Compute Auto-Scroll Duration = Duration - Pre-Roll, formatted as m:ss.
 */
export function computeAutoScrollDuration(durationStr, preRollStr) {
  const durSec = parseDurationToSeconds(durationStr);
  if (durSec === null) return '';
  const preSec = parseDurationToSeconds(preRollStr) ?? 0;
  return formatSecondsToDuration(Math.max(0, durSec - preSec));
}

/**
 * Parse raw input text (Chords Over Lyrics, ChordPro, or Mixed) into a structured document.
 */
export function parseChordSheet(rawText) {
  const lines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const metadata = {
    title: '',
    artist: '',
    key: '',
    tempo: '',
    time: '',
    capo: '',
    leadVox: '',
    backupVox: '',
    tuning: '',
    duration: '',
    preRoll: '',
    autoScrollDuration: '',
    comments: [],
  };

  const entries = []; // { kind: 'section_start' | 'section_end' | 'tab_line' | 'line' | 'blank' | 'comment', ... }
  let activeSection = null;
  let inTabBlock = false;
  let seenMusicContent = false;

  const closeActiveSection = () => {
    if (activeSection) {
      entries.push({ kind: 'section_end', sectionType: activeSection.type, label: activeSection.label });
      activeSection = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      if (entries.length > 0 && entries[entries.length - 1].kind !== 'blank') {
        entries.push({ kind: 'blank' });
      }
      continue;
    }

    // 1. ChordPro curly-brace directives
    const dirMatch = trimmed.match(/^\{([^}:]+?)(?::\s*(.*))?\}$/);
    if (dirMatch) {
      const key = dirMatch[1].trim().toLowerCase();
      const val = (dirMatch[2] || '').trim();

      if (key === 'title' || key === 't') {
        metadata.title = val;
        continue;
      }
      if (key === 'artist' || key === 'subtitle' || key === 'st') {
        if (!metadata.artist) metadata.artist = val;
        continue;
      }
      if (key === 'key') {
        metadata.key = val;
        continue;
      }
      if (key === 'tempo' || key === 'bpm') {
        metadata.tempo = val;
        continue;
      }
      if (key === 'time') {
        metadata.time = val;
        continue;
      }
      if (key === 'capo') {
        metadata.capo = val;
        continue;
      }
      if (key === 'duration') {
        metadata.duration = val;
        continue;
      }
      if (key === 'tuning') {
        metadata.tuning = val;
        continue;
      }
      if (key === 'lead_vox' || key === 'lead vox') {
        metadata.leadVox = val;
        continue;
      }
      if (key === 'backup_vox' || key === 'backup vox') {
        metadata.backupVox = val;
        continue;
      }
      if (key === 'pre_roll' || key === 'pre-roll' || key === 'auto_scroll_pre_roll') {
        metadata.preRoll = val;
        continue;
      }
      if (key === 'auto_scroll_duration') {
        metadata.autoScrollDuration = val;
        continue;
      }
      if (key === 'comment' || key === 'c' || key === 'comment_italic' || key === 'ci') {
        if (!seenMusicContent && /^capo\b/i.test(val) && !metadata.capo) {
          metadata.capo = val.replace(/^capo\s*:?\s*/i, '');
        } else if (!seenMusicContent && /^lead\s*vox\s*:/i.test(val) && !metadata.leadVox) {
          metadata.leadVox = val.replace(/^lead\s*vox\s*:\s*/i, '');
        } else if (!seenMusicContent && /^backup\s*vox\s*:/i.test(val) && !metadata.backupVox) {
          metadata.backupVox = val.replace(/^backup\s*vox\s*:\s*/i, '');
        } else if (!seenMusicContent && /^tuning(?:\s*note)?\s*:/i.test(val) && !metadata.tuning) {
          metadata.tuning = val.replace(/^tuning(?:\s*note)?\s*:\s*/i, '');
        } else if (!seenMusicContent && /^(?:auto-scroll\s*)?pre-roll\s*:/i.test(val) && !metadata.preRoll) {
          metadata.preRoll = val.replace(/^(?:auto-scroll\s*)?pre-roll\s*:\s*/i, '').replace(/\s*s(?:ec(?:onds?)?)?$/i, '');
        } else if (!seenMusicContent && /^auto-scroll\s*duration\s*:/i.test(val) && !metadata.autoScrollDuration) {
          metadata.autoScrollDuration = val.replace(/^auto-scroll\s*duration\s*:\s*/i, '');
        } else {
          entries.push({ kind: 'comment', text: val });
        }
        continue;
      }
      if (key === 'start_of_verse' || key === 'sov') {
        closeActiveSection();
        activeSection = { type: 'verse', label: val || 'Verse' };
        entries.push({ kind: 'section_start', sectionType: 'verse', label: activeSection.label });
        seenMusicContent = true;
        continue;
      }
      if (key === 'start_of_chorus' || key === 'soc') {
        closeActiveSection();
        activeSection = { type: 'chorus', label: val || 'Chorus' };
        entries.push({ kind: 'section_start', sectionType: 'chorus', label: activeSection.label });
        seenMusicContent = true;
        continue;
      }
      if (key === 'start_of_bridge' || key === 'sob') {
        closeActiveSection();
        activeSection = { type: 'bridge', label: val || 'Bridge' };
        entries.push({ kind: 'section_start', sectionType: 'bridge', label: activeSection.label });
        seenMusicContent = true;
        continue;
      }
      if (key === 'start_of_tab' || key === 'sot') {
        closeActiveSection();
        inTabBlock = true;
        entries.push({ kind: 'section_start', sectionType: 'tab', label: val || 'Tab' });
        seenMusicContent = true;
        continue;
      }
      if (key === 'end_of_verse' || key === 'eov' || key === 'end_of_chorus' || key === 'eoc' || key === 'end_of_bridge' || key === 'eob') {
        closeActiveSection();
        continue;
      }
      if (key === 'end_of_tab' || key === 'eot') {
        if (inTabBlock) {
          entries.push({ kind: 'section_end', sectionType: 'tab', label: 'Tab' });
          inTabBlock = false;
        }
        continue;
      }
      // Ignore unrecognized ChordPro directives or preserve as comment
      continue;
    }

    // 2. Plain-text metadata headers near the top (before music starts)
    if (!seenMusicContent) {
      const metaMatch = trimmed.match(/^(Title|Song|Artist|By|Key|Tempo|BPM|Time|Time Signature|Capo|Lead Vox|Backup Vox|Tuning|Tuning Note|Duration|Auto-Scroll Pre-Roll|Pre-Roll|Auto-Scroll Duration)\s*:\s*(.+)$/i);
      if (metaMatch) {
        const field = metaMatch[1].toLowerCase();
        const val = metaMatch[2].trim();
        if (field === 'title' || field === 'song') metadata.title = val;
        else if (field === 'artist' || field === 'by') metadata.artist = val;
        else if (field === 'key') metadata.key = val;
        else if (field === 'tempo' || field === 'bpm') metadata.tempo = val.replace(/\s*bpm$/i, '');
        else if (field === 'time' || field === 'time signature') metadata.time = val;
        else if (field === 'capo') metadata.capo = val;
        else if (field === 'lead vox') metadata.leadVox = val;
        else if (field === 'backup vox') metadata.backupVox = val;
        else if (field === 'tuning' || field === 'tuning note') metadata.tuning = val;
        else if (field === 'duration') metadata.duration = val;
        else if (field === 'auto-scroll pre-roll' || field === 'pre-roll') metadata.preRoll = val.replace(/\s*s(?:ec(?:onds?)?)?$/i, '');
        else if (field === 'auto-scroll duration') metadata.autoScrollDuration = val;
        continue;
      }

      const capoPlainMatch = trimmed.match(/^Capo\s+(?:on\s+)?(\d+(?:st|nd|rd|th)?(?:\s+fret)?)$/i);
      if (capoPlainMatch) {
        metadata.capo = capoPlainMatch[1];
        continue;
      }
    }

    // 3. Tab lines
    if (inTabBlock || isTabLine(line)) {
      seenMusicContent = true;
      entries.push({ kind: 'tab_line', text: line });
      continue;
    }

    // 4. Section headers
    const sec = parseSectionHeader(line);
    if (sec) {
      seenMusicContent = true;
      closeActiveSection();
      if (sec.type === 'verse' || sec.type === 'chorus' || sec.type === 'bridge') {
        activeSection = { type: sec.type, label: sec.label };
        entries.push({ kind: 'section_start', sectionType: sec.type, label: sec.label });
      } else {
        entries.push({ kind: 'section_label', sectionType: sec.type, label: sec.label });
      }
      continue;
    }

    // 5. Already inline ChordPro line (contains [Chord])
    if (/\[[A-G][^\]]*\]/.test(line) && !isChordLine(line)) {
      seenMusicContent = true;
      entries.push({ kind: 'line', segments: parseInlineChordProLine(line) });
      continue;
    }

    // 6. Chords-over-lyrics pair OR standalone chord line
    if (isChordLine(line)) {
      seenMusicContent = true;
      const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
      const nextTrimmed = nextLine.trim();
      const nextIsMusicLyric =
        nextTrimmed.length > 0 &&
        !isChordLine(nextLine) &&
        !parseSectionHeader(nextLine) &&
        !isTabLine(nextLine) &&
        !nextTrimmed.startsWith('{');

      if (nextIsMusicLyric) {
        entries.push({ kind: 'line', segments: alignChordLineOverLyrics(line, nextLine) });
        i++; // consume paired lyric line
      } else {
        // Standalone instrumental/chord-only line
        const tokens = trimmed.split(/\s+/);
        const segments = [];
        tokens.forEach((tok, idx) => {
          if (idx > 0) segments.push({ type: 'text', value: ' ' });
          if (tok === '|' || tok === '||') {
            segments.push({ type: 'text', value: tok });
          } else {
            const stripped = tok.replace(/^\|+/, '').replace(/\|+$/, '');
            if (isChordToken(stripped)) {
              segments.push({ type: 'chord', value: stripped });
            } else {
              segments.push({ type: 'text', value: tok });
            }
          }
        });
        entries.push({ kind: 'line', segments });
      }
      continue;
    }

    // 7. Plain lyric / text line
    seenMusicContent = true;
    entries.push({ kind: 'line', segments: [{ type: 'text', value: line }] });
  }

  if (inTabBlock) {
    entries.push({ kind: 'section_end', sectionType: 'tab', label: 'Tab' });
  }
  closeActiveSection();

  // Trim leading/trailing blank entries
  while (entries.length > 0 && entries[0].kind === 'blank') entries.shift();
  while (entries.length > 0 && entries[entries.length - 1].kind === 'blank') entries.pop();

  return { metadata, entries };
}

/**
 * Apply transposition to a parsed document and return a new transposed copy.
 */
export function transposeDocument(doc, semitones, accidentalMode = 'auto') {
  const newKey = doc.metadata.key
    ? transposeKey(doc.metadata.key, semitones, accidentalMode)
    : '';

  const newEntries = doc.entries.map((entry) => {
    if (entry.kind !== 'line') return entry;
    return {
      ...entry,
      segments: entry.segments.map((seg) =>
        seg.type === 'chord'
          ? { type: 'chord', value: transposeChord(seg.value, semitones, accidentalMode, newKey) }
          : seg
      ),
    };
  });

  return {
    metadata: { ...doc.metadata, key: newKey },
    entries: newEntries,
  };
}

function segmentsToChordProText(segments) {
  return segments
    .map((seg) => (seg.type === 'chord' ? `[${seg.value}]` : seg.value))
    .join('');
}

function segmentsToChordsOverLyrics(segments) {
  let chordLine = '';
  let lyricLine = '';

  for (const seg of segments) {
    if (seg.type === 'chord') {
      // Ensure at least 1 space between adjacent chords in the chord line
      if (chordLine.length > lyricLine.length) {
        const needed = chordLine.length - lyricLine.length + 1;
        lyricLine += ' '.repeat(needed);
      }
      while (chordLine.length < lyricLine.length) {
        chordLine += ' ';
      }
      chordLine += seg.value;
    } else {
      lyricLine += seg.value;
    }
  }

  return {
    chordLine: chordLine.trimEnd(),
    lyricLine: lyricLine.trimEnd(),
  };
}

function formatLyricsSectionHeader(label, style) {
  if (style === 'uppercase') return label.toUpperCase();
  if (style === 'title_colon') return `${label}:`;
  return label;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format a parsed document into rich HTML (with bolded section titles and clean text)
 * suitable for BandHelper's rich-text Lyrics editor clipboard paste.
 */
export function formatBandHelperHtml(doc, options = {}) {
  const { headerStyle = 'title' } = options;
  const htmlLines = [];

  for (const entry of doc.entries) {
    if (entry.kind === 'blank') {
      if (htmlLines.length > 0 && htmlLines[htmlLines.length - 1] !== '') {
        htmlLines.push('');
      }
    } else if (entry.kind === 'section_start' || entry.kind === 'section_label') {
      while (htmlLines.length > 0 && htmlLines[htmlLines.length - 1] === '') {
        htmlLines.pop();
      }
      if (htmlLines.length > 0) {
        htmlLines.push('', '');
      }
      const title = formatLyricsSectionHeader(entry.label, headerStyle);
      htmlLines.push(`<strong>${escapeHtml(title)}</strong>`);
    } else if (entry.kind === 'section_end') {
      // No end tags
    } else if (entry.kind === 'comment') {
      htmlLines.push(`<i>${escapeHtml(entry.text)}</i>`);
    } else if (entry.kind === 'tab_line') {
      htmlLines.push(escapeHtml(entry.text));
    } else if (entry.kind === 'line') {
      htmlLines.push(escapeHtml(segmentsToChordProText(entry.segments)));
    }
  }

  while (htmlLines.length > 0 && htmlLines[htmlLines.length - 1] === '') {
    htmlLines.pop();
  }

  return htmlLines.join('<br>');
}

/**
 * Format a parsed document into one of:
 * - 'bandhelper_file': Full BandHelper .chordpro file with metadata & {comment:} section headers (default)
 * - 'bandhelper_lyrics': Clean inline [Chord] text with section titles ready for BandHelper's Lyrics field
 * - 'chords_over_lyrics': Standard aligned chords-over-lyrics text
 */
export function formatDocument(doc, options = {}) {
  const {
    format = 'bandhelper_file',
    headerStyle = 'title',
    zipHeaderMode = 'comment',
    overrideMeta = {},
  } = options;

  const meta = {
    title: overrideMeta.title !== undefined ? overrideMeta.title : doc.metadata.title,
    artist: overrideMeta.artist !== undefined ? overrideMeta.artist : doc.metadata.artist,
    key: overrideMeta.key !== undefined ? overrideMeta.key : doc.metadata.key,
    tempo: overrideMeta.tempo !== undefined ? overrideMeta.tempo : doc.metadata.tempo,
    time: overrideMeta.time !== undefined ? overrideMeta.time : doc.metadata.time,
    capo: overrideMeta.capo !== undefined ? overrideMeta.capo : doc.metadata.capo,
    leadVox: overrideMeta.leadVox !== undefined ? overrideMeta.leadVox : doc.metadata.leadVox,
    backupVox: overrideMeta.backupVox !== undefined ? overrideMeta.backupVox : doc.metadata.backupVox,
    tuning: overrideMeta.tuning !== undefined ? overrideMeta.tuning : doc.metadata.tuning,
    duration: overrideMeta.duration !== undefined ? overrideMeta.duration : doc.metadata.duration,
    preRoll: overrideMeta.preRoll !== undefined ? overrideMeta.preRoll : doc.metadata.preRoll,
    autoScrollDuration: overrideMeta.autoScrollDuration !== undefined ? overrideMeta.autoScrollDuration : doc.metadata.autoScrollDuration,
  };

  const normalizedDuration = (() => {
    if (!meta.duration) return '';
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(meta.duration.trim())) return meta.duration.trim();
    const sec = parseDurationToSeconds(meta.duration);
    return sec !== null ? formatSecondsToDuration(sec) : meta.duration.trim();
  })();

  const computedAutoScrollDuration =
    meta.autoScrollDuration || computeAutoScrollDuration(normalizedDuration, meta.preRoll);

  const outLines = [];

  if (format === 'bandhelper_file') {
    const useCommentDirectives = zipHeaderMode !== 'plain';
    const formatFileHeader = (label) => {
      const styled = formatLyricsSectionHeader(label, headerStyle);
      return useCommentDirectives ? `{comment: ${styled}}` : styled;
    };

    if (meta.title) outLines.push(`{title: ${meta.title}}`);
    if (meta.artist) outLines.push(`{artist: ${meta.artist}}`);
    if (meta.key) outLines.push(`{key: ${meta.key}}`);
    if (meta.tempo) outLines.push(`{tempo: ${meta.tempo}}`);
    if (meta.time) outLines.push(`{time: ${meta.time}}`);
    if (normalizedDuration) outLines.push(`{duration: ${normalizedDuration}}`);
    if (meta.leadVox) outLines.push(useCommentDirectives ? `{comment: Lead Vox: ${meta.leadVox}}` : `Lead Vox: ${meta.leadVox}`);
    if (meta.backupVox) outLines.push(useCommentDirectives ? `{comment: Backup Vox: ${meta.backupVox}}` : `Backup Vox: ${meta.backupVox}`);
    if (meta.tuning) outLines.push(useCommentDirectives ? `{comment: Tuning: ${meta.tuning}}` : `Tuning: ${meta.tuning}`);
    if (meta.capo) outLines.push(useCommentDirectives ? `{comment: Capo: ${meta.capo}}` : `Capo: ${meta.capo}`);
    if (meta.preRoll) {
      const preText = /^\d+$/.test(String(meta.preRoll).trim()) ? `${meta.preRoll.trim()}s` : String(meta.preRoll).trim();
      outLines.push(useCommentDirectives ? `{comment: Auto-Scroll Pre-Roll: ${preText}}` : `Auto-Scroll Pre-Roll: ${preText}`);
    }
    if (computedAutoScrollDuration) {
      outLines.push(useCommentDirectives ? `{comment: Auto-Scroll Duration: ${computedAutoScrollDuration}}` : `Auto-Scroll Duration: ${computedAutoScrollDuration}`);
    }
    const metaLineCount = outLines.length;
    if (metaLineCount > 0) outLines.push('');

    for (const entry of doc.entries) {
      if (entry.kind === 'blank') {
        if (outLines.length > 0 && outLines[outLines.length - 1] !== '') {
          outLines.push('');
        }
      } else if (entry.kind === 'section_start') {
        if (entry.sectionType === 'tab') {
          outLines.push('{start_of_tab}');
        } else {
          if (outLines.length > metaLineCount + 1) {
            while (outLines.length > 0 && outLines[outLines.length - 1] === '') {
              outLines.pop();
            }
            outLines.push('', '');
          }
          outLines.push(formatFileHeader(entry.label));
        }
      } else if (entry.kind === 'section_end') {
        if (entry.sectionType === 'tab') outLines.push('{end_of_tab}');
      } else if (entry.kind === 'section_label') {
        if (outLines.length > metaLineCount + 1) {
          while (outLines.length > 0 && outLines[outLines.length - 1] === '') {
            outLines.pop();
          }
          outLines.push('', '');
        }
        outLines.push(formatFileHeader(entry.label));
      } else if (entry.kind === 'comment') {
        outLines.push(useCommentDirectives ? `{comment: ${entry.text}}` : entry.text);
      } else if (entry.kind === 'tab_line') {
        outLines.push(entry.text);
      } else if (entry.kind === 'line') {
        outLines.push(segmentsToChordProText(entry.segments));
      }
    }
  } else if (format === 'bandhelper_lyrics') {
    for (const entry of doc.entries) {
      if (entry.kind === 'blank') {
        if (outLines.length > 0 && outLines[outLines.length - 1] !== '') {
          outLines.push('');
        }
      } else if (entry.kind === 'section_start' || entry.kind === 'section_label') {
        while (outLines.length > 0 && outLines[outLines.length - 1] === '') {
          outLines.pop();
        }
        if (outLines.length > 0) {
          outLines.push('', '');
        }
        outLines.push(formatLyricsSectionHeader(entry.label, headerStyle));
      } else if (entry.kind === 'section_end') {
        // No end tags in BandHelper Lyrics field
      } else if (entry.kind === 'comment') {
        outLines.push(entry.text);
      } else if (entry.kind === 'tab_line') {
        outLines.push(entry.text);
      } else if (entry.kind === 'line') {
        outLines.push(segmentsToChordProText(entry.segments));
      }
    }
  } else {
    // chords_over_lyrics
    for (const entry of doc.entries) {
      if (entry.kind === 'blank') {
        if (outLines.length > 0 && outLines[outLines.length - 1] !== '') {
          outLines.push('');
        }
      } else if (entry.kind === 'section_start' || entry.kind === 'section_label') {
        if (outLines.length > 0 && outLines[outLines.length - 1] !== '') {
          outLines.push('');
        }
        outLines.push(`[${entry.label}]`);
      } else if (entry.kind === 'section_end') {
        // omit
      } else if (entry.kind === 'comment') {
        outLines.push(entry.text);
      } else if (entry.kind === 'tab_line') {
        outLines.push(entry.text);
      } else if (entry.kind === 'line') {
        const { chordLine, lyricLine } = segmentsToChordsOverLyrics(entry.segments);
        if (chordLine) outLines.push(chordLine);
        if (lyricLine) outLines.push(lyricLine);
      }
    }
  }

  return outLines.join('\n').trim();
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Create a standard uncompressed (Store) single-file PKZIP archive in memory.
 * Compatible with BandHelper's Batch Import (.zip containing .chordpro).
 */
export function createSingleFileZip(filename, textContent) {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(filename);
  const dataBytes = encoder.encode(textContent);
  const checksum = crc32(dataBytes);
  const size = dataBytes.length;

  const localHeaderSize = 30 + nameBytes.length;
  const centralHeaderSize = 46 + nameBytes.length;
  const eocdSize = 22;
  const totalSize = localHeaderSize + size + centralHeaderSize + eocdSize;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);

  // Local file header
  let pos = 0;
  view.setUint32(pos, 0x04034b50, true); pos += 4;
  view.setUint16(pos, 20, true); pos += 2;          // version needed
  view.setUint16(pos, 0x0800, true); pos += 2;      // UTF-8 filename flag
  view.setUint16(pos, 0, true); pos += 2;           // compression: store
  view.setUint16(pos, 0, true); pos += 2;           // mod time
  view.setUint16(pos, 0x0021, true); pos += 2;      // mod date (1980-01-01)
  view.setUint32(pos, checksum, true); pos += 4;
  view.setUint32(pos, size, true); pos += 4;
  view.setUint32(pos, size, true); pos += 4;
  view.setUint16(pos, nameBytes.length, true); pos += 2;
  view.setUint16(pos, 0, true); pos += 2;           // extra len
  buf.set(nameBytes, pos); pos += nameBytes.length;

  // File payload
  buf.set(dataBytes, pos); pos += size;

  // Central directory header
  const cdOffset = pos;
  view.setUint32(pos, 0x02014b50, true); pos += 4;
  view.setUint16(pos, 20, true); pos += 2;          // version made by
  view.setUint16(pos, 20, true); pos += 2;          // version needed
  view.setUint16(pos, 0x0800, true); pos += 2;      // UTF-8 filename flag
  view.setUint16(pos, 0, true); pos += 2;           // compression: store
  view.setUint16(pos, 0, true); pos += 2;           // mod time
  view.setUint16(pos, 0x0021, true); pos += 2;      // mod date
  view.setUint32(pos, checksum, true); pos += 4;
  view.setUint32(pos, size, true); pos += 4;
  view.setUint32(pos, size, true); pos += 4;
  view.setUint16(pos, nameBytes.length, true); pos += 2;
  view.setUint16(pos, 0, true); pos += 2;           // extra len
  view.setUint16(pos, 0, true); pos += 2;           // comment len
  view.setUint16(pos, 0, true); pos += 2;           // disk start
  view.setUint16(pos, 0, true); pos += 2;           // internal attrs
  view.setUint32(pos, 0, true); pos += 4;           // external attrs
  view.setUint32(pos, 0, true); pos += 4;           // local header offset
  buf.set(nameBytes, pos); pos += nameBytes.length;

  // End of central directory
  view.setUint32(pos, 0x06054b50, true); pos += 4;
  view.setUint16(pos, 0, true); pos += 2;           // disk num
  view.setUint16(pos, 0, true); pos += 2;           // cd start disk
  view.setUint16(pos, 1, true); pos += 2;           // disk entries
  view.setUint16(pos, 1, true); pos += 2;           // total entries
  view.setUint32(pos, centralHeaderSize, true); pos += 4;
  view.setUint32(pos, cdOffset, true); pos += 4;
  view.setUint16(pos, 0, true);                     // comment len

  return buf;
}

function parseChordRootAndQuality(chordStr) {
  const norm = normalizeAccidentals(String(chordStr || '').trim());
  const match = norm.match(/^([A-G](?:#|b)?)(.*)$/);
  if (!match) return null;
  const rootName = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const semi = NOTE_TO_SEMITONE[rootName];
  if (semi === undefined) return null;

  const rest = match[2].replace(/\/[A-G](?:#|b)?$/, '').toLowerCase();
  let quality = 'maj';
  if (/^(dim|°|ø|m7b5)/.test(rest)) {
    quality = 'dim';
  } else if (/^m(?!aj)/.test(rest) || /^min/.test(rest)) {
    quality = 'min';
  }
  return { semi, quality, hasFlat: rootName.includes('b'), hasSharp: rootName.includes('#') };
}

/**
 * Infer the most likely musical key from the chord progression in a parsed document.
 */
export function inferKeyFromChords(doc) {
  const chords = [];
  let chorusChords = [];
  let inChorus = false;

  for (const entry of doc.entries || []) {
    if (entry.kind === 'section_start' || entry.kind === 'section_label') {
      inChorus = /\bchorus\b/i.test(entry.label || '');
    } else if (entry.kind === 'section_end') {
      inChorus = false;
    } else if (entry.kind === 'line') {
      for (const seg of entry.segments) {
        if (seg.type === 'chord') {
          const parsed = parseChordRootAndQuality(seg.value);
          if (parsed) {
            chords.push(parsed);
            if (inChorus) chorusChords.push(parsed);
          }
        }
      }
    }
  }

  if (chords.length < 2) return '';

  const flatChordsCount = chords.filter((c) => c.hasFlat).length;
  const sharpChordsCount = chords.filter((c) => c.hasSharp).length;
  const preferFlatsOverall = flatChordsCount > sharpChordsCount;

  // Major key diatonic intervals: 0:maj, 2:min, 4:min, 5:maj, 7:maj, 9:min, 11:dim
  const MAJOR_MAP = new Map([
    [0, { q: 'maj', w: 3.5 }],
    [2, { q: 'min', w: 2.5 }],
    [4, { q: 'min', w: 2.0 }],
    [5, { q: 'maj', w: 3.0 }],
    [7, { q: 'maj', w: 3.2 }],
    [9, { q: 'min', w: 2.6 }],
    [11, { q: 'dim', w: 1.5 }],
  ]);

  // Minor key diatonic intervals (including harmonic minor V): 0:min, 2:dim, 3:maj, 5:min, 7:min/maj, 8:maj, 10:maj
  const MINOR_MAP = new Map([
    [0, { q: 'min', w: 3.5 }],
    [2, { q: 'dim', w: 1.5 }],
    [3, { q: 'maj', w: 2.6 }],
    [5, { q: 'min', w: 2.6 }],
    [7, { q: 'both', w: 2.8 }],
    [8, { q: 'maj', w: 2.5 }],
    [10, { q: 'maj', w: 2.2 }],
  ]);

  let bestKey = '';
  let bestScore = -Infinity;

  const firstChord = chords[0];
  const lastChord = chords[chords.length - 1];
  const chorusFirst = chorusChords[0];
  const chorusLast = chorusChords[chorusChords.length - 1];

  for (let tonic = 0; tonic < 12; tonic++) {
    // Major candidate
    {
      let score = 0;
      for (const c of chords) {
        const deg = (c.semi - tonic + 12) % 12;
        const rule = MAJOR_MAP.get(deg);
        if (rule && rule.q === c.quality) score += rule.w;
        else if (rule) score += 0.5;
        else score -= 2.0;
      }
      if (firstChord.semi === tonic && firstChord.quality === 'maj') score += 4.5;
      if (lastChord.semi === tonic && lastChord.quality === 'maj') score += 5.5;
      if (chorusFirst && chorusFirst.semi === tonic && chorusFirst.quality === 'maj') score += 2.5;
      if (chorusLast && chorusLast.semi === tonic && chorusLast.quality === 'maj') score += 2.5;

      const sharpName = SHARP_SCALE[tonic];
      const flatName = FLAT_SCALE[tonic];
      const useFlat = FLAT_KEYS.has(flatName) || (preferFlatsOverall && flatName !== sharpName);
      const name = useFlat ? flatName : sharpName;

      if (score > bestScore) {
        bestScore = score;
        bestKey = name;
      }
    }

    // Minor candidate
    {
      let score = 0;
      for (const c of chords) {
        const deg = (c.semi - tonic + 12) % 12;
        const rule = MINOR_MAP.get(deg);
        if (rule && (rule.q === c.quality || (rule.q === 'both' && (c.quality === 'min' || c.quality === 'maj')))) {
          score += rule.w;
        } else if (rule) {
          score += 0.5;
        } else {
          score -= 2.0;
        }
      }
      if (firstChord.semi === tonic && firstChord.quality === 'min') score += 4.5;
      if (lastChord.semi === tonic && lastChord.quality === 'min') score += 5.5;
      if (chorusFirst && chorusFirst.semi === tonic && chorusFirst.quality === 'min') score += 2.5;
      if (chorusLast && chorusLast.semi === tonic && chorusLast.quality === 'min') score += 2.5;

      const sharpName = `${SHARP_SCALE[tonic]}m`;
      const flatName = `${FLAT_SCALE[tonic]}m`;
      const useFlat = FLAT_KEYS.has(flatName) || (preferFlatsOverall && flatName !== sharpName);
      const name = useFlat ? flatName : sharpName;

      if (score > bestScore) {
        bestScore = score;
        bestKey = name;
      }
    }
  }

  return bestKey;
}

/**
 * Take a best guess at missing metadata fields (Key, Time, Tuning, Tempo, Capo)
 * from parsed chords and raw text. Never invents band-specific vocalists.
 */
export function inferMissingMetadata(doc, rawText = '') {
  const hasMusic = (doc.entries || []).some((e) => e.kind === 'line');
  const text = String(rawText || '');

  const key = inferKeyFromChords(doc);

  let tempo = '';
  const tempoMatch =
    text.match(/\b(\d{2,3})\s*bpm\b/i) ||
    text.match(/(?:♩|q)\s*=\s*(\d{2,3})/i);
  if (tempoMatch) tempo = tempoMatch[1];

  let capo = '';
  const capoMatch = text.match(/\bCapo\s*[:\-]?\s*(?:on\s+)?(\d+)(?:st|nd|rd|th)?(?:\s+fret)?/i);
  if (capoMatch) capo = capoMatch[1];

  let tuning = '';
  const tuningMatch =
    text.match(/(?:^|\n)\s*Tuning(?:\s+Note)?\s*:\s*([^\n\r]+)/i) ||
    text.match(/\b(Drop\s+[A-G](?:#|b)?|Half[- ]Step Down|Whole[- ]Step Down|Eb\s+Standard|D\s+Standard|C#\s+Standard|Open\s+[A-G]|DADGAD)\b/i);
  if (tuningMatch) {
    tuning = tuningMatch[1].trim();
  } else if (hasMusic) {
    tuning = 'Standard';
  }

  let time = '';
  const timeMatch = text.match(/\b(2\/4|3\/4|4\/4|5\/4|6\/8|9\/8|12\/8)\b/);
  if (timeMatch) {
    time = timeMatch[1];
  } else if (hasMusic) {
    time = '4/4';
  }

  return { key, tempo, capo, tuning, time };
}


