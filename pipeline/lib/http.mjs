// Tiny HTTP helper: polite fetch w/ retry, JSON parse, optional concurrency map.

const UA = "repo-software-audit (+https://metaudits.rijdho.org)";

export async function fetchJson(url, { retries = 5, timeoutMs = 30000 } = {}) {
  // Two failure modes need distinct backoffs:
  //   - Throwable errors (timeout, network) → exponential 1s, 2s, 4s, 8s, 16s
  //   - 429 / 5xx server status → longer backoff because DataCite throttles hard
  //     when concurrent clients hammer /dois; respect Retry-After when sent.
  // After all retries we throw a NAMED Error — previously a 429-exhaust path
  // threw undefined which produced unparseable "error: undefined" cache entries.
  let lastErr = new Error(`exhausted retries for ${url}`);
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/vnd.api+json, application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const wait = retryAfter > 0
          ? retryAfter * 1000
          : 2000 * Math.pow(2, attempt);             // 2s, 4s, 8s, 16s, 32s
        lastErr = new Error(`HTTP ${res.status} for ${url}; retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e ?? new Error(`unknown fetch error for ${url}`);
      if (attempt < retries - 1) await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

export async function fetchText(url, { retries = 2, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xml,*/*" },
        signal: ctrl.signal,
        redirect: "follow",
      });
      clearTimeout(t);
      if (!res.ok) return { status: res.status, text: "", finalUrl: res.url };
      const text = await res.text();
      return { status: res.status, text, finalUrl: res.url };
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries - 1) await sleep(500 * (attempt + 1));
    }
  }
  return { status: 0, text: "", finalUrl: url, error: String(lastErr) };
}

export async function probeLiveness(url, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    return { status: res.status, ok: res.ok, finalUrl: res.url };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, ok: false, error: String(e?.name || e) };
  }
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function mapConcurrent(items, worker, concurrency = 8, onProgress) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx], idx); }
      catch (e) { out[idx] = { __error: String(e) }; }
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  if (onProgress) onProgress(done, items.length);
  return out;
}
