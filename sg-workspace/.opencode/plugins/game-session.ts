import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createSceneImageRenderer, imageAttachment } from "./image-tools.ts";

function validateID(value: string, label: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Ungültige ${label}: ${value}`);
  }
}

type ContentKind = "npcs" | "scenes";
type CatalogEntry = {
  id: string;
  title: string;
  description: string;
  source: "data" | "src";
};
type NPCContext = { scene: string; content: string };
type SceneContext = { scene: string; npcs: string[] };
type NPCChanges = {
  description?: string;
  state?: string;
  image?: string;
  contexts?: NPCContext[];
};

function slugify(value: string) {
  const slug = value
    .trim()
    .toLocaleLowerCase("de-DE")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug)
    throw new Error("Aus dem Namen konnte keine gültige ID gebildet werden");
  return slug;
}

async function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
}

async function directoryIDs(root: string) {
  return readdir(root, { withFileTypes: true })
    .then((entries) =>
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    )
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
}

function dataPath(dataRoot: string, ...parts: string[]) {
  const target = path.resolve(dataRoot, ...parts);
  const relative = path.relative(dataRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Schreibzugriffe sind nur unter .data erlaubt");
  }
  return target;
}

async function copyIfMissing(dataRoot: string, source: string, target: string) {
  dataPath(dataRoot, path.relative(dataRoot, target));
  await mkdir(path.dirname(target), { recursive: true });

  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function readContext(file: string): Promise<SceneContext | undefined> {
  return readFile(file, "utf8")
    .then((content) => JSON.parse(content) as SceneContext)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
}

async function readFirstContentLine(file: string) {
  const content = await readFile(file, "utf8");
  return (
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ?? ""
  );
}

async function writeState(dataRoot: string, file: string, content: string) {
  dataPath(dataRoot, path.relative(dataRoot, file));
  const previous = await readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (previous === content) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

export default Plugin.define({
  id: "social-game.session",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const sceneRenderer = createSceneImageRenderer(ctx, directory);
    const sourceRoot = directory;
    const dataRoot = path.join(directory, ".data");

    async function findContentFile(
      kind: ContentKind,
      id: string,
      ...parts: string[]
    ) {
      validateID(id, kind === "npcs" ? "NPC-ID" : "Szenen-ID");
      const local = path.join(dataRoot, kind, id, ...parts);
      if (await exists(local)) return local;
      const standard = path.join(sourceRoot, kind, id, ...parts);
      if (await exists(standard)) return standard;
    }

    async function requireContentFile(
      kind: ContentKind,
      id: string,
      ...parts: string[]
    ) {
      const file = await findContentFile(kind, id, ...parts);
      if (file) return file;
      throw new Error(
        `Inhalt nicht gefunden: ${kind}/${id}/${parts.join("/")}`,
      );
    }

    const contentExists = async (kind: ContentKind, id: string) =>
      (await exists(path.join(dataRoot, kind, id))) ||
      (await exists(path.join(sourceRoot, kind, id)));

    async function catalog(kind: ContentKind): Promise<CatalogEntry[]> {
      const ids = new Set([
        ...(await directoryIDs(path.join(sourceRoot, kind))),
        ...(await directoryIDs(path.join(dataRoot, kind))),
      ]);

      return Promise.all(
        [...ids].sort().map(async (id) => {
          const file = await requireContentFile(
            kind,
            id,
            kind === "npcs" ? "description.md" : "scene.md",
          );
          const source = (await exists(path.join(dataRoot, kind, id)))
            ? "data"
            : "src";
          const firstLine = await readFirstContentLine(file);
          const title =
            kind === "npcs"
              ? firstLine || id
              : (await readFile(file, "utf8"))
                  .match(/^#{1,6}\s+(.+)$/m)?.[1]
                  ?.trim() || id;
          return { id, title, description: firstLine, source };
        }),
      );
    }

    async function copyGeneratedImage(
      source: string,
      target: string,
      sessionID: string,
    ) {
      const imageRoot = dataPath(dataRoot, "session", sessionID, "images");
      const resolved = path.resolve(directory, source);
      const relative = path.relative(imageRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          "Das Bild muss aus dem Bilderverzeichnis der aktuellen Session stammen",
        );
      }
      dataPath(dataRoot, path.relative(dataRoot, target));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(resolved, target);
    }

    async function writeNPCContexts(npc: string, contexts: NPCContext[]) {
      validateID(npc, "NPC-ID");
      await Promise.all(
        contexts.map(async ({ scene, content }) => {
          validateID(scene, "Szenen-ID");
          if (!content.trim())
            throw new Error(`NPC-Szenenkontext für ${scene} fehlt`);
          const target = dataPath(
            dataRoot,
            "npcs",
            npc,
            "scenes",
            scene,
            "scene.md",
          );
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, `${content.trim()}\n`);
        }),
      );
    }

    async function prepareSession(
      sessionID: string,
      scene: string,
      npcs: string[],
    ) {
      validateID(scene, "Szenen-ID");
      for (const npc of npcs) validateID(npc, "NPC-ID");

      const sessionRoot = dataPath(dataRoot, "session", sessionID);
      const missingContexts: string[] = [];
      const copies: [string, string][] = [];

      for (const file of ["scene.md", "img.png"]) {
        copies.push([
          await requireContentFile("scenes", scene, file),
          path.join(sessionRoot, "scenes", scene, file),
        ]);
      }

      for (const npc of npcs) {
        for (const file of ["description.md", "state.md", "img.png"]) {
          copies.push([
            await requireContentFile("npcs", npc, file),
            path.join(sessionRoot, "npcs", npc, file),
          ]);
        }

        const context = await findContentFile(
          "npcs",
          npc,
          "scenes",
          scene,
          "scene.md",
        );
        if (context) {
          copies.push([
            context,
            path.join(sessionRoot, "npcs", npc, "scenes", scene, "scene.md"),
          ]);
        } else {
          missingContexts.push(npc);
        }
      }

      // Erst alle Vorlagen auflösen, dann kopieren; vorhandene Session-Dateien bleiben erhalten.
      await Promise.all(
        copies.map(([source, target]) =>
          copyIfMissing(dataRoot, source, target),
        ),
      );
      return missingContexts;
    }

    async function writeNPC(
      npc: string,
      changes: NPCChanges,
      sessionID: string,
    ) {
      const target = dataPath(dataRoot, "npcs", npc);
      await mkdir(target, { recursive: true });
      const writes: Promise<void>[] = [];

      if (changes.description) {
        writes.push(
          writeFile(
            path.join(target, "description.md"),
            `${changes.description.trim()}\n`,
          ),
        );
      }
      if (changes.state) {
        writes.push(
          writeFile(path.join(target, "state.md"), `${changes.state.trim()}\n`),
        );
      }
      if (changes.image) {
        writes.push(
          copyGeneratedImage(
            changes.image,
            path.join(target, "img.png"),
            sessionID,
          ),
        );
      }
      if (changes.contexts) {
        writes.push(writeNPCContexts(npc, changes.contexts));
      }

      await Promise.all(writes);
    }

    async function rootSessionID(context: ToolContext) {
      let rootID: string = context.sessionID;
      let session = await ctx.session.get(
        { sessionID: context.sessionID },
        { signal: context.signal },
      );
      while (session.parentID) {
        rootID = session.parentID;
        session = await ctx.session.get(
          { sessionID: session.parentID },
          { signal: context.signal },
        );
      }
      return rootID;
    }

    async function saveSceneState(
      sessionID: string,
      current: SceneContext,
      visualState: string,
    ) {
      const root = dataPath(dataRoot, "session", sessionID);
      const contextFile = path.join(root, "scene-context.json");
      const previous = await readContext(contextFile);
      const previousNPCs =
        previous?.scene === current.scene ? previous.npcs : [];
      const additions = current.npcs.filter(
        (npc) => !previousNPCs.includes(npc),
      );
      const removals = previousNPCs.filter(
        (npc) => !current.npcs.includes(npc),
      );

      await writeState(
        dataRoot,
        contextFile,
        `${JSON.stringify(current, null, 2)}\n`,
      );
      await writeState(
        dataRoot,
        dataPath(
          dataRoot,
          "session",
          sessionID,
          "scenes",
          current.scene,
          "visual-state.md",
        ),
        `${visualState}\n`,
      );
      return { additions, removals };
    }

    async function getSession(_input: unknown, context: ToolContext) {
      return {
        content: [
          `Session-ID: ${context.sessionID}`,
          `Session-Verzeichnis: .data/session/${context.sessionID}/`,
        ].join("\n"),
      };
    }

    async function prepareGameSession(input: unknown, context: ToolContext) {
      const args = input as { scene: string; npcs: string[] };
      const missingContexts = await prepareSession(
        context.sessionID,
        args.scene,
        args.npcs,
      );
      const missing = missingContexts.length
        ? ` Fehlende NPC-Szenenkontexte: ${missingContexts.join(", ")}.`
        : "";
      return {
        content: `Session bereit: .data/session/${context.sessionID}/${missing}`,
      };
    }

    async function getCatalog(input: unknown) {
      const { kind } = input as { kind: ContentKind };
      return { content: JSON.stringify(await catalog(kind), null, 2) };
    }

    async function getContentStatus(input: unknown) {
      const { kind, name } = input as { kind: ContentKind; name: string };
      const id = slugify(name);
      return {
        content: JSON.stringify({
          id,
          standard: await exists(path.join(sourceRoot, kind, id)),
          local: await exists(path.join(dataRoot, kind, id)),
        }),
      };
    }

    async function readContent(input: unknown) {
      const { kind, id, file, scene } = input as {
        kind: ContentKind;
        id: string;
        file: string;
        scene?: string;
      };
      if (kind === "scenes" && file !== "scene.md") {
        throw new Error("Für Szenen ist nur scene.md lesbar");
      }
      if (kind === "npcs" && file === "scene.md") {
        if (!scene)
          throw new Error(
            "Für einen NPC-Szenenkontext ist eine Szenen-ID erforderlich",
          );
        validateID(scene, "Szenen-ID");
        return {
          content: await readFile(
            await requireContentFile(kind, id, "scenes", scene, file),
            "utf8",
          ),
        };
      }
      return {
        content: await readFile(
          await requireContentFile(kind, id, file),
          "utf8",
        ),
      };
    }

    async function createNPC(input: unknown, context: ToolContext) {
      const args = input as {
        name: string;
        description: string;
        state: string;
        image: string;
        contexts: NPCContext[];
        mode: "auto" | "override";
      };
      const id = slugify(args.name);
      const alreadyExists = await contentExists("npcs", id);
      if (alreadyExists && args.mode === "auto") {
        return {
          content: `Entscheidung erforderlich: Die NPC-ID ${id} existiert bereits. Frage nach einem lokalen Override oder einer weiteren Neuanlage.`,
        };
      }

      await writeNPC(id, args, context.sessionID);
      return {
        content: `NPC ${id} wurde unter .data/npcs/${id}/ angelegt.`,
      };
    }

    async function createScene(input: unknown, context: ToolContext) {
      const args = input as {
        title: string;
        description: string;
        image: string;
        contexts: { npc: string; content: string }[];
        mode: "auto" | "override";
      };
      const id = slugify(args.title);
      const alreadyExists = await contentExists("scenes", id);
      if (alreadyExists && args.mode === "auto") {
        return {
          content: `Entscheidung erforderlich: Die Szenen-ID ${id} existiert bereits. Frage nach einem lokalen Override oder einer weiteren Neuanlage.`,
        };
      }

      const target = dataPath(dataRoot, "scenes", id);
      await mkdir(target, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(target, "scene.md"),
          `## ${args.title.trim()}\n\n${args.description.trim()}\n`,
        ),
        copyGeneratedImage(
          args.image,
          path.join(target, "img.png"),
          context.sessionID,
        ),
        ...args.contexts.map(({ npc, content }) => {
          validateID(npc, "NPC-ID");
          return writeNPCContexts(npc, [{ scene: id, content }]);
        }),
      ]);
      return {
        content: `Szene ${id} wurde unter .data/scenes/${id}/ angelegt.`,
      };
    }

    async function updateNPC(input: unknown, context: ToolContext) {
      const args = input as NPCChanges & { npc: string };
      validateID(args.npc, "NPC-ID");
      if (!(await contentExists("npcs", args.npc)))
        throw new Error(`Unbekannte NPC-ID: ${args.npc}`);
      if (
        !args.description &&
        !args.state &&
        !args.image &&
        !args.contexts?.length
      ) {
        throw new Error("Es wurde keine NPC-Änderung übergeben");
      }

      await writeNPC(args.npc, args, context.sessionID);
      return { content: `NPC ${args.npc} wurde lokal aktualisiert.` };
    }

    async function updateScene(input: unknown, context: ToolContext) {
      const args = input as {
        scene: string;
        npcs: string[];
        visualState: string;
        render: "never" | "participant-change";
      };
      validateID(args.scene, "Szenen-ID");
      for (const npc of args.npcs) validateID(npc, "NPC-ID");

      const rootID = await rootSessionID(context);
      const sessionRoot = dataPath(dataRoot, "session", rootID);
      if (
        !(await exists(path.join(sessionRoot, "player", "context.json"))) &&
        ((await exists(
          path.join(sessionRoot, "player", "private", "selection.json"),
        )) ||
          !(await exists(path.join(sessionRoot, "scene-context.json"))))
      ) {
        throw new Error(
          "Spielerinitialisierung muss vor Spielbeginn abgeschlossen sein",
        );
      }
      const { additions, removals } = await saveSceneState(
        rootID,
        { scene: args.scene, npcs: args.npcs },
        args.visualState,
      );

      if (
        args.render === "never" ||
        (additions.length === 0 && removals.length === 0)
      ) {
        return { content: "Szenenzustand gespeichert." };
      }

      try {
        const image = await sceneRenderer.render(context, {
          additions,
          removals,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Szenenzustand gespeichert.",
                `Bild aktualisiert: ${image.path}`,
              ].join("\n"),
            },
            await imageAttachment(image.file),
          ],
        };
      } catch {
        await sceneRenderer.pending(context.sessionID);
        return {
          content: "Szenenzustand gespeichert. Bildaktualisierung ausstehend.",
        };
      }
    }

    async function updateNPCStates(input: unknown, context: ToolContext) {
      const args = input as { updates: { npc: string; content: string }[] };
      const npcIDs = new Set<string>();
      for (const update of args.updates) {
        validateID(update.npc, "NPC-ID");
        if (npcIDs.has(update.npc)) {
          throw new Error(
            `Zustand für ${update.npc} wurde mehrfach übergeben.`,
          );
        }
        npcIDs.add(update.npc);
      }

      await Promise.all(
        args.updates.map(async (update) => {
          const target = dataPath(
            dataRoot,
            "session",
            context.sessionID,
            "npcs",
            update.npc,
            "state.md",
          );
          const temporary = `${target}.tmp`;
          await writeFile(temporary, update.content);
          await rename(temporary, target);
        }),
      );

      return {
        content: `Zustände für ${args.updates.map((update) => update.npc).join(", ")} gespeichert.`,
      };
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "game_session",
        description:
          "Liefert die ID des aktuellen Hauptchats und dessen isoliertes Social-Game-Session-Verzeichnis.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: getSession,
      });

      editor.add({
        name: "game_session_prepare",
        description:
          "Kopiert die benötigten NPC- und Szenenvorlagen einmalig in das isolierte Verzeichnis des aktuellen Hauptchats.",
        input: {
          type: "object",
          properties: {
            scene: { type: "string" },
            npcs: { type: "array", items: { type: "string" } },
          },
          required: ["scene", "npcs"],
          additionalProperties: false,
        },
        execute: prepareGameSession,
      });

      editor.add({
        name: "game_catalog",
        description:
          "Liefert alle verfügbaren Standard- und lokalen NPCs oder Szenen für die Auswahl.",
        input: {
          type: "object",
          properties: { kind: { type: "string", enum: ["npcs", "scenes"] } },
          required: ["kind"],
          additionalProperties: false,
        },
        execute: getCatalog,
      });

      editor.add({
        name: "game_content_status",
        description:
          "Ermittelt die aus einem sichtbaren Namen abgeleitete ID und ob sie bereits als Standard oder lokal existiert.",
        input: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["npcs", "scenes"] },
            name: { type: "string", minLength: 1 },
          },
          required: ["kind", "name"],
          additionalProperties: false,
        },
        execute: getContentStatus,
      });

      editor.add({
        name: "game_content_read",
        description:
          "Liest eine aufgelöste Standard- oder lokale Inhaltsdatei mit lokaler Priorität.",
        input: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["npcs", "scenes"] },
            id: { type: "string" },
            file: {
              type: "string",
              enum: ["description.md", "state.md", "scene.md"],
            },
            scene: { type: "string" },
          },
          required: ["kind", "id", "file"],
          additionalProperties: false,
        },
        execute: readContent,
      });

      editor.add({
        name: "game_create_npc",
        description:
          "Legt einen neuen lokalen NPC oder ein lokales NPC-Override unter .data/npcs an.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            state: { type: "string", minLength: 1 },
            image: { type: "string", minLength: 1 },
            contexts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  scene: { type: "string" },
                  content: { type: "string", minLength: 1 },
                },
                required: ["scene", "content"],
                additionalProperties: false,
              },
            },
            mode: { type: "string", enum: ["auto", "override"] },
          },
          required: [
            "name",
            "description",
            "state",
            "image",
            "contexts",
            "mode",
          ],
          additionalProperties: false,
        },
        execute: createNPC,
      });

      editor.add({
        name: "game_create_scene",
        description:
          "Legt eine neue lokale Szene oder ein lokales Szenen-Override unter .data/scenes an.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            image: { type: "string", minLength: 1 },
            contexts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  npc: { type: "string" },
                  content: { type: "string", minLength: 1 },
                },
                required: ["npc", "content"],
                additionalProperties: false,
              },
            },
            mode: { type: "string", enum: ["auto", "override"] },
          },
          required: ["title", "description", "image", "contexts", "mode"],
          additionalProperties: false,
        },
        execute: createScene,
      });

      editor.add({
        name: "game_update_npc",
        description:
          "Aktualisiert gezielt lokale NPC-Overrides oder NPC-Szenenkontexte unter .data/npcs.",
        input: {
          type: "object",
          properties: {
            npc: { type: "string" },
            description: { type: "string", minLength: 1 },
            state: { type: "string", minLength: 1 },
            image: { type: "string", minLength: 1 },
            contexts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  scene: { type: "string" },
                  content: { type: "string", minLength: 1 },
                },
                required: ["scene", "content"],
                additionalProperties: false,
              },
            },
          },
          required: ["npc"],
          additionalProperties: false,
        },
        execute: updateNPC,
      });

      editor.add({
        name: "game_scene_update",
        options: { permission: "image_edit" },
        description: [
          "Speichert den aktiven Teilnehmerstand und den sichtbaren Zustand der Szene in der Hauptchat-Session.",
          "Bei participant-change wird das Szenenbild nach der Speicherung einmal aktualisiert.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            scene: { type: "string" },
            npcs: { type: "array", items: { type: "string" }, minItems: 1 },
            visualState: { type: "string", minLength: 1 },
            render: { type: "string", enum: ["never", "participant-change"] },
          },
          required: ["scene", "npcs", "visualState", "render"],
          additionalProperties: false,
        },
        execute: updateScene,
      });

      editor.add({
        name: "game_state_updates",
        description:
          "Speichert die vollständigen Zustände aller betroffenen NPCs ausschließlich in deren Kopien der aktuellen Hauptchat-Session.",
        input: {
          type: "object",
          properties: {
            updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  npc: { type: "string" },
                  content: { type: "string" },
                },
                required: ["npc", "content"],
                additionalProperties: false,
              },
            },
          },
          required: ["updates"],
          additionalProperties: false,
        },
        execute: updateNPCStates,
      });
    });
  },
});
