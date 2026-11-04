# Dirigent

A conductor for Claude Code in the Claude desktop app: one master session hands your requests to worker sessions, and a live band above the prompt shows what each of them is doing. The skill and all of its messages are in German.

Dirigent ist ein Mod mit Skill für den Code-Tab der Claude-Desktop-App. Eine Master-Session nimmt deine Aufträge an und verteilt sie an Arbeits-Sessions mit passendem Modell. Sie überwacht Fortschritt, Limits und Kontext und archiviert fertige Sessions.

```
🎼 Dirigent · Lage prüfen
? farb-wahl · Welche Farbe?
● layout-bau 2/4 · Band bauen
✓ wissen-einbau 3/3 · Bestand ist eingearbeitet.
```

Das Band steht immer zwischen Chatverlauf und Texteingabe: `?` wartet auf dich, `●` arbeitet, `✓` ist fertig und verschwindet nach 30 Minuten.

## Installieren

In der Desktop-App: **+** neben dem Eingabefeld, dann **Plugins**, **Add marketplace** mit `meistermarco-cell/dirigent`, dann **Add plugin**.

Im Terminal, an der Eingabe einer Session:

```
/plugin install dirigent --marketplace meistermarco-cell/dirigent
```

Oder aus der Shell:

```
claude plugin install dirigent --marketplace meistermarco-cell/dirigent
```

Danach einen neuen Chat öffnen und den Skill `dirigent` aufrufen. Läuft schon ein Dirigent, lädt `/reload-plugins` in dessen Chat die Mod neu.

## Bevor du es benutzt

- **Der Dirigent arbeitet mit weiten Freigaben.** Er schaltet seine Session in den Auto-Modus (die App fragt dich einmal), und Arbeits-Sessions erben ihn. Sie bekommen den Auftrag, selbständig und ohne Rückfrage zu arbeiten. Endgültiges Löschen, Veröffentlichen, Pushen und Nachrichten an andere Menschen sollen sie nur tun, wenn dein Auftrag das ausdrücklich sagt. Das ist eine Anweisung an das Modell und keine technische Sperre. Nutze den Dirigenten nur für Arbeit, bei der du damit leben kannst.
- **Er verbraucht schneller deine Limits**, weil mehrere Sessions gleichzeitig laufen.
- **Er archiviert fertige Sessions automatisch** und bereinigt seinen eigenen Chat, wenn der Kontext voll wird.
- **Nur für die Desktop-App.** Er braucht deren Session-Werkzeuge; im reinen Terminal oder mit `claude -p` funktioniert er nicht.
- **Frühe Programmierschnittstelle.** Claude Code nennt die Mod-Schnittstelle „early access“; ein Update kann den Mod brechen.

## Was wo liegt

Alles bleibt auf deinem Rechner, der Mod sendet nichts ins Netz.

| Was | Wo |
|---|---|
| Stand jeder Session (Aufgabenliste, kurzer Bericht) | `~/.claude/dirigent/stand/` |
| Übergaben des Dirigenten | `~/.claude/dirigent/uebergabe-<kennung>.md` |
| Zuordnung von Master und Arbeits-Sessions | Speicher des Mods unter `~/.claude/plugins/store/` |

## Grenzen

- Das Band ist nur so aktuell wie die Aufgabenlisten der Sessions; jeder Auftrag verlangt deshalb, die Liste zu führen.
- Eine Session, die auf eine Freigabe-Karte wartet, erscheint als `●`, nicht als `?`.
- Stand-Dateien bleiben liegen, werden nach 24 Stunden aber nicht mehr gelesen.
- Abgestürzte Sessions zeigen ab 20 Minuten `keine Meldung` und verschwinden nach 24 Stunden.
- Getestet ist der Mod bisher nur auf einem Mac mit Claude Code 2.1.317.

## Entwickeln

```
claude plugin validate .
claude plugin test .
```

## Lizenz

MIT, siehe [LICENSE](LICENSE).
