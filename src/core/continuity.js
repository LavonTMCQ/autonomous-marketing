const path = require('path');
const fs = require('fs');
const { hasFfmpeg, runFfmpeg } = require('../utils/ffmpeg');

const extractLastFrame = (clipPath, outputPath) => {
  if (!hasFfmpeg()) {
    fs.writeFileSync(outputPath, 'placeholder last frame');
    return outputPath;
  }
  const args = ['-y', '-sseof', '-0.1', '-i', clipPath, '-vframes', '1', outputPath];
  const result = runFfmpeg(args);
  if (!result.ok) {
    fs.writeFileSync(outputPath, 'placeholder last frame');
  }
  return outputPath;
};

class ContinuityManager {
  constructor({ supportsFirstLast, mode } = {}) {
    this.supportsFirstLast = supportsFirstLast || false;
    this.mode = mode || 'bridging';
  }

  resolveFrames({ previousShot, currentShot }) {
    if (this.mode === 'independent') {
      return {
        firstFramePath: currentShot.keyframe_image_path,
        targetLastFramePath: null,
      };
    }

    if (!previousShot) {
      return {
        firstFramePath: currentShot.keyframe_image_path,
        targetLastFramePath: null,
      };
    }

    if (this.mode === 'last-frame') {
      return {
        firstFramePath: previousShot.continuity?.last_frame_path || previousShot.keyframe_image_path,
        targetLastFramePath: null,
      };
    }

    if (this.supportsFirstLast) {
      return {
        firstFramePath: currentShot.keyframe_image_path,
        targetLastFramePath: previousShot.continuity?.last_frame_path || previousShot.keyframe_image_path,
      };
    }

    return {
      firstFramePath: previousShot.continuity?.last_frame_path || previousShot.keyframe_image_path,
      targetLastFramePath: null,
    };
  }

  saveLastFrame({ clipPath, framePath }) {
    return extractLastFrame(clipPath, framePath);
  }
}

module.exports = { ContinuityManager };
