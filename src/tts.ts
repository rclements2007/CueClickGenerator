import fs from 'fs';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const DEFAULT_VOICE_ID = 'en-US-SteffanNeural';
export const DEFAULT_ADVANCED_VOICE_ID = 'en-US-BrianNeural';

export async function generateSpeechEdge(
  text: string,
  outputPath: string,
  requestedVoiceId?: string
): Promise<string> {
  const voice =
    requestedVoiceId && requestedVoiceId.startsWith('en-US-')
      ? requestedVoiceId
      : 'en-US-BrianNeural';

  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const audioBuffer = Buffer.concat(chunks);
    if (audioBuffer.length === 0) {
      throw new Error('Edge TTS returned empty audio stream');
    }
    await fs.promises.writeFile(outputPath, audioBuffer);
    return outputPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Edge TTS generation failed for voice '${voice}' and text '${text}': ${msg}`);
    throw new Error(`Edge TTS voice generation failed: ${msg}`);
  } finally {
    try {
      tts.close();
    } catch {
      // ignore close errors
    }
  }
}

export async function generateSpeech(
  text: string,
  outputPath: string,
  voiceId?: string,
  defaultVoiceId: string = DEFAULT_VOICE_ID
): Promise<string> {
  const selectedVoice = voiceId || process.env.ELEVENLABS_VOICE_ID || defaultVoiceId;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (selectedVoice.startsWith('en-US-') || !apiKey) {
    await generateSpeechEdge(text, outputPath, selectedVoice);
    return outputPath;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(selectedVoice)}`;

  try {
    console.log(`Calling ElevenLabs with Voice ID: ${selectedVoice}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      const arrayBuf = await response.arrayBuffer();
      await fs.promises.writeFile(outputPath, Buffer.from(arrayBuf));
      return outputPath;
    } else {
      const errText = await response.text();
      console.error(`ElevenLabs error (${response.status}): ${errText}`);
    }
  } catch (err) {
    console.error('ElevenLabs request failed:', err);
  }

  console.log(`Falling back to Edge TTS for text: ${text}`);
  await generateSpeechEdge(text, outputPath, selectedVoice);
  return outputPath;
}
