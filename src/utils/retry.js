/**
 * Retry Utility with Exponential Backoff
 * Handles transient failures gracefully
 */

const DEFAULT_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'rate limit',
    'quota exceeded',
    '429',
    '500',
    '502',
    '503',
    '504',
  ],
  onRetry: null, // callback(attempt, error, delay)
};

/**
 * Check if an error is retryable
 */
function isRetryable(error, retryableErrors) {
  const errorString = error.message?.toLowerCase() || String(error).toLowerCase();
  const errorCode = error.code?.toLowerCase() || '';

  return retryableErrors.some(pattern => {
    const p = pattern.toLowerCase();
    return errorString.includes(p) || errorCode.includes(p);
  });
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt, initialDelay, maxDelay, multiplier) {
  const exponentialDelay = initialDelay * Math.pow(multiplier, attempt - 1);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Sleep for a given duration
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise} - Result of the function
 */
async function retry(fn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      // Check if we've exhausted retries
      if (attempt > opts.maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryable(error, opts.retryableErrors)) {
        console.log(`[Retry] Non-retryable error: ${error.message}`);
        break;
      }

      // Calculate delay
      const delay = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier
      );

      console.log(`[Retry] Attempt ${attempt}/${opts.maxRetries} failed: ${error.message}`);
      console.log(`[Retry] Retrying in ${Math.round(delay / 1000)}s...`);

      // Call retry callback if provided
      if (opts.onRetry) {
        opts.onRetry(attempt, error, delay);
      }

      await sleep(delay);
    }
  }

  // All retries exhausted
  throw lastError;
}

/**
 * Create a retry wrapper for a class method
 */
function withRetry(fn, options = {}) {
  return async function (...args) {
    return retry(() => fn.apply(this, args), options);
  };
}

/**
 * Provider-specific retry configurations
 */
const PROVIDER_RETRY_CONFIGS = {
  gemini: {
    maxRetries: 3,
    initialDelayMs: 2000,
    retryableErrors: [
      'rate limit',
      'quota exceeded',
      '429',
      '500',
      '503',
      'RESOURCE_EXHAUSTED',
    ],
  },
  replicate: {
    maxRetries: 3,
    initialDelayMs: 1000,
    retryableErrors: [
      'rate limit',
      '429',
      '500',
      '503',
      'processing',
    ],
  },
  default: DEFAULT_OPTIONS,
};

/**
 * Get retry config for a provider
 */
function getRetryConfig(provider) {
  return PROVIDER_RETRY_CONFIGS[provider] || PROVIDER_RETRY_CONFIGS.default;
}

module.exports = {
  retry,
  withRetry,
  isRetryable,
  calculateDelay,
  sleep,
  getRetryConfig,
  PROVIDER_RETRY_CONFIGS,
  DEFAULT_OPTIONS,
};
