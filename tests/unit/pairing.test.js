// The text in a pairing QR code, as the command line's `token add --qr` writes it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pairingText, parsePairing } from "../../packages/sync/pairing.js";

// The same example is in the server's tests (servers/python/tests/test_pairing.py)
const URL = "https://sync1.example.com";
const TOKEN = "lk_abc-DEF_123";
const TEXT = "lokki:sync?url=https%3A%2F%2Fsync1.example.com&token=lk_abc-DEF_123";

describe("pairing codes", () => {
  it("are written like the command line writes them", () => {
    assert.equal(pairingText(URL, TOKEN, "lokki"), TEXT);
  });

  it("are read back", () => {
    assert.deepEqual(parsePairing(TEXT, "lokki"), { url: URL, token: TOKEN });
    assert.deepEqual(parsePairing(pairingText("http://localhost:8000/sync?x=1&y", "t+/=", "lokki"), "lokki"), {
      url: "http://localhost:8000/sync?x=1&y",
      token: "t+/=",
    });
  });

  it("start with the app's name, and each app takes only its own", () => {
    const other = pairingText(URL, TOKEN, "other-app");
    assert.equal(other, TEXT.replace("lokki:", "other-app:"));
    assert.deepEqual(parsePairing(other, "other-app"), { url: URL, token: TOKEN });
    assert.equal(parsePairing(other, "lokki"), null);
    assert.equal(parsePairing(TEXT, "other-app"), null);
    assert.throws(() => pairingText(URL, TOKEN, "Not An App"), TypeError);
  });

  it("other codes aren't", () => {
    for (const text of [
      null,
      "",
      "https://sync1.example.com",
      "lokki:other?url=https%3A%2F%2Fa.example.com&token=t",
      "lokki:sync?token=t",
      "lokki:sync?url=https%3A%2F%2Fa.example.com",
      "lokki:sync?url=ftp%3A%2F%2Fa.example.com&token=t",
      "lokki:sync?url=javascript%3Aalert(1)&token=t",
      "lokki:sync?url=https%3A%2F%2Fa.example.com&token=two%20words",
    ])
      assert.equal(parsePairing(text, "lokki"), null, String(text));
  });
});
