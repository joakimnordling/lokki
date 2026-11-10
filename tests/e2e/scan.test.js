// Scan QR Code: Chromium's fake camera shows a pairing code, which fills in the Sync screen.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { home, startHarness, toastText } from "./harness.js";

/**
 * A video for Chromium's fake camera (y4m: one raw frame, which it repeats) showing the QR code of
 * lokki:sync?url=https%3A%2F%2Fsync1.example.com&token=lk_abc-DEF_123, made with segno. It's
 * drawn in light modules on dark, as `token add --qr` comes out on a terminal with a light
 * background: the harder case.
 */
async function cameraVideo() {
  const rows = (await readFile(new URL("media/pairing-qr.txt", import.meta.url), "utf8")).trim().split("\n");
  const [W, H, SCALE] = [640, 480, 5];
  const side = (rows.length + 8) * SCALE; // with a quiet zone of 4 modules
  const [left, top] = [(W - side) >> 1, (H - side) >> 1];
  const luma = Buffer.alloc(W * H, 128); // grey around it
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const dark = rows[Math.floor(y / SCALE) - 4]?.[Math.floor(x / SCALE) - 4] === "#";
      luma[(top + y) * W + left + x] = dark ? 235 : 16;
    }
  const file = join(await mkdtemp(join(tmpdir(), "lokki-scan-")), "camera.y4m");
  const chroma = Buffer.alloc((W * H) / 2, 128); // no colour: two quarter-size planes
  await writeFile(
    file,
    Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\nFRAME\n`), luma, chroma]),
  );
  return file;
}

describe("scanning a pairing code", () => {
  let h, P, video;
  const open = async () => {
    await home(P);
    await P.click("#hSet");
    await P.click("#sSync");
  };

  before(async () => {
    video = await cameraVideo();
    h = await startHarness({
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-video-capture=${video}`,
      ],
    });
    P = await h.device("/site/", { claude: false, wait: 0 });
    await P.context().grantPermissions(["camera"]);
    await P.waitForSelector("#cCreate");
  });
  after(async () => {
    await h.close();
    await rm(dirname(video), { recursive: true });
  });

  it("fills in the URL and token", async () => {
    await open();
    await P.click("#sScan");
    await P.waitForSelector(".scan video");
    await P.waitForSelector(".scan", { state: "detached", timeout: 20000 });
    assert.equal(await P.inputValue("#sUrl"), "https://sync1.example.com");
    assert.equal(await P.inputValue("#sToken"), "lk_abc-DEF_123");
    assert.equal(await toastText(P, /QR code/), "Filled in from the QR code.");
  });

  it("Cancel closes the camera and leaves the fields alone", async () => {
    await open();
    await P.fill("#sUrl", "https://typed.example.com");
    await P.click("#sScan");
    await P.click("#scanCancel");
    await P.waitForSelector(".scan", { state: "detached" });
    assert.equal(await P.inputValue("#sUrl"), "https://typed.example.com");
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
