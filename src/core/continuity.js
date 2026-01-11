const path = require('path');
const fs = require('fs');
const { hasFfmpeg, runFfmpeg } = require('../utils/ffmpeg');

const placeholderPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQYV2NkYGD4DwABBAEAkS8hNwAAAABJRU5ErkJggg==',
  'base64'
);

const writePlaceholderPng = (outputPath) => {
  fs.writeFileSync(outputPath, placeholderPng);
};

const extractLastFrame = (clipPath, outputPath) => {
  if (!hasFfmpeg()) {
    writePlaceholderPng(outputPath);
    return outputPath;
  }
  const args = ['-y', '-sseof', '-0.1', '-i', clipPath, '-vframes', '1', outputPath];
  const result = runFfmpeg(args);
  if (!result.ok) {
    writePlaceholderPng(outputPath);
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
