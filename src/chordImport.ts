import dns from 'dns/promises';
import net from 'net';

export interface ImportedChordResult {
  content: string;
  title: string;
  artist: string;
  key: string;
  tempo: string;
  time: string;
  capo: string;
  tuning: string;
  duration: string;
  sourceUrl: string;
  note?: string;
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    return (
      norm === '::1' ||
      norm === '::' ||
      norm.startsWith('fc') ||
      norm.startsWith('fd') ||
      norm.startsWith('fe80') ||
      norm.startsWith('::ffff:127.') ||
      norm.startsWith('::ffff:10.') ||
      norm.startsWith('::ffff:192.168.')
    );
  }
  return true;
}

async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Local or internal URLs are not allowed.');
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error('Private IP addresses are not allowed.');
    }
  } else {
    const records = await dns.lookup(host, { all: true });
    if (records.length === 0 || records.some((r) => isPrivateIp(r.address))) {
      throw new Error('URL resolves to a private or disallowed address.');
    }
  }

  return parsed;
}

function decodeAttrForJson(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;|&bdquo;/g, '"')
    .replace(/&#039;|&#39;|&apos;|&rsquo;|&lsquo;|&sbquo;/g, "'")
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&hellip;/g, '...')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function cleanUltimateGuitarContent(raw: string): string {
  return decodeHtmlEntities(raw)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\[\/?tab\]/gi, '')
    .replace(/\[ch\]/gi, '')
    .replace(/\[\/ch\]/gi, '')
    .trim();
}

