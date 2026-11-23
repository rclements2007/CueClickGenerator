# Cue Track Generator

A web application to generate metronome cue tracks with AI-spoken song titles and countdowns.

## Local Setup

1. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```
2. **Install FFmpeg**: Ensure FFmpeg is installed on your system (required for audio processing).
3. **API Key**: Create a `.env` file in the root directory and add your ElevenLabs API key:
   ```env
   ELEVENLABS_API_KEY=your_key_here
   ```
4. **Start the server**:
   ```bash
   export PYTHONPATH=$PYTHONPATH:.
   python app/main.py
   ```
5. **Access the app**: Open `http://localhost:8000` in your browser.

## Deploying to Render

This project is configured for easy deployment to **Render** using the provided `Dockerfile` and `render.yaml`.

1. **Create a new Web Service**: Connect your GitHub repository to Render.
2. **Environment Variables**: In the Render dashboard, go to the **Environment** tab and add:
   - `ELEVENLABS_API_KEY`: Your ElevenLabs API key.
   - `ELEVENLABS_VOICE_ID`: (Optional) The unique alphanumeric **Voice ID** from your ElevenLabs dashboard (e.g., `pNInz6obpg8ndclK7Ab3` for Adam).
3. **Deployment**: Render will detect the `Dockerfile` and `render.yaml` to build and deploy the application automatically.

## Features

- Dynamic BPM and duration.
- AI Voice intro (Song Name + Annotation).
- Beat-synchronized "3, 2, 1, Go" countdown.
- Selectable metronome sounds.
