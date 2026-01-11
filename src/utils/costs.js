/**
 * Cost Estimation Utility
 * Tracks estimated costs for all AI provider operations
 */

// Pricing data (as of Jan 2025)
const PRICING = {
  // ==========================================
  // GEMINI (Google AI)
  // ==========================================
  gemini: {
    // Image Generation - Nano Banana Pro
    'gemini-3-pro-image-preview': {
      type: 'image',
      costPer: 0.04,        // ~$0.04 per image
      unit: 'image',
      description: 'Nano Banana Pro - Best quality image generation',
    },
    'gemini-2.0-flash': {
      type: 'text',
      inputCostPer1k: 0.0001,   // $0.10 per 1M input tokens
      outputCostPer1k: 0.0004,  // $0.40 per 1M output tokens
      unit: 'tokens',
      description: 'Gemini 2.0 Flash - Fast text generation',
    },
    // Video Generation - Veo
    'veo-3.0-fast-generate-001': {
      type: 'video',
      costPerSec: 0.15,     // ~$0.15 per second
      unit: 'second',
      description: 'Veo 3.0 Fast - Quick video generation',
    },
    'veo-3.0-generate-001': {
      type: 'video',
      costPerSec: 0.40,     // ~$0.40 per second
      unit: 'second',
      description: 'Veo 3.0 Standard - Higher quality',
    },
    'veo-3.1-generate-preview': {
      type: 'video',
      costPerSec: 0.40,
      unit: 'second',
      description: 'Veo 3.1 Preview - Latest features',
    },
    'veo-2.0-generate-001': {
      type: 'video',
      costPerSec: 0.35,
      unit: 'second',
      description: 'Veo 2.0 - Stable video generation',
    },
  },

  // ==========================================
  // REPLICATE
  // ==========================================
  replicate: {
    // Image Generation
    'black-forest-labs/flux-1.1-pro': {
      type: 'image',
      costPer: 0.04,        // ~$0.04 per image
      unit: 'image',
      description: 'Flux 1.1 Pro - High quality images',
    },
    // Video Generation - Kling
    'kwaivgi/kling-v2.6': {
      type: 'video',
      costPer: 0.35,        // ~$0.35 per run (5s video)
      costPer10s: 0.70,     // ~$0.70 for 10s video
      unit: 'run',
      description: 'Kling 2.6 - Video with native audio',
    },
    'kwaivgi/kling-v2.6-motion-control': {
      type: 'video',
      costPer: 0.34,        // ~$0.34 per run
      unit: 'run',
      description: 'Kling 2.6 Motion Control - Motion transfer',
    },
  },

  // ==========================================
  // PLACEHOLDER (Free)
  // ==========================================
  placeholder: {
    'placeholder': {
      type: 'any',
      costPer: 0,
      unit: 'run',
      description: 'Local placeholder - Free',
    },
  },
};

/**
 * Estimate cost for an image generation
 */
function estimateImageCost(provider, model, count = 1) {
  const pricing = PRICING[provider]?.[model];
  if (!pricing) {
    return { cost: 0, formatted: 'Unknown', model, provider };
  }

  const cost = pricing.costPer * count;
  return {
    cost,
    formatted: formatCost(cost),
    model,
    provider,
    description: pricing.description,
    breakdown: `${count} image${count > 1 ? 's' : ''} @ $${pricing.costPer.toFixed(3)}/image`,
  };
}

/**
 * Estimate cost for a video generation
 */
function estimateVideoCost(provider, model, durationSec = 5) {
  const pricing = PRICING[provider]?.[model];
  if (!pricing) {
    return { cost: 0, formatted: 'Unknown', model, provider };
  }

  let cost;
  let breakdown;

  if (pricing.costPerSec) {
    // Per-second pricing (Veo)
    cost = pricing.costPerSec * durationSec;
    breakdown = `${durationSec}s @ $${pricing.costPerSec.toFixed(2)}/sec`;
  } else if (pricing.costPer10s && durationSec > 5) {
    // Tiered pricing (Kling)
    cost = pricing.costPer10s;
    breakdown = `10s video @ $${pricing.costPer10s.toFixed(2)}`;
  } else {
    // Per-run pricing
    cost = pricing.costPer;
    breakdown = `${durationSec}s video @ $${pricing.costPer.toFixed(2)}/run`;
  }

  return {
    cost,
    formatted: formatCost(cost),
    model,
    provider,
    description: pricing.description,
    breakdown,
    durationSec,
  };
}

/**
 * Estimate cost for text/LLM generation
 */
