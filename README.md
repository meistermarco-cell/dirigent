# Dirigent

A conductor for Claude Code in the Claude desktop app: one master session hands your requests to worker sessions, and a live band above the prompt shows what each of them is doing. The skill and all of its messages are in German.

Dirigent ist ein Mod mit Skill für den Code-Tab der Claude-Desktop-App. Eine Master-Session nimmt deine Aufträge an und verteilt sie an Arbeits-Sessions mit passendem Modell. Sie überwacht Fortschritt, Limits und Kontext und archiviert fertige Sessions.

```
🎼 Musik  📌 2  ❓1 🔄2 ☑️1  ▰▰▰▱▱ 58 %  5h 25 %  bereit
❓ farb-wahl ▰▰▱▱▱ 40 % · Welche Farbe?
🔄 layout-bau ▰▰▰▱▱ 50 % · Band bauen
🔄 mix ▱▱▱▱▱ 0 % · Spuren einlesen
☑️ wissen ▰▰▰▰▰ 100 % · Bestand eingearbeitet
```

Das Band steht immer zwischen Chatverlauf und Texteingabe und zeigt das Wichtigste auf kleinem Raum. Die Kopfzeile bleibt eine Zeile; wird es eng, kürzt sie zuerst den Text.

| Zeichen | Bedeutung |
|---|---|
| 📌 | so viele offene Punkte stehen auf der Liste |
| `5h 25 %` | 5-Stunden-Limit, ab 80 % hervorgehoben als ⚠️ |
| ❓ | wartet auf dich: eine Frage oder eine Freigabe-Karte |
| ⚠️ | seit über 20 Minuten keine Meldung, oder als eigene Zeile: Dateikonflikt |
| 🔄 | arbeitet |
| ⏸️ | Runde zu Ende, Aufgabenliste aber nicht |
| ☑️ | die Session hat sich fertig gemeldet, der Dirigent hat es noch nicht geprüft |
| ✅ | vom Dirigenten geprüft, verschwindet nach 30 Minuten |

Auf dem Desktop stehen unter den Stand-Zeilen Knöpfe: eine Session wählen, öffnen und stoppen. Wartet eine Session, ist sie schon ausgewählt. Hat sie ihre Runde mit einer Frage beendet, kannst du direkt im Band antworten.

## Offene Punkte

Keine gute Idee soll auf der Strecke bleiben. Der Dirigent hält eigene Vorschläge, unbeantwortete Fragen, Zurückgestelltes und offene Fragen aus den Meldungen der Sessions in einer Liste fest (`offen_merken`) und nennt am Ende jeder Antwort die Anzahl. Die Liste übersteht `/clear` und Neustart. Ein Punkt verschwindet nur mit Beleg oder auf dein Wort (`offen_erledigen`, Pflichtfeld `grund`).

Die Mod hilft dabei auf zwei Wegen: Jede deiner Nachrichten bringt dem Dirigenten die offene Liste mit, und eine Stichwortprüfung erinnert ihn, wenn seine Antwort nach Vorschlag oder Frage klingt, ohne dass er etwas festgehalten hat. Die Prüfung trägt nichts selbst ein.

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

## Skill-Verwaltung

Der Dirigent hilft, dass passende Skills genutzt und gepflegt werden. Er weist Arbeits-Sessions in der Auftragszeile `Skills:` passende Skills zu, die Mod schreibt mit, welche Skills wirklich geladen werden (das Band zeigt `[name]` oder `[name?]`, wenn der Skill noch nicht geladen ist), und das Werkzeug `skills_lage` fasst Nutzung, Lücken und Aufräum-Kandidaten zusammen. Mitgelieferte Skills (etwa `update-config`) kennt `skills_lage` nicht; sie nimmt der Master aus seiner eigenen Skill-Liste. Hinweise zu Skills hält `skill_hinweis` fest; daraus entstehen Entwürfe unter `vorschlaege/`.

Wird ein Skill geändert, merkt sich `skill_aenderung` Datum und Sicherung. `skills_lage` vergleicht dann Erfolgsquote und Hinweise vorher und nachher; unter 5 Nutzungen je Seite sagt es, dass die Daten nicht reichen. Wird es schlechter, schlägt der Dirigent vor, die Sicherung zurückzuspielen.

Passt ein fremder Skill oder ein Plugin aus dem Internet und würde die Arbeit am Projekt deutlich effizienter machen, schlägt der Dirigent auch das vor: von selbst höchstens einmal je Projekt und höchstens 3 auf einmal, je Vorschlag mit Name, Link, Nutzen, Quelle und Risiko. Eine günstige, nur lesende Session recherchiert dafür und prüft Herkunft, Pflege, Lizenz, Rechte und Inhalt; sie lädt nichts herunter und führt nichts aus. Findet sie nichts deutlich Besseres, hörst du nichts davon. Jeder Vorschlag landet als offener Punkt, und was du ablehnst, kommt mit Grund nicht wieder.

