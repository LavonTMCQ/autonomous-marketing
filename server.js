const express = require('express');
const path = require('path');
const multer = require('multer');
const { nanoid } = require('nanoid');
const {
  createProject,
  loadProject,
  saveProject,
  listProjects,
} = require('./src/storage/projectStore');
const {
  createStylePack,
  listStylePacks,
  loadStylePack,
  saveStylePack,
  ensureStylePackDirs,
  processStylePackVideos,
} = require('./src/storage/stylePackStore');
const {
  generateScriptSections,
  generateStoryboardShots,
  generateKeyframesForShots,
  generateClipsForShots,
  generateKeyframeForShot,
  generateClipForShot,
  applyKeyframeVersion,
  applyClipVersion,
  ensureShotHistory,
  exportProjectVideo,
} = require('./src/core/pipeline');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'data', 'uploads') });

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects() });
});

app.post('/api/projects', (req, res) => {
  const projectId = nanoid(10);
  const project = createProject(projectId, req.body);
  res.status(201).json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(project);
});

app.post('/api/projects/:id/brand-kit', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  project.brand_kit = req.body;
  saveProject(project);
  res.json(project);
});

app.post('/api/projects/:id/script', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const { brief, raw_script } = req.body;
  const sections = generateScriptSections({ brief, raw_script });
  project.script = { raw: sections.raw, sections: sections.sections };
  saveProject(project);
  res.json(project.script);
});

app.post('/api/projects/:id/storyboard', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  project.shots = generateStoryboardShots(project);
  saveProject(project);
  res.json({ shots: project.shots });
});

app.post('/api/projects/:id/settings', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (req.body.selected_style_pack_id !== undefined) {
    project.selected_style_pack_id = req.body.selected_style_pack_id || null;
  }
  if (req.body.continuity_mode) {
    project.continuity_mode = req.body.continuity_mode;
  }
  saveProject(project);
  res.json(project);
});

app.post('/api/projects/:id/keyframes', async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const updated = await generateKeyframesForShots(project);
  saveProject(updated);
  res.json({ shots: updated.shots });
});

app.post('/api/projects/:id/clips', async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const updated = await generateClipsForShots(project);
  saveProject(updated);
  res.json({ shots: updated.shots });
});

app.post('/api/projects/:id/shots/:shotId/keyframe', async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const shotIndex = project.shots.findIndex((item) => item.id === req.params.shotId);
  if (shotIndex === -1) {
    return res.status(404).json({ error: 'Shot not found' });
  }
  const shot = project.shots[shotIndex];
  await generateKeyframeForShot({ project, shot });
  saveProject(project);
  res.json({ project, shot });
});

app.post('/api/projects/:id/shots/:shotId/clip', async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const shotIndex = project.shots.findIndex((item) => item.id === req.params.shotId);
  if (shotIndex === -1) {
    return res.status(404).json({ error: 'Shot not found' });
  }
  const shot = project.shots[shotIndex];
  const previousShot = project.shots[shotIndex - 1];
  await generateClipForShot({ project, shot, previousShot });
  saveProject(project);
  res.json({ project, shot });
});

app.post('/api/projects/:id/shots/:shotId/regenerate', async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const shotIndex = project.shots.findIndex((item) => item.id === req.params.shotId);
  if (shotIndex === -1) {
    return res.status(404).json({ error: 'Shot not found' });
  }
  const shot = project.shots[shotIndex];
  const mode = req.body?.mode || 'both';
  if (mode === 'keyframe' || mode === 'both') {
    await generateKeyframeForShot({ project, shot });
  }
  if (mode === 'clip' || mode === 'both') {
    const previousShot = project.shots[shotIndex - 1];
    await generateClipForShot({ project, shot, previousShot });
  }
  saveProject(project);
  res.json({ project, shot });
});

app.post('/api/projects/:id/shots/:shotId/rollback', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const shot = project.shots.find((item) => item.id === req.params.shotId);
  if (!shot) {
    return res.status(404).json({ error: 'Shot not found' });
  }
  ensureShotHistory(shot);
  const asset = req.body?.asset;
  const version = Number(req.body?.version);
  if (!asset || Number.isNaN(version)) {
    return res.status(400).json({ error: 'asset and version are required' });
  }

  if (asset === 'keyframe') {
    const entry = shot.keyframe_versions.find((item) => item.version === version);
    if (!entry) {
      return res.status(404).json({ error: 'Keyframe version not found' });
    }
    applyKeyframeVersion(shot, entry);
  } else if (asset === 'clip') {
    const entry = shot.clip_versions.find((item) => item.version === version);
    if (!entry) {
      return res.status(404).json({ error: 'Clip version not found' });
    }
    applyClipVersion(shot, entry);
  } else {
    return res.status(400).json({ error: 'Invalid asset type' });
  }

  saveProject(project);
  res.json({ project, shot });
});

app.post('/api/projects/:id/export', async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const result = await exportProjectVideo(project, req.body || {});
  saveProject(result.project);
  res.json(result);
});

app.get('/api/stylepacks', (req, res) => {
  res.json({ stylepacks: listStylePacks() });
});

app.post('/api/stylepacks', (req, res) => {
  const packId = nanoid(10);
  const pack = createStylePack(packId, req.body);
  res.status(201).json(pack);
});

app.get('/api/stylepacks/:id', (req, res) => {
  const pack = loadStylePack(req.params.id);
  if (!pack) {
    return res.status(404).json({ error: 'Style pack not found' });
  }
  res.json(pack);
});

app.post('/api/stylepacks/:id', (req, res) => {
  const pack = loadStylePack(req.params.id);
  if (!pack) {
    return res.status(404).json({ error: 'Style pack not found' });
  }
  Object.assign(pack, req.body);
  saveStylePack(pack);
  res.json(pack);
});

app.post('/api/stylepacks/:id/videos', upload.array('videos', 10), async (req, res) => {
  const pack = loadStylePack(req.params.id);
  if (!pack) {
    return res.status(404).json({ error: 'Style pack not found' });
  }
  ensureStylePackDirs(pack.pack_id);
  const updatedPack = await processStylePackVideos(pack, req.files);
  saveStylePack(updatedPack);
  res.json(updatedPack);
});

app.listen(port, () => {
  console.log(`Marketing video studio running on http://localhost:${port}`);
});
