import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..');
export const APP_DIR = path.join(REPO_ROOT, 'app');

// Core Directories
export const ASSETS_DIR = path.join(APP_DIR, 'assets');
export const METRONOMES_DIR = path.join(ASSETS_DIR, 'metronomes');
export const STATIC_DIR = path.join(APP_DIR, 'static');
export const SAMPLES_DIR = path.join(STATIC_DIR, 'samples');
export const TEMP_DIR = path.join(APP_DIR, 'temp');

// Advanced Mode Directories
export const ADVANCED_DIR = path.join(APP_DIR, 'advanced');
export const ADVANCED_STATIC_DIR = path.join(ADVANCED_DIR, 'static');
export const ADVANCED_TEMP_DIR = path.join(ADVANCED_DIR, 'temp');

// Chord Converter Directories
export const CHORDS_DIR = path.join(APP_DIR, 'chords');
export const CHORDS_STATIC_DIR = path.join(CHORDS_DIR, 'static');

export function ensureDirs(): void {
  fs.mkdirSync(METRONOMES_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(ADVANCED_TEMP_DIR, { recursive: true });
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
}

ensureDirs();
