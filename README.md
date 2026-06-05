# Thirai Stremio Addon

Browse and watch South Asian cinema (Tamil, Hindi, Telugu, Malayalam and more) from Einthusan — directly inside Stremio.

## Features

- **Featured / Popular** catalog per language
- **Recent releases** catalog per language
- **Search** per language
- Streams SD, HD, and UHD (4K) where available
- Subtitles flag shown in metadata

## Quick Install

If you're hosting this on a server (e.g. `https://stremio.thirai.me`), open this URL in a browser or paste it into Stremio's addon search:

```
https://stremio.thirai.me/manifest.json
```

Or use the Stremio deep-link:

```
stremio://stremio.thirai.me/manifest.json
```

## Self-Host

```bash
npm install
npm start          # runs on http://localhost:7000
```

Set `PORT` env var to change the port.

## Deployment (Railway / Render / Fly.io)

1. Push this folder to a GitHub repo.
2. Connect to Railway/Render, set start command to `npm start`.
3. Set `PORT` if needed (most platforms inject it automatically).
4. Add the public HTTPS URL to Stremio.

## Supported Languages

Tamil · Hindi · Telugu · Malayalam · Kannada · Punjabi · Bengali · Marathi

## Notes

- UHD streams require valid Einthusan premium credentials configured on **api.thirai.me** (env vars `EINTHUSAN_EMAIL` / `EINTHUSAN_PASSWORD`).
- Video is proxied through `api.thirai.me/proxy` to handle CORS and CDN auth.
