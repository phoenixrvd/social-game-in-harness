import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

type Selection = {
  avatar: string | null;
  scene: string;
  npcs: string[];
  acquaintances: { npc: string; history: string }[];
};
type PlayerContext = {
  avatar: string | null;
  visible: string;
  known: { npc: string; relationship: string; facts: string[] }[];
};
type AvatarProfile = {
  avatar: string;
  name: string;
  description: string;
  image?: string;
  mode: "create" | "update";
};
type FilteredPlayerContext = Omit<PlayerContext, "avatar">;

const initialPlayerState =
  "# Spielerzustand\n\nNur ausdrücklich beschriebene Handlungen und Angaben übernehmen.\n";

function validateID(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Ungültige ID");
}

function requireAgent(context: ToolContext, agent: string) {
  if (context.agent !== agent) {
    throw new Error(`Nur ${agent} darf dieses Werkzeug verwenden`);
  }
}

function validateSelection(selection: Selection) {
  validateID(selection.scene);
  selection.npcs.forEach(validateID);
  if (
    new Set(selection.npcs).size !== selection.npcs.length ||
    !selection.npcs.length
  ) {
    throw new Error("NPC-Auswahl ungültig");
  }

  const known = new Set<string>();
  for (const { npc, history } of selection.acquaintances) {
    if (!selection.npcs.includes(npc) || known.has(npc) || !history.trim()) {
      throw new Error("Bekanntschaft ungültig");
    }
    known.add(npc);
  }
}

function validateFilteredContext(
  player: FilteredPlayerContext,
  selection: Selection,
) {
  const ids = new Set<string>();
  for (const { npc } of player.known) {
    if (
      !selection.acquaintances.some((entry) => entry.npc === npc) ||
      ids.has(npc)
    ) {
      throw new Error("NPC-Vorwissen benötigt eine bestätigte Bekanntschaft");
    }
    ids.add(npc);
  }
  if (ids.size !== selection.acquaintances.length || !player.visible.trim()) {
    throw new Error("Gefilterter Startkontext unvollständig");
  }
}

async function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

async function readJSON<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function initializePlayerWithoutAvatar(
  playerRoot: string,
  acquaintances: Selection["acquaintances"],
) {
  await mkdir(playerRoot, { recursive: true });
  const player: PlayerContext = {
    avatar: null,
    visible: "Keine Profilangaben festgelegt.",
    known: acquaintances.map(({ npc, history }) => ({
      npc,
      relationship: history,
      facts: [],
    })),
  };
  await writeFile(path.join(playerRoot, "state.md"), initialPlayerState);
  await writeFile(
    path.join(playerRoot, "description.md"),
    `${player.visible}\n`,
  );
  await writeFile(
    path.join(playerRoot, "context.json"),
    JSON.stringify(player),
  );
  return player;
}

