const fs = require('fs');
const path = require('path');
const { hasFfmpeg, runFfmpeg } = require('../utils/ffmpeg');

class VideoProvider {
  constructor(config) {
    this.name = config?.name || 'veo';
    this.model = config?.model || 'veo-2-preview';
    this.settings = config?.settings || {};
  }

  async generateVideo({ prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages = [] }) {
    if (!outputPath) {
      throw new Error('outputPath is required');
    }

    if (hasFfmpeg() && firstFramePath) {
      const args = [
        '-y',
        '-loop',
        '1',
        '-i',
        firstFramePath,
        '-t',
        `${this.settings.durationSec || 3}`,
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt',
        'yuv420p',
        outputPath,
      ];
      const result = runFfmpeg(args);
      if (!result.ok) {
        fs.writeFileSync(outputPath, 'placeholder clip');
      }
    } else {
      fs.writeFileSync(outputPath, 'placeholder clip');
    }

    return {
      outputPath,
      prompt,
      negativePrompt,
      provider: this.name,
      model: this.model,
      firstFramePath,
      lastFramePath,
      referenceImages,
    };
  }

  static defaultConfig() {
    return {
      name: 'veo',
      model: 'veo-2-preview',
      settings: {
        durationSec: 3,
      },
    };
  }
}

module.exports = { VideoProvider };
