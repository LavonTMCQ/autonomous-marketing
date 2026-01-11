const path = require('path');
const fs = require('fs');
const { ImageProvider } = require('../providers/imageProvider');
const { VideoProvider } = require('../providers/videoProvider');
const { ContinuityManager } = require('./continuity');
const { loadStylePack } = require('../storage/stylePackStore');
const { ensureProjectDirs } = require('../storage/projectStore');
const { hasFfmpeg, runFfmpeg } = require('../utils/ffmpeg');

const buildPromptSpine = (project, stylePack) => {
  const brand = project.brand_kit || {};
  const voice = brand.brand_voice || {};
  const colors = (brand.colors || []).join(', ');
  const voiceText = `Voice: playful ${voice.playful ?? 0.5}, luxury ${voice.luxury ?? 0.5}, minimal ${voice.minimal ?? 0.5}.`;
  const styleText = stylePack?.prompt_spine ? `Style Pack: ${stylePack.prompt_spine}` : 'Style Pack: none.';
  const colorText = colors ? `Brand colors: ${colors}.` : 'Brand colors: none.';
  return `${voiceText} ${colorText} ${styleText}`.trim();
};

const selectStyleRefs = (stylePack, count = 3) => {
  if (!stylePack?.extracted_ref_images?.length) {
    return [];
  }
  return [...stylePack.extracted_ref_images].sort((a, b) => b.score - a.score).slice(0, count);
};

const cacheStylePackRefs = (projectId, stylePack, refs) => {
  if (!stylePack || !refs.length) {
    return [];
  }
  const cacheDir = path.join(__dirname, '..', '..', 'data', 'projects', projectId, 'assets', 'stylepacks');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return refs.map((ref) => {
    const filename = path.basename(ref.path);
    const destination = path.join(cacheDir, filename);
    if (!fs.existsSync(destination)) {
      fs.copyFileSync(ref.path, destination);
    }
    return { ...ref, cached_path: destination };
  });
};

const generateScriptSections = ({ brief, raw_script }) => {
  if (raw_script) {
    return {
      raw: raw_script,
      sections: splitScriptSections(raw_script),
    };
  }
  const seed = brief || 'Introduce the product, highlight the problem, show the solution, and finish with a CTA.';
  const raw = `Hook: ${seed}\nProblem: The audience struggles with the current workflow.\nSolution: Show how the product solves it with clarity and speed.\nCTA: Invite them to try it today.`;
  return {
    raw,
    sections: splitScriptSections(raw),
  };
};

const splitScriptSections = (raw) => {
  const sections = { hook: '', problem: '', solution: '', cta: '' };
  raw.split('\n').forEach((line) => {
    const [label, ...rest] = line.split(':');
    const content = rest.join(':').trim();
    const key = label.trim().toLowerCase();
    if (sections[key] !== undefined) {
      sections[key] = content;
    }
  });
  return sections;
};

const generateStoryboardShots = (project) => {
  const script = project.script?.sections || {};
  const shotLabels = [
    { id: 'hook', text: script.hook || 'Open with the hook.' },
    { id: 'problem', text: script.problem || 'Highlight the problem.' },
    { id: 'solution', text: script.solution || 'Show the solution.' },
    { id: 'cta', text: script.cta || 'Close with the CTA.' },
  ];
  const duration = project.target_duration || 30;
  const perShot = Math.max(2, Math.round(duration / shotLabels.length));
  return shotLabels.map((shot, index) => ({
    id: `${shot.id}-${index + 1}`,
    order: index + 1,
    duration_sec: perShot,
    keyframe_prompt: `${shot.text} Visualize with marketing polish.`,
    negative_prompt: 'blurry, distorted, low quality',
    on_screen_text: shot.text,
    camera_notes: 'Smooth push-in, steady framing.',
    keyframe_image_path: null,
    keyframe_version: 0,
    video_prompt: `${shot.text} Maintain continuity and brand style.`,
    video_negative_prompt: 'flicker, jitter, low fidelity',
    clip_path: null,
    clip_version: 0,
    continuity: {
      prev_last_frame_path: null,
      first_frame_path: null,
      target_last_frame_path: null,
      last_frame_path: null,
    },
    provider_config: {
      image_provider: null,
      image_model: null,
      image_settings: {},
      video_provider: null,
      video_model: null,
      video_settings: {},
    },
    status: {
      keyframe_status: 'pending',
      clip_status: 'pending',
      error: null,
    },
  }));
};

