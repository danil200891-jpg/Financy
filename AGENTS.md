# Finance — guide for AI coding agents (Claude Code, ChatGPT Codex)

Personal finance tracker PWA for iPhone. Free, offline-first, no backend, no accounts.
UI language: **Russian**. Code, comments and commit messages: English.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Dev server | `npm run dev` |
| Type-check | `npx tsc -b` |
| Production build | `npm run build` (copies OCR assets first via `prebuild`) |
| Build for a GitHub Pages subpath | `BASE_PATH=/<repo>/ npm run build` |
| Test on iPhone over Wi-Fi | `npm run cert` once, then `npm run iphone` (see README) |

Always run `npx tsc -b` and `npm run build` before finishing a change.

## Architecture

- React 19 + TypeScript + Vite + Tailwind CSS v4 + vite-plugin-pwa (Workbox).
- `src/lib/db.ts` IndexedDB schema (`idb`). `src/lib/store.ts` in-memory cache + actions; screens never touch IDB directly.
- `src/lib/backup.ts` JSON backup/restore (merge or replace, undoable) and CSV export.
- `src/lib/ocr.ts` Tesseract.js, fully local; assets in `public/ocr` (generated, git-ignored).
- `src/lib/receipt.ts` OCR text → amount/date/merchant/type. `src/lib/parse.ts` manual text input parser.
- `src/screens/*` screens, `src/components/*` shared UI. Design tokens live in `src/index.css` (`@theme`).

## Hard rules

1. **Do not change the approved design** (colors, typography, layout, animations) unless the user explicitly asks.
2. **User data must survive every update.**
   - Never rename the IndexedDB database `finance`, never delete or recreate object stores, never clear data in a migration.
   - Schema change → bump `DB_VERSION` in `src/lib/db.ts` and add an `if (oldVersion < N)` block that migrates in place.
   - Keep the backup format backward compatible: bump `BACKUP_VERSION` and keep `parseBackup` able to read older files.
   - Deletions are soft (`deletedAt`); every write goes through `store.ts` so it lands in the `history` store.
3. **Never invent recognized data.** If OCR/parsing can't find a field, leave it empty and set a flag for the user to confirm.
4. **Privacy.** No network calls with user data, no analytics, no paid APIs. Never commit backups, CSV exports, `.cert/`, keys or `.env` (see `.gitignore`).
5. **iOS Safari compatibility.** Build target is Safari 15. Avoid regex lookbehind `(?<=` `(?<!`, and keep the ES5 boot watchdog in `index.html` working.
6. **Paths.** The app is served from a subpath on GitHub Pages. Use `import.meta.env.BASE_URL` (or `%BASE_URL%` in `index.html`) — never hard-code `/...` URLs.
7. **Updates.** Service worker uses `registerType: 'prompt'`: a new version is offered with an «Обновить» toast; do not switch to auto-reload.
8. Do not publish, push or create remote repositories without the user's explicit permission.
