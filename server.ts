import 'dotenv/config';
import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  APP_DIR,
  ASSETS_DIR,
  METRONOMES_DIR,
  STATIC_DIR,
  SAMPLES_DIR,
  TEMP_DIR,
  ADVANCED_STATIC_DIR,
  ADVANCED_TEMP_DIR,
  CHORDS_STATIC_DIR,
  REPO_ROOT,
} from './src/paths.js';
import {
  createCueTrack,
  createCueAudio,
  detectClicksFromFile,
  generateMetronomePreview,
  getAudioInfo,
  mixTracksFfmpeg,
  TrackMixConfig,
} from './src/audioEngine.js';
import { generateSpeechEdge } from './src/tts.js';
import { importChordsFromUrl, lookupSongDuration } from './src/chordImport.js';

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  dest: ADVANCED_TEMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
});

// In-flight cache for voice sample generation
const sampleGenerationLocks = new Map<string, Promise<string>>();

async function whichBinary(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [name]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ==========================================
// Simple Mode Routes
// ==========================================

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// On-demand voice sample generation if not pre-generated
app.get('/static/samples/:filename', async (req: Request, res: Response) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename.endsWith('.mp3')) {
    res.status(404).json({ detail: 'Sample not found' });
    return;
  }

  const voiceId = filename.replace(/\.mp3$/, '');
  if (!/^[a-zA-Z0-9-]+$/.test(voiceId)) {
    res.status(400).json({ detail: 'Invalid voice ID' });
    return;
  }

  const samplePath = path.join(SAMPLES_DIR, filename);
  if (fs.existsSync(samplePath)) {
    res.sendFile(samplePath);
    return;
  }

  try {
    let pending = sampleGenerationLocks.get(voiceId);
    if (!pending) {
      pending = generateSpeechEdge('This is a sample', samplePath, voiceId).finally(() => {
        sampleGenerationLocks.delete(voiceId);
      });
      sampleGenerationLocks.set(voiceId, pending);
    }
    await pending;
    res.sendFile(samplePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ detail: `Failed to generate voice sample: ${msg}` });
  }
});

app.use('/static', express.static(STATIC_DIR));
app.use('/assets', express.static(ASSETS_DIR));

app.post('/generate', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const songName = String(body.songName || '').trim();
  if (!songName) {
    res.status(400).json({ detail: 'songName is required' });
    return;
  }

  const annotation = String(body.annotation || '');
  const bpm = Number(body.bpm);
  const timeSignature = String(body.timeSignature || '4/4');
  const minutes = Number(body.minutes ?? 0);
  const seconds = Number(body.seconds ?? 0);
  const voice = String(body.voice || 'en-US-SteffanNeural');
  const sound = String(body.sound || 'Synth_Block_A_lo.wav');
  const panning = Number(body.panning ?? 0);

  if (!Number.isFinite(bpm) || bpm <= 0) {
    res.status(400).json({ detail: 'Valid BPM is required' });
    return;
  }

  const durationSeconds = Math.max(1, minutes * 60 + seconds);
  const fileId = crypto.randomUUID();
  const outputPath = path.join(TEMP_DIR, `${fileId}.mp3`);

  try {
    await createCueTrack({
      songName,
      annotation,
      bpm,
      timeSignature,
      durationSeconds,
      voiceId: voice,
      soundType: sound,
      panning: Number.isFinite(panning) ? panning : 0,
      outputPath,
    });

    const downloadName = `${songName.replace(/[^a-zA-Z0-9_-]+/g, '_')}_cue.mp3`;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.sendFile(outputPath, (err) => {
      fs.promises.unlink(outputPath).catch(() => {});
      if (err && !res.headersSent) {
        res.status(500).json({ detail: err.message });
      }
    });
  } catch (err) {
    fs.promises.unlink(outputPath).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    console.error('GENERATE ERROR:', err);
    res.status(500).json({ detail: msg });
  }
});

// ==========================================
// Advanced Mode Routes
// ==========================================

const advancedRouter = express.Router();

// Ensure /advanced (without trailing slash) redirects to /advanced/ so relative paths like 'static/voices.json' resolve properly
app.use((req: Request, res: Response, next) => {
  const pathOnly = req.originalUrl.split('?')[0];
  if (pathOnly === '/advanced') {
    res.redirect(301, '/advanced/');
    return;
  }
  next();
});

