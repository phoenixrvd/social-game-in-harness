import { tool, type Plugin } from "@opencode-ai/plugin"
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createSceneImageRenderer, imageAttachment } from "./image-tools.ts"

function validateID(value: string, label: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Ungültige ${label}: ${value}`)
  }
}

async function copyIfMissing(source: string, target: string) {
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

async function writeState(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

export const GameSessionPlugin: Plugin = async ({ client, directory }) => {
  const sceneRenderer = createSceneImageRenderer(client, directory)

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

        const sourceRoot = path.join(context.directory, "src")
        const sessionRoot = path.join(context.directory, ".data", "session", context.sessionID)
        const copied = [
          [
            path.join(sourceRoot, "scenes", args.scene, "scene.md"),
            path.join(sessionRoot, "scenes", args.scene, "scene.md"),
          ],
          [
            path.join(sourceRoot, "scenes", args.scene, "img.png"),
            path.join(sessionRoot, "scenes", args.scene, "img.png"),
          ],
        ]

        for (const npc of args.npcs) {
          for (const file of ["description.md", "state.md"]) {
            copied.push([
              path.join(sourceRoot, "npcs", npc, file),
              path.join(sessionRoot, "npcs", npc, file),
            ])
          }

          copied.push([
            path.join(sourceRoot, "npcs", npc, "img.png"),
            path.join(sessionRoot, "npcs", npc, "img.png"),
          ])

          copied.push([
            path.join(sourceRoot, "npcs", npc, "scenes", args.scene, "scene.md"),
            path.join(sessionRoot, "npcs", npc, "scenes", args.scene, "scene.md"),
          ])
        }

        await Promise.all(copied.map(([source, target]) => copyIfMissing(source, target)))

        return `Session bereit: .data/session/${context.sessionID}/`
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

        const root = path.join(directory, ".data", "session", rootID)
        const contextFile = path.join(root, "scene-context.json")
        const previous = await readContext(contextFile)
        const previousNPCs = previous?.scene === args.scene ? previous.npcs : []
        const additions = args.npcs.filter((npc) => !previousNPCs.includes(npc))
        const removals = previousNPCs.filter((npc) => !args.npcs.includes(npc))

        await writeState(contextFile, `${JSON.stringify({ scene: args.scene, npcs: args.npcs }, null, 2)}\n`)
        await writeState(path.join(root, "scenes", args.scene, "visual-state.md"), `${args.visualState}\n`)

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
          const target = path.join(
            context.directory,
            ".data",
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
