import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import imageTools, {
  createSceneImageRenderer,
  imageAttachment,
} from "../plugins/image-tools.ts";

const defaultModel = "x-ai/grok-imagine-image-quality";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=",
  "base64",
);
// Für JPEG und WebP werden nur die vom Plugin geprüften Dateisignaturen benötigt.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const webp = Buffer.from("RIFF0000WEBP", "ascii");
const context = { sessionID: "ses_test", signal: new AbortController().signal };

function response(images = [png]) {
  return Response.json({
    data: images.map((bytes) => ({ b64_json: bytes.toString("base64") })),
  });
}

function resultData(result) {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text.split("\n")[1]);
}

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "social-game-images-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = new Map();
  const requests = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return response();
  });
  const ctx = {
    location: { directory },
    session: { get: async () => ({ parentID: undefined }) },
    integration: {
      connection: {
        active: async () => ({ id: "test-connection" }),
        resolve: async () => ({ type: "key", key: "test-key" }),
      },
    },
    tool: {
      transform: async (register) =>
        register({ add: (tool) => tools.set(tool.name, tool) }),
    },
  };
  await imageTools.setup(ctx);

  async function put(relative, content) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return target;
  }

  return {
    directory,
    ctx,
    requests,
    fetch,
    put,
    execute: (name, input, toolContext = context) =>
      tools.get(name).execute(input, toolContext),
  };
}

async function sceneFixture(t, npcs = ["mira", "noah"]) {
  const fixtureData = await fixture(t);
  const { directory, ctx, put } = fixtureData;
  const root = ".data/session/ses_test";
  const scene = `${root}/scenes/cafe`;
  await put(
    `${root}/scene-context.json`,
    JSON.stringify({ scene: "cafe", npcs }),
  );
  await put(`${scene}/scene.md`, "Ein gemütliches Café.");
  await put(`${scene}/visual-state.md`, "Die Figuren sitzen am Fenster.");
  await put(`${scene}/img.png`, png);
  for (const npc of ["mira", "noah"]) {
    await put(`${root}/npcs/${npc}/description.md`, `Charakter ${npc}`);
    await put(`${root}/npcs/${npc}/state.md`, `${npc} ist entspannt.`);
    await put(`${root}/npcs/${npc}/img.png`, jpeg);
  }
  // Noah hat absichtlich keinen optionalen NPC-Szenenkontext.
  await put(
    `${root}/npcs/mira/scenes/cafe/scene.md`,
    "Mira trägt eine rote Jacke.",
  );
  return {
    ...fixtureData,
    sceneRoot: path.join(directory, scene),
    renderer: createSceneImageRenderer(ctx, directory),
  };
}

test("image_generate sends default settings and saves an attached image", async (t) => {
  const { directory, requests, execute } = await fixture(t);
  const result = await execute("image_generate", { prompt: "Ein Café" });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "https://openrouter.ai/api/v1/images");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, "Bearer test-key");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.deepEqual(request.body, {
    model: defaultModel,
    prompt: "Ein Café",
    n: 1,
  });
  assert.equal(request.signal.aborted, false);

  const data = resultData(result);
  assert.equal(data.model, defaultModel);
  assert.equal(data.images.length, 1);
  const image = data.images[0];
  assert.equal(
    path.dirname(image.path),
    path.join(directory, ".data/session/ses_test/images"),
  );
  assert.match(
    path.basename(image.path),
    /^image-\d{8}-\d{6}-[a-f0-9]{8}\.png$/,
  );
  assert.deepEqual(await readFile(image.path), png);
  assert.deepEqual(result.content[1], {
    type: "file",
    mime: "image/png",
    uri: `data:image/png;base64,${png.toString("base64")}`,
    name: path.basename(image.path),
  });
});

test("image_generate forwards options and saves multiple image formats", async (t) => {
  const { fetch, execute } = await fixture(t);
  fetch.mock.mockImplementation(async () => response([png, jpeg, webp]));
  const result = await execute("image_generate", {
    prompt: "Test",
    model: "openai/gpt-image-2",
    aspectRatio: "16:9",
    resolution: "2K",
  });
  assert.deepEqual(
    resultData(result).images.map((image) => image.mime),
    ["image/png", "image/jpeg", "image/webp"],
  );
  for (const [index, image] of resultData(result).images.entries()) {
    assert.match(image.path, new RegExp(`-${index + 1}\\.(png|jpg|webp)$`));
    assert.deepEqual(await readFile(image.path), [png, jpeg, webp][index]);
  }
  assert.equal(result.content.length, 4);
  const body = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.deepEqual(body, {
    model: "openai/gpt-image-2",
    prompt: "Test",
    n: 1,
    aspect_ratio: "16:9",
    resolution: "2K",
  });
});

