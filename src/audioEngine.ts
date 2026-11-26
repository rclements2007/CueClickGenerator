import { execFile, spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { generateSpeech, DEFAULT_ADVANCED_VOICE_ID } from './tts.js';
import {
  ASSETS_DIR,
  METRONOMES_DIR,
  TEMP_DIR,
  ADVANCED_TEMP_DIR,
} from './paths.js';

const execFileAsync = promisify(execFile);

function resolveBinary(candidate: string | null | undefined, envOverride: string | undefined, fallback: string): string {
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
  if (candidate && fs.existsSync(candidate)) {
    try {
      fs.chmodSync(candidate, 0o755);
    } catch {
      // ignore chmod errors on read-only filesystems
    }
    return candidate;
  }
  return fallback;
}

export const FFMPEG_BIN = resolveBinary(ffmpegStatic, process.env.FFMPEG_PATH, 'ffmpeg');
export const FFPROBE_BIN = resolveBinary(ffprobeStatic?.path, process.env.FFPROBE_PATH, 'ffprobe');

export interface AudioInfo {
  duration: number;
  sampleRate: number;
}

export interface TrackMixConfig {
  path: string;
  pan?: number;
  volume?: number;
  mute?: boolean;
  offset_ms?: number;
}

export type ClickItem = number | [number, boolean];

export async function getAudioInfo(filepath: string): Promise<AudioInfo> {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=sample_rate',
      '-of', 'json',
      filepath,
    ]);
    const data = JSON.parse(stdout);
    const duration = parseFloat(data?.format?.duration ?? '0') || 0;
    const streams = Array.isArray(data?.streams) ? data.streams : [];
    const sampleRate = streams.length > 0
      ? parseInt(String(streams[0]?.sample_rate ?? '44100'), 10) || 44100
      : 44100;
    return { duration, sampleRate };
  } catch {
    return { duration: 0, sampleRate: 44100 };
  }
}

export async function stripSilenceFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
    '-y', '-v', 'error', '-i', inputPath,
    '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse',
    outputPath,
  ]);
}