function extractUgJsStore(html: string): Record<string, unknown> | null {
  const match = html.match(/class=["'][^"']*js-store[^"']*["'][^>]*data-content=["']([^"']+)["']/i);
  if (!match) return null;
  try {
    return JSON.parse(decodeAttrForJson(match[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface UgTabData {
  tab?: {
    song_name?: string;
    artist_name?: string;
    type_name?: string;
    tonality_name?: string;
    tab_url?: string;
  };
  tab_view?: {
    meta?: {
      capo?: number | string;
      tonality?: string;
      tempo?: number | string;
      tuning?: {
        name?: string;
        value?: string;
      } | string;
    };
    wiki_tab?: {
      content?: string;
      content_is_pro?: boolean;
    };
  };
  results?: Array<{
    song_name?: string;
    artist_name?: string;
    type?: string;
    rating?: number;
    votes?: number;
    tab_url?: string;
  }>;
}

async function fetchHtml(url: string): Promise<{ text: string; contentType: string; finalUrl: string }> {
  const safeUrl = await assertSafePublicUrl(url);
  const resp = await fetch(safeUrl.toString(), {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`Remote server returned HTTP ${resp.status}.`);
  }

  // Re-validate final URL after any redirects
  await assertSafePublicUrl(resp.url);

  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  const text = await resp.text();
  return { text, contentType, finalUrl: resp.url };
}

function formatMsToDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function normalizeMatchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function lookupSongDuration(title: string, artist: string): Promise<string> {
  const cleanTitle = title.trim();
  const cleanArtist = artist.trim();
  if (!cleanTitle) return '';

  const query = cleanArtist ? `${cleanArtist} ${cleanTitle}` : cleanTitle;
  const normTitle = normalizeMatchText(cleanTitle);
  const normArtist = normalizeMatchText(cleanArtist);

  // 1. iTunes Search API (fast, keyless)
  try {
    const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=10`;
    const resp = await fetch(itUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4500),
    });
    if (resp.ok) {
      const json = (await resp.json()) as {
        results?: Array<{
          trackName?: string;
          artistName?: string;
          trackTimeMillis?: number;
        }>;
      };
      const results = (json.results || []).filter((r) => (r.trackTimeMillis || 0) >= 30000);
      if (results.length > 0) {
        let best = results[0];
        let bestScore = -Infinity;
        for (const r of results) {
          const rTitle = normalizeMatchText(r.trackName || '');
          const rArtist = normalizeMatchText(r.artistName || '');
          let score = 0;
          if (rTitle === normTitle) score += 10;
          else if (rTitle.includes(normTitle) || normTitle.includes(rTitle)) score += 5;
          if (normArtist) {
            if (rArtist === normArtist) score += 10;
            else if (rArtist.includes(normArtist) || normArtist.includes(rArtist)) score += 6;
            else score -= 6;
          }
          if (/\b(karaoke|tribute|cover|made famous)\b/.test(rArtist + ' ' + rTitle) && !/\b(karaoke|tribute|cover)\b/.test(normTitle)) {
            score -= 15;
          }
          if (/\b(live|acoustic|remix|instrumental)\b/.test(rTitle) && !/\b(live|acoustic|remix|instrumental)\b/.test(normTitle)) {
            score -= 4;
          }
          if (score > bestScore) {
            bestScore = score;
            best = r;
          }
        }
        if (best?.trackTimeMillis) {
          return formatMsToDuration(best.trackTimeMillis);
        }
      }
    }
  } catch {
    // Fall through to MusicBrainz
  }

  // 2. MusicBrainz fallback
  try {
    const mbQuery = cleanArtist
      ? `recording:"${cleanTitle}" AND artist:"${cleanArtist}"`
      : `recording:"${cleanTitle}"`;
    const mbUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(mbQuery)}&fmt=json&limit=5`;
    const resp = await fetch(mbUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CueTrackChordConverter/1.0',
      },
      signal: AbortSignal.timeout(4500),
    });
    if (resp.ok) {
      const json = (await resp.json()) as {
        recordings?: Array<{ length?: number }>;
      };
      const hit = (json.recordings || []).find((r) => (r.length || 0) >= 30000);
      if (hit?.length) {
        return formatMsToDuration(hit.length);
      }
    }
  } catch {
    // Ignore lookup failure
  }

  return '';
}

function extractMetadataFromText(text: string): {
  tempo: string;
  time: string;
  tuning: string;
  duration: string;
  capo: string;
} {
  let tempo = '';
  let time = '';
  let tuning = '';
  let duration = '';
  let capo = '';

  const tempoMatch =
    text.match(/(?:^|\n)\s*(?:Tempo|BPM)\s*[:=]\s*(\d{2,3})/i) ||
    text.match(/\b(\d{2,3})\s*bpm\b/i) ||
    text.match(/(?:♩|q)\s*=\s*(\d{2,3})/i);
  if (tempoMatch) tempo = tempoMatch[1];

  const timeMatch =
    text.match(/(?:^|\n)\s*(?:Time(?:\s+Signature)?)\s*[:=]\s*(\d+\s*\/\s*\d+)/i) ||
    text.match(/\b(2\/4|3\/4|4\/4|5\/4|6\/8|9\/8|12\/8)\s*(?:time|meter)\b/i);
  if (timeMatch) time = timeMatch[1].replace(/\s+/g, '');

  const tuningMatch =
    text.match(/(?:^|\n)\s*Tuning(?:\s+Note)?\s*:\s*([^\n\r]+)/i) ||
    text.match(/\b(Drop\s+[A-G](?:#|b)?|Half[- ]Step Down|Whole[- ]Step Down|Eb\s+Standard|D\s+Standard|C#\s+Standard|Open\s+[A-G]|DADGAD)\b/i);
  if (tuningMatch) tuning = tuningMatch[1].trim();

  const durMatch = text.match(/(?:^|\n)\s*Duration\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)/i);
  if (durMatch) duration = durMatch[1].trim();

  const capoMatch =
    text.match(/(?:^|\n)\s*Capo\s*[:\-]?\s*(?:on\s+)?(\d+)(?:st|nd|rd|th)?(?:\s+fret)?/i);
  if (capoMatch) capo = capoMatch[1];

  return { tempo, time, tuning, duration, capo };
}

async function importFromUltimateGuitar(
  html: string,
  pageUrl: string
): Promise<ImportedChordResult> {
  const store = extractUgJsStore(html);
  const pageData = ((store?.store as Record<string, unknown> | undefined)?.page as Record<string, unknown> | undefined)?.data as UgTabData | undefined;

  if (!pageData) {
    throw new Error('Could not find chord data on this Ultimate Guitar page.');
  }

  const tab = pageData.tab;
  const tabView = pageData.tab_view;
  const rawWikiContent = tabView?.wiki_tab?.content;

  if (rawWikiContent && !tabView?.wiki_tab?.content_is_pro) {
    const content = cleanUltimateGuitarContent(rawWikiContent);
    const textMeta = extractMetadataFromText(content);
    const metaTempo = tabView?.meta?.tempo ? String(tabView.meta.tempo) : textMeta.tempo;

    let ugTuning = textMeta.tuning;
    const rawTuning = tabView?.meta?.tuning;
    if (!ugTuning && rawTuning) {
      if (typeof rawTuning === 'string') {
        if (rawTuning.trim().toLowerCase() !== 'standard') ugTuning = rawTuning.trim();
      } else if (rawTuning.name && rawTuning.name.trim().toLowerCase() !== 'standard') {
        ugTuning = rawTuning.value
          ? `${rawTuning.name.trim()} (${rawTuning.value.trim()})`
          : rawTuning.name.trim();
      }
    }

    return {
      content,
      title: tab?.song_name || '',
      artist: tab?.artist_name || '',
      key: tabView?.meta?.tonality || tab?.tonality_name || '',
      tempo: metaTempo,
      time: textMeta.time,
      capo: tabView?.meta?.capo ? String(tabView.meta.capo) : textMeta.capo,
      tuning: ugTuning,
      duration: textMeta.duration,
      sourceUrl: pageUrl,
    };
  }

  // If this was a Guitar Pro / Official tab with no text content, automatically search UG for a Chords version of the song
  const songName = tab?.song_name || '';
  const artistName = tab?.artist_name || '';
  if (!songName) {
    throw new Error('This tab does not contain plain text chords (binary Guitar Pro / Official tab).');
  }

  const query = `${artistName} ${songName}`.trim();
  const searchUrl = `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(query)}`;
  const searchResp = await fetchHtml(searchUrl);
  const searchStore = extractUgJsStore(searchResp.text);
  const searchData = ((searchStore?.store as Record<string, unknown> | undefined)?.page as Record<string, unknown> | undefined)?.data as UgTabData | undefined;
  const results = searchData?.results || [];

  const chordMatches = results
    .filter((r) => r.type === 'Chords' && r.tab_url)
    .sort((a, b) => (b.votes || 0) * (b.rating || 1) - (a.votes || 0) * (a.rating || 1));

  if (chordMatches.length === 0) {
    throw new Error(
      `"${songName}" (${tab?.type_name || 'Pro'}) has no plain-text Chords version available on Ultimate Guitar.`
    );
  }

  const bestUrl = chordMatches[0].tab_url!;
  const bestResp = await fetchHtml(bestUrl);
  const bestResult = await importFromUltimateGuitar(bestResp.text, bestResp.finalUrl);
  bestResult.note = `Matched Chords chart for "${songName}" (${artistName || 'Ultimate Guitar'})`;
  return bestResult;
}

function extractGenericHtmlChords(html: string, url: string): ImportedChordResult {
  const preMatches = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)];
  let bestContent = '';

  for (const m of preMatches) {
    const stripped = decodeHtmlEntities(
      m[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    ).trim();

    if (stripped.length > bestContent.length) {
      bestContent = stripped;
    }
  }

  if (!bestContent) {
    throw new Error(
      'No chord sheet text was found at this URL. Try an Ultimate Guitar Chords URL or a direct .chordpro/.txt link.'
    );
  }

  let title = '';
  let artist = '';
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleTag) {
    const rawTitle = decodeHtmlEntities(titleTag[1]).replace(/\s*\|.*$/, '').trim();
    const dashParts = rawTitle.split(/\s+-\s+|\s+by\s+/i);
    if (dashParts.length >= 2) {
      title = dashParts[0].trim();
      artist = dashParts[1].replace(/\s*(chords|tabs).*$/i, '').trim();
    } else {
      title = rawTitle;
    }
  }

  const textMeta = extractMetadataFromText(bestContent);

  return {
    content: bestContent,
    title,
    artist,
    key: '',
    tempo: textMeta.tempo,
    time: textMeta.time,
    capo: textMeta.capo,
    tuning: textMeta.tuning,
    duration: textMeta.duration,
    sourceUrl: url,
  };
}

export async function importChordsFromUrl(rawUrl: string): Promise<ImportedChordResult> {
  const { text, contentType, finalUrl } = await fetchHtml(rawUrl);
  const parsedUrl = new URL(finalUrl);
  const lowerPath = parsedUrl.pathname.toLowerCase();

  let result: ImportedChordResult;

  // Direct plain text / ChordPro files
  if (
    contentType.includes('text/plain') ||
    /\.(txt|cho|chopro|chordpro|pro|onsong)$/.test(lowerPath)
  ) {
    const cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const textMeta = extractMetadataFromText(cleaned);
    result = {
      content: cleaned,
      title: '',
      artist: '',
      key: '',
      tempo: textMeta.tempo,
      time: textMeta.time,
      capo: textMeta.capo,
      tuning: textMeta.tuning,
      duration: textMeta.duration,
      sourceUrl: finalUrl,
    };
  } else if (parsedUrl.hostname.toLowerCase().endsWith('ultimate-guitar.com')) {
    result = await importFromUltimateGuitar(text, finalUrl);
  } else {
    result = extractGenericHtmlChords(text, finalUrl);
  }

  // Enrich missing track duration from iTunes / MusicBrainz when title is known
  if (!result.duration && result.title) {
    result.duration = await lookupSongDuration(result.title, result.artist);
  }

  return result;
}
