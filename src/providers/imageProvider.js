const path = require('path');
const fs = require('fs');
const https = require('https');

// Load environment variables
require('dotenv').config();

// Import utilities
const { retry, getRetryConfig } = require('../utils/retry');
const { estimateImageCost, tracker } = require('../utils/costs');

const placeholderPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQYV2NkYGD4DwABBAEAkS8hNwAAAABJRU5ErkJggg==',
  'base64'
);

// Aspect ratio to dimensions mapping for Replicate/Flux
const FLUX_ASPECT_RATIOS = {
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1152, height: 896 },
  '3:4': { width: 896, height: 1152 },
};

// Supported providers
const PROVIDERS = {
  REPLICATE: 'replicate',
  GEMINI: 'gemini',
  PLACEHOLDER: 'placeholder',
};

class ImageProvider {
  constructor(config = {}) {
    // Default to Gemini (uses $300 credits)
    this.provider = config.provider || process.env.IMAGE_PROVIDER || PROVIDERS.GEMINI;
    this.useReal = config.useReal ?? (process.env.USE_REAL_IMAGE_PROVIDER === 'true');

    // Gemini settings (PRIMARY - uses $300 credits)
    this.geminiApiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
    this.geminiModel = config.geminiModel || process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';
    this.geminiImageSize = config.geminiImageSize || process.env.GEMINI_IMAGE_SIZE || '2K';

    // Replicate settings (FALLBACK)
    this.replicateApiKey = config.replicateApiKey || process.env.REPLICATE_API_KEY;
    this.replicateModel = config.replicateModel || process.env.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-1.1-pro';

    // Retry settings
    this.retryConfig = config.retryConfig || getRetryConfig(this.provider);

    this.settings = config.settings || {};

    // Expose name/model for pipeline tracking
    this._updateActiveInfo();
  }

  _updateActiveInfo() {
    const active = this._getActiveProvider();
    this.name = active;
    if (active === PROVIDERS.GEMINI) {
      this.model = this.geminiModel;
    } else if (active === PROVIDERS.REPLICATE) {
      this.model = this.replicateModel;
    } else {
      this.model = 'placeholder';
    }
  }

  async generateImage({ prompt, negativePrompt, outputPath, referenceImages = [], aspectRatio = '16:9' }) {
    if (!outputPath) {
      throw new Error('outputPath is required');
    }

    // Determine which provider to use
    const activeProvider = this._getActiveProvider();

    if (activeProvider === PROVIDERS.PLACEHOLDER) {
      return this._generatePlaceholder({ prompt, negativePrompt, outputPath, referenceImages });
    }

    // Estimate cost
    const costEstimate = estimateImageCost(activeProvider, this.model);
    console.log(`[ImageProvider] Using ${activeProvider} provider (${costEstimate.formatted})`);
    console.log(`[ImageProvider] Prompt: ${prompt.substring(0, 100)}...`);

    // Try primary provider with retry, then fallback
    try {
      const result = await retry(async (attempt) => {
        if (attempt > 1) {
          console.log(`[ImageProvider] Retry attempt ${attempt}...`);
        }

        if (activeProvider === PROVIDERS.GEMINI) {
          return await this._generateWithGemini({ prompt, negativePrompt, outputPath, referenceImages, aspectRatio });
        } else {
          return await this._generateWithReplicate({ prompt, negativePrompt, outputPath, referenceImages, aspectRatio });
        }
      }, this.retryConfig);

      // Track cost
      tracker.addOperation('images', activeProvider, this.model, costEstimate.cost, { prompt: prompt.substring(0, 50) });

      return {
        ...result,
        costEstimate,
      };
    } catch (primaryError) {
      console.error(`[ImageProvider] Primary provider failed: ${primaryError.message}`);

      // Try fallback provider if available
      const fallbackProvider = this._getFallbackProvider(activeProvider);
      if (fallbackProvider && fallbackProvider !== PROVIDERS.PLACEHOLDER) {
        console.log(`[ImageProvider] Trying fallback: ${fallbackProvider}`);
        try {
          const fallbackResult = await this._generateWithFallback(fallbackProvider, { prompt, negativePrompt, outputPath, referenceImages, aspectRatio });
          const fallbackCost = estimateImageCost(fallbackProvider, fallbackResult.model);
          tracker.addOperation('images', fallbackProvider, fallbackResult.model, fallbackCost.cost);
          return { ...fallbackResult, costEstimate: fallbackCost, fallbackUsed: true };
        } catch (fallbackError) {
          console.error(`[ImageProvider] Fallback also failed: ${fallbackError.message}`);
        }
      }

      // Final fallback to placeholder
      console.log('[ImageProvider] All providers failed, using placeholder');
      return this._generatePlaceholder({ prompt, negativePrompt, outputPath, referenceImages, error: primaryError.message });
    }
  }

