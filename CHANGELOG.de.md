# Änderungen

Alle wesentlichen Änderungen an diesem Projekt werden in dieser Datei festgehalten.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionsnummern folgen [Semantic Versioning](https://semver.org/lang/de/).

[English version](CHANGELOG.md)

## [1.0.1] – 2026-10-06

### Behoben
- Die Statistik-Zusammenfassung zeigt bei einer einzelnen Übertragung „Übertragung(en)“ statt „Übertragungen“.

### Geändert
- Der CI-Workflow nutzt die aktuellen Versionen der GitHub-Actions (Node 20 wird von GitHub abgekündigt).
- Website-Links aus Dokumentation und Paketangaben entfernt; Unterstützung gibt es über GitHub Issues.

## [1.0.0] – 2026-10-06

Erste öffentliche Fassung unter der GNU GPL v3.0 oder neuer.

### Neu
- Jobs, die einen Ordner überwachen und neue Dateien an eine HTTP-Schnittstelle
  (über `curl`), einen Ordner oder eine E-Mail-Adresse zustellen, mit zusätzlichen Zielen je Job.
- Ruhezeit, maximale Dateigröße, Zeitfenster, Testmodus und Duplikat-Erkennung.
- Archiv-, Fehler- und Quarantäne-Unterordner; Wiederholungen mit wachsender Wartezeit.
- Eingescannte PDFs: QR-Erkennung mit eigenen JPEG-, CCITT-Gruppe-4- und QR-Decodern,
  Ausgabe als JSON oder Multipart mit Metadaten-Vorlage, Aufteilen von Stapelscans an QR-Codes.
- Weboberfläche mit Übersicht, Job-Details, Übertragungsprotokoll, Statistik, Kategorien,
  Vorlagen, Sammelaktionen, Schnellzugriff, hellem und dunklem Modus.
- Benutzer mit den Rollen Verwaltung, Benutzer und Betrachter; Anmeldesperre.
- Benachrichtigung per E-Mail und Webhook, wenn eine Datei in die Quarantäne wandert.
- Selbstdiagnose, Konfigurations-Warnungen, Änderungsprotokoll, Konfigurations-Sicherungen,
  Export/Import und Aktualisierung durch Hochladen eines ZIP-Pakets.
- Oberfläche auf Englisch und Deutsch; Protokoll und Benachrichtigungen in einstellbarer Sprache.
- Umgebungsvariablen `PORT` und `HOST` sowie optionale Einstellung `host`.
- Tests mit synthetischen PDF-Dateien und CI-Workflow für Linux, macOS und Windows.

[1.0.1]: https://github.com/TechFlow-IT/folderpost/releases/tag/v1.0.1
[1.0.0]: https://github.com/TechFlow-IT/folderpost/releases/tag/v1.0.0
