const fs = require('fs');
const path = require('path');
const {
  extractFramesFromVideo,
  analyzeFrameSet,
  buildPromptSpine,
} = require('../utils/stylePackUtils');

const stylePackRoot = path.join(__dirname, '..', '..', 'data', 'StylePacks');

const ensureStylePackDirs = (packId) => {
  const base = path.join(stylePackRoot, packId);
  const dirs = [base, path.join(base, 'videos'), path.join(base, 'refs')];
  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

const defaultStylePack = (id, input) => {
  const now = new Date().toISOString();
  return {
    pack_id: id,
    name: input?.name || `Style Pack ${id}`,
    description: input?.description || '',
    created_at: now,
    source_videos: [],
    extracted_ref_images: [],
    metadata_summary: {
      aspect_ratio: null,
      fps: null,
      brightness: null,
      contrast: null,
      palette: [],
    },
    prompt_spine: '',
  };
};

const stylePackPath = (id) => path.join(stylePackRoot, id, 'pack.json');

const createStylePack = (id, input) => {
  ensureStylePackDirs(id);
  const pack = defaultStylePack(id, input);
  fs.writeFileSync(stylePackPath(id), JSON.stringify(pack, null, 2));
  return pack;
};

const loadStylePack = (id) => {
  const filePath = stylePackPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const saveStylePack = (pack) => {
  ensureStylePackDirs(pack.pack_id);
  fs.writeFileSync(stylePackPath(pack.pack_id), JSON.stringify(pack, null, 2));
  return pack;
};

const listStylePacks = () => {
  if (!fs.existsSync(stylePackRoot)) {
    return [];
  }
  return fs
    .readdirSync(stylePackRoot)
    .map((id) => loadStylePack(id))
    .filter(Boolean)
    .map((pack) => ({
      pack_id: pack.pack_id,
      name: pack.name,
      description: pack.description,
      created_at: pack.created_at,
    }));
};

const processStylePackVideos = async (pack, files) => {
  ensureStylePackDirs(pack.pack_id);
  const base = path.join(stylePackRoot, pack.pack_id);
  const videoDir = path.join(base, 'videos');
  const refsDir = path.join(base, 'refs');

  const newVideos = [];
  for (const file of files) {
    const destination = path.join(videoDir, file.originalname);
    fs.renameSync(file.path, destination);
    newVideos.push({
      filename: file.originalname,
      path: destination,
      added_at: new Date().toISOString(),
    });
  }

  pack.source_videos = [...pack.source_videos, ...newVideos];

  const extracted = [];
  for (const video of newVideos) {
    const frames = await extractFramesFromVideo(video.path, refsDir);
    extracted.push(...frames);
  }

  const analysis = analyzeFrameSet(extracted);
  pack.extracted_ref_images = analysis.refs;
  pack.metadata_summary = analysis.summary;
  pack.prompt_spine = pack.prompt_spine || buildPromptSpine(pack.metadata_summary);
  return pack;
};

module.exports = {
  createStylePack,
  loadStylePack,
  saveStylePack,
  listStylePacks,
  ensureStylePackDirs,
  processStylePackVideos,
};
