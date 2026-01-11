const https = require('https');

// Load environment variables
require('dotenv').config();

// Import utilities
const { retry, getRetryConfig } = require('../utils/retry');
const { estimateLLMCost, tracker } = require('../utils/costs');

// Supported providers
const PROVIDERS = {
  GEMINI: 'gemini',
  PLACEHOLDER: 'placeholder',
};

// Marketing script system prompt
const SCRIPT_SYSTEM_PROMPT = `You are a professional marketing copywriter. Your task is to create compelling video marketing scripts.

Given a brief description of a product, service, or campaign, generate a structured marketing script with these sections:

1. **hook** - A compelling opening (1-2 sentences) that grabs attention immediately. Use questions, surprising facts, or emotional triggers.

2. **problem** - Identify the pain point or challenge the target audience faces (2-3 sentences). Make them feel understood.

3. **solution** - Present the product/service as the answer (2-3 sentences). Highlight key benefits and unique value.

4. **cta** - A clear call-to-action (1-2 sentences). Tell them exactly what to do next.

Keep the tone conversational and engaging. Each section should flow naturally into the next.

IMPORTANT: Return ONLY valid JSON in this exact format:
{
  "hook": "...",
  "problem": "...",
  "solution": "...",
  "cta": "..."
}`;

class LLMProvider {
  constructor(config = {}) {
    this.provider = config.provider || process.env.LLM_PROVIDER || PROVIDERS.GEMINI;
    this.useReal = config.useReal ?? (process.env.USE_REAL_LLM_PROVIDER !== 'false');

    // Gemini settings
    this.geminiApiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
    this.geminiModel = config.geminiModel || process.env.LLM_MODEL || 'gemini-2.0-flash';

    // Retry settings
    this.retryConfig = config.retryConfig || getRetryConfig('gemini');

    // Expose name/model for tracking
    this._updateActiveInfo();
  }

  _updateActiveInfo() {
    const active = this._getActiveProvider();
    this.name = active;
    this.model = active === PROVIDERS.GEMINI ? this.geminiModel : 'placeholder';
  }

  _getActiveProvider() {
    if (!this.useReal) {
      return PROVIDERS.PLACEHOLDER;
    }

    if (this.geminiApiKey) {
      return PROVIDERS.GEMINI;
    }

    return PROVIDERS.PLACEHOLDER;
  }

  /**
   * Generate a marketing script from a brief
   * @param {string} brief - Short description (1-5 sentences) of what to promote
   * @param {object} options - Additional options
   * @returns {Promise<{hook: string, problem: string, solution: string, cta: string}>}
   */
  async generateScript(brief, options = {}) {
    const activeProvider = this._getActiveProvider();

    // Estimate cost (Gemini Flash is essentially free)
    const costEstimate = estimateLLMCost('gemini', this.geminiModel, 500, 500);
    console.log(`[LLMProvider] Using ${activeProvider} provider (${costEstimate.formatted})`);
    console.log(`[LLMProvider] Brief: ${brief.substring(0, 100)}...`);

    if (activeProvider === PROVIDERS.PLACEHOLDER) {
      return this._generatePlaceholderScript(brief);
    }

    try {
      const result = await retry(async (attempt) => {
        if (attempt > 1) {
          console.log(`[LLMProvider] Retry attempt ${attempt}...`);
        }
        return await this._generateWithGemini(brief, options);
      }, this.retryConfig);

      // Track cost
      tracker.addOperation('llm', 'gemini', this.geminiModel, costEstimate.cost, { brief: brief.substring(0, 50) });

      return {
        ...result,
        costEstimate,
      };
    } catch (error) {
      console.error(`[LLMProvider] Error: ${error.message}`);
      console.log('[LLMProvider] Falling back to placeholder');
      return this._generatePlaceholderScript(brief, error.message);
    }
  }