Der Dirigent **schlägt nur vor**. Er ändert keinen Skill ohne dein Wort, installiert fremde Skills nur auf dein ausdrückliches Wort zu genau diesem Vorschlag und ändert keine Einstellungen selbst; zum Ausblenden selten genutzter Skills liefert `skills_ausblenden` nur einen Befehl, den du selbst ausführst. Aufräum-Kandidaten gibt es erst nach 30 Tagen Protokoll.

## Bevor du es benutzt

- **Der Dirigent arbeitet mit weiten Freigaben.** Er schaltet seine Session in den Auto-Modus (die App fragt dich einmal), und Arbeits-Sessions erben ihn. Sie bekommen den Auftrag, selbständig und ohne Rückfrage zu arbeiten. Endgültiges Löschen, Veröffentlichen, Pushen und Nachrichten an andere Menschen sollen sie nur tun, wenn dein Auftrag das ausdrücklich sagt. Das ist eine Anweisung an das Modell und keine technische Sperre. Nutze den Dirigenten nur für Arbeit, bei der du damit leben kannst.
- **Er verbraucht schneller deine Limits**, weil mehrere Sessions gleichzeitig laufen.
- **Er archiviert fertige Sessions automatisch** und bereinigt seinen eigenen Chat, wenn der Kontext voll wird.
- **Nur für die Desktop-App.** Er braucht deren Session-Werkzeuge; im reinen Terminal oder mit `claude -p` funktioniert er nicht.
- **Frühe Programmierschnittstelle.** Claude Code nennt die Mod-Schnittstelle „early access“; ein Update kann den Mod brechen.

## Was wo liegt

Alles bleibt auf deinem Rechner, der Mod sendet nichts ins Netz. Er ruft nur lokale Dienste der App auf (Titel, Limit, Öffnen, Stoppen, Antworten). Nur eine Recherche-Session für Skill-Vorschläge sucht im Netz, wie jede Session, die das darf; sie schickt dabei Suchanfragen zum Projekt hinaus.

| Was | Wo |
|---|---|
| Stand jeder Session (Aufgabenliste, kurzer Bericht) | `~/.claude/dirigent/stand/` |
| `local_…`-Id und geänderte Dateien jeder Session | `~/.claude/dirigent/zusatz/` |
| Welche Sessions der Dirigent geprüft hat | `~/.claude/dirigent/geprueft/` |
| Offene Punkte je Dirigent | `~/.claude/dirigent/offen/<kennung>.json` |
| Skill-Protokoll (welche Session welche Skills lud), Hinweise und Änderungen zu Skills | `~/.claude/dirigent/skills/` |
| Entwürfe für neue Skills und Änderungsvorschläge (nicht aktiv) | `~/.claude/dirigent/vorschlaege/` |
| Übergaben des Dirigenten | `~/.claude/dirigent/uebergabe-<kennung>.md` |
| Zuordnung von Master und Arbeits-Sessions | Speicher des Mods unter `~/.claude/plugins/store/` |

## Grenzen

- Das Band ist nur so aktuell wie die Aufgabenlisten der Sessions; jeder Auftrag verlangt deshalb, die Liste zu führen.
- Setzt die App eine Session nach einem Neustart fort, bekommt sie eine neue Session-Id. Der Mod erkennt sie an der Host-Id der App wieder und übernimmt Stand, Projekt und offene Punkte. Im Terminal gibt es keine Host-Id; dort beginnt eine fortgesetzte Session mit neuer Id ohne Dirigent.
- Stand-Dateien bleiben liegen, werden nach 7 Tagen aber nicht mehr gelesen. Auch ein nie geprüftes ☑️ verschwindet dann.
- Abgestürzte Sessions zeigen ab 20 Minuten ⚠️ und verschwinden nach 24 Stunden.
- Dateikonflikte: Das Band warnt, wenn zwei noch nicht geprüfte Sessions dieselbe Datei geändert haben, auch wenn eine schon fertig gemeldet ist. Erst die Prüfung (✅) oder das Ende einer Session nimmt sie aus dem Vergleich. Erkannt wird das nur bei `Write`, `Edit` und `NotebookEdit`, auch aus Unteragenten. Was eine Session über Bash ändert (`sed`, `git`, Skripte), ist nicht erfassbar. Sessions in eigenen Worktrees haben andere Pfade und gelten nicht als Konflikt.
- Im Band-Feld lässt sich nur eine Frage am Ende einer Runde beantworten. Eine Freigabe-Karte oder Auswahl-Frage beantwortet keine Nachricht; dafür gibt es `Öffnen`.
- Die Stichwortprüfung für offene Punkte erinnert auch mal grundlos und übersieht anders Formuliertes. Verlässlich wird die Liste durch den Dirigenten, nicht durch die Prüfung.
- Das Limit im Band stammt aus `get_usage` und wird höchstens einmal pro Minute gelesen. Geht das nicht, zeigt das Band nichts dazu.
- Getestet ist der Mod bisher nur auf einem Mac mit Claude Code 2.1.317.

## Entwickeln

```
claude plugin validate .
claude plugin test .
```

## Lizenz

MIT, siehe [LICENSE](LICENSE).
