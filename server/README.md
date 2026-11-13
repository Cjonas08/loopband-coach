# Sync-server voor Loopband Coach

Een kleine Cloudflare Worker die per account de trainingsbibliotheek bewaart.
Gratis binnen het gratis Cloudflare-plan (Workers + KV).

## Eenmalig installeren (via het Cloudflare-dashboard, zonder extra software)

1. Maak een gratis account op https://dash.cloudflare.com en log in.
2. **Storage & Databases → KV → Create**: maak een namespace met de naam `loopband-sync`.
3. **Workers & Pages → Create → Worker**: geef hem de naam `loopband-sync` en klik *Deploy*.
4. Klik **Edit code**, vervang alles door de inhoud van `worker.js` en klik **Deploy**.
5. Open de Worker → **Settings → Bindings → Add → KV namespace**:
   variabelenaam `SYNC`, namespace `loopband-sync`.
6. (Aanbevolen) **Settings → Variables and Secrets → Add**: `INVITE_CODE` met een code naar keuze.
   Alleen wie die code kent, kan dan een account maken.
7. Kopieer het adres van de Worker (bv. `https://loopband-sync.<naam>.workers.dev`).

Vul dat adres in de app in bij **Instellingen → Account en synchronisatie → Geavanceerd**,
of laat het als standaard in `index.html` zetten (`DEFAULT_SYNC_URL`).

## Wat er bewaard wordt

- `user:<e-mail>`: zout + PBKDF2-hash van het wachtwoord (nooit het wachtwoord zelf)
- `tok:<token>`: aanmeldtoken per toestel, 1 jaar geldig
- `data:<e-mail>`: de trainingen (tekst) en een lijst van verwijderde trainingen

Strava-gegevens en afgewerkte trainingen worden niet gesynchroniseerd.
