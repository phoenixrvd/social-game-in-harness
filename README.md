# Social Game - Agentic Zero-Code Experiment

## Idee

Dieses Projekt untersucht, ob sich der bisher in Python implementierte Workflow von **Social Game** weitgehend direkt innerhalb eines KI-Agenten betreiben laesst.

Dabei geht es nicht darum, die bestehende Anwendung nachzubauen. Stattdessen soll untersucht werden, welche Teile klassischer Anwendungslogik ein moderner Agent selbst uebernehmen kann.

## Social Game als Testfall

Social Game erzeugt fortlaufende soziale Interaktionen mit KI-Charakteren. Es gibt keine feste Story oder Dialogbaeume. Die Situation entwickelt sich aus der Kommunikation.

Dafuer muss das System insbesondere:

- Charakter und Persoenlichkeit konsistent halten
- den aktuellen Gespraechskontext beruecksichtigen
- relevante Ereignisse erinnern
- soziale Zustaende und Beziehungen veraendern
- diese Veraenderungen in spaeteren Gespraechen beruecksichtigen

Im urspruenglichen Projekt werden diese Ablaeufe durch Python-Komponenten koordiniert.

## Neuer Ansatz

Im neuen Projekt soll moeglichst viel davon direkt durch den Agenten erfolgen:

**Benutzer -> Agent -> Kontext / Memory / Werkzeuge**

Die erste Implementierung beschraenkt sich bewusst auf textuelle Kommunikation. Bilder, Szenengenerierung und andere visuelle Funktionen werden zunaechst nicht betrachtet.

Die zentrale Frage lautet:

**Kann ein Agent selbst die Rolle der Social-Game-Engine uebernehmen, sodass statt programmierter Workflows hauptsaechlich Instruktionen, Kontext und vorhandene Agenten-Werkzeuge benoetigt werden?**

Damit dient Social Game als praktisches Experiment fuer die allgemeinere Frage, wie weit sich klassische KI-Anwendungsentwicklung in Richtung **Zero Code innerhalb eines Agenten** verschieben laesst.

## Status

Experimentelles Testprojekt. Strukturen, Regeln und Inhalte duerfen sich mit den Erkenntnissen aus den Versuchen aendern.

## Arbeitsweise

Alle Mitwirkenden und Agenten beachten die Regeln in [AGENTS.md](AGENTS.md).

## Anpassungen

Lege globale Nutzerpräferenzen als Markdown-Datei unter
`sg-workspace/.data/instructions/` ab.

Beispiel:

```text
sg-workspace/.data/instructions/praeferenzen.md
```

Nutze sie für dauerhafte Vorgaben wie Ton, Spieldynamik oder visuelle Präferenzen.
