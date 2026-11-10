// A client for a sync server's HTTP API (docs/sync-protocol.md, section 5.3).

/** An error response: `status` is the HTTP status (0 when the server couldn't be reached), `body` the JSON, and
    `retryAfter` the seconds a server asked to wait (Retry-After), if any. */
export class ServerError extends Error {
  constructor(status, body, retryAfter = null) {
    super(body?.message || (status ? `HTTP ${status}` : "can't reach the server"));
    this.status = status;
    this.code = body?.error || (status ? "error" : "unreachable");
    this.body = body || {};
    this.retryAfter = retryAfter;
  }
  /** Whether trying again soon may work: unreachable, timed out, too many requests, or a server's own trouble. */
  get passing() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export class ServerClient {
  constructor(url, token, { fetch: fetchImpl = globalThis.fetch.bind(globalThis), timeout = 30000 } = {}) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.timeout = timeout;
  }

  async request(method, path, body) {
    let response;
    try {
      response = await this.fetch(this.url + path, {
        method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch {
      throw new ServerError(0);
    }
    if (response.status === 204) return null;
    let json = null;
    try {
      json = await response.json();
    } catch {}
    if (!response.ok) {
      const wait = Number(response.headers?.get("Retry-After"));
      throw new ServerError(response.status, json, Number.isFinite(wait) && wait > 0 ? wait : null);
    }
    return json;
  }

  info() {
    return this.request("GET", "/v1/info");
  }
  vault() {
    return this.request("GET", "/v1/vault");
  }
  putKeyring(base, keyring) {
    return this.request("PUT", "/v1/vault/keyring", { base, keyring });
  }
  pull(since, limit) {
    return this.request("GET", `/v1/vault/rows?since=${since}${limit ? `&limit=${limit}` : ""}`);
  }
  push(base, rows) {
    return this.request("POST", "/v1/vault/rows", { base, rows });
  }
  deleteVault() {
    return this.request("DELETE", "/v1/vault");
  }
}
