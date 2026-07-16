/**
 * Retry wrapper for async jobs. Kept intentionally small so it can become an SQS adapter later.
 * @template T
 * @param {string} jobName
 * @param {() => Promise<T>} fn
 * @param {number} [attempts]
 * @returns {Promise<T>}
 */
export async function runJob(jobName, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** (attempt - 1))));
    }
  }
  throw Object.assign(lastError instanceof Error ? lastError : new Error(String(lastError)), { jobName });
}
