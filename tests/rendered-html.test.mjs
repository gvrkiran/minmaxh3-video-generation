import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the H3 Remote Studio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>H3 Remote Studio<\/title>/i);
  assert.match(html, /Turn a thought into motion/);
  assert.match(html, /Consistent characters/);
  assert.match(html, /All generated videos/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/i);
});

test("keeps multi-character R2V mapping explicit and automatic", async () => {
  const [page, generateRoute, enhanceRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/enhance/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /References sent to MiniMax/);
  assert.match(page, /automatic cast board/i);
  assert.match(page, /referenceLayout/);
  assert.match(generateRoute, /createCastBoard/);
  assert.match(generateRoute, /cast-board-/);
  assert.match(generateRoute, /Multiple selected characters use one automatic cast board/);
  assert.match(enhanceRoute, /REFERENCE CAST BOARD/);
  assert.match(enhanceRoute, /<d>\[Language\]/);
  assert.match(enhanceRoute, /fully_preserved/);
});