  _getFallbackProvider(currentProvider) {
    if (currentProvider === PROVIDERS.GEMINI && this.replicateApiKey) {
      return PROVIDERS.REPLICATE;
    }
    if (currentProvider === PROVIDERS.REPLICATE && this.geminiApiKey) {
      return PROVIDERS.GEMINI;
    }
    return PROVIDERS.PLACEHOLDER;
  }

  async _generateWithFallback(provider, params) {
    if (provider === PROVIDERS.GEMINI) {
      return await this._generateWithGemini(params);
    } else if (provider === PROVIDERS.REPLICATE) {
      return await this._generateWithReplicate(params);
    }
    throw new Error(`Unknown fallback provider: ${provider}`);
  }

  _getActiveProvider() {
    if (!this.useReal) {
      return PROVIDERS.PLACEHOLDER;
    }

    if (this.provider === PROVIDERS.GEMINI && this.geminiApiKey) {
      return PROVIDERS.GEMINI;
    }

    if (this.provider === PROVIDERS.REPLICATE && this.replicateApiKey) {
      return PROVIDERS.REPLICATE;
    }

    // Fallback: try whichever has an API key
    if (this.geminiApiKey) return PROVIDERS.GEMINI;
    if (this.replicateApiKey) return PROVIDERS.REPLICATE;

    return PROVIDERS.PLACEHOLDER;
  }

  _generatePlaceholder({ prompt, negativePrompt, outputPath, referenceImages, error = null }) {
    console.log('[ImageProvider] Generating placeholder image');
    fs.writeFileSync(outputPath, placeholderPng);
    return {
      outputPath,
      prompt,
      negativePrompt,
      referenceImages,
      provider: error ? 'placeholder-fallback' : 'placeholder',
      model: 'placeholder',
      error,
    };
  }

