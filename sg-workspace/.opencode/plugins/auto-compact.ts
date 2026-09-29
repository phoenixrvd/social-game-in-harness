/**
 * Entscheidung: kostenorientierte Auto-Kompaktierung | 29.09.2026 | umgesetzt
 *
 * Befund: Zwei NPCs, kurze Beiträge (Median 90 Zeichen), viele kleine Änderungen;
 * Zustandsdateien erfassen Dialognuancen nur teilweise. Sitzungsstatistik: 8,89 USD,
 * 1,09 Mio. input, 16,49 Mio. cache.read. Export: 76 Beiträge, 158 Assistentenschritte;
 * davon 144 OpenRouter/Grok-4.7 (5,08 USD). Erste/letzte 36 Grok-Schritte: medianer
 * Kontext 41000/106000 Tokens, mittlere Kosten 2,5/4,4 Cent. Manuelles Compact bei
 * ca. 117000 Tokens: 0,155 USD, ca. 3000 Zeichen Zusammenfassung + ca. 18 Beiträge.
 * Export inkl. Compact: 5,24 USD; Differenz zu 8,89 USD ungeklärt. Kontextwachstum
 * mit steigenden Kosten beobachtet, Gesamtkostenursache nicht vollständig geklärt.
 *
 * Wahl: früherer Token-Trigger vor neuen Beiträgen, nur Hauptagent game-context.
 * Gründe/Standards in `.opencode/opencode.json`, `plugins[].options`:
 * - thresholdTokens=70000: unter beobachteten 100000–117000; nach Inhaltssichtung
 *   von 60000 erhöht, um aufeinander aufbauende Dialogdetails länger zu erhalten.
 * - minUserTurns=10: pragmatischer Abstand gegen häufige Kosten/Detailverluste;
 *   neue Beiträge seit erfolgreichem Compact, anfangs seit Sitzungsbeginn.
 * - agent="game-context": Subagenten ausnehmen.
 * Separat compaction.keep.tokens=15000: V2-Standard für jüngste Dialognuancen;
 * ca. 18 Beiträge im Beispiel, keine feste Umrechnung. Trigger: beide Schwellen >=;
 * Tokenmaß input+cache.read des letzten abgeschlossenen Aufrufs, ohne neuen Beitrag
 * (kein hartes Limit). Optimistisch ohne Optionsvalidierung/persistente Retries;
 * Parallel-/Wiederholschutz nur zur Laufzeit. V2-Client + lokale Service-Erkennung,
 * weil Plugin-API kein compact() bietet.
 *
 * Verworfen: eingebaute Automatik/buffer (Modellgrenze statt fester Kostentrigger);
 * Neuigkeitsklassifikator pro Beitrag mit confidence>0,9 (Zusatzkosten, unkalibriert;
 * Neuigkeit kein Maß für Kompaktierbarkeit). Risiko: Compact kostet/verliert Details;
 * Charaktere, Szene, nachhaltige Änderungen sichern. Neustart verliert Wiederholschutz.
 * Prüfung: Typecheck, Trigger-Tests, Plugin-Ladung bestanden; keine automatische
 * Live-Kosten-/Kontinuitätsprüfung, 70000/10 nicht vergleichend getestet. Kein belegtes
 * Optimum/garantierte Ersparnis; nach einigen Szenen Kosten/Kontinuität neu bewerten.
 * Quellen: https://opencode.ai/v2/docs/compaction;
 */
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { Plugin } from "@opencode/plugin";

async function compact(sessionID: string, id: string) {
  const endpoint = await Service.discover();
  if (!endpoint) throw new Error("OpenCode-Service nicht erreichbar");

  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  await client.session.compact({ sessionID, id });
}

export function createAutoCompactHandler(
  ctx: Plugin.Context,
  request: (sessionID: string, id: string) => Promise<void>,
) {
  const threshold =
    (ctx.options.thresholdTokens as number | undefined) ?? 70_000;
  const minTurns = (ctx.options.minUserTurns as number | undefined) ?? 10;
  const agent = ctx.options.agent ?? "game-context";
  const requested = new Map<string, string>();
  const running = new Set<string>();

  return async ({ sessionID }: { sessionID: string }) => {
    if (running.has(sessionID)) return;
    running.add(sessionID);

    try {
      const session = await ctx.session.get({ sessionID });
      if (session.parentID || session.agent !== agent) return;

      const messages = await ctx.session.context({ sessionID });
      const newestFirst = [...messages].reverse();
      const lastCompaction = newestFirst.find(
        (message) =>
          message.type === "compaction" && message.status === "completed",
      );
      const since = lastCompaction?.time.created ?? 0;
      const turns = messages.filter(
        (message) => message.type === "user" && message.time.created > since,
      ).length;
      if (turns < minTurns) return;

      const lastAssistant = newestFirst.find(
        (message) => message.type === "assistant" && message.time.completed,
      );
      if (
        !lastAssistant ||
        lastAssistant.type !== "assistant" ||
        !lastAssistant.tokens
      ) {
        return;
      }

      // Näherung aus dem letzten Aufruf; der neue Beitrag ist noch nicht enthalten.
      const tokens =
        lastAssistant.tokens.input + lastAssistant.tokens.cache.read;
      if (tokens < threshold) return;

      const boundary = lastCompaction?.id ?? "initial";
      if (requested.get(sessionID) === boundary) return;

      await request(sessionID, `msg_auto_compact_${lastAssistant.id}`);
      requested.set(sessionID, boundary);
    } catch (error) {
      // Die Kostenkontrolle darf den Chat nicht blockieren.
      console.warn("auto-compact: Kompaktierung übersprungen", error);
    } finally {
      running.delete(sessionID);
    }
  };
}

export default Plugin.define({
  id: "social-game.auto-compact",
  async setup(ctx) {
    const hook = await ctx.session.hook(
      "prompt",
      createAutoCompactHandler(ctx, compact),
    );
    return () => hook.dispose();
  },
});
