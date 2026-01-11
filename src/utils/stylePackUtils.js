const fs = require('fs');
const path = require('path');
const { analyzePng, sharpnessScore } = require('./imageUtils');
const { hasFfmpeg, hasFfprobe, runFfmpeg, runFfprobe } = require('./ffmpeg');

const placeholderPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQYV2NkYGD4DwABBAEAkS8hNwAAAABJRU5ErkJggg==',
  'base64'
);

const ensurePlaceholder = (filePath) => {
  fs.writeFileSync(filePath, placeholderPng);
};

const getVideoMetadata = (videoPath) => {
  if (!hasFfprobe()) {
    return { fps: null, aspect_ratio: null };
  }
  const result = runFfprobe([
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate',
    '-of',
    'json',
    videoPath,
  ]);
  if (!result.ok) {
    return { fps: null, aspect_ratio: null };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const stream = parsed.streams?.[0];
    if (!stream) {
      return { fps: null, aspect_ratio: null };
    }
    const [num, den] = (stream.r_frame_rate || '0/1').split('/').map(Number);
    const fps = den ? Number((num / den).toFixed(2)) : null;
    const aspect_ratio = stream.width && stream.height ? `${stream.width}:${stream.height}` : null;
    return { fps, aspect_ratio };
  } catch (error) {
    return { fps: null, aspect_ratio: null };
  }
};

const getVideoDuration = (videoPath) => {
  if (!hasFfprobe()) {
    return null;
  }
  const result = runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', videoPath]);
  if (!result.ok) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const duration = parseFloat(parsed.format?.duration);
    return Number.isNaN(duration) ? null : duration;
  } catch (error) {
    return null;
  }
};

const extractFramesFromVideo = async (videoPath, outputDir) => {
  const frames = [];
  const basename = path.basename(videoPath, path.extname(videoPath));
  if (!hasFfmpeg()) {
    for (let i = 0; i < 5; i += 1) {
      const filename = `${basename}_ref_${i + 1}.png`;
      const outputPath = path.join(outputDir, filename);
      ensurePlaceholder(outputPath);
      frames.push({ path: outputPath, source: videoPath });
    }
    return frames;
  }

  const duration = getVideoDuration(videoPath);
  const offsets = duration ? [0, duration * 0.25, duration * 0.5, duration * 0.75, duration * 0.9] : [0, 1, 2, 3, 4];

  for (let i = 0; i < offsets.length; i += 1) {
    const filename = `${basename}_ref_${i + 1}.png`;
    const outputPath = path.join(outputDir, filename);
    const args = ['-y', '-ss', `${offsets[i]}`, '-i', videoPath, '-vframes', '1', outputPath];
    const result = runFfmpeg(args);
    if (!result.ok) {
      ensurePlaceholder(outputPath);
    }
    frames.push({ path: outputPath, source: videoPath });
  }
  return frames;
};

const analyzeFrameSet = (frames) => {
  const refs = frames.map((frame) => {
    const stats = analyzePng(frame.path);
    const sharpness = sharpnessScore(frame.path);
    return {
      path: frame.path,
      source: frame.source,
      brightness: stats.brightness,
      contrast: stats.contrast,
      palette: stats.palette,
      sharpness,
      score: sharpness + stats.contrast,
    };
  });

  const sorted = [...refs].sort((a, b) => b.score - a.score);
  const topRefs = sorted.slice(0, 3);

  const summary = {
    brightness: refs.length ? average(refs.map((ref) => ref.brightness)) : null,
    contrast: refs.length ? average(refs.map((ref) => ref.contrast)) : null,
    palette: topRefs.flatMap((ref) => ref.palette).slice(0, 5),
    fps: null,
    aspect_ratio: null,
  };

  if (frames.length) {
    const meta = getVideoMetadata(frames[0].source);
    summary.fps = meta.fps;
    summary.aspect_ratio = meta.aspect_ratio;
  }

  return { refs: sorted, summary };
};

const buildPromptSpine = (summary) => {
  const palette = summary.palette?.length ? summary.palette.slice(0, 3).join(', ') : 'neutral tones';
  const brightness = summary.brightness ? Math.round(summary.brightness) : 120;
  const contrast = summary.contrast ? Math.round(summary.contrast) : 30;
  return `Visual style: ${palette} palette, brightness around ${brightness}, contrast around ${contrast}, cinematic framing, polished marketing tone.`;
};

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

module.exports = {
  extractFramesFromVideo,
  analyzeFrameSet,
  buildPromptSpine,
};
