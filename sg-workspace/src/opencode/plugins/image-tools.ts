import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { access, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"

const endpoint = "https://openrouter.ai/api/v1/images"
const timeoutMs = 180_000
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const models = {
  "x-ai/grok-imagine-image-2.0": { maxReferences: 3 },
  "x-ai/grok-imagine-image-quality": { maxReferences: 3 },
  "bytedance-seed/seedream-5-0-lite": { maxReferences: 14 },
  "bytedance-seed/seedream-5-0-pro": { maxReferences: 14 },
  "openai/gpt-image-2": { maxReferences: 16 },
  "openai/gpt-image-2.5-flare": { maxReferences: 16 },
  "openai/gpt-image-2.5-sunburst": { maxReferences: 16 },
} as const

const defaultModel = "x-ai/grok-imagine-image-quality"
const fastModel = "x-ai/grok-imagine-image-2.0"
const modelList = Object.keys(models).join(", ")

const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const

type Mime = keyof typeof extensions
type ImageData = { bytes: Buffer; mime: Mime }
type SavedImage = { path: string; mime: Mime }
type SceneContext = { scene: string; npcs: string[] }
type SceneImageDebug = {
  model: string
  parameters: { n: 1; aspectRatio: string | null; resolution: string | null }
  steps: Array<{ action: "add" | "remove" | "update"; npc?: string; references: string[] }>
}

function imageMime(bytes: Buffer): Mime | undefined {
  if (bytes.subarray(0, 8).equals(pngSignature)) return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp"
  }
}

function timestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0")
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}-${time}`
}

function resolveModel(route?: string): keyof typeof models {
  const model = route ?? defaultModel
  if (!(model in models)) {
    throw new Error(`Unbekanntes Modell; gültig sind: ${modelList}`)
  }
  return model as keyof typeof models
}

async function referenceURL(value: string, directory: string) {
  if (/^https:\/\//.test(value)) return value
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error(`Referenz muss ein lokaler Pfad oder eine HTTPS-URL sein: ${value}`)
  }
  const bytes = await readFile(path.resolve(directory, value)).catch(() => {
    throw new Error(`Referenzbild ist nicht lesbar: ${value}`)
  })
  const mime = imageMime(bytes)
  if (!mime) throw new Error(`Referenzbild muss PNG, JPEG oder WebP sein: ${value}`)
  return `data:${mime};base64,${bytes.toString("base64")}`
}

function parseImageItem(item: unknown): ImageData {
  const { b64_json, media_type, mime_type } = item as {
    b64_json?: unknown
    media_type?: unknown
    mime_type?: unknown
  }
  if (typeof b64_json !== "string") {
    throw new Error("OpenRouter lieferte ungültige Bilddaten")
  }
  const declared = [media_type, mime_type].find(
    (value): value is Mime => typeof value === "string" && value in extensions,
  )
  const bytes = Buffer.from(b64_json, "base64")
  const mime = imageMime(bytes) ?? declared
  if (!mime) throw new Error("Bildformat in der Antwort nicht unterstützt")
  return { bytes, mime }
}

async function postImages(key: string, body: Record<string, unknown>, signal: AbortSignal) {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort,
    })
  } catch {
    throw new Error(
      abort.aborted ? "Bildanfrage abgebrochen oder Zeitlimit erreicht" : "OpenRouter-Anfrage fehlgeschlagen",
    )
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`OpenRouter lieferte HTTP ${response.status} für Modell ${String(body.model)}`)
  }
  const result = (await response.json()) as { data?: unknown[] }
  const items = Array.isArray(result.data) ? result.data : []
  if (items.length === 0) throw new Error("OpenRouter lieferte keine Bilddaten")
  return items.map(parseImageItem)
}

async function saveImages(images: ImageData[], directory: string, sessionID: string) {
  const target = path.join(directory, ".data", "session", sessionID, "images")
  await mkdir(target, { recursive: true })
  const prefix = `image-${timestamp()}-${randomUUID().slice(0, 8)}`

  return Promise.all(
    images.map(async (image, index) => {
      const suffix = images.length === 1 ? "" : `-${index + 1}`
      const file = path.join(target, `${prefix}${suffix}.${extensions[image.mime]}`)
      await writeFile(file, image.bytes)
      return { path: file, mime: image.mime }
    }),
  )
}

export async function imageAttachment(file: string) {
  const bytes = await readFile(file)
  const mime = imageMime(bytes)
  if (!mime) throw new Error(`Gespeichertes Bild hat ein nicht unterstütztes Format: ${file}`)
  return {
    type: "file" as const,
    mime,
    url: `data:${mime};base64,${bytes.toString("base64")}`,
    filename: path.basename(file),
  }
}

async function imageResult(result: Record<string, unknown>, files: string[]) {
  return {
    output: ["Bild erfolgreich erstellt.", JSON.stringify(result)].join("\n"),
    attachments: await Promise.all(files.map(imageAttachment)),
  }
}

async function requestKey(client: Parameters<Plugin>[0]["client"], directory: string, signal: AbortSignal) {
  const response = await client.config.providers({ query: { directory }, signal }).catch(() => {
    throw new Error("OpenCode-Providerabfrage fehlgeschlagen")
  })
  const provider = response.data?.providers?.find((entry) => entry.id === "openrouter")
  const key = [provider?.options?.apiKey, provider?.key].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0 && value !== "OAUTH_DUMMY_KEY",
  )
  if (!key) throw new Error("OpenRouter ist in OpenCode nicht mit einem API-Key verbunden")
  return key
}

async function rootSessionID(client: Parameters<Plugin>[0]["client"], sessionID: string, signal: AbortSignal) {
  let current = sessionID
  while (true) {
    const response = await client.session.get({ path: { id: current }, signal }).catch(() => {
      throw new Error("OpenCode-Session konnte nicht gelesen werden")
    })
    const parentID = response.data?.parentID
    if (!parentID) return current
    current = parentID
  }
}

async function readJSON<T>(file: string): Promise<T | undefined> {
  return readFile(file, "utf8").then((content) => JSON.parse(content) as T).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
}

async function existingLatest(sceneRoot: string) {
  for (const extension of Object.values(extensions)) {
    const file = path.join(sceneRoot, `latest.${extension}`)
    try {
      await access(file, constants.R_OK)
      return file
    } catch {}
  }
}

async function linkLatest(sceneRoot: string, image: string) {
  await Promise.all(Object.values(extensions).map(async (extension) => {
    await unlink(path.join(sceneRoot, `latest.${extension}`)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    })
  }))
  const latest = path.join(sceneRoot, `latest${path.extname(image)}`)
  await symlink(path.relative(sceneRoot, image), latest)
  return latest
}

function visualAnchor(description: string, scene: string) {
  return `${description}\n\n${scene}`.trim()
}

export function createSceneImageRenderer(client: Parameters<Plugin>[0]["client"], directory: string) {
  async function files(root: string, scene: string, npc: string) {
    const npcRoot = path.join(root, "npcs", npc)
    return {
      description: await readFile(path.join(npcRoot, "description.md"), "utf8"),
      state: await readFile(path.join(npcRoot, "state.md"), "utf8"),
      scene: await readFile(path.join(npcRoot, "scenes", scene, "scene.md"), "utf8"),
      image: path.join(npcRoot, "img.png"),
    }
  }

  async function render(
    context: Pick<ToolContext, "sessionID" | "abort" | "ask">,
    options: { model?: string; aspectRatio?: string; resolution?: string; additions?: string[]; removals?: string[] } = {},
  ) {
    const sessionID = await rootSessionID(client, context.sessionID, context.abort)
    const root = path.join(directory, ".data", "session", sessionID)
    const current = await readJSON<SceneContext>(path.join(root, "scene-context.json"))
    if (!current) throw new Error("Keine aktive Szene in dieser Session")

    const sceneRoot = path.join(root, "scenes", current.scene)
    const pendingFile = path.join(sceneRoot, "image-pending")
    const sceneDescription = await readFile(path.join(sceneRoot, "scene.md"), "utf8")
    const visualState = await readFile(path.join(sceneRoot, "visual-state.md"), "utf8").catch(() => "")
    const route = resolveModel(options.model)
    const key = await requestKey(client, directory, context.abort)
    const target = path.join(sceneRoot, "images")
    await mkdir(target, { recursive: true })
    let latest = await existingLatest(sceneRoot)
    const hadLatest = Boolean(latest)
    let lastImage: SavedImage | undefined
    const debug: SceneImageDebug = {
      model: route,
      parameters: { n: 1, aspectRatio: options.aspectRatio ?? null, resolution: options.resolution ?? null },
      steps: [],
    }

    const saveSceneImage = async (image: ImageData) => {
      const file = path.join(target, `scene-${timestamp()}-${randomUUID().slice(0, 8)}.${extensions[image.mime]}`)
      await writeFile(file, image.bytes)
      latest = await linkLatest(sceneRoot, file)
      lastImage = { path: file, mime: image.mime }
      return file
    }

    const edit = async (prompt: string, references: string[], step: SceneImageDebug["steps"][number]) => {
      if (references.length > models[route].maxReferences) {
        throw new Error(`${route} akzeptiert höchstens ${models[route].maxReferences} Referenzbilder`)
      }
      await context.ask({
        permission: "image_edit",
        patterns: [route],
        always: [],
        metadata: { model: route, referenceCount: references.length },
      })
      const images = await postImages(key, {
        model: route,
        prompt,
        n: 1,
        input_references: (await Promise.all(references.map((value) => referenceURL(value, directory)))).map((url) => ({
          type: "image_url",
          image_url: { url },
        })),
        aspect_ratio: options.aspectRatio,
        resolution: options.resolution,
      }, context.abort)
      debug.steps.push({ ...step, references: references.map((value) => path.relative(directory, value)) })
      return saveSceneImage(images[0])
    }

    const removals = options.removals ?? []
    for (const npc of removals) {
      if (!latest) continue
      const anchor = visualAnchor(
        (await files(root, current.scene, npc)).description,
        (await files(root, current.scene, npc)).scene,
      )
      await edit([
        "Bearbeite das Referenzbild und entferne diese Figur vollständig.",
        `Zu entfernen (${npc}): ${anchor}`,
        "Erhalte alle übrigen Figuren, deren Kleidung, Umgebung, Lichtstimmung und Komposition.",
        "Fülle den frei werdenden Bereich natürlich als Teil der Szene.",
        `Aktueller sichtbarer Zustand:\n${visualState}`,
      ].join("\n\n"), [latest], { action: "remove", npc, references: [] })
    }

    const additions = latest ? (options.additions ?? []) : current.npcs
    for (const npc of additions) {
      const npcFiles = await files(root, current.scene, npc)
      const anchor = visualAnchor(npcFiles.description, npcFiles.scene)
      const base = latest ?? path.join(sceneRoot, "img.png")
      await edit([
        "Bearbeite das Szenenbild und füge genau diese Figur passend ein.",
        `Neue Figur (${npc}): ${anchor}`,
        `Zustand der Figur:\n${npcFiles.state}`,
        `Globale Szene:\n${sceneDescription}`,
        `Aktueller sichtbarer Zustand:\n${visualState}`,
        "Die Kleidung und sichtbaren Details aus der NPC-Szenenbeschreibung sind verbindlich und dürfen nicht ersetzt oder neu interpretiert werden.",
        "Erhalte alle bereits sichtbaren Figuren, die Umgebung, den Stil und die Komposition des Referenzbilds.",
      ].join("\n\n"), [base, npcFiles.image], { action: "add", npc, references: [] })
    }

    if (hadLatest && latest && options.additions === undefined && options.removals === undefined) {
      await edit([
        "Aktualisiere das Referenzbild, statt eine neue Szene zu erfinden.",
        "Behalte Ort, alle sichtbaren Figuren und ihre visuellen Identitäten bei.",
        `Globale Szene:\n${sceneDescription}`,
        `Aktueller sichtbarer Zustand:\n${visualState}`,
        "Ändere nur Stimmung, Posen, Blickrichtungen und Bildausschnitt, soweit der aktuelle Zustand es beschreibt.",
      ].join("\n\n"), [latest], { action: "update", references: [] })
    }

    await unlink(pendingFile).catch(() => {})
    if (!latest || !lastImage) throw new Error("Die Szene enthält keine Figur zum Rendern")
    return {
      path: path.relative(directory, lastImage.path),
      file: lastImage.path,
      debug,
    }
  }

  async function pending(sessionID: string) {
    const rootID = await rootSessionID(client, sessionID, new AbortController().signal)
    const context = await readJSON<SceneContext>(path.join(directory, ".data", "session", rootID, "scene-context.json"))
    if (!context) return
    await writeFile(path.join(directory, ".data", "session", rootID, "scenes", context.scene, "image-pending"), "pending\n")
  }

  return { render, pending }
}

export const ImageToolsPlugin: Plugin = async ({ client, directory }) => {
  const sceneRenderer = createSceneImageRenderer(client, directory)

  const args = {
    prompt: tool.schema.string().trim().min(1).describe("Bildbeschreibung"),
    model: tool.schema.string().optional().describe(`Route aus: ${modelList}`),
    aspectRatio: tool.schema
      .string()
      .optional()
      .describe("z. B. 1:1, 16:9; nur Werte, die das Modell unterstützt"),
    resolution: tool.schema
      .string()
      .optional()
      .describe("z. B. 1K, 2K; nur Werte, die das Modell unterstützt"),
  }

  return {
    tool: {
      image_generate: tool({
        description: [
          "Erzeugt ein Bild über OpenRouter.",
          "Ergebnisse landen unter .data/session/<session-id>/images/ der aktuellen Hauptchat-Session.",
          `Standardmodell: ${defaultModel} (zuverlässig); ${fastModel} ist die schnelle Alternative.`,
          "Optionen nur senden, wenn das Modell sie unterstützt.",
        ].join(" "),
        args,
        async execute({ prompt, model, aspectRatio, resolution }, context) {
          const route = resolveModel(model)
          await context.ask({
            permission: "image_generate",
            patterns: [route],
            always: [route],
            metadata: { model: route },
          })
          const key = await requestKey(client, directory, context.abort)
          const images = await postImages(
            key,
            { model: route, prompt, n: 1, aspect_ratio: aspectRatio, resolution },
            context.abort,
          )
          const saved = await saveImages(images, context.directory, context.sessionID)
          return await imageResult({ model: route, images: saved }, saved.map((image) => image.path))
        },
      }),
      image_edit: tool({
        description: [
          "Bearbeitet oder kombiniert Bilder mit Referenzbildern über OpenRouter.",
          "Ergebnisse landen unter .data/session/<session-id>/images/ der aktuellen Hauptchat-Session.",
          `Standardmodell: ${defaultModel} (zuverlässig); ${fastModel} ist die schnelle Alternative.`,
          "Referenzen sind lokale Pfade (relativ zum Workspace-Verzeichnis) oder HTTPS-URLs.",
          "Die maximale Referenzanzahl hängt vom Modell ab.",
        ].join(" "),
        args: {
          ...args,
          referenceImages: tool.schema
            .array(tool.schema.string().trim().min(1))
            .min(1)
            .max(16)
            .describe("Geordnete lokale Pfade oder HTTPS-URLs als Bearbeitungsreferenzen"),
        },
        async execute({ prompt, model, aspectRatio, resolution, referenceImages }, context) {
          const route = resolveModel(model)
          const maxReferences = models[route].maxReferences
          if (referenceImages.length > maxReferences) {
            throw new Error(`${route} akzeptiert höchstens ${maxReferences} Referenzbilder`)
          }
          await context.ask({
            permission: "image_edit",
            patterns: [route],
            always: [],
            metadata: { model: route, referenceCount: referenceImages.length },
          })
          const references = await Promise.all(
            referenceImages.map((value) => referenceURL(value, context.directory)),
          )
          const key = await requestKey(client, directory, context.abort)
          const images = await postImages(
            key,
            {
              model: route,
              prompt,
              n: 1,
              input_references: references.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
              aspect_ratio: aspectRatio,
              resolution,
            },
            context.abort,
          )
          const saved = await saveImages(images, context.directory, context.sessionID)
          return await imageResult(
            { operation: "edit", model: route, images: saved },
            saved.map((image) => image.path),
          )
        },
      }),
      scene_image_render: tool({
        description: "Aktualisiert das Bild der aktiven Social-Game-Szene anhand ihres gespeicherten visuellen Zustands. Gibt nur den relativen Pfad zum aktuellen Bild zurück.",
        args: {
          model: args.model,
          aspectRatio: args.aspectRatio,
          resolution: args.resolution,
        },
        async execute({ model, aspectRatio, resolution }, context) {
          try {
            const rendered = await sceneRenderer.render(context, { model, aspectRatio, resolution })
            const { file, ...result } = rendered
            return await imageResult(result, [file])
          } catch (error) {
            await sceneRenderer.pending(context.sessionID)
            throw error
          }
        },
      }),
    },
  }
}