async function decodeToMonoPcm(soundPath: string): Promise<Int16Array> {
  const { stdout } = await execFileAsync(
    FFMPEG_BIN,
    [
      '-v', 'error',
      '-i', soundPath,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', '44100',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 }
  );
  const alignedLength = stdout.length - (stdout.length % 2);
  return new Int16Array(stdout.buffer, stdout.byteOffset, alignedLength / 2);
}

export async function generateMetronomeFile(
  clicks: ClickItem[],
  soundPath: string,
  durationMs: number,
  outputPath: string,
  accentSoundPath?: string | null
): Promise<void> {
  const clickPcm = await decodeToMonoPcm(soundPath);
  let accentPcm = clickPcm;

  if (accentSoundPath && fs.existsSync(accentSoundPath)) {
    try {
      const res = await decodeToMonoPcm(accentSoundPath);
      if (res.length > 0) {
        accentPcm = res;
      }
    } catch {
      // Fallback to standard click sound
    }
  }

  const sampleRate = 44100;
  const totalSamples = Math.floor((durationMs / 1000.0) * sampleRate);

  const ffmpegProc = spawn(FFMPEG_BIN, [
    '-y', '-v', 'error',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', '1',
    '-i', 'pipe:0',
    '-acodec', 'libmp3lame', '-b:a', '192k',
    outputPath,
  ]);

  let stderrData = '';
  ffmpegProc.stderr?.on('data', (d) => {
    stderrData += d.toString();
  });

  const exitPromise = new Promise<void>((resolve, reject) => {
    ffmpegProc.on('error', reject);
    ffmpegProc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg metronome exited with code ${code}: ${stderrData}`));
    });
  });

  const chunkSamples = sampleRate * 5; // 5-second chunks
  for (let startIdx = 0; startIdx < totalSamples; startIdx += chunkSamples) {
    const endIdx = Math.min(startIdx + chunkSamples, totalSamples);
    const chunk = new Int16Array(endIdx - startIdx);

    for (const item of clicks) {
      let ts: number;
      let isAccent: boolean;
      if (Array.isArray(item)) {
        ts = item[0];
        isAccent = item[1];
      } else {
        ts = item;
        isAccent = false;
      }

      const pcmData = isAccent ? accentPcm : clickPcm;
      const clickStartSample = Math.floor((ts / 1000.0) * sampleRate);
      const clickEndSample = clickStartSample + pcmData.length;

      const overlapStart = Math.max(clickStartSample, startIdx);
      const overlapEnd = Math.min(clickEndSample, endIdx);

      if (overlapStart < overlapEnd) {
        const chunkOffset = overlapStart - startIdx;
        const clickOffset = overlapStart - clickStartSample;
        const length = overlapEnd - overlapStart;

        for (let j = 0; j < length; j++) {
          const sum = chunk[chunkOffset + j] + pcmData[clickOffset + j];
          chunk[chunkOffset + j] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
        }
      }
    }

    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (!ffmpegProc.stdin.write(buf)) {
      await once(ffmpegProc.stdin, 'drain');
    }
  }

  ffmpegProc.stdin.end();
  await exitPromise;
}

export async function mixTracksFfmpeg(
  tracksInfo: TrackMixConfig[],
  outputPath: string
): Promise<void> {
  const activeTracks = tracksInfo.filter((t) => !t.mute);
  if (activeTracks.length === 0) {
    await execFileAsync(FFMPEG_BIN, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'anullsrc',
      '-t', '1',
      '-acodec', 'libmp3lame', '-b:a', '192k',
      outputPath,
    ]);
    return;
  }

  const inputs: string[] = [];
  let filterComplex = '';

  activeTracks.forEach((track, i) => {
    inputs.push('-i', track.path);
    const offset = track.offset_ms ?? 0;
    const vol = track.volume ?? 1.0;
    const pan = track.pan ?? 0.0;
    const label = `[a${i}]`;

    const filters: string[] = [];
    if (offset > 0) {
      filters.push(`adelay=${Math.round(offset)}|${Math.round(offset)}`);
    }
    if (vol !== 1.0) {
      filters.push(`volume=${vol}`);
    }
    const lGain = Math.max(0, Math.min(1, 1.0 - (pan + 1) / 2)) * 2;
    const rGain = Math.max(0, Math.min(1, (pan + 1) / 2)) * 2;
    filters.push(`pan=stereo|c0=${lGain}*c0|c1=${rGain}*c1`);
    filters.push('aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo');
    filterComplex += `[${i}:a]${filters.join(',')}${label};`;
  });

  const labels = activeTracks.map((_, i) => `[a${i}]`).join('');
  filterComplex += `${labels}amix=inputs=${activeTracks.length}:duration=longest:dropout_transition=0[out]`;

  await execFileAsync(FFMPEG_BIN, [
    '-y', '-v', 'error',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-acodec', 'libmp3lame', '-b:a', '192k',
    outputPath,
  ]);
}

export interface CreateCueTrackParams {
  songName: string;
  annotation?: string;
  bpm: number;
  durationSeconds: number;
  soundType: string;
  voiceId: string;
  panning: number;
  outputPath: string;
  timeSignature?: string;
}

function synthesizeClickWavBuffer(soundFilename: string): Buffer {
  const sampleRate = 44100;
  const lower = soundFilename.toLowerCase();
  const isHi = lower.includes('_hi');
  const durationSec = lower.includes('bell') || lower.includes('whistle') ? 0.09 : 0.045;
  const numSamples = Math.floor(sampleRate * durationSec);

  let hash = 0;
  for (let i = 0; i < soundFilename.length; i++) {
    hash = (hash * 31 + soundFilename.charCodeAt(i)) >>> 0;
  }

  let baseFreq = isHi ? 1320 : 880;
  if (lower.includes('block')) baseFreq = isHi ? 1280 : 860;
  else if (lower.includes('bell')) baseFreq = isHi ? 1760 : 1175;
  else if (lower.includes('whistle')) baseFreq = isHi ? 2400 : 1850;
  else if (lower.includes('tick') || lower.includes('quartz')) baseFreq = isHi ? 1600 : 1050;
  else if (lower.includes('perc_') && !lower.includes('stick')) baseFreq = isHi ? 1150 : 720;
  else baseFreq += (hash % 7) * 35;

  const useSquare = lower.includes('square');
  const usePercNoise = lower.includes('clap') || lower.includes('tamb') || lower.includes('perc_');
  const decayRate = lower.includes('bell') ? 38 : 75;

  const dataSize = numSamples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // Mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  let seed = hash || 1337;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const attack = t < 0.0015 ? t / 0.0015 : 1.0;
    const env = attack * Math.exp(-decayRate * t);
    let sampleVal = Math.sin(2 * Math.PI * baseFreq * t);
    if (useSquare) {
      sampleVal = sampleVal >= 0 ? 0.75 : -0.75;
    } else if (lower.includes('bell')) {
      sampleVal = 0.7 * sampleVal + 0.3 * Math.sin(2 * Math.PI * baseFreq * 2.02 * t);
    } else if (usePercNoise) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = ((seed & 0xffff) / 32768.0 - 1.0) * Math.exp(-95 * t);
      sampleVal = 0.65 * sampleVal + 0.35 * noise;
    }
    const clamped = Math.max(-1, Math.min(1, sampleVal * env * 0.85));
    wav.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return wav;
}

export function ensureMetronomeSound(soundFileOrName: string): string {
  const safeName = path.basename((soundFileOrName || '').trim()) || 'Synth_Block_A_lo.wav';
  const finalName = safeName.endsWith('.wav') ? safeName : `${safeName}.wav`;
  const targetPath = path.join(METRONOMES_DIR, finalName);
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  fs.mkdirSync(METRONOMES_DIR, { recursive: true });
  const wavBuf = synthesizeClickWavBuffer(finalName);
  fs.writeFileSync(targetPath, wavBuf);
  return targetPath;
}

export function resolveMetronomePath(soundType: string): string {
  const safeName = path.basename((soundType || '').trim()) || 'Synth_Block_A_lo.wav';
  return ensureMetronomeSound(safeName);
}

export async function createCueTrack({
  songName,
  annotation = '',
  bpm,
  durationSeconds,
  soundType,
  voiceId,
  panning,
  outputPath,
  timeSignature = '4/4',
}: CreateCueTrackParams): Promise<string> {
  const requestId = crypto.randomUUID();
  const tempFiles: string[] = [];

  try {
    let clickPath = resolveMetronomePath(soundType);
    let accentClickPath: string | null = null;

    if (timeSignature === '6/8') {
      const filename = path.basename(clickPath);
      if (filename.includes('_lo.wav')) {
        accentClickPath = ensureMetronomeSound(filename.replace('_lo.wav', '_hi.wav'));
      } else if (filename.includes('_hi.wav')) {
        accentClickPath = clickPath;
        clickPath = ensureMetronomeSound(filename.replace('_hi.wav', '_lo.wav'));
      }
    }

    const beatMs = 60000 / bpm;

    let beatsPerMeasure = 4;
    let countdownSequence = ['3', '2', '1', 'go'];

    if (timeSignature === '3/4') {
      beatsPerMeasure = 3;
      countdownSequence = ['1', '2', '3', '1', '2', 'go'];
    } else if (timeSignature === '6/8') {
      beatsPerMeasure = 6;
      countdownSequence = ['ONE!', '2', '3', 'FOUR!', '5', '6'];
    } else if (timeSignature === '8/8') {
      beatsPerMeasure = 8;
      countdownSequence = ['5', '6', '7', '8'];
    }

    // 1. Intro Speech
    const introText = `${songName}.` + (annotation ? ` ${annotation}.` : '');
    const rawIntroPath = path.join(TEMP_DIR, `raw_intro_${requestId}.mp3`);
    const introPath = path.join(TEMP_DIR, `intro_${requestId}.mp3`);
    await generateSpeech(introText, rawIntroPath, voiceId);
    await stripSilenceFfmpeg(rawIntroPath, introPath);
    tempFiles.push(rawIntroPath, introPath);

    const { duration: introDur } = await getAudioInfo(introPath);
    const beatsForIntro = Math.ceil((introDur * 1000) / beatMs);
    const introMeasures = Math.max(1, Math.ceil(beatsForIntro / beatsPerMeasure));
    const introBeats = introMeasures * beatsPerMeasure;
    const introDurationMs = introBeats * beatMs;

    // 2. Countdown Speech
    const countdownPaths: string[] = [];
    for (let idx = 0; idx < countdownSequence.length; idx++) {
      const c = countdownSequence[idx];
      const cClean = c.toLowerCase().replace(/!/g, '');
      const assetPath = path.join(ASSETS_DIR, `count_${cClean}.mp3`);
      if (fs.existsSync(assetPath)) {
        countdownPaths.push(assetPath);
      } else {
        const countPath = path.join(TEMP_DIR, `count_${cClean}_${idx}_${requestId}.mp3`);
        const rawPath = path.join(TEMP_DIR, `raw_count_${cClean}_${idx}_${requestId}.mp3`);
        await generateSpeech(c, rawPath, voiceId);
        await stripSilenceFfmpeg(rawPath, countPath);
        tempFiles.push(rawPath, countPath);
        countdownPaths.push(countPath);
      }
    }

    // 3. Assemble components
    const numCountdownBeats = countdownSequence.length;
    const tracksToMix: TrackMixConfig[] = [
      { path: introPath, volume: 1.0, pan: panning, offset_ms: 0 },
    ];

    for (let i = 0; i < countdownSequence.length; i++) {
      const cText = countdownSequence[i];
      const cPath = countdownPaths[i];
      const cVol = cText.includes('!') ? 1.3 : 1.0;
      tracksToMix.push({
        path: cPath,
        volume: cVol,
        pan: panning,
        offset_ms: Math.floor(introDurationMs + i * beatMs),
      });
    }

    const allClicks: ClickItem[] = [];
    const totalMainBeats = Math.ceil((durationSeconds * 1000) / beatMs);
    const mainStartMs = introDurationMs + numCountdownBeats * beatMs;

    if (timeSignature === '6/8' && accentClickPath) {
      for (let i = 0; i < introBeats; i++) {
        allClicks.push([i * beatMs, i % 6 === 0 || i % 6 === 3]);
      }
      for (let i = 0; i < numCountdownBeats; i++) {
        allClicks.push([introDurationMs + i * beatMs, i % 6 === 0 || i % 6 === 3]);
      }
      for (let i = 0; i < totalMainBeats; i++) {
        allClicks.push([mainStartMs + i * beatMs, i % 6 === 0 || i % 6 === 3]);
      }
    } else {
      for (let i = 0; i < introBeats; i++) allClicks.push(i * beatMs);
      for (let i = 0; i < numCountdownBeats; i++) allClicks.push(introDurationMs + i * beatMs);
      for (let i = 0; i < totalMainBeats; i++) allClicks.push(mainStartMs + i * beatMs);
    }

    const totalDurMs = mainStartMs + totalMainBeats * beatMs;
    const metronomePath = path.join(TEMP_DIR, `metronome_${requestId}.mp3`);
    await generateMetronomeFile(allClicks, clickPath, totalDurMs, metronomePath, accentClickPath);
    tempFiles.push(metronomePath);
    tracksToMix.push({ path: metronomePath, volume: 1.0, pan: panning, offset_ms: 0 });

    await mixTracksFfmpeg(tracksToMix, outputPath);
    return outputPath;
  } finally {
    for (const f of tempFiles) {
      if (fs.existsSync(f) && !f.includes(`app${path.sep}assets`)) {
        fs.promises.unlink(f).catch(() => {});
      }
    }
  }
}

export async function createCueAudio(
  text: string,
  voiceId?: string
): Promise<{ durationMs: number; path: string }> {
  const fileId = crypto.randomUUID();
  const rawPath = path.join(ADVANCED_TEMP_DIR, `raw_cue_${fileId}.mp3`);
  const cuePath = path.join(ADVANCED_TEMP_DIR, `cue_${fileId}.mp3`);

  await generateSpeech(text, rawPath, voiceId, DEFAULT_ADVANCED_VOICE_ID);
  await stripSilenceFfmpeg(rawPath, cuePath);

  const { duration } = await getAudioInfo(cuePath);
  if (fs.existsSync(rawPath)) {
    await fs.promises.unlink(rawPath).catch(() => {});
  }
  return { durationMs: Math.floor(duration * 1000), path: cuePath };
}

export async function detectClicksFromFile(filepath: string, bpm: number): Promise<number[]> {
  const { sampleRate } = await getAudioInfo(filepath);
  const beatMs = 60000 / bpm;
  const minGapSamples = Math.floor((beatMs * 0.5) * (sampleRate / 1000));

  const clicks: number[] = [];
  let lastClickSample = -minGapSamples;
  let globalSampleIndex = 0;
  let threshold = 0;

  const ffmpegProc = spawn(FFMPEG_BIN, [
    '-v', 'quiet',
    '-i', filepath,
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1',
    'pipe:1',
  ]);

  let leftoverByte: number | null = null;

  for await (const rawChunk of ffmpegProc.stdout) {
    let chunkBuf = rawChunk as Buffer;
    if (leftoverByte !== null) {
      chunkBuf = Buffer.concat([Buffer.from([leftoverByte]), chunkBuf]);
      leftoverByte = null;
    }
    if (chunkBuf.length % 2 !== 0) {
      leftoverByte = chunkBuf[chunkBuf.length - 1];
      chunkBuf = chunkBuf.subarray(0, chunkBuf.length - 1);
    }
    if (chunkBuf.length === 0) continue;

    const sampleCount = chunkBuf.length / 2;
    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = chunkBuf.readInt16LE(i * 2);
    }

    let localPeak = 0;
    for (let i = 0; i < sampleCount; i++) {
      const absVal = Math.abs(samples[i]);
      if (absVal > localPeak) localPeak = absVal;
    }

    if (localPeak > threshold) {
      threshold = localPeak * 0.4;
    } else if (threshold === 0) {
      threshold = 5000;
    }

    for (let i = 0; i < sampleCount; i++) {
      if (Math.abs(samples[i]) > threshold) {
        const currentGlobalIdx = globalSampleIndex + i;
        if (currentGlobalIdx - lastClickSample > minGapSamples) {
          const windowEnd = Math.min(i + 500, sampleCount);
          let localPeakIdx = 0;
          let maxWindowVal = -1;
          for (let w = i; w < windowEnd; w++) {
            const val = Math.abs(samples[w]);
            if (val > maxWindowVal) {
              maxWindowVal = val;
              localPeakIdx = w - i;
            }
          }
          const actualGlobalIdx = currentGlobalIdx + localPeakIdx;
          clicks.push(Math.floor((actualGlobalIdx * 1000) / sampleRate));
          lastClickSample = actualGlobalIdx;
        }
      }
    }

    globalSampleIndex += sampleCount;
  }

  await new Promise<void>((resolve) => {
    ffmpegProc.on('close', () => resolve());
    ffmpegProc.on('error', () => resolve());
  });

  return clicks;
}

export async function generateMetronomePreview(
  clicks: number[],
  soundPath: string,
  durationMs: number,
  outputPath: string
): Promise<void> {
  await generateMetronomeFile(clicks, soundPath, durationMs, outputPath);
}
