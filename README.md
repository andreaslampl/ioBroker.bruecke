# ioBroker.bruecke

**Brücke zwischen Standorten:** gibt ausgewählte Datenpunkte zwischen mehreren ioBroker-Installationen weiter, z. B.
zwischen Zuhause, Geschäft und Ferienhaus über ein VPN – ohne MQTT-Broker, ohne Multihost.

- **Jeder Standort bleibt selbstständig.** Die Logik läuft weiter vor Ort; fällt das VPN aus, wird nur
  `bruecke.0.<standort>.connected` falsch, die letzten Werte bleiben stehen.
- **Freigeben:** Jeder Standort bestimmt selbst, welche Datenpunkte die anderen sehen dürfen – pro Datenpunkt
  **nur lesen** oder **lesen + schalten**. Auswahl im Objektbaum: einzelne Datenpunkte oder ganze Ordner / Kanäle /
  Geräte (alles darunter, z. B. `spc-edp.0.areas`) oder ein ganzer Adapter (`spc-edp.0`). Von Hand geht auch `spc-edp.0.areas.*`.
- **Sehen:** Die Datenpunkte des anderen Standorts erscheinen unter `bruecke.0.<standort>.<originale ID>`, mit
  gleichem Typ, Einheit, Rolle und Texten (z. B. „Unscharf / Scharf“) – direkt nutzbar in SmartView, VIS, Logik, Blockly.
- **Schalten:** Ein schaltbarer Datenpunkt wird hier geschrieben (ohne Bestätigung) → der Befehl geht an den anderen
  Standort; die Bestätigung des Geräts dort kommt zurück. Nicht freigegebene Befehle werden abgelehnt.
- **Sicher:** gemeinsamer Zugriffsschlüssel mit Gegenprüfung (der Schlüssel selbst geht nie über das Netz), danach
  ist jede Nachricht verschlüsselt (AES-256-GCM). 5 falsche Anmeldungen → 1 Minute gesperrt.
- **Verbindungsstatus** pro Standort und automatisches Neuverbinden (2 s … 60 s).

## Installation

Auf **jedem** Standort:

```
iobroker url https://github.com/andreaslampl/ioBroker.bruecke
```

## Beispiel: Alarmanlage vom Friseursalon zuhause sehen und schalten

**Im Friseursalon** (der Standort mit der Alarmanlage), Instanz-Einstellungen:

| Reiter | Feld | Wert |
|---|---|---|
| Allgemein | Name dieses Standorts | `Friseursalon` |
| Freigeben | Port | `8102` |
| Freigeben | Zugriffsschlüssel | ein langes Passwort, z. B. `Salon-Bruecke-2026!` |
| Freigeben | Datenpunkte | ins Feld klicken → im Objektbaum den Ordner `spc-edp.0.areas` wählen (nur lesen) |
| | | `spc-edp.0.areas.1.setMode` ✔ darf schalten (falls du von zuhause scharf/unscharf schalten willst) |

**Zuhause**, Instanz-Einstellungen:

| Reiter | Feld | Wert |
|---|---|---|
| Allgemein | Name dieses Standorts | `Zuhause` |
| Standorte | Name | `Friseursalon` |
| | Adresse | VPN-Adresse des ioBroker im Salon, z. B. `192.168.20.10` (Port 8102 wird ergänzt) |
| | Zugriffsschlüssel | derselbe wie im Salon |

Danach gibt es zuhause z. B. `bruecke.0.friseursalon.spc-edp.0.areas.1.mode` – in SmartView einfach diesen Datenpunkt
in der Alarm-Kachel auswählen.

**In beide Richtungen?** Soll der Salon auch etwas von zuhause sehen, dann zuhause Datenpunkte freigeben und im
Salon „Zuhause“ als Standort eintragen. Jede Richtung ist eine eigene Verbindung.

**Firewall / VPN:** Der Standort, der sich verbindet (oben: zuhause), muss den Port 8102 des anderen erreichen.

## Datenpunkte

| Datenpunkt | Bedeutung |
|---|---|
| `info.connection` | alle eingetragenen Standorte verbunden |
| `info.clients` | welche Standorte gerade mit uns verbunden sind |
| `info.shared` | Anzahl freigegebener Datenpunkte |
| `<standort>.connected` | Verbindung zu diesem Standort (gut für eine Push-Regel „Standort nicht erreichbar“) |
| `<standort>.lastSeen` | Zeit der letzten Änderung der Verbindung |
| `<standort>.lastError` | letzter Fehler (z. B. „Schlüssel falsch“, „nicht erreichbar (VPN / Firewall?)“) |
| `<standort>.points` | Anzahl Datenpunkte von dort |
| `<standort>.<id>` | die gespiegelten Datenpunkte |

Wird eine Freigabe dort entfernt, verschwindet der Datenpunkt hier beim nächsten Verbinden. Wird ein Standort aus der
Liste gelöscht, werden seine Datenpunkte hier gelöscht.

## Hinweise

- Höchstens 2000 freigegebene Datenpunkte je Standort.
- Ist die Verbindung weg, wird ein Befehl nicht zwischengespeichert: der Datenpunkt springt auf den letzten bekannten
  Wert zurück und im Log steht „nicht verbunden“.
- Die Uhren der Standorte sollten stimmen (Zeitstempel kommen vom anderen Standort).

## Changelog

### 0.1.3
- Ganze Adapter-Instanz freigeben (z. B. `spc-edp.0`)

### 0.1.2
- Verständlichere Verbindungsfehler

### 0.1.1
- Freigaben im Objektbaum auswählen, auch ganze Ordner / Kanäle / Geräte

### 0.1.0
- Erste Version

## License

MIT License, Copyright (c) 2026 andreaslampl
