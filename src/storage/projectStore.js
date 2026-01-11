const fs = require('fs');
const path = require('path');

const projectsRoot = path.join(__dirname, '..', '..', 'data', 'projects');

const defaultProject = (id, input) => {
  const now = new Date().toISOString();
  return {
    id,
    name: input?.name || `Project ${id}`,
    created_at: now,
    aspect_ratio: input?.aspect_ratio || '16:9',
    continuity_mode: input?.continuity_mode || 'maintain',
    fps_target: 30,
    target_duration: input?.target_duration || 30,
    selected_style_pack_id: input?.selected_style_pack_id || null,
    brand_kit: {
      colors: [],
      logo_path: null,
      product_photo_paths: [],
      brand_voice: {
        playful: 0.5,
        luxury: 0.5,
        minimal: 0.5,
      },
    },
    script: {
      raw: '',
      sections: {
        hook: '',
        problem: '',
        solution: '',
        cta: '',
      },
    },
    shots: [],
    exports: [],
    last_updated: now,
  };
};

const projectPath = (id) => path.join(projectsRoot, id);

const ensureProjectDirs = (id) => {
  const base = projectPath(id);
  const assets = path.join(base, 'assets');
  const folders = [
    base,
    assets,
    path.join(assets, 'brand'),
    path.join(assets, 'refs'),
    path.join(assets, 'stylepacks'),
    path.join(assets, 'keyframes'),
    path.join(assets, 'clips'),
    path.join(assets, 'frames'),
    path.join(assets, 'exports'),
  ];
  folders.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

const createProject = (id, input) => {
  ensureProjectDirs(id);
  const project = defaultProject(id, input);
  fs.writeFileSync(path.join(projectPath(id), 'project.json'), JSON.stringify(project, null, 2));
  return project;
};

const loadProject = (id) => {
  const filePath = path.join(projectPath(id), 'project.json');
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const saveProject = (project) => {
  project.last_updated = new Date().toISOString();
  fs.writeFileSync(
    path.join(projectPath(project.id), 'project.json'),
    JSON.stringify(project, null, 2)
  );
  return project;
};

const listProjects = () => {
  if (!fs.existsSync(projectsRoot)) {
    return [];
  }
  return fs
    .readdirSync(projectsRoot)
    .map((id) => loadProject(id))
    .filter(Boolean)
    .map((project) => ({
      id: project.id,
      name: project.name,
      created_at: project.created_at,
      last_updated: project.last_updated,
    }));
};

module.exports = {
  createProject,
  loadProject,
  saveProject,
  listProjects,
  ensureProjectDirs,
};
