const fs = require('fs');
const path = require('path');
const https = require('https');
const { hasFfmpeg, runFfmpeg } = require('../utils/ffmpeg');

// Load environment variables
require('dotenv').config();

// Import utilities
const { retry, getRetryConfig } = require('../utils/retry');
const { estimateVideoCost, tracker } = require('../utils/costs');

// Supported providers
const PROVIDERS = {
  GEMINI: 'gemini',      // Veo 3.1 / Veo 3
  REPLICATE: 'replicate', // Kling 2.6, Luma, etc.
  PLACEHOLDER: 'placeholder',
};

// Replicate video models
const REPLICATE_VIDEO_MODELS = {
  KLING_2_6: 'kwaivgi/kling-v2.6',
  KLING_2_6_MOTION: 'kwaivgi/kling-v2.6-motion-control',
};

class VideoProvider {
  constructor(config = {}) {
    // Default to Gemini/Veo (uses $300 credits)
    this.provider = config.provider || process.env.VIDEO_PROVIDER || PROVIDERS.GEMINI;
    this.useReal = config.useReal ?? (process.env.USE_REAL_VIDEO_PROVIDER === 'true');

    // Gemini/Veo settings (PRIMARY - uses $300 credits)
    this.geminiApiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
    this.veoModel = config.veoModel || process.env.VEO_MODEL || 'veo-3.0-fast-generate-001';
    this.veoDuration = config.veoDuration || process.env.VEO_DURATION || '4';
    this.veoResolution = config.veoResolution || process.env.VEO_RESOLUTION || '720p';

    // Replicate settings (FALLBACK - Kling 2.6)
    this.replicateApiKey = config.replicateApiKey || process.env.REPLICATE_API_KEY;
    this.replicateModel = config.replicateModel || process.env.REPLICATE_VIDEO_MODEL || REPLICATE_VIDEO_MODELS.KLING_2_6;
    this.klingMode = config.klingMode || process.env.KLING_MODE || 'std';
    this.klingAudio = config.klingAudio ?? (process.env.KLING_AUDIO !== 'false');

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
      this.model = this.veoModel;
    } else if (active === PROVIDERS.REPLICATE) {
      this.model = this.replicateModel || 'replicate-video';
    } else {
      this.model = 'placeholder';
    }
  }

  async generateVideo({
    prompt,
    negativePrompt,
    outputPath,
    firstFramePath,
    lastFramePath,
    referenceImages = [],
    aspectRatio = '16:9',
    durationSec = 4
  }) {
    if (!outputPath) {
      throw new Error('outputPath is required');
    }

    const activeProvider = this._getActiveProvider();

    if (activeProvider === PROVIDERS.PLACEHOLDER) {
      return this._generatePlaceholder({ prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages });
    }

    // Estimate cost
    const costEstimate = estimateVideoCost(activeProvider, this.model, durationSec);
    console.log(`[VideoProvider] Using ${activeProvider} provider (${costEstimate.formatted})`);
    console.log(`[VideoProvider] Prompt: ${prompt.substring(0, 100)}...`);

    // Try primary provider with retry, then fallback
    try {
      const result = await retry(async (attempt) => {
        if (attempt > 1) {
          console.log(`[VideoProvider] Retry attempt ${attempt}...`);
        }

        if (activeProvider === PROVIDERS.GEMINI) {
          return await this._generateWithVeo({
            prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages, aspectRatio, durationSec
          });
        } else {
          return await this._generateWithReplicate({
            prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages, aspectRatio, durationSec
          });
        }
      }, this.retryConfig);

      // Track cost
      tracker.addOperation('videos', activeProvider, this.model, costEstimate.cost, { prompt: prompt.substring(0, 50) });

      return {
        ...result,
        costEstimate,
      };
    } catch (primaryError) {
      console.error(`[VideoProvider] Primary provider failed: ${primaryError.message}`);

      // Try fallback provider if available
      const fallbackProvider = this._getFallbackProvider(activeProvider);
      if (fallbackProvider && fallbackProvider !== PROVIDERS.PLACEHOLDER) {
        console.log(`[VideoProvider] Trying fallback: ${fallbackProvider}`);
        try {
          const fallbackResult = await this._generateWithFallback(fallbackProvider, {
            prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages, aspectRatio, durationSec
          });
          const fallbackCost = estimateVideoCost(fallbackProvider, fallbackResult.model, durationSec);
          tracker.addOperation('videos', fallbackProvider, fallbackResult.model, fallbackCost.cost);
          return { ...fallbackResult, costEstimate: fallbackCost, fallbackUsed: true };
        } catch (fallbackError) {
          console.error(`[VideoProvider] Fallback also failed: ${fallbackError.message}`);
        }
      }

      // Final fallback to placeholder
      console.log('[VideoProvider] All providers failed, using placeholder');
      return this._generatePlaceholder({ prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages, error: primaryError.message });
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
      return await this._generateWithVeo(params);
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

    if (this.provider === PROVIDERS.REPLICATE && this.replicateApiKey && this.replicateModel) {
      return PROVIDERS.REPLICATE;
    }

    // Fallback
    if (this.geminiApiKey) return PROVIDERS.GEMINI;
    if (this.replicateApiKey && this.replicateModel) return PROVIDERS.REPLICATE;

    return PROVIDERS.PLACEHOLDER;
  }

  _generatePlaceholder({ prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages, error = null }) {
    console.log('[VideoProvider] Generating placeholder video');

    // If we have ffmpeg and a first frame, create a looping video
    if (hasFfmpeg() && firstFramePath && fs.existsSync(firstFramePath)) {
      const args = [
        '-y',
        '-loop', '1',
        '-i', firstFramePath,
        '-t', `${this.settings.durationSec || 3}`,
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'fast',
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
      provider: error ? 'placeholder-fallback' : 'placeholder',
      model: 'placeholder',
      firstFramePath,
      lastFramePath,
      referenceImages,
      error,
    };
  }

  // ==========================================
  // GEMINI VEO 3.1 / VEO 3
  // ==========================================
  async _generateWithVeo({ prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages, aspectRatio, durationSec }) {
    console.log(`[VideoProvider] Generating with Veo ${this.veoModel}...`);

    // Build the request
    const instances = [{
      prompt: prompt,
    }];

    // Add first frame if provided
    if (firstFramePath && fs.existsSync(firstFramePath)) {
      const imageData = fs.readFileSync(firstFramePath);
      const base64Image = imageData.toString('base64');
      const mimeType = firstFramePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

      instances[0].image = {
        bytesBase64Encoded: base64Image,
        mimeType: mimeType,
      };
      console.log('[VideoProvider] Added first frame to request');
    }

    // Add last frame for interpolation (Veo 3.1 only - not supported in 3.0)
    const supportsLastFrame = this.veoModel.includes('3.1');
    if (supportsLastFrame && lastFramePath && fs.existsSync(lastFramePath)) {
      const imageData = fs.readFileSync(lastFramePath);
      const base64Image = imageData.toString('base64');
      const mimeType = lastFramePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

      instances[0].lastFrame = {
        bytesBase64Encoded: base64Image,
        mimeType: mimeType,
      };
      console.log('[VideoProvider] Added last frame for interpolation (bridging mode)');
    } else if (lastFramePath && !supportsLastFrame) {
      console.log('[VideoProvider] Skipping lastFrame (not supported by ' + this.veoModel + ')');
    }

    const parameters = {
      aspectRatio: aspectRatio.replace(':', ':'),
      durationSeconds: Number(durationSec) || Number(this.veoDuration) || 4,
    };

    // Add negative prompt if provided
    if (negativePrompt) {
      parameters.negativePrompt = negativePrompt;
    }

    // Start the long-running operation
    const operation = await this._veoStartGeneration(instances, parameters);
    console.log(`[VideoProvider] Veo operation started: ${operation.name}`);

    // Poll for completion
    const result = await this._veoWaitForCompletion(operation.name);

    if (!result.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri) {
      throw new Error('No video URI in Veo response');
    }

    // Download the video
    const videoUri = result.response.generateVideoResponse.generatedSamples[0].video.uri;
    await this._downloadVideo(videoUri, outputPath);

    console.log(`[VideoProvider] Veo video saved to: ${outputPath}`);

    return {
      outputPath,
      prompt,
      negativePrompt,
      provider: 'gemini-veo',
      model: this.veoModel,
      firstFramePath,
      lastFramePath,
      referenceImages,
      operationName: operation.name,
    };
  }

  async _veoStartGeneration(instances, parameters) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ instances, parameters });

      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${this.veoModel}:predictLongRunning?key=${this.geminiApiKey}`,
        method: 'POST',
        headers: {
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
              reject(new Error(json.error?.message || `HTTP ${res.statusCode}: ${body}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`Failed to parse Veo response: ${body.substring(0, 500)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async _veoWaitForCompletion(operationName, maxAttempts = 120, pollInterval = 5000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await this._veoGetOperation(operationName);

      if (status.done) {
        if (status.error) {
          throw new Error(`Veo operation failed: ${status.error.message || JSON.stringify(status.error)}`);
        }
        return status;
      }

      console.log(`[VideoProvider] Veo status: processing (${attempt + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error('Veo operation timed out');
  }

  async _veoGetOperation(operationName) {
    return new Promise((resolve, reject) => {
      // Extract just the operation ID from the full name
      const opPath = operationName.startsWith('/') ? operationName : `/${operationName}`;

      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta${opPath}?key=${this.geminiApiKey}`,
        method: 'GET',
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse operation status: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  async _downloadVideo(uri, outputPath) {
    return new Promise((resolve, reject) => {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // For GCS URIs, we need to use the download endpoint
      // For direct URLs, download directly
      let downloadUrl = uri;

      if (uri.startsWith('gs://')) {
        // Convert GCS URI to download URL via Gemini API
        downloadUrl = `https://storage.googleapis.com/${uri.replace('gs://', '')}`;
      }

      // Add API key to Gemini API download URLs
      if (uri.includes('generativelanguage.googleapis.com') && this.geminiApiKey) {
        const separator = uri.includes('?') ? '&' : '?';
        downloadUrl = `${uri}${separator}key=${this.geminiApiKey}`;
      }

      const file = fs.createWriteStream(outputPath);

      const download = (url) => {
        const protocol = url.startsWith('https') ? https : require('http');
        protocol.get(url, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            download(response.headers.location);
          } else if (response.statusCode === 200) {
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          } else {
            reject(new Error(`Failed to download video: HTTP ${response.statusCode}`));
          }
        }).on('error', (err) => {
          fs.unlink(outputPath, () => {});
          reject(err);
        });
      };

      download(downloadUrl);
    });
  }

  // ==========================================
  // REPLICATE (Kling 2.6, etc.)
  // ==========================================
  async _generateWithReplicate({ prompt, negativePrompt, outputPath, firstFramePath, lastFramePath, referenceImages, aspectRatio, durationSec, motionVideoPath }) {
    console.log(`[VideoProvider] Generating with Replicate ${this.replicateModel}...`);

    const isMotionControl = this.replicateModel.includes('motion-control');

    if (isMotionControl) {
      return await this._generateWithKlingMotion({
        prompt, outputPath, firstFramePath, motionVideoPath, aspectRatio
      });
    } else {
      return await this._generateWithKling({
        prompt, negativePrompt, outputPath, firstFramePath, aspectRatio, durationSec
      });
    }
  }

  async _generateWithKling({ prompt, negativePrompt, outputPath, firstFramePath, aspectRatio, durationSec }) {
    console.log(`[VideoProvider] Generating with Kling 2.6 (${this.klingMode} mode)...`);

    // Build input for Kling 2.6
    const input = {
      prompt: prompt,
      negative_prompt: negativePrompt || '',
      duration: durationSec <= 5 ? 5 : 10,
      aspect_ratio: aspectRatio.replace(':', ':'),
      generate_audio: this.klingAudio,
    };

    // Add start image if provided (image-to-video)
    if (firstFramePath && fs.existsSync(firstFramePath)) {
      const imageData = fs.readFileSync(firstFramePath);
      const base64Image = imageData.toString('base64');
      const mimeType = firstFramePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
      input.start_image = `data:${mimeType};base64,${base64Image}`;
      console.log('[VideoProvider] Added start image for image-to-video mode');
    }

    console.log(`[VideoProvider] Kling input: prompt=${prompt.substring(0, 50)}..., duration=${input.duration}s, audio=${input.generate_audio}`);

    // Start prediction
    const prediction = await this._replicateCreatePrediction(this.replicateModel, input);
    console.log(`[VideoProvider] Kling prediction started: ${prediction.id}`);

    // Poll for completion
    const result = await this._replicateWaitForCompletion(prediction.id);

    if (!result.output) {
      throw new Error('No video output from Kling');
    }

    // Download the video
    const videoUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    await this._downloadVideo(videoUrl, outputPath);

    console.log(`[VideoProvider] Kling video saved to: ${outputPath}`);

    return {
      outputPath,
      prompt,
      negativePrompt,
      provider: 'replicate-kling',
      model: this.replicateModel,
      mode: this.klingMode,
      hasAudio: this.klingAudio,
      firstFramePath,
      predictionId: prediction.id,
    };
  }

  async _generateWithKlingMotion({ prompt, outputPath, firstFramePath, motionVideoPath, aspectRatio }) {
    console.log('[VideoProvider] Generating with Kling 2.6 Motion Control...');

    if (!firstFramePath || !fs.existsSync(firstFramePath)) {
      throw new Error('Kling Motion Control requires a reference image (firstFramePath)');
    }

    if (!motionVideoPath || !fs.existsSync(motionVideoPath)) {
      throw new Error('Kling Motion Control requires a motion reference video (motionVideoPath)');
    }

    // Read image and video as base64
    const imageData = fs.readFileSync(firstFramePath);
    const imageMime = firstFramePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const imageBase64 = `data:${imageMime};base64,${imageData.toString('base64')}`;

    const videoData = fs.readFileSync(motionVideoPath);
    const videoBase64 = `data:video/mp4;base64,${videoData.toString('base64')}`;

    const input = {
      image: imageBase64,
      video: videoBase64,
      prompt: prompt || '',
      mode: this.klingMode,
      character_orientation: 'image',
      keep_original_sound: true,
    };

    console.log(`[VideoProvider] Kling Motion input: mode=${this.klingMode}, orientation=image`);

    // Start prediction
    const prediction = await this._replicateCreatePrediction(REPLICATE_VIDEO_MODELS.KLING_2_6_MOTION, input);
    console.log(`[VideoProvider] Kling Motion prediction started: ${prediction.id}`);

    // Poll for completion
    const result = await this._replicateWaitForCompletion(prediction.id);

    if (!result.output) {
      throw new Error('No video output from Kling Motion Control');
    }

    // Download the video
    const videoUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    await this._downloadVideo(videoUrl, outputPath);

    console.log(`[VideoProvider] Kling Motion video saved to: ${outputPath}`);

    return {
      outputPath,
      prompt,
      provider: 'replicate-kling-motion',
      model: REPLICATE_VIDEO_MODELS.KLING_2_6_MOTION,
      mode: this.klingMode,
      firstFramePath,
      motionVideoPath,
      predictionId: prediction.id,
    };
  }

  async _replicateCreatePrediction(model, input) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        version: model,
        input: input,
      });

      const options = {
        hostname: 'api.replicate.com',
        port: 443,
        path: '/v1/predictions',
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
              reject(new Error(json.detail || json.error || `HTTP ${res.statusCode}: ${body}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`Failed to parse Replicate response: ${body.substring(0, 500)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async _replicateWaitForCompletion(predictionId, maxAttempts = 180, pollInterval = 5000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await this._replicateGetPrediction(predictionId);

      if (status.status === 'succeeded') {
        return status;
      } else if (status.status === 'failed' || status.status === 'canceled') {
        throw new Error(`Replicate prediction ${status.status}: ${status.error || 'Unknown error'}`);
      }

      console.log(`[VideoProvider] Replicate status: ${status.status} (${attempt + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
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
            reject(new Error(`Failed to parse prediction status: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  // ==========================================
  // STATIC METHODS
  // ==========================================
  static defaultConfig() {
    return {
      provider: process.env.VIDEO_PROVIDER || PROVIDERS.GEMINI,
      useReal: process.env.USE_REAL_VIDEO_PROVIDER === 'true',
      geminiApiKey: process.env.GEMINI_API_KEY,
      veoModel: process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview',
      veoDuration: process.env.VEO_DURATION || '4',
      veoResolution: process.env.VEO_RESOLUTION || '720p',
      replicateApiKey: process.env.REPLICATE_API_KEY,
      replicateModel: process.env.REPLICATE_VIDEO_MODEL,
    };
  }

  static getAvailableProviders() {
    return Object.values(PROVIDERS);
  }

  static getAvailableModels() {
    return {
      gemini: [
        'veo-3.1-fast-generate-preview',  // Fast mode - $0.15/sec
        'veo-3.1-generate-preview',        // Standard mode - $0.40/sec
        'veo-3.0-fast-generate-001',       // Veo 3 Fast
        'veo-3.0-generate-001',            // Veo 3 Standard
        'veo-2.0-generate-001',            // Veo 2 - $0.35/sec
      ],
      replicate: [
        'kwaivgi/kling-v2.6',              // Kling 2.6 - text/image to video with audio
        'kwaivgi/kling-v2.6-motion-control', // Kling 2.6 Motion Control - motion transfer
      ],
    };
  }
}

module.exports = { VideoProvider, PROVIDERS, REPLICATE_VIDEO_MODELS };
