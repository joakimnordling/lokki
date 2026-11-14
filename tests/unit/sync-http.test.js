// The server client's errors: which may pass by trying again, and how long a server asked to wait.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ServerClient, ServerError } from "../../packages/sync/http.js";

const answering = (status, headers = {}) =>
  new ServerClient("https://sync.example.com/", "lk_x", {
    fetch: async () => new Response(JSON.stringify({ error: "x", message: "m" }), { status, headers }),
  });

describe("server errors", () => {
  it("may pass when unreachable, too busy, or the server's own trouble", () => {
    for (const status of [0, 429, 500, 502, 503, 504]) assert.equal(new ServerError(status).passing, true, status);
    for (const status of [400, 401, 403, 404, 409, 413]) assert.equal(new ServerError(status).passing, false, status);
  });

  it("keep the seconds a server asked to wait", async () => {
    await assert.rejects(answering(429, { "Retry-After": "30" }).info(), (e) => e.retryAfter === 30);
    await assert.rejects(answering(503).info(), (e) => e.retryAfter === null && e.passing);
    await assert.rejects(answering(503, { "Retry-After": "soon" }).info(), (e) => e.retryAfter === null);
  });

  it("can't reach a server that doesn't answer", async () => {
    const offline = new ServerClient("https://sync.example.com", "lk_x", {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await assert.rejects(offline.info(), (e) => e.status === 0 && e.passing);
  });
});
