import { tool, type Plugin } from "@opencode-ai/plugin"
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createSceneImageRenderer, imageAttachment } from "./image-tools.ts"

function validateID(value: string, label: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Ungültige ${label}: ${value}`)
  }
}

type ContentKind = "npcs" | "scenes"
type CatalogEntry = { id: string; title: string; description: string; source: "data" | "src" }
type NPCContext = { scene: string; content: string }

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
    .replace(/^-+|-+$/g, "")

  if (!slug) throw new Error("Aus dem Namen konnte keine gültige ID gebildet werden")
  return slug
}

async function exists(file: string) {
  return stat(file).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  })
}

async function directoryIDs(root: string) {
  return readdir(root, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    })
}

function dataPath(dataRoot: string, ...parts: string[]) {
  const target = path.resolve(dataRoot, ...parts)
  const relative = path.relative(dataRoot, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Schreibzugriffe sind nur unter .data erlaubt")
  }
  return target
}

async function copyIfMissing(dataRoot: string, source: string, target: string) {
  dataPath(dataRoot, path.relative(dataRoot, target))
  await mkdir(path.dirname(target), { recursive: true })

  try {
    await copyFile(source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

async function readContext(file: string): Promise<{ scene: string; npcs: string[] } | undefined> {
  return readFile(file, "utf8").then((content) => JSON.parse(content) as { scene: string; npcs: string[] }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
}

async function readFirstContentLine(file: string) {
  const content = await readFile(file, "utf8")
  return content.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? ""
}

async function writeState(dataRoot: string, file: string, content: string) {
  dataPath(dataRoot, path.relative(dataRoot, file))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

export const GameSessionPlugin: Plugin = async ({ client, directory }) => {
  const sceneRenderer = createSceneImageRenderer(client, directory)
  const sourceRoot = directory
  const dataRoot = path.join(directory, ".data")

  const resolvedContentFile = async (kind: ContentKind, id: string, ...parts: string[]) => {
    validateID(id, kind === "npcs" ? "NPC-ID" : "Szenen-ID")
    const local = path.join(dataRoot, kind, id, ...parts)
    if (await exists(local)) return local
    const standard = path.join(sourceRoot, kind, id, ...parts)
    if (await exists(standard)) return standard
  }

  const contentFile = async (kind: ContentKind, id: string, ...parts: string[]) => {
    const file = await resolvedContentFile(kind, id, ...parts)
    if (file) return file
    throw new Error(`Inhalt nicht gefunden: ${kind}/${id}/${parts.join("/")}`)
  }

  const contentExists = async (kind: ContentKind, id: string) =>
    (await exists(path.join(dataRoot, kind, id))) || (await exists(path.join(sourceRoot, kind, id)))

  const catalog = async (kind: ContentKind): Promise<CatalogEntry[]> => {
    const ids = new Set([
      ...await directoryIDs(path.join(sourceRoot, kind)),
      ...await directoryIDs(path.join(dataRoot, kind)),
    ])

    return Promise.all([...ids].sort().map(async (id) => {
      const file = await contentFile(kind, id, kind === "npcs" ? "description.md" : "scene.md")
      const source = await exists(path.join(dataRoot, kind, id)) ? "data" : "src"
      const firstLine = await readFirstContentLine(file)
      const title = kind === "npcs"
        ? firstLine || id
        : (await readFile(file, "utf8")).match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || id
      return { id, title, description: firstLine, source }
    }))
  }

  const copyGeneratedImage = async (source: string, target: string, sessionID: string) => {
    const imageRoot = dataPath(dataRoot, "session", sessionID, "images")
    const resolved = path.resolve(directory, source)
    const relative = path.relative(imageRoot, resolved)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Das Bild muss aus dem Bilderverzeichnis der aktuellen Session stammen")
    }
    dataPath(dataRoot, path.relative(dataRoot, target))
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(resolved, target)
  }

  const writeNPCContexts = async (npc: string, contexts: NPCContext[]) => {
    validateID(npc, "NPC-ID")
    await Promise.all(contexts.map(async ({ scene, content }) => {
      validateID(scene, "Szenen-ID")
      if (!content.trim()) throw new Error(`NPC-Szenenkontext für ${scene} fehlt`)
      const target = dataPath(dataRoot, "npcs", npc, "scenes", scene, "scene.md")
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `${content.trim()}\n`)
    }))
  }

  return {
    tool: {

    game_session: tool({
      description:
        "Liefert die ID des aktuellen Hauptchats und dessen isoliertes Social-Game-Session-Verzeichnis.",
      args: {},
      async execute(_args, context) {
        return [
          `Session-ID: ${context.sessionID}`,
          `Session-Verzeichnis: .data/session/${context.sessionID}/`,
        ].join("\n")
      },
    }),

    game_session_prepare: tool({
      description:
        "Kopiert die benötigten NPC- und Szenenvorlagen einmalig in das isolierte Verzeichnis des aktuellen Hauptchats.",
      args: {
        scene: tool.schema.string(),
        npcs: tool.schema.array(tool.schema.string()),
      },
      async execute(args, context) {
        validateID(args.scene, "Szenen-ID")

        for (const npc of args.npcs) validateID(npc, "NPC-ID")

        const sessionRoot = dataPath(dataRoot, "session", context.sessionID)
        const missingContexts: string[] = []
        const copied = [
          [
            await contentFile("scenes", args.scene, "scene.md"),
            path.join(sessionRoot, "scenes", args.scene, "scene.md"),
          ],
          [
            await contentFile("scenes", args.scene, "img.png"),
            path.join(sessionRoot, "scenes", args.scene, "img.png"),
          ],
        ]

        for (const npc of args.npcs) {
          for (const file of ["description.md", "state.md"]) {
            copied.push([
              await contentFile("npcs", npc, file),
              path.join(sessionRoot, "npcs", npc, file),
            ])
          }

          copied.push([
            await contentFile("npcs", npc, "img.png"),
            path.join(sessionRoot, "npcs", npc, "img.png"),
          ])

          const npcScene = await resolvedContentFile("npcs", npc, "scenes", args.scene, "scene.md")
          if (npcScene) {
            copied.push([
              npcScene,
              path.join(sessionRoot, "npcs", npc, "scenes", args.scene, "scene.md"),
            ])
          } else {
            missingContexts.push(npc)
          }
        }

        await Promise.all(copied.map(([source, target]) => copyIfMissing(dataRoot, source, target)))

        const missing = missingContexts.length
          ? ` Fehlende NPC-Szenenkontexte: ${missingContexts.join(", ")}.`
          : ""
        return `Session bereit: .data/session/${context.sessionID}/${missing}`
      },
    }),

    game_catalog: tool({
      description: "Liefert alle verfügbaren Standard- und lokalen NPCs oder Szenen für die Auswahl.",
      args: {
        kind: tool.schema.enum(["npcs", "scenes"]),
      },
      async execute({ kind }) {
        return JSON.stringify(await catalog(kind), null, 2)
      },
    }),

    game_content_status: tool({
      description: "Ermittelt die aus einem sichtbaren Namen abgeleitete ID und ob sie bereits als Standard oder lokal existiert.",
      args: {
        kind: tool.schema.enum(["npcs", "scenes"]),
        name: tool.schema.string().trim().min(1),
      },
      async execute({ kind, name }) {
        const id = slugify(name)
        return JSON.stringify({
          id,
          standard: await exists(path.join(sourceRoot, kind, id)),
          local: await exists(path.join(dataRoot, kind, id)),
        })
      },
    }),

    game_content_read: tool({
      description: "Liest eine aufgelöste Standard- oder lokale Inhaltsdatei mit lokaler Priorität.",
      args: {
        kind: tool.schema.enum(["npcs", "scenes"]),
        id: tool.schema.string(),
        file: tool.schema.enum(["description.md", "state.md", "scene.md"]),
        scene: tool.schema.string().optional(),
      },
      async execute({ kind, id, file, scene }) {
        if (kind === "scenes" && file !== "scene.md") {
          throw new Error("Für Szenen ist nur scene.md lesbar")
        }
        if (kind === "npcs" && file === "scene.md") {
          if (!scene) throw new Error("Für einen NPC-Szenenkontext ist eine Szenen-ID erforderlich")
          validateID(scene, "Szenen-ID")
          return readFile(await contentFile(kind, id, "scenes", scene, file), "utf8")
        }
        return readFile(await contentFile(kind, id, file), "utf8")
      },
    }),

    game_create_npc: tool({
      description: "Legt einen neuen lokalen NPC oder ein lokales NPC-Override unter .data/npcs an.",
      args: {
        name: tool.schema.string().trim().min(1),
        description: tool.schema.string().trim().min(1),
        state: tool.schema.string().trim().min(1),
        image: tool.schema.string().trim().min(1),
        contexts: tool.schema.array(tool.schema.object({
          scene: tool.schema.string(),
          content: tool.schema.string().trim().min(1),
        })),
        mode: tool.schema.enum(["auto", "override"]),
      },
      async execute(args, context) {
        const id = slugify(args.name)
        const alreadyExists = await contentExists("npcs", id)
        if (alreadyExists && args.mode === "auto") {
          return `Entscheidung erforderlich: Die NPC-ID ${id} existiert bereits. Frage nach einem lokalen Override oder einer weiteren Neuanlage.`
        }

        const target = dataPath(dataRoot, "npcs", id)
        await mkdir(target, { recursive: true })
        await Promise.all([
          writeFile(path.join(target, "description.md"), `${args.description.trim()}\n`),
          writeFile(path.join(target, "state.md"), `${args.state.trim()}\n`),
          copyGeneratedImage(args.image, path.join(target, "img.png"), context.sessionID),
          writeNPCContexts(id, args.contexts),
        ])
        return `NPC ${id} wurde unter .data/npcs/${id}/ angelegt.`
      },
    }),

    game_create_scene: tool({
      description: "Legt eine neue lokale Szene oder ein lokales Szenen-Override unter .data/scenes an.",
      args: {
        title: tool.schema.string().trim().min(1),
        description: tool.schema.string().trim().min(1),
        image: tool.schema.string().trim().min(1),
        contexts: tool.schema.array(tool.schema.object({
          npc: tool.schema.string(),
          content: tool.schema.string().trim().min(1),
        })),
        mode: tool.schema.enum(["auto", "override"]),
      },
      async execute(args, context) {
        const id = slugify(args.title)
        const alreadyExists = await contentExists("scenes", id)
        if (alreadyExists && args.mode === "auto") {
          return `Entscheidung erforderlich: Die Szenen-ID ${id} existiert bereits. Frage nach einem lokalen Override oder einer weiteren Neuanlage.`
        }

        const target = dataPath(dataRoot, "scenes", id)
        await mkdir(target, { recursive: true })
        await Promise.all([
          writeFile(path.join(target, "scene.md"), `## ${args.title.trim()}\n\n${args.description.trim()}\n`),
          copyGeneratedImage(args.image, path.join(target, "img.png"), context.sessionID),
          ...args.contexts.map(({ npc, content }) => {
            validateID(npc, "NPC-ID")
            return writeNPCContexts(npc, [{ scene: id, content }])
          }),
        ])
        return `Szene ${id} wurde unter .data/scenes/${id}/ angelegt.`
      },
    }),

    game_update_npc: tool({
      description: "Aktualisiert gezielt lokale NPC-Overrides oder NPC-Szenenkontexte unter .data/npcs.",
      args: {
        npc: tool.schema.string(),
        description: tool.schema.string().trim().min(1).optional(),
        state: tool.schema.string().trim().min(1).optional(),
        image: tool.schema.string().trim().min(1).optional(),
        contexts: tool.schema.array(tool.schema.object({
          scene: tool.schema.string(),
          content: tool.schema.string().trim().min(1),
        })).optional(),
      },
      async execute(args, context) {
        validateID(args.npc, "NPC-ID")
        if (!(await contentExists("npcs", args.npc))) throw new Error(`Unbekannte NPC-ID: ${args.npc}`)
        if (!args.description && !args.state && !args.image && !args.contexts?.length) {
          throw new Error("Es wurde keine NPC-Änderung übergeben")
        }

        const target = dataPath(dataRoot, "npcs", args.npc)
        await mkdir(target, { recursive: true })
        await Promise.all([
          ...(args.description ? [writeFile(path.join(target, "description.md"), `${args.description.trim()}\n`)] : []),
          ...(args.state ? [writeFile(path.join(target, "state.md"), `${args.state.trim()}\n`)] : []),
          ...(args.image ? [copyGeneratedImage(args.image, path.join(target, "img.png"), context.sessionID)] : []),
          ...(args.contexts?.length ? [writeNPCContexts(args.npc, args.contexts)] : []),
        ])
        return `NPC ${args.npc} wurde lokal aktualisiert.`
      },
    }),

    game_scene_update: tool({
      description: [
        "Speichert den aktiven Teilnehmerstand und den sichtbaren Zustand der Szene in der Hauptchat-Session.",
        "Bei participant-change wird das Szenenbild nach der Speicherung einmal aktualisiert.",
      ].join(" "),
      args: {
        scene: tool.schema.string(),
        npcs: tool.schema.array(tool.schema.string()).min(1),
        visualState: tool.schema.string().trim().min(1),
        render: tool.schema.enum(["never", "participant-change"]),
      },
      async execute(args, context) {
        validateID(args.scene, "Szenen-ID")
        for (const npc of args.npcs) validateID(npc, "NPC-ID")

        const session = await client.session.get({ path: { id: context.sessionID }, signal: context.abort })
        let rootID = context.sessionID
        let parentID = session.data?.parentID
        while (parentID) {
          rootID = parentID
          const parent = await client.session.get({ path: { id: parentID }, signal: context.abort })
          parentID = parent.data?.parentID
        }

        const root = dataPath(dataRoot, "session", rootID)
        const contextFile = path.join(root, "scene-context.json")
        const previous = await readContext(contextFile)
        const previousNPCs = previous?.scene === args.scene ? previous.npcs : []
        const additions = args.npcs.filter((npc) => !previousNPCs.includes(npc))
        const removals = previousNPCs.filter((npc) => !args.npcs.includes(npc))

        await writeState(dataRoot, contextFile, `${JSON.stringify({ scene: args.scene, npcs: args.npcs }, null, 2)}\n`)
        await writeState(dataRoot, dataPath(dataRoot, "session", rootID, "scenes", args.scene, "visual-state.md"), `${args.visualState}\n`)

        if (args.render === "never" || (additions.length === 0 && removals.length === 0)) {
          return "Szenenzustand gespeichert."
        }

        try {
          const image = await sceneRenderer.render(context, { additions, removals })
          return {
            output: [
              "Szenenzustand gespeichert.",
              `Bild aktualisiert: ${image.path}`,
            ].join("\n"),
            attachments: [await imageAttachment(image.file)],
          }
        } catch {
          await sceneRenderer.pending(context.sessionID)
          return "Szenenzustand gespeichert. Bildaktualisierung ausstehend."
        }
      },
    }),

    game_state_updates: tool({
      description:
        "Speichert die vollständigen Zustände aller betroffenen NPCs ausschließlich in deren Kopien der aktuellen Hauptchat-Session.",
      args: {
        updates: tool.schema.array(
          tool.schema.object({
            npc: tool.schema.string(),
            content: tool.schema.string(),
          }),
        ),
      },
      async execute(args, context) {
        const npcIDs = new Set<string>()
        for (const update of args.updates) {
          validateID(update.npc, "NPC-ID")
          if (npcIDs.has(update.npc)) {
            throw new Error(`Zustand für ${update.npc} wurde mehrfach übergeben.`)
          }
          npcIDs.add(update.npc)
        }

        await Promise.all(args.updates.map(async (update) => {
          const target = dataPath(
            dataRoot,
            "session",
            context.sessionID,
            "npcs",
            update.npc,
            "state.md",
          )
          const temporary = `${target}.tmp`

          await writeFile(temporary, update.content)
          await rename(temporary, target)
        }))

        return `Zustände für ${args.updates.map((update) => update.npc).join(", ")} gespeichert.`
      },
    }),

    },
  }
}
