export type FetchLike = typeof fetch;

/** Reject remote model endpoints so vault content cannot leave the device silently. */
export function assertLoopbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid local model URL: ${value}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Context Bucket only supports local HTTP model servers.");
  }
  if (!loopback || url.username || url.password) {
    throw new Error("Context Bucket only connects to localhost, 127.0.0.1, or [::1].");
  }
  return url;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface JsonRequestOptions extends RequestInit {
  timeoutMs?: number;
  fetcher?: FetchLike;
}

export async function requestLocalJson<T>(urlValue: string, options: JsonRequestOptions = {}): Promise<T> {
  const url = assertLoopbackUrl(urlValue);
  const { timeoutMs = 30_000, fetcher = fetch, signal, ...request } = options;
  const timeout = new AbortController();
  const timer = globalThis.setTimeout(() => timeout.abort(new Error("The local model request timed out.")), timeoutMs);
  const abort = (): void => timeout.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  try {
    const response = await fetcher(url, {
      ...request,
      signal: timeout.signal,
      headers: { "Content-Type": "application/json", ...request.headers },
    });
    const body = await response.text();
    if (!response.ok) {
      const detail = body.slice(0, 300).trim();
      throw new Error(detail || `Local model server returned ${response.status}.`);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error("The local model server returned invalid JSON.");
    }
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
