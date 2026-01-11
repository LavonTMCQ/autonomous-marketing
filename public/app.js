const state = {
  activeView: 'stepper',
  activeStep: 0,
  project: null,
  stylepacks: [],
  selectedStylePack: null,
};

const steps = [
  'New Project',
  'Brand Kit',
  'Script',
  'Storyboard',
  'Generate Clips',
  'Export',
];

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => Array.from(document.querySelectorAll(selector));

const storage = {
  getLastProjectId: () => window.localStorage.getItem('lastProjectId'),
  setLastProjectId: (id) => window.localStorage.setItem('lastProjectId', id),
};

const api = {
  get: (path) => fetch(path).then((res) => res.json()),
  post: (path, body) =>
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((res) => res.json()),
  postForm: (path, formData) =>
    fetch(path, {
      method: 'POST',
      body: formData,
    }).then((res) => res.json()),
};

const renderSteps = () => {
  const container = qs('#steps');
  container.innerHTML = '';
  steps.forEach((label, index) => {
    const btn = document.createElement('button');
    btn.className = `step ${index === state.activeStep ? 'active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', () => setStep(index));
    container.appendChild(btn);
  });
};

const setStep = (index) => {
  state.activeStep = index;
  renderSteps();
  qsa('.step-panel').forEach((panel) => {
    panel.classList.toggle('active', parseInt(panel.dataset.step, 10) === index);
  });
};

const setView = (view) => {
  state.activeView = view;
  qs('#stepperView').classList.toggle('active', view === 'stepper');
  qs('#stylepackView').classList.toggle('active', view === 'stylepacks');
  qsa('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
};

const updateProjectUI = () => {
  qs('#activeProject').textContent = state.project ? state.project.name : 'None';
  qs('#projectStatus').textContent = state.project ? `Project ${state.project.id}` : 'No project yet';
};

const applyProjectToForm = () => {
  if (!state.project) return;
  qs('#projectName').value = state.project.name || '';
  qs('#aspectRatio').value = state.project.aspect_ratio || '16:9';
  qs('#targetDuration').value = String(state.project.target_duration || 30);
  qs('#continuityMode').value = state.project.continuity_mode || 'maintain';
  qs('#stylePackSelect').value = state.project.selected_style_pack_id || '';
};

const setActiveProject = (project) => {
  state.project = project;
  updateProjectUI();
  applyProjectToForm();
  renderShotTable();
  updateClipStatus();
  updateExportStatus();
  storage.setLastProjectId(project.id);
};

const refreshStylePacks = async () => {
  const data = await api.get('/api/stylepacks');
  state.stylepacks = data.stylepacks || [];
  const select = qs('#stylePackSelect');
  select.innerHTML = '<option value="">None</option>';
  state.stylepacks.forEach((pack) => {
    const option = document.createElement('option');
    option.value = pack.pack_id;
    option.textContent = pack.name;
    select.appendChild(option);
  });
  if (state.project?.selected_style_pack_id) {
    select.value = state.project.selected_style_pack_id;
  }

  const list = qs('#stylePackList');
  list.innerHTML = '';
  state.stylepacks.forEach((pack) => {
    const option = document.createElement('option');
    option.value = pack.pack_id;
    option.textContent = pack.name;
    list.appendChild(option);
  });
};

const loadStylePackDetails = async (packId) => {
  if (!packId) {
    qs('#promptSpine').value = '';
    qs('#stylePackMeta').textContent = '';
    return;
  }
  const pack = await api.get(`/api/stylepacks/${packId}`);
  state.selectedStylePack = pack;
  qs('#promptSpine').value = pack.prompt_spine || '';
  qs('#stylePackMeta').textContent = `Videos: ${pack.source_videos.length}, Refs: ${pack.extracted_ref_images.length}, Brightness: ${Math.round(
    pack.metadata_summary.brightness || 0
  )}`;
};

const renderShotTable = () => {
  const container = qs('#shotTable');
  container.innerHTML = '';
  if (!state.project?.shots?.length) {
    container.innerHTML = '<p>No shots yet. Generate the storyboard.</p>';
    return;
  }
  state.project.shots.forEach((shot) => {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.innerHTML = `
      <div>#${shot.order}</div>
      <input value="${shot.keyframe_prompt}" data-shot="${shot.id}" data-field="keyframe_prompt" />
      <input value="${shot.duration_sec}" data-shot="${shot.id}" data-field="duration_sec" />
      <input value="${shot.on_screen_text || ''}" data-shot="${shot.id}" data-field="on_screen_text" />
    `;
    row.querySelectorAll('input').forEach((input) => {
      input.addEventListener('change', (event) => {
        const field = event.target.dataset.field;
        const shotId = event.target.dataset.shot;
        const targetShot = state.project.shots.find((item) => item.id === shotId);
        targetShot[field] = field === 'duration_sec' ? Number(event.target.value) : event.target.value;
      });
    });
    container.appendChild(row);
  });
};

const updateClipStatus = () => {
  const container = qs('#clipStatus');
  container.innerHTML = '';
  if (!state.project?.shots?.length) {
    return;
  }
  state.project.shots.forEach((shot) => {
    const div = document.createElement('div');
    div.textContent = `${shot.id}: ${shot.status.clip_status}`;
    container.appendChild(div);
  });
};

const updateExportStatus = () => {
  const container = qs('#exportStatus');
  container.innerHTML = '';
  if (!state.project?.exports?.length) {
    container.textContent = 'No exports yet.';
    return;
  }
  state.project.exports.forEach((item) => {
    const div = document.createElement('div');
    div.textContent = `Exported: ${item.path}`;
    container.appendChild(div);
  });
};

const loadProjectById = async (projectId) => {
  if (!projectId) return null;
  const project = await api.get(`/api/projects/${projectId}`);
  if (project?.error) return null;
  return project;
};

const restoreLastProject = async () => {
  const data = await api.get('/api/projects');
  const projects = data.projects || [];
  if (!projects.length) return;

  const storedId = storage.getLastProjectId();
  const storedProject = projects.find((project) => project.id === storedId);
  const fallback = projects
    .slice()
    .sort((a, b) => b.last_updated.localeCompare(a.last_updated))[0];
  const target = storedProject || fallback;
  if (!target) return;

  const project = await loadProjectById(target.id);
  if (project) {
    setActiveProject(project);
  }
};

const init = async () => {
  renderSteps();
  setStep(0);
  setView('stepper');
  await refreshStylePacks();
  await restoreLastProject();
};

qsa('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

qs('#createProject').addEventListener('click', async () => {
  const payload = {
    name: qs('#projectName').value || 'New Project',
    aspect_ratio: qs('#aspectRatio').value,
    target_duration: Number(qs('#targetDuration').value),
    continuity_mode: qs('#continuityMode').value,
    selected_style_pack_id: qs('#stylePackSelect').value || null,
  };
  const project = await api.post('/api/projects', payload);
  setActiveProject(project);
});

qs('#saveBrandKit').addEventListener('click', async () => {
  if (!state.project) return;
  const payload = {
    colors: qs('#brandColors').value.split(',').map((color) => color.trim()).filter(Boolean),
    logo_path: qs('#logoPath').value || null,
    product_photo_paths: qs('#productPhotos').value.split(',').map((item) => item.trim()).filter(Boolean),
    brand_voice: {
      playful: Number(qs('#voicePlayful').value),
      luxury: Number(qs('#voiceLuxury').value),
      minimal: Number(qs('#voiceMinimal').value),
    },
  };
  state.project.brand_kit = payload;
  await api.post(`/api/projects/${state.project.id}/brand-kit`, payload);
});

qs('#generateScript').addEventListener('click', async () => {
  if (!state.project) return;
  const payload = {
    brief: qs('#briefText').value,
    raw_script: qs('#scriptText').value,
  };
  const script = await api.post(`/api/projects/${state.project.id}/script`, payload);
  qs('#scriptHook').value = script.sections.hook || '';
  qs('#scriptProblem').value = script.sections.problem || '';
  qs('#scriptSolution').value = script.sections.solution || '';
  qs('#scriptCta').value = script.sections.cta || '';
});

qs('#generateStoryboard').addEventListener('click', async () => {
  if (!state.project) return;
  const result = await api.post(`/api/projects/${state.project.id}/storyboard`, {});
  state.project.shots = result.shots;
  renderShotTable();
});

qs('#generateKeyframes').addEventListener('click', async () => {
  if (!state.project) return;
  const result = await api.post(`/api/projects/${state.project.id}/keyframes`, {});
  state.project.shots = result.shots;
  renderShotTable();
});

qs('#generateClips').addEventListener('click', async () => {
  if (!state.project) return;
  const result = await api.post(`/api/projects/${state.project.id}/clips`, {});
  state.project.shots = result.shots;
  updateClipStatus();
});

qs('#exportVideo').addEventListener('click', async () => {
  if (!state.project) return;
  const payload = {
    audio_path: qs('#audioPath').value || null,
  };
  const result = await api.post(`/api/projects/${state.project.id}/export`, payload);
  state.project = result.project;
  updateExportStatus();
});

qs('#createStylePack').addEventListener('click', async () => {
  const payload = {
    name: qs('#stylePackName').value || 'New Style Pack',
    description: qs('#stylePackDesc').value || '',
  };
  await api.post('/api/stylepacks', payload);
  await refreshStylePacks();
});

qs('#stylePackList').addEventListener('change', async (event) => {
  await loadStylePackDetails(event.target.value);
});

qs('#uploadStyleVideos').addEventListener('click', async () => {
  const packId = qs('#stylePackList').value;
  const files = qs('#stylePackVideos').files;
  if (!packId || !files.length) return;
  const formData = new FormData();
  Array.from(files).forEach((file) => formData.append('videos', file));
  await api.postForm(`/api/stylepacks/${packId}/videos`, formData);
  await loadStylePackDetails(packId);
  await refreshStylePacks();
});

qs('#savePromptSpine').addEventListener('click', async () => {
  const packId = qs('#stylePackList').value;
  if (!packId) return;
  const payload = { prompt_spine: qs('#promptSpine').value };
  await api.post(`/api/stylepacks/${packId}`, payload);
});

init();
