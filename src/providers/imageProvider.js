const path = require('path');
const fs = require('fs');

const placeholderPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQYV2NkYGD4DwABBAEAkS8hNwAAAABJRU5ErkJggg==',
  'base64'
);

class ImageProvider {
  constructor(config) {
    this.name = config?.name || 'nano-banana-pro';
    this.model = config?.model || 'gemini-3-pro-image-preview';
    this.settings = config?.settings || {};
  }

  async generateImage({ prompt, negativePrompt, outputPath, referenceImages = [] }) {
    if (!outputPath) {
      throw new Error('outputPath is required');
    }
    fs.writeFileSync(outputPath, placeholderPng);
    return {
      outputPath,
      prompt,
      negativePrompt,
      referenceImages,
      provider: this.name,
      model: this.model,
    };
  }

  static defaultConfig() {
    return {
      name: 'nano-banana-pro',
      model: 'gemini-3-pro-image-preview',
      settings: {
        resolution: '1024x1024',
      },
    };
  }
}

module.exports = { ImageProvider };
