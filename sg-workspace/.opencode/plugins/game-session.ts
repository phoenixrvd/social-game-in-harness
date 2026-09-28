import { Plugin } from "@opencode/plugin";
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

async function readContext(
  file: string,
): Promise<{ scene: string; npcs: string[] } | undefined> {
  return readFile(file, "utf8")
    .then((content) => JSON.parse(content) as { scene: string; npcs: string[] })
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

    const resolvedContentFile = async (
      kind: ContentKind,
      id: string,
      ...parts: string[]
    ) => {
      validateID(id, kind === "npcs" ? "NPC-ID" : "Szenen-ID");
      const local = path.join(dataRoot, kind, id, ...parts);
      if (await exists(local)) return local;
      const standard = path.join(sourceRoot, kind, id, ...parts);
      if (await exists(standard)) return standard;
    };

    const contentFile = async (
      kind: ContentKind,
      id: string,
      ...parts: string[]
    ) => {
      const file = await resolvedContentFile(kind, id, ...parts);
      if (file) return file;
      throw new Error(
        `Inhalt nicht gefunden: ${kind}/${id}/${parts.join("/")}`,
      );
    };

    const contentExists = async (kind: ContentKind, id: string) =>
      (await exists(path.join(dataRoot, kind, id))) ||
      (await exists(path.join(sourceRoot, kind, id)));

    const catalog = async (kind: ContentKind): Promise<CatalogEntry[]> => {
      const ids = new Set([
        ...(await directoryIDs(path.join(sourceRoot, kind))),
        ...(await directoryIDs(path.join(dataRoot, kind))),
      ]);

      return Promise.all(
        [...ids].sort().map(async (id) => {
          const file = await contentFile(
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
    };

    const copyGeneratedImage = async (
      source: string,
      target: string,
      sessionID: string,
    ) => {
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
    };

    const writeNPCContexts = async (npc: string, contexts: NPCContext[]) => {
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
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "game_session",
        description:
          "Liefert die ID des aktuellen Hauptchats und dessen isoliertes Social-Game-Session-Verzeichnis.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_args, context) {
          return {
            content: [
              `Session-ID: ${context.sessionID}`,
              `Session-Verzeichnis: .data/session/${context.sessionID}/`,
            ].join("\n"),
          };
        },
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
        async execute(input, context) {
          const args = input as { scene: string; npcs: string[] };
          validateID(args.scene, "Szenen-ID");

          for (const npc of args.npcs) validateID(npc, "NPC-ID");

          const sessionRoot = dataPath(dataRoot, "session", context.sessionID);
          const missingContexts: string[] = [];
          const copied = [
            [
              await contentFile("scenes", args.scene, "scene.md"),
              path.join(sessionRoot, "scenes", args.scene, "scene.md"),
            ],
            [
              await contentFile("scenes", args.scene, "img.png"),
              path.join(sessionRoot, "scenes", args.scene, "img.png"),
            ],
          ];

          for (const npc of args.npcs) {
            for (const file of ["description.md", "state.md"]) {
              copied.push([
                await contentFile("npcs", npc, file),
                path.join(sessionRoot, "npcs", npc, file),
              ]);
            }

            copied.push([
              await contentFile("npcs", npc, "img.png"),
              path.join(sessionRoot, "npcs", npc, "img.png"),
            ]);

            const npcScene = await resolvedContentFile(
              "npcs",
              npc,
              "scenes",
              args.scene,
              "scene.md",
            );
            if (npcScene) {
              copied.push([
                npcScene,
                path.join(
                  sessionRoot,
                  "npcs",
                  npc,
                  "scenes",
                  args.scene,
                  "scene.md",
                ),
              ]);
            } else {
              missingContexts.push(npc);
            }
          }

          await Promise.all(
            copied.map(([source, target]) =>
              copyIfMissing(dataRoot, source, target),
            ),
          );

          const missing = missingContexts.length
            ? ` Fehlende NPC-Szenenkontexte: ${missingContexts.join(", ")}.`
            : "";
          return {
            content: `Session bereit: .data/session/${context.sessionID}/${missing}`,
          };
        },
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
        async execute(input) {
          const { kind } = input as { kind: ContentKind };
          return { content: JSON.stringify(await catalog(kind), null, 2) };
        },
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
        async execute(input) {
          const { kind, name } = input as { kind: ContentKind; name: string };
          const id = slugify(name);
          return {
            content: JSON.stringify({
              id,
              standard: await exists(path.join(sourceRoot, kind, id)),
              local: await exists(path.join(dataRoot, kind, id)),
            }),
          };
        },
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
        async execute(input) {
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
                await contentFile(kind, id, "scenes", scene, file),
                "utf8",
              ),
            };
          }
          return {
            content: await readFile(await contentFile(kind, id, file), "utf8"),
          };
        },
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
        async execute(input, context) {
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

          const target = dataPath(dataRoot, "npcs", id);
          await mkdir(target, { recursive: true });
          await Promise.all([
            writeFile(
              path.join(target, "description.md"),
              `${args.description.trim()}\n`,
            ),
            writeFile(path.join(target, "state.md"), `${args.state.trim()}\n`),
            copyGeneratedImage(
              args.image,
              path.join(target, "img.png"),
              context.sessionID,
            ),
            writeNPCContexts(id, args.contexts),
          ]);
          return {
            content: `NPC ${id} wurde unter .data/npcs/${id}/ angelegt.`,
          };
        },
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
        async execute(input, context) {
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
        },
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
        async execute(input, context) {
          const args = input as {
            npc: string;
            description?: string;
            state?: string;
            image?: string;
            contexts?: NPCContext[];
          };
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

          const target = dataPath(dataRoot, "npcs", args.npc);
          await mkdir(target, { recursive: true });
          await Promise.all([
            ...(args.description
              ? [
                  writeFile(
                    path.join(target, "description.md"),
                    `${args.description.trim()}\n`,
                  ),
                ]
              : []),
            ...(args.state
              ? [
                  writeFile(
                    path.join(target, "state.md"),
                    `${args.state.trim()}\n`,
                  ),
                ]
              : []),
            ...(args.image
              ? [
                  copyGeneratedImage(
                    args.image,
                    path.join(target, "img.png"),
                    context.sessionID,
                  ),
                ]
              : []),
            ...(args.contexts?.length
              ? [writeNPCContexts(args.npc, args.contexts)]
              : []),
          ]);
          return { content: `NPC ${args.npc} wurde lokal aktualisiert.` };
        },
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
        async execute(input, context) {
          const args = input as {
            scene: string;
            npcs: string[];
            visualState: string;
            render: "never" | "participant-change";
          };
          validateID(args.scene, "Szenen-ID");
          for (const npc of args.npcs) validateID(npc, "NPC-ID");

          const session = await ctx.session.get(
            { sessionID: context.sessionID },
            { signal: context.signal },
          );
          let rootID: string = context.sessionID;
          let parentID = session.parentID;
          while (parentID) {
            rootID = parentID;
            const parent = await ctx.session.get(
              { sessionID: parentID },
              { signal: context.signal },
            );
            parentID = parent.parentID;
          }

          const root = dataPath(dataRoot, "session", rootID);
          const contextFile = path.join(root, "scene-context.json");
          const previous = await readContext(contextFile);
          const previousNPCs =
            previous?.scene === args.scene ? previous.npcs : [];
          const additions = args.npcs.filter(
            (npc) => !previousNPCs.includes(npc),
          );
          const removals = previousNPCs.filter(
            (npc) => !args.npcs.includes(npc),
          );

          await writeState(
            dataRoot,
            contextFile,
            `${JSON.stringify({ scene: args.scene, npcs: args.npcs }, null, 2)}\n`,
          );
          await writeState(
            dataRoot,
            dataPath(
              dataRoot,
              "session",
              rootID,
              "scenes",
              args.scene,
              "visual-state.md",
            ),
            `${args.visualState}\n`,
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
                  type: "text",
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
              content:
                "Szenenzustand gespeichert. Bildaktualisierung ausstehend.",
            };
          }
        },
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
        async execute(input, context) {
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
        },
      });
    });
  },
});
