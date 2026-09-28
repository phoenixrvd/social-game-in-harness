import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import gameSession from "../plugins/game-session.ts";
import imageTools from "../plugins/image-tools.ts";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function tools(directory = workspace) {
  const registered = new Map();
  const context = {
    location: { directory },
    session: { get: async () => ({ parentID: undefined }) },
    tool: {
      transform: async (register) => {
        register({
          add: (definition) => registered.set(definition.name, definition),
        });
      },
    },
    integration: { connection: { active: async () => undefined } },
  };

  await gameSession.setup(context);
  await imageTools.setup(context);
  return registered;
}

test("V2 plugins register all game and image tools", async () => {
  assert.equal(gameSession.id, "social-game.session");
  assert.equal(imageTools.id, "social-game.images");

  const registered = await tools();
  assert.deepEqual(
    [...registered.keys()],
    [
      "game_session",
      "game_session_prepare",
      "game_catalog",
      "game_content_status",
      "game_content_read",
      "game_create_npc",
      "game_create_scene",
      "game_update_npc",
      "game_scene_update",
      "game_state_updates",
      "image_generate",
      "image_edit",
      "scene_image_render",
    ],
  );
  for (const definition of registered.values()) {
    assert.equal(definition.input.type, "object", definition.name);
    assert.equal(definition.input.additionalProperties, false, definition.name);
  }
});

test("session and catalog tools return usable V2 content", async () => {
  const registered = await tools();
  const session = await registered
    .get("game_session")
    .execute({}, { sessionID: "ses_test" });
  assert.match(session.content, /\.data\/session\/ses_test\//);

  const catalog = await registered
    .get("game_catalog")
    .execute({ kind: "scenes" }, {});
  assert.ok(JSON.parse(catalog.content).some((scene) => scene.id === "cafe"));

  const status = await registered
    .get("game_content_status")
    .execute({ kind: "npcs", name: "Mira" }, {});
  assert.equal(JSON.parse(status.content).id, "mira");
});

test("image tools reject unknown models before requesting credentials", async () => {
  const registered = await tools();
  await assert.rejects(
    registered
      .get("image_generate")
      .execute({ prompt: "Test", model: "unknown" }, {}),
    /Unbekanntes Modell/,
  );
  assert.equal(
    registered.get("image_generate").options.permission,
    "image_generate",
  );
  assert.equal(registered.get("image_edit").options.permission, "image_edit");
});

test("scene state is written only when its contents change", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "social-game-state-"));
  try {
    const registered = await tools(directory);
    const update = registered.get("game_scene_update");
    const context = {
      sessionID: "ses_test",
      signal: new AbortController().signal,
    };
    const state = {
      scene: "cafe",
      npcs: ["mira"],
      visualState: "Mira sitzt am Fenster.",
      render: "never",
    };
    const sceneRoot = path.join(
      directory,
      ".data/session/ses_test/scenes/cafe",
    );
    const visualFile = path.join(sceneRoot, "visual-state.md");
    const contextFile = path.join(
      directory,
      ".data/session/ses_test/scene-context.json",
    );

    await update.execute(state, context);
    assert.equal(await readFile(visualFile, "utf8"), `${state.visualState}\n`);
    const oldTime = new Date("2000-01-01T00:00:00Z");
    await utimes(visualFile, oldTime, oldTime);
    await utimes(contextFile, oldTime, oldTime);

    await update.execute(state, context);
    assert.equal((await stat(visualFile)).mtimeMs, oldTime.getTime());
    assert.equal((await stat(contextFile)).mtimeMs, oldTime.getTime());

    await update.execute(
      { ...state, visualState: "Mira steht am Fenster." },
      context,
    );
    assert.equal(
      await readFile(visualFile, "utf8"),
      "Mira steht am Fenster.\n",
    );
    assert.notEqual((await stat(visualFile)).mtimeMs, oldTime.getTime());
    assert.equal((await stat(contextFile)).mtimeMs, oldTime.getTime());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
