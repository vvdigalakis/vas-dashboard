# Dashboard app

A single static page. It logs in to Dropbox in your browser and reads and edits `vas-work` directly. The code holds no data and no secrets; your files only reach the browser after you log in.

- `index.html`, `styles.css`: the page.
- `core.js`: parsing and editing of PORTFOLIO.md and NOTES.md (no network).
- `app.js`: Dropbox login, loading, saving, and the interface.

## Run locally
`python3 -m http.server 8765 --bind 127.0.0.1` in this folder, then open http://localhost:8765/.

## Dropbox app settings
Scoped access, Full Dropbox. Permissions: files.metadata.read, files.content.read, files.content.write. Allow public clients (PKCE). Redirect URIs: `http://localhost:8765/` and the GitHub Pages address. Never generate an access token.

## Safety
- Strict Content-Security-Policy: only these scripts run; the page talks only to Dropbox.
- All file text is shown as text, never run.
- Saves overwrite a file only if it has not changed since it was read.
- The Dropbox key stays in the tab and expires in about 4 hours. Revoke the app any time in Dropbox settings.