export default Plugin.define({
  id: "social-game.avatar",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const dataRoot = path.join(directory, ".data");
    const avatarRoot = path.join(dataRoot, "avatars");
    const locks = new Map<string, Promise<unknown>>();

    async function runExclusive<T>(
      key: string,
      run: () => Promise<T>,
    ): Promise<T> {
      const previous = locks.get(key) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(run);
      locks.set(key, current);
      try {
        return await current;
      } finally {
        if (locks.get(key) === current) locks.delete(key);
      }
    }

    async function getSessionRoot(context: ToolContext) {
      let id: string = context.sessionID;
      let session = await ctx.session.get(
        { sessionID: id },
        { signal: context.signal },
      );
      while (session.parentID) {
        id = session.parentID;
        session = await ctx.session.get(
          { sessionID: id },
          { signal: context.signal },
        );
      }
      validateID(id);
      return path.join(dataRoot, "session", id);
    }

    async function readPlayerStatus(sessionRoot: string) {
      const player = await readJSON<PlayerContext>(
        path.join(sessionRoot, "player", "context.json"),
      );
      if (player) return { status: "ready", ...player };
      if (await exists(path.join(sessionRoot, "scene-context.json")))
        return { status: "legacy" };
      const selection = await readJSON<Selection>(
        path.join(sessionRoot, "player", "private", "selection.json"),
      );
      if (!selection) return { status: "unselected" };
      return {
        status: "pending",
        avatar: selection.avatar,
        scene: selection.scene,
        npcs: selection.npcs,
      };
    }

    async function resolveSessionImage(source: string, context: ToolContext) {
      validateID(context.sessionID);
      const imageRoot = path.join(
        dataRoot,
        "session",
        context.sessionID,
        "images",
      );
      const image = path.resolve(directory, source);
      const relative = path.relative(imageRoot, image);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Bild muss aus der aktuellen Session stammen");
      }
      await stat(image);
      return image;
    }

    async function copyAvatarToSession(avatar: string, privateRoot: string) {
      validateID(avatar);
      const source = path.join(avatarRoot, avatar);
      await stat(path.join(source, "avatar.json"));
      const profile = await readFile(
        path.join(source, "description.md"),
        "utf8",
      );
      await mkdir(privateRoot, { recursive: true });
      await writeFile(path.join(privateRoot, "description.md"), profile);
      const image = path.join(source, "img.png");
      if (await exists(image)) {
        await copyFile(image, path.join(privateRoot, "img.png"));
      }
    }

    async function getAvatarCatalog() {
      const entries = await readdir(avatarRoot, {
        withFileTypes: true,
      }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const avatars = [];
      for (const entry of entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        validateID(entry.name);
        const metadata = await readJSON<{ name: string }>(
          path.join(avatarRoot, entry.name, "avatar.json"),
        );
        if (metadata) avatars.push({ id: entry.name, name: metadata.name });
      }
      return { content: JSON.stringify(avatars) };
    }

    async function readAvatarProfile(input: unknown, context: ToolContext) {
      requireAgent(context, "game-create-avatar");
      const { avatar } = input as { avatar: string };
      validateID(avatar);
      return {
        content: await readFile(
          path.join(avatarRoot, avatar, "description.md"),
          "utf8",
        ),
      };
    }

    async function saveAvatar(input: unknown, context: ToolContext) {
      requireAgent(context, "game-create-avatar");
      const args = input as AvatarProfile;
      validateID(args.avatar);
      if (!args.name.trim() || !args.description.trim())
        throw new Error("Name und Profil dürfen nicht leer sein");
      const target = path.join(avatarRoot, args.avatar);
      return runExclusive(target, async () => {
        const present = await exists(target);
        if (!present && args.mode === "update") {
          throw new Error("Avatar nicht vorhanden");
        }
        if (present && args.mode !== "update") {
          throw new Error(
            "Avatar existiert bereits; andere ID wählen oder Änderung bestätigen",
          );
        }
        const image = args.image
          ? await resolveSessionImage(args.image, context)
          : undefined;
        await mkdir(target, { recursive: true });
        if (image) await copyFile(image, path.join(target, "img.png"));
        await writeFile(
          path.join(target, "description.md"),
          `${args.description.trim()}\n`,
        );
        await writeFile(
          path.join(target, "avatar.json"),
          JSON.stringify({ name: args.name.trim() }),
        );
        return {
          content: JSON.stringify({ avatar: args.avatar, status: "saved" }),
        };
      });
    }

    async function getPlayerStatus(_input: unknown, context: ToolContext) {
      return {
        content: JSON.stringify(
          await readPlayerStatus(await getSessionRoot(context)),
        ),
      };
    }

    async function updatePlayerState(input: unknown, context: ToolContext) {
      requireAgent(context, "game-context");
      const { content } = input as { content: string };
      const sessionRoot = await getSessionRoot(context);
      return runExclusive(sessionRoot, async () => {
        if (
          (await readPlayerStatus(sessionRoot)).status !== "ready" ||
          !content.trim()
        ) {
          throw new Error(
            "Ein initialisierter Spieler und ein nicht leerer Zustand sind erforderlich",
          );
        }
        await writeFile(
          path.join(sessionRoot, "player", "state.md"),
          `${content.trim()}\n`,
        );
        return { content: "Spielerzustand gespeichert." };
      });
    }

    async function selectPlayer(input: unknown, context: ToolContext) {
      requireAgent(context, "game-context");
      const args = input as Selection;
      validateSelection(args);
      const sessionRoot = await getSessionRoot(context);
      return runExclusive(sessionRoot, async () => {
        const current = await readPlayerStatus(sessionRoot);
        if (current.status !== "unselected")
          throw new Error(
            "Spieler wurde bereits gewählt; keine erneute Initialisierung",
          );
        await stat(path.join(sessionRoot, "scenes", args.scene, "scene.md"));
        for (const npc of args.npcs)
          await stat(path.join(sessionRoot, "npcs", npc, "state.md"));
        const playerRoot = path.join(sessionRoot, "player");
        if (args.avatar !== null) {
          const privateRoot = path.join(playerRoot, "private");
          await copyAvatarToSession(args.avatar, privateRoot);
          await writeFile(
            path.join(privateRoot, "selection.json"),
            JSON.stringify(args),
          );
          return {
            content: JSON.stringify({ status: "pending", avatar: args.avatar }),
          };
        }
        const player = await initializePlayerWithoutAvatar(
          playerRoot,
          args.acquaintances,
        );
        return { content: JSON.stringify({ status: "ready", ...player }) };
      });
    }

    async function getAvatarFilterInput(_input: unknown, context: ToolContext) {
      requireAgent(context, "game-avatar-context");
      const sessionRoot = await getSessionRoot(context);
      if ((await readPlayerStatus(sessionRoot)).status !== "pending")
        throw new Error(
          "Profilfilter ist nur vor dem ersten Spielbeginn zulässig",
        );
      const privateRoot = path.join(sessionRoot, "player", "private");
      const selection = (await readJSON<Selection>(
        path.join(privateRoot, "selection.json"),
      ))!;
      return {
        content: JSON.stringify({
          ...selection,
          profile: await readFile(
            path.join(privateRoot, "description.md"),
            "utf8",
          ),
          sceneDescription: await readFile(
            path.join(sessionRoot, "scenes", selection.scene, "scene.md"),
            "utf8",
          ),
        }),
      };
    }

    async function saveAvatarFilter(input: unknown, context: ToolContext) {
      requireAgent(context, "game-avatar-context");
      const args = input as FilteredPlayerContext;
      const sessionRoot = await getSessionRoot(context);
      return runExclusive(sessionRoot, async () => {
        if ((await readPlayerStatus(sessionRoot)).status !== "pending")
          throw new Error(
            "Profilfilter ist bereits abgeschlossen oder das Spiel läuft",
          );
        const playerRoot = path.join(sessionRoot, "player");
        const selection = (await readJSON<Selection>(
          path.join(playerRoot, "private", "selection.json"),
        ))!;
        validateFilteredContext(args, selection);
        const player = { avatar: selection.avatar, ...args };
        await writeFile(
          path.join(playerRoot, "description.md"),
          `${args.visible.trim()}\n`,
        );
        await writeFile(path.join(playerRoot, "state.md"), initialPlayerState);
        await writeFile(
          path.join(playerRoot, "context.json"),
          JSON.stringify(player),
        );
        return { content: JSON.stringify({ status: "ready", ...player }) };
      });
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "game_avatar_catalog",
        description:
          "Listet ausschließlich selbst erstellte Avatare mit ihrem bestätigten Anzeigenamen, niemals private Profilangaben.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: getAvatarCatalog,
      });

      editor.add({
        name: "game_avatar_profile",
        description:
          "Liest ein vollständiges Profil ausschließlich im Avatar-Wizard, nicht im Spielkontext.",
        input: {
          type: "object",
          properties: { avatar: { type: "string" } },
          required: ["avatar"],
          additionalProperties: false,
        },
        execute: readAvatarProfile,
      });

      editor.add({
        name: "game_avatar_save",
        description:
          "Speichert ein bestätigtes Avatar-Profil mit optionalem Bild. Aktualisierungen betreffen keine laufende Session.",
        input: {
          type: "object",
          properties: {
            avatar: { type: "string" },
            name: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            image: { type: "string" },
            mode: { type: "string", enum: ["create", "update"] },
          },
          required: ["avatar", "name", "description", "mode"],
          additionalProperties: false,
        },
        execute: saveAvatar,
      });

      editor.add({
        name: "game_player_status",
        description:
          "Liefert den gespeicherten gefilterten Spielerkontext oder den Initialisierungsstatus, niemals das vollständige Profil.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: getPlayerStatus,
      });

      editor.add({
        name: "game_player_state_update",
        description:
          "Speichert ausschließlich ausdrücklich beschriebene Spielerangaben und Handlungen in der laufenden Session, ohne Originalprofil oder Startfilter zu verändern.",
        input: {
          type: "object",
          properties: { content: { type: "string", minLength: 1 } },
          required: ["content"],
          additionalProperties: false,
        },
        execute: updatePlayerState,
      });

      editor.add({
        name: "game_player_select",
        description:
          "Wählt vor Spielbeginn einen eigenen Avatar oder null, kopiert sein Profil privat und hält bestätigte Bekanntschaften für den einmaligen Filter fest.",
        input: {
          type: "object",
          properties: {
            avatar: { type: ["string", "null"] },
            scene: { type: "string" },
            npcs: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              uniqueItems: true,
            },
            acquaintances: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  npc: { type: "string" },
                  history: { type: "string", minLength: 1 },
                },
                required: ["npc", "history"],
                additionalProperties: false,
              },
            },
          },
          required: ["avatar", "scene", "npcs", "acquaintances"],
          additionalProperties: false,
        },
        execute: selectPlayer,
      });

      editor.add({
        name: "game_avatar_filter_input",
        description:
          "Liefert ausschließlich dem Profilfilter vor Spielbeginn die private Profilkopie, Einstiegsszene und bestätigten Bekanntschaften. Liest keine NPC-Charaktere.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: getAvatarFilterInput,
      });

      editor.add({
        name: "game_avatar_filter_save",
        description:
          "Speichert einmalig ausschließlich den freigegebenen Avatar-Startkontext. Danach ist der Profilfilter für diese Session gesperrt.",
        input: {
          type: "object",
          properties: {
            visible: { type: "string", minLength: 1 },
            known: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  npc: { type: "string" },
                  relationship: { type: "string", minLength: 1 },
                  facts: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                  },
                },
                required: ["npc", "relationship", "facts"],
                additionalProperties: false,
              },
            },
          },
          required: ["visible", "known"],
          additionalProperties: false,
        },
        execute: saveAvatarFilter,
      });
    });
  },
});