advancedRouter.get('/', (_req: Request, res: Response) => {
  const indexPath = path.join(ADVANCED_STATIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Advanced Mode interface not found.');
  }
});

advancedRouter.use('/static', express.static(ADVANCED_STATIC_DIR));
advancedRouter.use('/temp', express.static(ADVANCED_TEMP_DIR));

advancedRouter.get('/api/debug-paths', async (_req: Request, res: Response) => {
  try {
    const mExists = fs.existsSync(METRONOMES_DIR);
    const mFiles = mExists ? fs.readdirSync(METRONOMES_DIR) : [];
    const [ffmpegPath, ffprobePath] = await Promise.all([
      whichBinary('ffmpeg'),
      whichBinary('ffprobe'),
    ]);

    res.json({
      cwd: process.cwd(),
      repo_root: REPO_ROOT,
      app_dir: APP_DIR,
      metronomes_dir: METRONOMES_DIR,
      metronomes_exists: mExists,
      metronome_count: mFiles.length,
      sample_files: mFiles.slice(0, 10),
      assets_dir_const: METRONOMES_DIR,
      ffmpeg: ffmpegPath,
      ffprobe: ffprobePath,
      wav_discovery: [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ error: msg });
  }
});

advancedRouter.post('/api/generate-cue', async (req: Request, res: Response) => {
  try {
    const text = String(req.body?.text || '').trim();
    const voiceId = String(req.body?.voice_id || '');
    if (!text) {
      res.status(400).json({ detail: 'Cue text is required' });
      return;
    }

    const { durationMs, path: tempPath } = await createCueAudio(text, voiceId);
    const filename = path.basename(tempPath);

    res.json({
      url: `/advanced/temp/${filename}`,
      duration_ms: durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ detail: msg });
  }
});

advancedRouter.post(
  '/api/analyze-click',
  upload.single('file'),
  async (req: Request, res: Response) => {
    const uploadedFile = req.file;
    if (!uploadedFile) {
      res.status(400).json({ detail: 'Audio file is required' });
      return;
    }

    try {
      const bpm = Number(req.body?.bpm);
      const soundType = path.basename(String(req.body?.sound_type || '').trim());
      if (!Number.isFinite(bpm) || bpm <= 0) {
        res.status(400).json({ detail: 'Valid BPM is required' });
        return;
      }

      const clickSoundPath = path.resolve(METRONOMES_DIR, soundType);
      if (!clickSoundPath.startsWith(METRONOMES_DIR + path.sep) || !fs.existsSync(clickSoundPath)) {
        res.status(404).json({ detail: `Metronome sound '${soundType}' not found.` });
        return;
      }

      const clicks = await detectClicksFromFile(uploadedFile.path, bpm);
      const { duration } = await getAudioInfo(uploadedFile.path);
      const durationMs = Math.floor(duration * 1000);

      const fileId = crypto.randomUUID();
      const previewFilename = `preview_${fileId}.mp3`;
      const previewPath = path.join(ADVANCED_TEMP_DIR, previewFilename);

      await generateMetronomePreview(clicks, clickSoundPath, durationMs, previewPath);

      res.json({
        clicks,
        preview_url: `/advanced/temp/${previewFilename}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ detail: msg });
    } finally {
      if (uploadedFile.path && fs.existsSync(uploadedFile.path)) {
        fs.promises.unlink(uploadedFile.path).catch(() => {});
      }
    }
  }
);

interface ExportTrackInput {
  filename: string;
  pan?: number;
  volume?: number;
  mute?: boolean;
  replaceClicks?: number[] | null;
  selectedSound?: string | null;
}

interface ExportCueInput {
  text: string;
  voice_id?: string;
  endTime: number;
}

advancedRouter.post(
  '/api/export-mix',
  upload.array('files'),
  async (req: Request, res: Response) => {
    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    const tempAssetsToCleanup: string[] = uploadedFiles.map((f) => f.path);

    try {
      const tracksData: ExportTrackInput[] = JSON.parse(String(req.body?.tracks_json || '[]'));
      const cuesData: ExportCueInput[] = JSON.parse(String(req.body?.cues_json || '[]'));

      const trackMap = new Map<string, string>();
      for (const file of uploadedFiles) {
        trackMap.set(file.originalname, file.path);
      }

      const tracksToMix: TrackMixConfig[] = [];

      for (const trackInfo of tracksData) {
        const mappedPath = trackMap.get(trackInfo.filename);
        if (!mappedPath) continue;

        let trackPath = mappedPath;
        if (trackInfo.replaceClicks && Array.isArray(trackInfo.replaceClicks)) {
          const { duration } = await getAudioInfo(trackPath);
          const safeSound = path.basename(trackInfo.selectedSound || 'Perc_Stick_hi.wav');
          const clickSoundPath = path.join(METRONOMES_DIR, safeSound);
          const resolvedClickSound = fs.existsSync(clickSoundPath)
            ? clickSoundPath
            : path.join(METRONOMES_DIR, 'Perc_Stick_hi.wav');

          const metronomePath = path.join(
            ADVANCED_TEMP_DIR,
            `metronome_mix_${crypto.randomUUID()}.mp3`
          );
          await generateMetronomePreview(
            trackInfo.replaceClicks,
            resolvedClickSound,
            Math.floor(duration * 1000),
            metronomePath
          );
          trackPath = metronomePath;
          tempAssetsToCleanup.push(metronomePath);
        }

        tracksToMix.push({
          path: trackPath,
          pan: trackInfo.pan ?? 0.0,
          volume: trackInfo.volume ?? 1.0,
          mute: Boolean(trackInfo.mute),
        });
      }

      for (const cue of cuesData) {
        const { durationMs, path: cuePath } = await createCueAudio(cue.text, cue.voice_id);
        tracksToMix.push({
          path: cuePath,
          pan: 0.0,
          volume: 1.0,
          mute: false,
          offset_ms: Math.max(0, Math.floor(cue.endTime * 1000) - durationMs),
        });
        tempAssetsToCleanup.push(cuePath);
      }

      const outputPath = path.join(ADVANCED_TEMP_DIR, `mix_${crypto.randomUUID()}.mp3`);
      await mixTracksFfmpeg(tracksToMix, outputPath);

      for (const f of tempAssetsToCleanup) {
        if (fs.existsSync(f)) {
          await fs.promises.unlink(f).catch(() => {});
        }
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', 'attachment; filename="final_mix.mp3"');
      res.sendFile(outputPath, (err) => {
        fs.promises.unlink(outputPath).catch(() => {});
        if (err && !res.headersSent) {
          res.status(500).json({ detail: err.message });
        }
      });
    } catch (err) {
      for (const f of tempAssetsToCleanup) {
        if (fs.existsSync(f)) {
          await fs.promises.unlink(f).catch(() => {});
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Export Error:', msg);
      res.status(500).json({ detail: msg });
    }
  }
);

app.use('/advanced', advancedRouter);

// ==========================================
// Chord Converter Routes
// ==========================================

app.use((req: Request, res: Response, next) => {
  const pathOnly = req.originalUrl.split('?')[0];
  if (pathOnly === '/chords') {
    res.redirect(301, '/chords/');
    return;
  }
  next();
});

const chordsRouter = express.Router();
chordsRouter.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(CHORDS_STATIC_DIR, 'index.html'));
});
chordsRouter.post('/api/import-url', async (req: Request, res: Response) => {
  const rawUrl = String(req.body?.url || '').trim();
  if (!rawUrl) {
    res.status(400).json({ detail: 'URL is required.' });
    return;
  }

  try {
    const result = await importChordsFromUrl(rawUrl);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(422).json({ detail: msg });
  }
});
chordsRouter.post('/api/lookup-meta', async (req: Request, res: Response) => {
  const title = String(req.body?.title || '').trim();
  const artist = String(req.body?.artist || '').trim();
  if (!title) {
    res.json({ duration: '' });
    return;
  }
  try {
    const duration = await lookupSongDuration(title, artist);
    res.json({ duration });
  } catch {
    res.json({ duration: '' });
  }
});
chordsRouter.use('/static', express.static(CHORDS_STATIC_DIR));

app.use('/chords', chordsRouter);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cue Track Generator server listening on http://0.0.0.0:${PORT}`);
});
