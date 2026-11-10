# Planning and safe upgrade

## Financial model

- All planning amounts use safe integer EUR cents. Monthly income/expense calculations remain separate from planning.
- `finance` IndexedDB version 2 adds one `planning` object store without changing existing stores. Its records are balance checkpoints, envelopes, reserve movements and preferences.
- A balance checkpoint records the user's observed amount at its timestamp. Only subsequent, non-deleted EUR operations dated up to now affect that amount. A correction appends another checkpoint; it never creates income or expense. Older history remains available.
- Confirmed reserve movements change free/reserved money only. A transfer is one record with two legs. A pending movement has no effect on confirmed reserves. Local previews include pending requests to avoid repeatedly allocating the same available amount.
- An expense optionally contains `planningPayment` (envelope, reserve limit, payment period). The reserve is consumed by the live expense, up to its current amount. Editing/deleting/restoring that expense recalculates consumption without creating another debit. An uncovered offline expense uses free cash; an envelope never becomes negative. A cash deficit remains visible.
- Recurrence preserves the original calendar day, clamps month-end/leap-day occurrences, retains unpaid periods and does not manufacture expenses or clear savings.
- Distribution is a preview, followed by explicit confirmation. Defaults: obligations, cushion, goals. Users can select global priority instead and disable automatic proposals. No expected income is treated as available cash.

## Sync 1.1 compatibility

The installed server is **not** modified by development or tests. An update requires the user's separate permission.

The new source server advertises `planning-v2` in `/ping`. A new client continues syncing operations, clients and categories with the old server, leaving planning records local and reserve requests provisional.

With a compatible server, definitions/checkpoints use ordinary signed sync. Reserve movements use `/planning/commit`, with a unique command ID and the server revision. The server serializes commands, validates funds, and acknowledges only after durable storage. Replaying an accepted command returns its original record. Stale/insufficient requests require user review. Generic last-write-wins pushes cannot change the reserve journal.

Old clients receive only known entities; new clients request `planning=2` and use a separate pull cursor so capability upgrades discover all new records without clearing existing data. Pairing IDs, non-extractable private keys, paths and server identity are preserved. A non-extractable key never appears in JSON backups.

Before an approved server update, create a verified copy of the current server data/configuration and a manual phone JSON backup. Do not install over the running server during development. Use the existing installer only after separate approval; it preserves the configured backup directory and pairing data.

## Backup format 2

Phone and PC backups include planning. Readers continue accepting version 1. Restoring a v1 backup never clears planning. Imported movements are rechecked before being treated as confirmed on a new device. Existing identical confirmed commands retain their identity; replay cannot create extra reserves. Restores with a paired PC remain edits, not a replacement of its database.

Balance checkpoints and reserve commands remain an immutable journal during restore. Extra envelopes are closed rather than deleted, allowing any remaining reserve to be released. Legacy clients receive a v1 projection of PC backups; the original v2 backup on disk is unchanged.

## Tests

- `npm run check` and `npm run build` (with `BASE_PATH=/Financy/`).
- `npm run test:app`: isolated browser, v1 migration, pairing-setting preservation, forms, local OCR, backup compatibility, manual balance history, provisional reserve and 10,000 operations.
- `npm run test:sync-server`: isolated temporary server and pure calculation/merge tests.
- `npm run test:sync`: two isolated browser devices, random test port and temporary server data. Includes competing reserves, old capability mode, linked expense edits, v2 backup/restore and restart.
- `npm run test:preview`: production resource paths, browser startup and offline reload.
- `npm run test:update`: downloads only public published app files, serves them on an isolated local origin, upgrades to the local build and checks preservation of all existing stores and a synthetic non-extractable pairing key. No financial data is uploaded.

## Manual test preview

Use the separate preview origin, not the existing installed app's origin. Do not pair a synthetic-data preview with the real PC database. Confirmed planning sync is exercised by the isolated two-device test; the installed server requires the separately approved update.

On physical iPhone check Safari and installed test PWA: touch targets, keyboard/date controls, scroll, camera/gallery, five tabs, offline restart and update prompt. Keep the existing PWA and backups. Financial data does not automatically move between origins.

## Compact planning interface

The daily screen shows confirmed reserved/free money and compact plan cards. New plans use name, budget, frequency, optional one-time date and a user-entered reserve. The form previews pending requests to avoid allocating the same cash twice, while the summary continues to show confirmed amounts.

Creating/editing a plan and its reserve delta uses one IndexedDB transaction. Closing a plan retains its history, cancels outstanding local requests and submits a normal release command for confirmed money. Released money becomes free only after confirmation. Advanced distribution, priorities, archive and request review remain in planning settings. This UI change requires no database or backup migration.


## Inline reserve workflow

Plan cards expand in place without autofocus or a modal. The entered amount is an addition, not a replacement total. Available money is bounded by both confirmed free cash and the pending projection; a pending release cannot be spent early. Metadata editing is separate and never changes a reserve. Reductions/transfers remain available as a small secondary action. Confirmed totals stay separate from provisional requests. Automatic signed sync retries transient stale revisions with the same command ID; genuine funds/command conflicts require review. See [the separately approved Sync update procedure](sync-update.md).