function estimateLLMCost(provider, model, inputTokens = 500, outputTokens = 500) {
  const pricing = PRICING[provider]?.[model];
  if (!pricing) {
    return { cost: 0, formatted: 'Free*', model, provider };
  }

  const inputCost = (inputTokens / 1000) * pricing.inputCostPer1k;
  const outputCost = (outputTokens / 1000) * pricing.outputCostPer1k;
  const cost = inputCost + outputCost;

  return {
    cost,
    formatted: cost < 0.001 ? '<$0.01' : formatCost(cost),
    model,
    provider,
    description: pricing.description,
    breakdown: `~${inputTokens + outputTokens} tokens`,
  };
}

/**
 * Estimate total project cost
 */
function estimateProjectCost(config) {
  const {
    imageProvider = 'gemini',
    imageModel = 'gemini-3-pro-image-preview',
    videoProvider = 'gemini',
    videoModel = 'veo-3.0-fast-generate-001',
    llmModel = 'gemini-2.0-flash',
    shotCount = 4,
    videoDuration = 4,
    regenerations = 0,
  } = config;

  const imageCost = estimateImageCost(imageProvider, imageModel, shotCount + regenerations);
  const videoCost = estimateVideoCost(videoProvider, videoModel, videoDuration);
  const totalVideoCost = videoCost.cost * (shotCount + regenerations);
  const llmCost = estimateLLMCost('gemini', llmModel);

  const totalCost = imageCost.cost + totalVideoCost + llmCost.cost;

  return {
    total: {
      cost: totalCost,
      formatted: formatCost(totalCost),
    },
    breakdown: {
      images: {
        ...imageCost,
        count: shotCount + regenerations,
      },
      videos: {
        cost: totalVideoCost,
        formatted: formatCost(totalVideoCost),
        count: shotCount + regenerations,
        perVideo: videoCost,
      },
      llm: llmCost,
    },
    summary: `Est. $${totalCost.toFixed(2)} for ${shotCount} shots`,
  };
}

/**
 * Format cost for display
 */
function formatCost(cost) {
  if (cost === 0) return 'Free';
  if (cost < 0.01) return '<$0.01';
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Get provider info with costs
 */
function getProviderInfo() {
  return {
    image: {
      gemini: {
        name: 'Gemini (Nano Banana Pro)',
        model: 'gemini-3-pro-image-preview',
        cost: '$0.04/image',
        recommended: true,
        reason: 'Best quality, uses your $300 credits',
      },
      replicate: {
        name: 'Replicate (Flux 1.1 Pro)',
        model: 'black-forest-labs/flux-1.1-pro',
        cost: '$0.04/image',
        recommended: false,
        reason: 'Great alternative, separate billing',
      },
    },
    video: {
      gemini: {
        name: 'Gemini (Veo 3.0 Fast)',
        model: 'veo-3.0-fast-generate-001',
        cost: '$0.15/sec (~$0.60 for 4s)',
        recommended: true,
        reason: 'Fast, uses your $300 credits',
      },
      replicate: {
        name: 'Replicate (Kling 2.6)',
        model: 'kwaivgi/kling-v2.6',
        cost: '$0.35/run (5s)',
        recommended: false,
        reason: 'Native audio, separate billing',
      },
    },
    llm: {
      gemini: {
        name: 'Gemini 2.0 Flash',
        model: 'gemini-2.0-flash',
        cost: '<$0.01/script',
        recommended: true,
        reason: 'Fast, essentially free',
      },
    },
  };
}

/**
 * Track actual costs (for session totals)
 */
class CostTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.session = {
      startTime: Date.now(),
      operations: [],
      totals: {
        images: 0,
        videos: 0,
        llm: 0,
        total: 0,
      },
    };
  }

  addOperation(type, provider, model, cost, metadata = {}) {
    const operation = {
      timestamp: Date.now(),
      type,
      provider,
      model,
      cost,
      ...metadata,
    };

    this.session.operations.push(operation);
    this.session.totals[type] = (this.session.totals[type] || 0) + cost;
    this.session.totals.total += cost;

    return operation;
  }

  getSessionSummary() {
    return {
      duration: Date.now() - this.session.startTime,
      operationCount: this.session.operations.length,
      totals: this.session.totals,
      formatted: formatCost(this.session.totals.total),
    };
  }

  getOperations() {
    return this.session.operations;
  }
}

// Singleton tracker
const tracker = new CostTracker();

module.exports = {
  PRICING,
  estimateImageCost,
  estimateVideoCost,
  estimateLLMCost,
  estimateProjectCost,
  formatCost,
  getProviderInfo,
  CostTracker,
  tracker,
};
