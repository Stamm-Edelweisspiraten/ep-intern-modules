# plz-de.json

Zuordnung deutsche Postleitzahl → Ortsnamen, abgeleitet aus den GeoNames-Postleitzahldaten
(<https://download.geonames.org/export/zip/>, Lizenz [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
Gefiltert (Firmen-/Behörden-Postleitzahlen und Sammelnamen entfernt) und auf `{ "<PLZ>": ["Ort", …] }` reduziert.
Nutzung: Ort-Ergänzung beim Eintippen einer PLZ (`address.service.ts`, `placesForPostalCode`).
