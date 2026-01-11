const { spawnSync } = require('child_process');

const hasFfmpeg = () => {
  const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return result.status === 0;
};

const hasFfprobe = () => {
  const result = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
  return result.status === 0;
};

const runFfmpeg = (args) => {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const runFfprobe = (args) => {
  const result = spawnSync('ffprobe', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

module.exports = {
  hasFfmpeg,
  hasFfprobe,
  runFfmpeg,
  runFfprobe,
};