  _generatePlaceholderScript(brief, error = null) {
    console.log('[LLMProvider] Generating placeholder script');

    return {
      hook: `Tired of the same old problems? There's a better way.`,
      problem: `We know how frustrating it can be when things don't work the way you need them to. You've tried everything, but nothing seems to stick.`,
      solution: `That's why we created something different. ${brief.substring(0, 100)}...`,
      cta: `Ready to make a change? Get started today and see the difference for yourself.`,
      provider: error ? 'placeholder-fallback' : 'placeholder',
      model: 'placeholder',
      error,
    };
  }

  async _generateWithGemini(brief, options = {}) {
    console.log(`[LLMProvider] Generating script with ${this.geminiModel}...`);

    const systemPrompt = options.systemPrompt || SCRIPT_SYSTEM_PROMPT;
    const userPrompt = `Create a marketing script for: ${brief}`;

    return new Promise((resolve, reject) => {
      const requestBody = {
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: options.temperature || 0.7,
          maxOutputTokens: options.maxTokens || 1024,
        }
      };

      const data = JSON.stringify(requestBody);

      const reqOptions = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(reqOptions, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);

            if (res.statusCode >= 400) {
              reject(new Error(json.error?.message || `HTTP ${res.statusCode}: ${body}`));
              return;
            }

            // Extract the text from the response
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) {
              reject(new Error('No text in Gemini response'));
              return;
            }

            // Parse the JSON from the response
            let script;
            try {
              // Handle nested structure if present
              const parsed = JSON.parse(text);
              script = parsed.script || parsed;
            } catch (e) {
              reject(new Error(`Failed to parse script JSON: ${text.substring(0, 200)}`));
              return;
            }

            // Validate required fields
            if (!script.hook || !script.problem || !script.solution || !script.cta) {
              reject(new Error('Script missing required sections'));
              return;
            }

            console.log('[LLMProvider] Script generated successfully');

            resolve({
              hook: script.hook,
              problem: script.problem,
              solution: script.solution,
              cta: script.cta,
              provider: 'gemini',
              model: this.geminiModel,
              usage: json.usageMetadata,
            });
          } catch (e) {
            reject(new Error(`Failed to parse Gemini response: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * Generate custom text (for other use cases beyond scripts)
   */
  async generateText(prompt, options = {}) {
    const activeProvider = this._getActiveProvider();

    if (activeProvider === PROVIDERS.PLACEHOLDER) {
      return { text: `[Placeholder response for: ${prompt.substring(0, 50)}...]`, provider: 'placeholder' };
    }

    return new Promise((resolve, reject) => {
      const requestBody = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature || 0.7,
          maxOutputTokens: options.maxTokens || 1024,
        }
      };

      if (options.jsonOutput) {
        requestBody.generationConfig.responseMimeType = 'application/json';
      }

      const data = JSON.stringify(requestBody);

      const reqOptions = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(reqOptions, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 400) {
              reject(new Error(json.error?.message || `HTTP ${res.statusCode}`));
              return;
            }

            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            resolve({
              text: text || '',
              provider: 'gemini',
              model: this.geminiModel,
              usage: json.usageMetadata,
            });
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // ==========================================
  // STATIC METHODS
  // ==========================================
  static defaultConfig() {
    return {
      provider: process.env.LLM_PROVIDER || PROVIDERS.GEMINI,
      useReal: process.env.USE_REAL_LLM_PROVIDER !== 'false',
      geminiApiKey: process.env.GEMINI_API_KEY,
      geminiModel: process.env.LLM_MODEL || 'gemini-2.0-flash',
    };
  }

  static getAvailableProviders() {
    return Object.values(PROVIDERS);
  }

  static getAvailableModels() {
    return {
      gemini: [
        'gemini-2.0-flash',        // Fast, cheap - great for scripts
        'gemini-2.0-flash-lite',   // Even faster/cheaper
        'gemini-1.5-flash',        // Stable alternative
      ],
    };
  }
}

module.exports = { LLMProvider, PROVIDERS, SCRIPT_SYSTEM_PROMPT };
