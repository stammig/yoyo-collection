# What the Apple apps rely on

The Yoyo Collection app for iPhone, iPad and Mac publishes to this website with
**Publish to website** (`WebPublisher.swift`). The app is the master copy and
replaces the site's collection on every publish. The Android app syncs through
`/api/sync/*` instead and isn't covered here.

`test/apple-publish.test.js` replays a publish exactly as the app sends it, in
three site setups. Every server change must keep it passing: people will be on
older app versions for a long time after a server update.

## The publish, step by step

| Step | Request | The server must |
|---|---|---|
| 1 | `POST /api/login` `{"password": "…"}` | Answer `200 {"token": "…"}`. The token is then sent as `Authorization: Bearer …`. Wrong passwords are limited (`LOGIN_FAIL_MAX`); a correct one never counts. |
| 2 | `POST /api/restore`, multipart field `file` = a zip holding only `yoyos.db` | Accept it with a bearer token in every mode, including the Settings read-only switch and `READ_ONLY`. Keep every file already in `uploads/`. Keep photo rows whose file hasn't arrived yet. |
| 3 | `HEAD /uploads/<PHOTO-UUID>.jpg`, no auth | Answer `200` when the file is there and `404` when it isn't. Not rate-limited. |
| 4 | `POST /api/sync/photos/<YOYO-UUID>/<PHOTO-UUID>`, multipart field `photo`, `image/jpeg` | Store it as `<PHOTO-UUID>.jpg`, the same case as sent, and attach it to the restored row with that uuid. |

Errors are always JSON `{"error": "…"}`; the app shows that text.

## What's in the app's database

Built by `BackupExporter.swift` (`APPLE_SCHEMA` in `test/fixtures.js` copies it):

- Two tables only: `yoyos` and `photos`. There's no `rev`, `sale_listed_at`,
  `videos`, `field_defs` or `settings`. Restore keeps the site's own videos,
  custom field definitions and sale notes when a backup has none.
- uuids are **UPPERCASE** (Swift's `UUID().uuidString`). The server compares
  uuids without regard to case, and never rewrites the case of a stored uuid or
  filename.
- Photo filenames are `<PHOTO-UUID>.jpg`. Restore accepts photo names made of
  letters, digits, `.`, `-` and `_` with an image extension; anything else is
  dropped.
- Tombstoned yoyos (`deleted_at` set) are included and stay hidden.
- Dates are `yyyy-MM-dd HH:mm:ss` in UTC.
- Zips are stored (not compressed), with correct CRC-32s and no Zip64. Restore
  now checks each entry's size and CRC-32.

## Sync changes in 1.3.0

The Apple apps don't call `/api/sync/push` or `/api/sync/changes`; those are
Android's. Two 1.3.0 changes touch the publish anyway, and both keep it
working:

- `/api/sync/photos/<YOYO>/<PHOTO>` finds the yoyo and photo without regard to
  uuid case. It still stores the file under the name in the URL.
- `PUT /api/yoyos/:id` now changes only the fields it is sent. The apps don't
  use it today; if a future version does, it can send just what changed.

## CSV

The web CSV export now has a `uuid` column, which `CSVImporter.swift` already
matches on. Cells that a spreadsheet would run as a formula (starting with `=`,
`@`, `+`, `-`, tab or CR) get a leading `'`, unless the whole cell is a plain
number such as `-5`. The web importer removes the `'` again. The Apple importer
keeps values as written, so those cells (for example a note starting "- ")
keep the `'` until the app removes it too.

## Ideas for the next Apple app update

These aren't required; today's app keeps working without them.

- Strip the leading `'` from cells that start with `'=`, `'@`, `'+` or `'-` when
  importing a CSV.
- Treat `429` from `/api/login` as "wait and retry", and show its
  `Retry-After`.
- Offer "Sign out everywhere" (`POST /api/logout-all`) next to the saved
  website password. After someone uses it on the website, the next publish
  gets `401` and the app should ask for the password again.
