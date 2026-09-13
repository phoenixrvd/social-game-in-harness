# Social Game - Agentic Zero-Code Experiment

## Idee

Dieses Projekt untersucht, ob sich der bisher in Python implementierte Workflow von **Social Game** weitgehend direkt innerhalb eines KI-Agenten betreiben lässt.

Dabei geht es nicht darum, die bestehende Anwendung nachzubauen. Stattdessen soll untersucht werden, welche Teile klassischer Anwendungslogik ein moderner Agent selbst übernehmen kann.

## Social Game als Testfall

Social Game erzeugt fortlaufende soziale Interaktionen mit KI-Charakteren. Es gibt keine feste Story oder Dialogbäume. Die Situation entwickelt sich aus der Kommunikation.

Dafür muss das System insbesondere:

- Charakter und Persönlichkeit konsistent halten
- den aktuellen Gesprächskontext berücksichtigen
- relevante Ereignisse erinnern
- soziale Zustände und Beziehungen verändern
- diese Veränderungen in späteren Gesprächen berücksichtigen

Im ursprünglichen Projekt werden diese Abläufe durch Python-Komponenten koordiniert.

## Neuer Ansatz

Im neuen Projekt soll möglichst viel davon direkt durch den Agenten erfolgen:

**Benutzer -> Agent -> Kontext / Memory / Werkzeuge**

Die zentrale Frage lautet:

**Kann ein Agent selbst die Rolle der Social-Game-Engine übernehmen, sodass statt programmierter Workflows hauptsächlich Instruktionen, Kontext und vorhandene Agenten-Werkzeuge benötigt werden?**

Damit dient Social Game als praktisches Experiment für die allgemeinere Frage, wie weit sich klassische KI-Anwendungsentwicklung in Richtung **Zero Code innerhalb eines Agenten** verschieben lässt.

## Status

Experimentelles Testprojekt. Strukturen, Regeln und Inhalte dürfen sich mit den Erkenntnissen aus den Versuchen ändern.

## Arbeitsweise

Alle Mitwirkenden und Agenten beachten die Regeln in [AGENTS.md](AGENTS.md).

## Projekt- und Spielkontext

Das Repository-Hauptverzeichnis ist das eigentliche Projekt. Es enthält die
Dokumentation, Experimente und die versionierte Konfiguration für Social Game.

Für die Nutzung des Social Game muss hingegen `sg-workspace/` als eigenes
OpenCode-Projekt geöffnet werden. Dieses Verzeichnis ist kein separates
Softwareprojekt, sondern konfiguriert die Spielumgebung: Seine `AGENTS.md` legt
das Verhalten im Chat, die Agentenkoordination sowie den Umgang mit Szenen und
Session-Zuständen fest.

## Nutzung

Installiere OpenCode und starte es aus dem Workspace:

```sh
cd sg-workspace
opencode
```

Für die Bildfunktionen muss OpenRouter in OpenCode mit einem API-Key verbunden
sein.

## Anpassungen

Lege globale Nutzerpräferenzen als Markdown-Datei unter
`sg-workspace/.data/instructions/` ab.

Beispiel:

```text
sg-workspace/.data/instructions/präferenzen.md
```

Nutze sie für dauerhafte Vorgaben wie Ton, Spieldynamik oder visuelle Präferenzen.