const generateKeyframesForShots = async (project) => {
  ensureProjectDirs(project.id);
  const stylePack = project.selected_style_pack_id ? loadStylePack(project.selected_style_pack_id) : null;
  const promptSpine = buildPromptSpine(project, stylePack);
  const styleRefs = cacheStylePackRefs(project.id, stylePack, selectStyleRefs(stylePack));
  const imageProvider = new ImageProvider(ImageProvider.defaultConfig());
  const assetsPath = path.join(__dirname, '..', '..', 'data', 'projects', project.id, 'assets', 'keyframes');

  for (const shot of project.shots) {
    const version = shot.keyframe_version + 1;
    const filename = `${shot.id}_v${version}.png`;
    const outputPath = path.join(assetsPath, filename);
    const prompt = `${shot.keyframe_prompt}\n${promptSpine}`;
    await imageProvider.generateImage({
      prompt,
      negativePrompt: shot.negative_prompt,
      outputPath,
      referenceImages: styleRefs.map((ref) => ref.cached_path || ref.path),
    });
    shot.keyframe_version = version;
    shot.keyframe_image_path = outputPath;
    shot.provider_config.image_provider = imageProvider.name;
    shot.provider_config.image_model = imageProvider.model;
    shot.provider_config.image_settings = imageProvider.settings;
    shot.status.keyframe_status = 'ready';
  }

  return project;
};

const generateClipsForShots = async (project) => {
  ensureProjectDirs(project.id);
  const stylePack = project.selected_style_pack_id ? loadStylePack(project.selected_style_pack_id) : null;
  const promptSpine = buildPromptSpine(project, stylePack);
  const styleRefs = cacheStylePackRefs(project.id, stylePack, selectStyleRefs(stylePack));
  const videoProvider = new VideoProvider(VideoProvider.defaultConfig());
  const continuity = new ContinuityManager({ supportsFirstLast: true });

  const clipsPath = path.join(__dirname, '..', '..', 'data', 'projects', project.id, 'assets', 'clips');
  const framesPath = path.join(__dirname, '..', '..', 'data', 'projects', project.id, 'assets', 'frames');

  for (let i = 0; i < project.shots.length; i += 1) {
    const shot = project.shots[i];
    const prevShot = project.shots[i - 1];
    const { firstFramePath, targetLastFramePath } = continuity.resolveFrames({
      previousShot: prevShot,
      currentShot: shot,
    });

    const version = shot.clip_version + 1;
    const filename = `${shot.id}_v${version}.mp4`;
    const outputPath = path.join(clipsPath, filename);
    const prompt = `${shot.video_prompt}\n${promptSpine}`;
    const response = await videoProvider.generateVideo({
      prompt,
      negativePrompt: shot.video_negative_prompt,
      outputPath,
      firstFramePath,
      lastFramePath: targetLastFramePath,
      referenceImages: styleRefs.map((ref) => ref.cached_path || ref.path),
    });
    shot.clip_version = version;
    shot.clip_path = outputPath;
    shot.provider_config.video_provider = videoProvider.name;
    shot.provider_config.video_model = videoProvider.model;
    shot.provider_config.video_settings = videoProvider.settings;
    shot.continuity.prev_last_frame_path = prevShot?.continuity?.last_frame_path || null;
    shot.continuity.first_frame_path = response.firstFramePath || firstFramePath || null;
    shot.continuity.target_last_frame_path = response.lastFramePath || targetLastFramePath || null;

    const frameFile = `${shot.id}_last_v${version}.png`;
    const framePath = path.join(framesPath, frameFile);
    continuity.saveLastFrame({ clipPath: outputPath, framePath });
    shot.continuity.last_frame_path = framePath;
    shot.status.clip_status = 'ready';
  }

  return project;
};

const exportProjectVideo = async (project, options) => {
  ensureProjectDirs(project.id);
  const exportDir = path.join(__dirname, '..', '..', 'data', 'projects', project.id, 'assets', 'exports');
  const filename = `final_v${project.exports.length + 1}.mp4`;
  const outputPath = path.join(exportDir, filename);
  let warning = null;

  const clipPaths = project.shots.map((shot) => shot.clip_path).filter(Boolean);
  if (!clipPaths.length) {
    throw new Error('No clips available for export.');
  }

  if (hasFfmpeg()) {
    const listFile = path.join(exportDir, `concat_${Date.now()}.txt`);
    fs.writeFileSync(listFile, clipPaths.map((clip) => `file '${clip}'`).join('\n'));
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outputPath];
    const result = runFfmpeg(args);
    if (!result.ok) {
      fs.writeFileSync(outputPath, 'export placeholder');
      warning = 'ffmpeg failed: wrote placeholder export';
    }
  } else {
    fs.writeFileSync(outputPath, 'export placeholder');
    warning = 'ffmpeg missing: wrote placeholder export';
  }

  project.exports.push({
    path: outputPath,
    created_at: new Date().toISOString(),
    audio: options?.audio_path || null,
    warning,
  });

  return { project, outputPath, warning };
};

module.exports = {
  generateScriptSections,
  generateStoryboardShots,
  generateKeyframesForShots,
  generateClipsForShots,
  exportProjectVideo,
};