test("image_edit preserves reference order and encodes local images", async (t) => {
  const { put, requests, execute } = await fixture(t);
  await put("reference.png", png);
  const result = await execute("image_edit", {
    prompt: "Figur einfügen",
    referenceImages: ["reference.png", "https://example.test/reference.jpg"],
  });
  assert.deepEqual(requests[0].body.input_references, [
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
    },
    {
      type: "image_url",
      image_url: { url: "https://example.test/reference.jpg" },
    },
  ]);
  assert.equal(resultData(result).operation, "edit");
});

for (const [reference, error] of [
  ["http://example.test/image.png", /lokaler Pfad oder eine HTTPS-URL/],
  ["data:image/png;base64,invalid", /lokaler Pfad oder eine HTTPS-URL/],
  ["../outside.png", /Dateizugriffe sind nur im Workspace erlaubt/],
  ["missing.png", /Referenzbild ist nicht lesbar/],
  ["invalid.txt", /Referenzbild muss PNG, JPEG oder WebP sein/],
]) {
  test(`image_edit rejects invalid reference ${reference} before fetching`, async (t) => {
    const { put, fetch, execute } = await fixture(t);
    await put("invalid.txt", "not an image");
    await assert.rejects(
      execute("image_edit", { prompt: "Test", referenceImages: [reference] }),
      error,
    );
    assert.equal(fetch.mock.callCount(), 0);
  });
}

