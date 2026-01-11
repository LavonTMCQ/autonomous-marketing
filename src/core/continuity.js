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
  constructor({ supportsFirstLast } = {}) {
    this.supportsFirstLast = supportsFirstLast || false;
  }

  resolveFrames({ previousShot, currentShot }) {
    if (!previousShot) {
      return {
        firstFramePath: currentShot.keyframe_image_path,
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
