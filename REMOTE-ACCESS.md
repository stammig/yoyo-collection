# Reaching your collection from outside the LAN

The deploy guides all assume **LAN-only**, which is why they tell you to skip
passwords, rate limiting, and HTTPS. This document covers what changes when you
need it from somewhere else — and the change is bigger than just "open a port."

Start by answering one question, because it decides everything:

| What you actually need | Use | App changes |
|---|---|---|
| **Just you**, from your phone/laptop, anywhere | Tailscale (or any VPN) | **None** |
| **Others** to see the collection, links that unfurl | Tailscale Funnel or Cloudflare Tunnel | Several — see [Going public](#tier-2-going-public) |
| A **public showcase**, nothing at home exposed | [Static snapshot](#tier-3-static-snapshot) | Export tooling (not built yet) |

Most people asking this question want the first row. It's also the only one that
requires no changes to the app at all.

> **Never just forward port 3000 on your router.** That publishes your home IP,
> puts an unauthenticated app on the open internet, and gives you no HTTPS. Every
> option below is easier *and* safer. There is no scenario in this document where
> raw port forwarding is the right answer.

---

## Tier 1: private access (recommended)

A mesh VPN puts your phone and your NAS on the same virtual network. You reach
the app exactly as you do at home, from anywhere, and **nothing is exposed to
the internet**. No port forwarding, no certificates, no public DNS.

This is the right answer for the overwhelming majority of cases: you want *your*
collection on *your* phone, not a public website.

**Tailscale** is the easiest. The free plan covers 6 users with unlimited
devices, which is enough for a household.

### Install it

| Platform | How |
|---|---|
| OMV / Debian / Armbian | `curl -fsSL https://tailscale.com/install.sh \| sh` |
| Unraid | **Tailscale** plugin in Community Applications |
| Synology | **Tailscale** in Package Center |
| TrueNAS SCALE | **Tailscale** in the Apps catalog |
| QNAP | **Tailscale** in App Center |
| macOS | `brew install --cask tailscale` or the App Store |
| Windows | `winget install tailscale.tailscale` |

Then `sudo tailscale up`, sign in, and install Tailscale on your phone. The app
is now at **http://your-nas-name:3000** from anywhere — MagicDNS resolves the
name, so it survives your home IP changing.

### Optional: HTTPS inside the tailnet

`tailscale serve` fronts the app with a real certificate, so you get
`https://your-nas.tailnet-name.ts.net` instead of a bare IP and port:

```bash
tailscale serve --bg 3000
```

Nice to have, not required. Worth it if you want the app installable as a
home-screen web app, since some browsers require HTTPS for that.

### Why no app changes are needed

The network is the boundary. Only your devices can reach the app, so the
`ADMIN_PASSWORD` read-only split and `RATE_LIMIT_MAX` still have nothing to
protect against. Leave the deploy guide's configuration exactly as it is.

**Other VPN options** work identically: WireGuard, ZeroTier, Netbird, or
self-hosted Headscale if you'd rather not depend on Tailscale's coordination
server. Most NAS platforms also ship a built-in VPN server. The reasoning above
applies to all of them.

---

## Tier 2: going public

Only do this if people **other than you** need to reach it — you want to share
a For Sale page, or you want `/y/:id` links to unfurl with a photo when pasted
into a chat app.

Two ways in, both avoiding port forwarding:

**Tailscale Funnel** — extends the setup you already have to the public
internet, with automatic HTTPS. No domain needed:

```bash
tailscale funnel --bg 3000
```

You get a public `https://your-nas.tailnet-name.ts.net` URL. Turn it off with
`tailscale funnel --https=443 off`.

**Cloudflare Tunnel** — the better choice if you want your *own* domain. Runs a
lightweight connector container alongside the app, terminates HTTPS at
Cloudflare, and never exposes your home IP.

### Now the security posture flips ⚠️

Everything the deploy guides told you to skip comes back. Work through all of
this before you turn the tunnel on:

- **Set `ADMIN_PASSWORD`** to something long and random. This is what keeps the
  public view read-only — without it, *anyone with the URL can edit or delete
  your entire collection*. Private fields (prices, sellers, buyers, purchase
  dates) are hidden from visitors automatically once it's set.
- **Set `RATE_LIMIT_MAX`** (120 is generous for humans) to slow password guessing
  and stop bots. Photo GETs are exempt, so this won't hurt normal browsing.
- **Set `FRAME_ANCESTORS`** to your site's origin if you're embedding the app in
  an iframe; leave it unset otherwise.
- **Consider `DEMO_MODE=1`** if you want people to see the owner view without
  being able to change anything. It also adds `noindex`.

Both tunnel options give you HTTPS automatically, so you don't need to configure
certificates.

### Two things the app already handles correctly

Behind a tunnel or reverse proxy, the app reads the first `X-Forwarded-For`
entry for rate limiting, so per-IP throttling works on real client addresses
rather than lumping everyone under the proxy. And the login cookie switches to
`Secure; SameSite=None` when it sees `x-forwarded-proto: https`, so login works
inside an HTTPS iframe — including mobile Safari, which blocks third-party
cookies and is why the app also accepts a bearer token.

### Worth doing before public exposure

Two items are deliberately deferred in the deploy guides because they only
matter when strangers can reach `/api/login` — and now they can:

- `server.js` compares `ADMIN_PASSWORD` and the Basic Auth password with `!==`,
  which is not constant-time. The session-token path correctly uses
  `crypto.timingSafeEqual`; these two should match it.
- There's no throttling specific to failed logins beyond the global rate limit.

Neither is catastrophic behind a long random password, but both are cheap to fix.

---

## Tier 3: static snapshot

The third option publishes a **read-only copy** and keeps your actual instance
private. Nothing at home is reachable from the internet at all — you generate a
static site from the database and push it to a CDN.

This is the best public option if you don't need live editing from outside:
there's no server to attack, no login endpoint, no patching, and link previews
work *better* than the live app's because Open Graph tags are baked per page at
build time.

It needs a small exporter that doesn't exist yet. See
[DEPLOY-NAS.md → Going public later](DEPLOY-NAS.md#going-public-later) for the
sketch and the one critical detail: every exported row must go through
`publicSafe()` so prices, sellers, and buyers stay out of the published data.

---

## Quick reference

```
Just me, from anywhere        → Tailscale.            No app changes.
Family/friends, live app      → Funnel or CF Tunnel.  Set ADMIN_PASSWORD + RATE_LIMIT_MAX.
Public showcase, nothing open → Static snapshot.      Needs the exporter.
Port forwarding               → Don't.
```

Whatever you choose, keep taking backups — see the *Backups* section of your
platform's deploy guide. Exposure changes the threat model, not the failure
modes.