test("image_edit checks the model reference limit before requesting credentials", async (t) => {
  const { ctx, fetch, execute } = await fixture(t);
  const active = t.mock.method(ctx.integration.connection, "active");
  await assert.rejects(
    execute("image_edit", {
      prompt: "Test",
      model: "x-ai/grok-imagine-image-2.0",
      referenceImages: Array(4).fill("https://example.test/image.png"),
    }),
    /höchstens 3 Referenzbilder/,
  );
  assert.equal(active.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

for (const [credential, error] of [
  [undefined, /nicht mit einem API-Key verbunden/],
  [
    { type: "oauth", access: "test-token" },
    /nicht mit einem API-Key verbunden/,
  ],
]) {
  test(`image_generate rejects missing API keys (${credential?.type ?? "none"})`, async (t) => {
    const { ctx, fetch, execute } = await fixture(t);
    t.mock.method(
      ctx.integration.connection,
      "resolve",
      async () => credential,
    );
    await assert.rejects(execute("image_generate", { prompt: "Test" }), error);
    assert.equal(fetch.mock.callCount(), 0);
  });
}

test("image_generate reports provider lookup failures", async (t) => {
  const { ctx, execute } = await fixture(t);
  t.mock.method(ctx.integration.connection, "active", async () => {
    throw new Error("provider unavailable");
  });
  await assert.rejects(
    execute("image_generate", { prompt: "Test" }),
    /OpenCode-Providerabfrage fehlgeschlagen/,
  );
});

for (const [label, makeResponse, error] of [
  [
    "HTTP errors",
    () => new Response("rate limited", { status: 429 }),
    /HTTP 429/,
  ],
  ["empty data", () => Response.json({ data: [] }), /keine Bilddaten/],
  ["missing data", () => Response.json({}), /keine Bilddaten/],
  [
    "invalid image data",
    () => Response.json({ data: [{}] }),
    /ungültige Bilddaten/,
  ],
  [
    "unsupported formats",
    () => response([Buffer.from("not an image")]),
    /Bildformat.*nicht unterstützt/,
  ],
]) {
  test(`image_generate reports ${label}`, async (t) => {
    const { fetch, execute } = await fixture(t);
    fetch.mock.mockImplementation(async () => makeResponse());
    await assert.rejects(execute("image_generate", { prompt: "Test" }), error);
  });
}

test("image_generate distinguishes network failure from cancellation", async (t) => {
  const { fetch, execute } = await fixture(t);
  fetch.mock.mockImplementation(async (_url, { signal }) => {
    if (signal.aborted) throw signal.reason;
    throw new Error("network offline");
  });
  await assert.rejects(
    execute("image_generate", { prompt: "Test" }),
    /OpenRouter-Anfrage fehlgeschlagen/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    execute(
      "image_generate",
      { prompt: "Test" },
      { ...context, signal: controller.signal },
    ),
    /Bildanfrage abgebrochen oder Zeitlimit erreicht/,
  );
});

test("imageAttachment rejects unsupported saved files", async (t) => {
  const { put } = await fixture(t);
  const file = await put("invalid.txt", "not an image");
  await assert.rejects(imageAttachment(file), /nicht unterstütztes Format/);
});

test("scene renderer builds the first image sequentially from all active NPCs", async (t) => {
  const { ctx, renderer, requests, sceneRoot, directory, put } =
    await sceneFixture(t);
  const session = t.mock.method(ctx.session, "get", async ({ sessionID }) => ({
    parentID: { ses_child: "ses_middle", ses_middle: "ses_test" }[sessionID],
  }));
  await put(".data/session/ses_test/scenes/cafe/image-pending", "pending\n");
  const rendered = await renderer.render({
    ...context,
    sessionID: "ses_child",
  });
  assert.deepEqual(
    session.mock.calls.map((call) => call.arguments[0].sessionID),
    ["ses_child", "ses_middle", "ses_test"],
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    rendered.debug.steps.map(({ action, npc }) => ({ action, npc })),
    [
      { action: "add", npc: "mira" },
      { action: "add", npc: "noah" },
    ],
  );
  assert.equal(
    rendered.debug.steps[0].references[0],
    ".data/session/ses_test/scenes/cafe/img.png",
  );
  assert.equal(
    rendered.debug.steps[1].references[0],
    ".data/session/ses_test/scenes/cafe/latest.png",
  );
  assert.match(requests[0].body.prompt, /Mira trägt eine rote Jacke/);
  assert.match(requests[0].body.prompt, /Die Figuren sitzen am Fenster/);
  assert.match(requests[1].body.prompt, /noah ist entspannt/);
  assert.equal(
    requests[0].body.input_references[1].image_url.url,
    `data:image/jpeg;base64,${jpeg.toString("base64")}`,
  );
  assert.equal(rendered.path, path.relative(directory, rendered.file));
  assert.equal(path.dirname(rendered.file), path.join(sceneRoot, "images"));
  assert.equal(
    await readlink(path.join(sceneRoot, "latest.png")),
    path.relative(sceneRoot, rendered.file),
  );
  await assert.rejects(readFile(path.join(sceneRoot, "image-pending")), {
    code: "ENOENT",
  });
});

test("scene renderer removes participants before adding new ones", async (t) => {
  const { renderer, requests, put } = await sceneFixture(t, ["noah"]);
  await put(".data/session/ses_test/scenes/cafe/latest.png", png);
  const rendered = await renderer.render(context, {
    removals: ["mira"],
    additions: ["noah"],
  });
  assert.deepEqual(
    rendered.debug.steps.map(({ action, npc }) => ({ action, npc })),
    [
      { action: "remove", npc: "mira" },
      { action: "add", npc: "noah" },
    ],
  );
  assert.equal(requests[0].body.input_references.length, 1);
  assert.equal(requests[1].body.input_references.length, 2);
  assert.match(requests[0].body.prompt, /entferne diese Figur vollständig/);
  assert.match(requests[1].body.prompt, /Neue Figur \(noah\)/);
});

test("scene_image_render updates the existing image and replaces obsolete latest links", async (t) => {
  const { fetch, put, sceneRoot, execute } = await sceneFixture(t);
  await put(".data/session/ses_test/scenes/cafe/latest.png", png);
  await put(".data/session/ses_test/scenes/cafe/latest.webp", webp);
  fetch.mock.mockImplementation(async () => response([jpeg]));
  const result = await execute("scene_image_render", {
    aspectRatio: "16:9",
    resolution: "2K",
  });
  const data = resultData(result);
  assert.deepEqual(
    data.debug.steps.map((step) => step.action),
    ["update"],
  );
  assert.deepEqual(data.debug.parameters, {
    n: 1,
    aspectRatio: "16:9",
    resolution: "2K",
  });
  assert.equal(result.content[1].mime, "image/jpeg");
  assert.equal(fetch.mock.callCount(), 1);
  const latest = await readlink(path.join(sceneRoot, "latest.jpg"));
  assert.equal(latest, path.join("images", path.basename(data.path)));
  await assert.rejects(readFile(path.join(sceneRoot, "latest.png")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(path.join(sceneRoot, "latest.webp")), {
    code: "ENOENT",
  });
});

test("scene_image_render marks failed rendering as pending and can retry", async (t) => {
  const { fetch, sceneRoot, execute } = await sceneFixture(t, ["mira"]);
  fetch.mock.mockImplementation(
    async () => new Response("unavailable", { status: 503 }),
  );
  await assert.rejects(execute("scene_image_render", {}), /HTTP 503/);
  assert.equal(
    await readFile(path.join(sceneRoot, "image-pending"), "utf8"),
    "pending\n",
  );
  fetch.mock.mockImplementation(async () => response());
  await execute("scene_image_render", {});
  await assert.rejects(readFile(path.join(sceneRoot, "image-pending")), {
    code: "ENOENT",
  });
});

test("scene_image_render rejects missing scenes without requesting images", async (t) => {
  const { fetch, execute } = await fixture(t);
  await assert.rejects(execute("scene_image_render", {}), /Keine aktive Szene/);
  assert.equal(fetch.mock.callCount(), 0);
});
