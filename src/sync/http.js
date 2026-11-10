// A client for a sync server's HTTP API (docs/sync-protocol.md, section 5.3).

/** An error response: `status` is the HTTP status (0 when the server couldn't be reached), `body` the JSON. */
export class ServerError extends Error {
  constructor(status, body) {
    super(body?.message || (status ? `HTTP ${status}` : "can't reach the server"));
    this.status = status;
    this.code = body?.error || (status ? "error" : "unreachable");
    this.body = body || {};
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
    if (!response.ok) throw new ServerError(response.status, json);
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
