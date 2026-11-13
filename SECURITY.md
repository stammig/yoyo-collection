# Security

## Reporting a problem

Please report security problems privately, through GitHub's **Security** tab
→ **Report a vulnerability** on this repository, rather than in a public
issue. Include what you did, what happened, and the version (shown in the
app's footer, or `package.json`). You'll get a reply as soon as possible, and
credit in the changelog if you'd like it.

## Supported versions

Only the latest release and `main` get security fixes. The Docker image
`ghcr.io/stammig/yoyo-collection:latest` follows `main` and is published only
after the test suite passes.

## What each setup exposes

| Setup | Visitors can | Visitors can't |
|---|---|---|
| Nothing set (default) | Everything, including editing, backups and restore | — |
| `ADMIN_PASSWORD` | Browse the public view | Edit, back up, export, import, restore, see Arrivals or Sold |
| `READ_ONLY` with no password | Browse the public view | Change anything, back up, export. Nobody, including you, can change the site from the browser |
| `READ_ONLY` + `ADMIN_PASSWORD` | Browse the public view | Same as `ADMIN_PASSWORD`. You can sign in to see everything and publish |
| `AUTH_USER` / `AUTH_PASS` | Nothing without the username and password | — |
| `DEMO_MODE` | Sign in with the demo password to see the owner view | Change anything |

The **public view** shows each yoyo's name, color, specs, description, photos
and videos, and the asking price of items listed for sale or trade. It never
shows what you paid, retail or estimated value, purchase and sale dates,
seller or buyer, tracking, custom fields, or anything marked Sold.

The default (nothing set) is for a computer only you can reach. **Before
putting the app on the internet, set `ADMIN_PASSWORD`** (or `AUTH_USER` /
`AUTH_PASS`).

## Built-in protections

- Owner sessions are signed tokens. **Sign out everywhere** in Settings ends
  every session at once, and so does changing `ADMIN_PASSWORD`.
- Sign-in pauses after repeated wrong passwords (`LOGIN_FAIL_MAX`). Behind a
  proxy, set `TRUST_PROXY=1` so each visitor is counted separately.
- Changes sent from another website are refused, and the session cookie is
  `SameSite=Lax`.
- Pages run only the app's own scripts (Content-Security-Policy); photos are
  served as images only.
- Restore checks every file in a backup (names, types, sizes, checksums)
  before anything is replaced.
