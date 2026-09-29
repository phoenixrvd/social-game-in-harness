import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import gameAvatar from "../plugins/game-avatar.ts";
import gameSession from "../plugins/game-session.ts";

const main = {
  sessionID: "ses_game",
  agent: "game-context",
  signal: new AbortController().signal,
};
const wizard = {
  ...main,
  sessionID: "ses_wizard",
  agent: "game-create-avatar",
};
const filter = {
  ...main,
  sessionID: "ses_child",
  agent: "game-avatar-context",
};
const profile =
  "# Avatar\n\nAnna, 30, Ärztin.\n\n## Aussehen\nBraune Haare.\n\n## Privat\nHöhenangst und Familiengeheimnis.";

async function fixture(run) {
  const directory = await mkdtemp("/tmp/opencode/social-game-avatar-");
  const registered = new Map();
  const ctx = {
    location: { directory },
    session: {
      get: async ({ sessionID }) => ({
        parentID: ["ses_child", "ses_wizard"].includes(sessionID)
          ? "ses_game"
          : undefined,
      }),
    },
    tool: {
      transform: async (register) =>
        register({ add: (tool) => registered.set(tool.name, tool) }),
    },
    integration: { connection: { active: async () => undefined } },
  };
  await gameAvatar.setup(ctx);
  await gameSession.setup(ctx);
  const call = async (name, args = {}, context = main) =>
    registered.get(name).execute(args, context);
  const parsed = async (...args) => JSON.parse((await call(...args)).content);
  const file = (...parts) => path.join(directory, ...parts);
  const write = async (relative, content) => {
    const target = file(relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  try {
    await write(
      ".data/session/ses_game/scenes/cafe/scene.md",
      "# Café\nEin ruhiges Café.",
    );
    await write(
      ".data/session/ses_game/npcs/vika/state.md",
      "relationship_stage: stranger",
    );
    await run({ directory, registered, call, parsed, file, write });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function create(call, extra = {}) {
  return call(
    "game_avatar_save",
    {
      avatar: "anna",
      name: "Anna",
      description: profile,
      mode: "create",
      ...extra,
    },
    wizard,
  );
}
const selection = {
  avatar: "anna",
  scene: "cafe",
  npcs: ["vika"],
  acquaintances: [
    {
      npc: "vika",
      history: "Kollegin seit zwei Jahren; kennt meinen Namen und Beruf.",
    },
  ],
};
const released = {
  visible: "Braune Haare.",
  known: [
    {
      npc: "vika",
      relationship: "Kollegin seit zwei Jahren",
      facts: ["Name: Anna", "Beruf: Ärztin"],
    },
  ],
};

test("avatar plugin registers strict schemas and never supplies standard avatars", async () => {
  await fixture(async ({ registered, parsed, write }) => {
    for (const tool of registered.values()) {
      assert.equal(tool.input.type, "object");
      assert.equal(tool.input.additionalProperties, false);
    }
    await write("avatars/standard/description.md", profile);
    await write("avatars/standard/avatar.json", '{"name":"Standard"}');
    assert.deepEqual(await parsed("game_avatar_catalog"), []);
    assert.equal((await parsed("game_player_status")).status, "unselected");
  });
});

test("wizard requires its own agent and confirmation-aware create/update; catalog exposes only name", async () => {
  await fixture(async ({ call, parsed, file }) => {
    await assert.rejects(
      create((name, args) => call(name, args)),
      /Nur game-create-avatar/,
    );
    await create(call);
    assert.deepEqual(await parsed("game_avatar_catalog"), [
      { id: "anna", name: "Anna" },
    ]);
    assert.equal(
      (await call("game_avatar_profile", { avatar: "anna" }, wizard)).content,
      `${profile}\n`,
    );
    await assert.rejects(
      call("game_avatar_profile", { avatar: "anna" }),
      /Nur game-create-avatar/,
    );
    await assert.rejects(create(call), /existiert bereits/);
    await assert.rejects(
      create(call, { avatar: "missing", mode: "update" }),
      /nicht vorhanden/,
    );
    await assert.rejects(
      create(call, { avatar: "../outside" }),
      /Ungültige ID/,
    );
    await create(call, {
      mode: "update",
      description: "Nur bestätigte Änderung.",
    });
    assert.equal(
      await readFile(file(".data/avatars/anna/description.md"), "utf8"),
      "Nur bestätigte Änderung.\n",
    );
  });
});

test("one-time child filter receives snapshot but parent and public files receive only released facts", async () => {
  await fixture(async ({ call, parsed, file, write }) => {
    await create(call);
    const selected = await parsed("game_player_select", selection);
    assert.deepEqual(selected, { status: "pending", avatar: "anna" });
    await create(call, { mode: "update", description: "Spätere Änderung." });
    await assert.rejects(
      call("game_avatar_filter_input"),
      /Nur game-avatar-context/,
    );
    const input = await parsed("game_avatar_filter_input", {}, filter);
    assert.equal(input.profile, `${profile}\n`);
    assert.match(input.sceneDescription, /Café/);
    assert.deepEqual(input.acquaintances, selection.acquaintances);
    assert.equal(input.npcCharacters, undefined);
    const ready = await parsed("game_avatar_filter_save", released, filter);
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.known, released.known);
    assert.deepEqual(await parsed("game_player_status"), ready);
    for (const name of ["context.json", "description.md", "state.md"]) {
      const publicContent = await readFile(
        file(`.data/session/ses_game/player/${name}`),
        "utf8",
      );
      assert.doesNotMatch(
        publicContent,
        /Höhenangst|Familiengeheimnis|Spätere Änderung/,
      );
    }
    await assert.rejects(
      call("game_avatar_filter_input", {}, filter),
      /nur vor/,
    );
    await assert.rejects(
      call("game_avatar_filter_save", released, filter),
      /abgeschlossen/,
    );
    await assert.rejects(
      call("game_player_select", selection),
      /bereits gewählt/,
    );
    await write(
      ".data/session/ses_game/scene-context.json",
      '{"scene":"office","npcs":["vika"]}',
    );
    assert.deepEqual(await parsed("game_player_status"), ready);
    await assert.rejects(
      call("game_avatar_filter_input", {}, filter),
      /nur vor/,
    );
  });
});

test("filter rejects fabricated NPC acquaintances and duplicate knowledge", async () => {
  await fixture(async ({ call }) => {
    await create(call);
    await assert.rejects(
      call("game_player_select", {
        ...selection,
        acquaintances: [{ npc: "stranger", history: "Bekannt" }],
      }),
      /Bekanntschaft ungültig/,
    );
    await call("game_player_select", selection);
    await assert.rejects(
      call("game_avatar_filter_save", released),
      /Nur game-avatar-context/,
    );
    await assert.rejects(
      call("game_avatar_filter_save", { ...released, known: [] }, filter),
      /unvollständig/,
    );
    await assert.rejects(
      call(
        "game_avatar_filter_save",
        { ...released, known: [{ ...released.known[0], npc: "stranger" }] },
        filter,
      ),
      /bestätigte Bekanntschaft/,
    );
    await assert.rejects(
      call(
        "game_avatar_filter_save",
        { ...released, known: [released.known[0], released.known[0]] },
        filter,
      ),
      /bestätigte Bekanntschaft/,
    );
  });
});

test("concurrent selection and filter commits cannot overwrite initialization", async () => {
  await fixture(async ({ call }) => {
    await create(call);
    const selections = await Promise.allSettled([
      call("game_player_select", selection),
      call("game_player_select", selection),
    ]);
    assert.equal(
      selections.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    const saves = await Promise.allSettled([
      call("game_avatar_filter_save", released, filter),
      call("game_avatar_filter_save", released, filter),
    ]);
    assert.equal(
      saves.filter(({ status }) => status === "fulfilled").length,
      1,
    );
  });
});

test("no-profile play keeps confirmed history and needs no filter; old sessions are not reinitialized", async () => {
  await fixture(async ({ call, parsed, write }) => {
    const player = await parsed("game_player_select", {
      ...selection,
      avatar: null,
    });
    assert.equal(player.status, "ready");
    assert.equal(player.avatar, null);
    assert.equal(
      player.known[0].relationship,
      selection.acquaintances[0].history,
    );
    await assert.rejects(
      call("game_avatar_filter_input", {}, filter),
      /nur vor/,
    );
    const legacy = { ...main, sessionID: "ses_legacy" };
    await write(
      ".data/session/ses_legacy/scene-context.json",
      '{"scene":"cafe","npcs":["vika"]}',
    );
    assert.deepEqual(await parsed("game_player_status", {}, legacy), {
      status: "legacy",
    });
    await assert.rejects(
      call("game_player_select", { ...selection, avatar: null }, legacy),
      /bereits gewählt/,
    );
  });
});

test("scene cannot start until player selection and filtering finish", async () => {
  await fixture(async ({ call }) => {
    const scene = {
      scene: "cafe",
      npcs: ["vika"],
      visualState: "Vika sitzt am Fenster.",
      render: "never",
    };
    await assert.rejects(
      call("game_scene_update", scene),
      /Spielerinitialisierung/,
    );
    await create(call);
    await call("game_player_select", selection);
    await assert.rejects(
      call("game_scene_update", scene),
      /Spielerinitialisierung/,
    );
    await call("game_avatar_filter_save", released, filter);
    assert.match(
      (await call("game_scene_update", scene)).content,
      /gespeichert/,
    );
  });
});

test("optional avatar image stays private and cannot be copied from arbitrary files", async () => {
  await fixture(async ({ call, file, write }) => {
    await write("outside.png", "outside");
    await assert.rejects(
      create(call, { image: "outside.png" }),
      /aktuellen Session/,
    );
    await write(".data/session/ses_game/images/parent.png", "parent");
    await assert.rejects(
      create(call, { image: ".data/session/ses_game/images/parent.png" }),
      /aktuellen Session/,
    );
    await write(".data/session/ses_wizard/images/portrait.png", "portrait");
    await create(call, {
      image: ".data/session/ses_wizard/images/portrait.png",
    });
    await create(call, { mode: "update" });
    await call("game_player_select", selection);
    assert.equal(
      await readFile(
        file(".data/session/ses_game/player/private/img.png"),
        "utf8",
      ),
      "portrait",
    );
    await assert.rejects(
      readFile(file(".data/session/ses_game/player/img.png")),
      { code: "ENOENT" },
    );
  });
});

test("child wizard returns only saved avatar ID and status, then the parent selects and filters it", async () => {
  await fixture(async ({ call, parsed }) => {
    const saved = JSON.parse((await create(call)).content);
    assert.deepEqual(saved, { avatar: "anna", status: "saved" });
    assert.deepEqual(await parsed("game_player_status"), {
      status: "unselected",
    });
    await call("game_player_select", { ...selection, avatar: saved.avatar });
    assert.equal((await parsed("game_player_status")).status, "pending");
    const input = await parsed("game_avatar_filter_input", {}, filter);
    assert.equal(input.profile, `${profile}\n`);
    await call("game_avatar_filter_save", released, filter);
    const player = await parsed("game_player_status");
    assert.equal(player.status, "ready");
    assert.doesNotMatch(
      JSON.stringify({ saved, player }),
      /Höhenangst|Familiengeheimnis/,
    );
  });
});

test("standalone wizard still accepts images from its own session", async () => {
  await fixture(async ({ call, write, file }) => {
    const standalone = { ...wizard, sessionID: "ses_standalone" };
    await write(
      ".data/session/ses_standalone/images/portrait.png",
      "standalone",
    );
    const result = await call(
      "game_avatar_save",
      {
        avatar: "anna",
        name: "Anna",
        description: profile,
        mode: "create",
        image: ".data/session/ses_standalone/images/portrait.png",
      },
      standalone,
    );
    assert.deepEqual(JSON.parse(result.content), {
      avatar: "anna",
      status: "saved",
    });
    assert.equal(
      await readFile(file(".data/avatars/anna/img.png"), "utf8"),
      "standalone",
    );
  });
});

test("agent definitions allow interactive wizard delegation without a manual session switch", async () => {
  const agents = new URL("../agent/", import.meta.url);
  const wizardPrompt = await readFile(
    new URL("game-create-avatar.md", agents),
    "utf8",
  );
  const coordinator = await readFile(
    new URL("game-context.md", agents),
    "utf8",
  );
  assert.match(wizardPrompt, /^mode: all$/m);
  for (const action of ["question", "execute"]) {
    assert.match(
      wizardPrompt,
      new RegExp(`action: ${action}\\n\\s+resource: "\\*"\\n\\s+effect: allow`),
    );
  }
  assert.match(
    coordinator,
    /action: subagent\n\s+resource: game-create-avatar\n\s+effect: allow/,
  );
  assert.match(wizardPrompt, /Bestätigung direkt über `question`/);
  assert.doesNotMatch(
    coordinator,
    /verweise auf den Agenten `game-create-avatar`|delegiere den interaktiven Wizard nicht/,
  );
});

test("explicit player state stays session-local without reopening filter or changing profile", async () => {
  await fixture(async ({ call, parsed, file }) => {
    await assert.rejects(
      call("game_player_state_update", { content: "Position: Eingang." }),
      /initialisierter Spieler/,
    );
    await create(call);
    await call("game_player_select", selection);
    await call("game_avatar_filter_save", released, filter);
    const start = await parsed("game_player_status");
    await call("game_player_state_update", {
      content:
        "# Spielerzustand\n\nDer Nutzer hat sich ausdrücklich ans Fenster gesetzt.",
    });
    assert.match(
      await readFile(file(".data/session/ses_game/player/state.md"), "utf8"),
      /ans Fenster/,
    );
    assert.equal(
      await readFile(file(".data/avatars/anna/description.md"), "utf8"),
      `${profile}\n`,
    );
    assert.deepEqual(await parsed("game_player_status"), start);
    assert.deepEqual(
      await parsed(
        "game_player_status",
        {},
        { ...main, sessionID: "ses_other" },
      ),
      { status: "unselected" },
    );
    await assert.rejects(
      call("game_avatar_filter_input", {}, filter),
      /nur vor/,
    );
    await assert.rejects(
      call(
        "game_player_state_update",
        { content: "Erfundene Reaktion." },
        filter,
      ),
      /Nur game-context/,
    );
  });
});
