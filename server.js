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
