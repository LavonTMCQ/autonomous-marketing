# Marketing Video Studio (Local MVP)

A beginner-friendly local web app that turns a short brief into a storyboard, keyframes, clips, and a stitched export. It also includes a **Level 1 Style Library** so you can build reusable Style Packs from example videos.

## Features
- Stepper-based storyboard workflow: New Project → Brand Kit → Script → Storyboard → Clips → Export.
- Local project persistence with reproducible `project.json` and deterministic asset paths.
- Style Packs: add example videos, extract reference frames + metadata, and apply a prompt spine across generations.
- Provider adapters (image + video) are swappable via config and environment variables.

## Quickstart (Beginner)
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the app:
   ```bash
   npm start
   ```
3. Open `http://localhost:3000`.
4. Create a project in the stepper and follow each step to generate keyframes, clips, and an export.

## Environment Setup
Set environment variables for providers (the adapters read from env or config files you add later):

- `GEMINI_API_KEY` – used by the image/video adapters when you swap the placeholders for real calls.

## ffmpeg (Required for real exports)
Install ffmpeg to enable frame extraction and video stitching.

- macOS: `brew install ffmpeg`
- Ubuntu: `sudo apt-get install ffmpeg`
- Windows: download from [ffmpeg.org](https://ffmpeg.org/download.html)

If ffmpeg is not available, the app will still run and generate placeholder files.

## Project Storage Layout
Each project lives under `data/projects/<projectId>` with a stable folder layout:

```
project.json
assets/
  brand/
  refs/
  stylepacks/
  keyframes/
  clips/
  frames/
  exports/
```

## Style Packs
Style Packs are stored under `data/StylePacks/<packId>`:

```
videos/
refs/
pack.json
```

The `pack.json` stores metadata (brightness, contrast, palette), extracted reference frames, and a reusable prompt spine you can edit in the UI.

## Extending Providers
Adapters live in `src/providers`. Replace placeholder image/video generation with real provider calls (Gemini/Veo, Kling, etc.) without touching UI logic.