  // ==========================================
  // GEMINI (Nano Banana Pro / Flash Image)
  // ==========================================
  async _generateWithGemini({ prompt, negativePrompt, outputPath, referenceImages, aspectRatio }) {
    console.log(`[ImageProvider] Generating with Gemini ${this.geminiModel}...`);

    const requestBody = {
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: aspectRatio.replace(':', ':'), // e.g., "16:9"
        }
      }
    };

    // Add image size for gemini-3-pro-image-preview
    if (this.geminiModel.includes('gemini-3')) {
      requestBody.generationConfig.imageConfig.imageSize = this.geminiImageSize;
    }

    const response = await this._geminiRequest(requestBody);

    // Extract image from response
    const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart?.inlineData?.data) {
      throw new Error('No image data in Gemini response');
    }

    // Decode and save image
    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    fs.writeFileSync(outputPath, imageBuffer);

    console.log(`[ImageProvider] Gemini image saved to: ${outputPath}`);

    return {
      outputPath,
      prompt,
      negativePrompt,
      referenceImages,
      provider: 'gemini',
      model: this.geminiModel,
      imageSize: this.geminiImageSize,
    };
  }

  async _geminiRequest(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);

      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => responseBody += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(responseBody);
            if (res.statusCode >= 400) {
              reject(new Error(json.error?.message || `HTTP ${res.statusCode}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`Failed to parse Gemini response: ${responseBody.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // ==========================================
  // REPLICATE (Flux 1.1 Pro)
  // ==========================================
  async _generateWithReplicate({ prompt, negativePrompt, outputPath, referenceImages, aspectRatio }) {
    console.log(`[ImageProvider] Generating image with Flux 1.1 Pro...`);
    console.log(`[ImageProvider] Prompt: ${prompt.substring(0, 100)}...`);

    // Flux 1.1 Pro accepts aspect_ratio as a string, not width/height
    // Accepted values: 1:1, 16:9, 3:2, 2:3, 4:5, 5:4, 9:16, 3:4, 4:3, custom
    const fluxAspectRatio = aspectRatio || '16:9';

    // Create prediction with only the parameters Flux 1.1 Pro accepts
    const input = {
      prompt,
      aspect_ratio: fluxAspectRatio,
      output_format: 'png',
      output_quality: 90,
    };

    console.log(`[ImageProvider] Replicate input:`, JSON.stringify(input));
    const prediction = await this._replicateCreatePrediction(input);

    // Poll for completion
    const result = await this._replicateWaitForPrediction(prediction.id);

    if (result.status === 'failed') {
      throw new Error(`Replicate prediction failed: ${result.error || 'Unknown error'}`);
    }

    // Download image
    const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    if (!imageUrl) {
      throw new Error('No output URL in Replicate response');
    }

    await this._downloadImage(imageUrl, outputPath);
    console.log(`[ImageProvider] Replicate image saved to: ${outputPath}`);

    return {
      outputPath,
      prompt,
      negativePrompt,
      referenceImages,
      provider: 'replicate',
      model: this.replicateModel,
      predictionId: prediction.id,
    };
  }

  async _replicateCreatePrediction(input) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ input });

      const options = {
        hostname: 'api.replicate.com',
        port: 443,
        path: `/v1/models/${this.replicateModel}/predictions`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.replicateApiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 400) {
              reject(new Error(json.detail || json.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`Failed to parse Replicate response: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async _replicateWaitForPrediction(predictionId, maxAttempts = 60) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const prediction = await this._replicateGetPrediction(predictionId);

      if (prediction.status === 'succeeded' || prediction.status === 'failed') {
        return prediction;
      }

      console.log(`[ImageProvider] Replicate status: ${prediction.status} (${attempt + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error('Replicate prediction timed out');
  }

  async _replicateGetPrediction(predictionId) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.replicate.com',
        port: 443,
        path: `/v1/predictions/${predictionId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.replicateApiKey}`,
        },
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse response: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  async _downloadImage(url, outputPath) {
    return new Promise((resolve, reject) => {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const file = fs.createWriteStream(outputPath);

      const download = (downloadUrl) => {
        https.get(downloadUrl, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            download(response.headers.location);
          } else {
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          }
        }).on('error', (err) => {
          fs.unlink(outputPath, () => {});
          reject(err);
        });
      };

      download(url);
    });
  }

  // ==========================================
  // STATIC METHODS
  // ==========================================
  static defaultConfig() {
    return {
      provider: process.env.IMAGE_PROVIDER || PROVIDERS.GEMINI, // Gemini default (uses $300 credits)
      useReal: process.env.USE_REAL_IMAGE_PROVIDER === 'true',
      geminiApiKey: process.env.GEMINI_API_KEY,
      geminiModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
      geminiImageSize: process.env.GEMINI_IMAGE_SIZE || '2K',
      replicateApiKey: process.env.REPLICATE_API_KEY,
      replicateModel: process.env.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-1.1-pro',
    };
  }

  static getAvailableProviders() {
    return Object.values(PROVIDERS);
  }

  static getAvailableModels() {
    return {
      replicate: [
        'black-forest-labs/flux-1.1-pro',
        'black-forest-labs/flux-schnell',
        'stability-ai/sdxl',
      ],
      gemini: [
        'gemini-2.5-flash-image',      // Fast, cheap ($0.039/image)
        'gemini-3-pro-image-preview',   // Nano Banana Pro - Best quality
      ],
    };
  }
}

module.exports = { ImageProvider, PROVIDERS };
