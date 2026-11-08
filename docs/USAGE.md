# Using `castsnap`

`castsnap` exports one Farcaster account (FID) into a new folder that is never modified afterwards, then checks it offline.

- **Without `--private`,** it exports the protocol data and the public parts of the app's API. No token is used or needed.
- **With `--private`,** it also exports what exists only on the app's servers: bookmarks, direct casts (DMs), drafts, mutes and favourite mini apps, plus the media of bookmarked casts. This needs your web session token (see below). castsnap never asks for a seed phrase.

If the Farcaster app banned or restricted your account, start with [BANNED_ACCOUNTS.md](BANNED_ACCOUNTS.md).

## Before you start

- **Node 24 or newer** (`node --version`) and **git**.
- **Your FID**, your account's number. To look it up, replace `YOUR_USERNAME` with your username (for example `alice` or `alice.eth`), then read the `"fid"` value:

  ```bash
  curl -s 'https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=YOUR_USERNAME'
  ```

In every command below, replace `YOUR_FID` with your FID.

## Run it

From the project folder, install the pinned dependencies once:

```bash
npm ci --ignore-scripts
```

`npm ci` currently reports high-severity vulnerabilities (4 as of October 2026). They come from two advisories in libraries that the official `@farcaster` packages depend on: one in `@faker-js/faker`'s `helpers.fake`, which neither castsnap nor `@farcaster/core` calls, and one in `@grpc/grpc-js`'s `getAuthContext`, which castsnap never calls. npm's suggested fix is to downgrade the `@farcaster` packages to older releases, which castsnap can't do. `--ignore-scripts` stops the dependencies' install scripts from running. castsnap needs none: the only one, in `protobufjs`, compares version ranges in `package.json` files and at most prints a warning, and castsnap's tests pass without it.

**Before a full run, check your free disk space.** A large account's export, with its media, can take a few gigabytes, and your computer needs room to spare while it runs. Running out can freeze it.

Public data only (no token):

```bash
node bin/castsnap.js export --fid YOUR_FID
```

For private data, read [Private data: your session token](#private-data-your-session-token) first.

Each export writes a new folder named `fc-export-` plus your FID and the time, under `~/FarcasterExports/`. The last lines print the exact folder. Check it by passing that folder to `verify`:

```bash
node bin/castsnap.js verify "PASTE_THE_FOLDER_HERE"
```

**What `verify` reports:**
- It exits 0 when no check fails.
- `N/A` marks criteria that don't apply to that export, for example the private criteria on a run without `--private`.
- After the checks, it prints the **manual checks** that only you can do; see [below](#manual-checks).

## Private data: your session token

### Security (read first)

- **It may stop working.** `--private` uses the Farcaster app's undocumented endpoints, which may stop working or be blocked at any time, and you run it under the app's current terms.
- **The token is a password.** While it is valid, it gives full access to your account.
  - Paste it only into `castsnap`'s hidden prompt, in your own terminal.
  - **Never paste it into an issue, a chat, or anyone else's tool.**
  - **Anyone who asks you for your token is trying to take over your account,** even if they say they're from this project. The maintainer will never ask for it.
- **What `castsnap` does with it:**
  - It keeps the token in memory only. It never writes it to disk, prints it or logs it, and error messages are redacted.
  - It sends the token only to `https://client.farcaster.xyz` or `https://farcaster.xyz/~api`, and never along a redirect. Protocol nodes and media hosts never receive it.
  - Before writing anything, it checks with `/v2/me` that the token belongs to `--fid`. If it doesn't, or the token is rejected, the run stops and no folder is created.
  - At the end, it scans its own output for the token and prints `Token self-scan: N file(s) contain the token.` N should be 0. If it isn't, the run exits with code 2: delete that folder.
- **Signing out does not revoke a copied token.** A copied token may stay valid for an unknown time after you sign out, and there is no known way for you to revoke it. In a test, it kept working after signing out of farcaster.xyz, and the app's Settings → Sessions screen didn't end it either.
- **The output is private on macOS and Linux.** It contains your DMs. There, the folder and each file in it are readable only by you (modes 0700 and 0600). castsnap can't set that on Windows, so don't use `--private` on native Windows for now. Don't put the output in git or cloud sync unless you mean to.

### 1. Copy your session token (desktop browser)

1. Sign in at https://farcaster.xyz in Chrome, Brave, Arc, Edge or Firefox. In Safari, first turn on **Settings → Advanced → Show features for web developers**.
2. Open developer tools with **⌥⌘I** (Option+Command+I) on macOS, or **Ctrl+Shift+I** elsewhere, then select the **Network** tab.
3. Reload the page.
4. In the Network filter box, type `~api`.
5. Click any request in the list, such as `me`, `unseen` or `feed-items`.
6. Under **Headers → Request Headers**, find the `authorization` header. Its value starts with `Bearer `.
7. Copy the value. You can include the word `Bearer`, or even the whole `authorization: Bearer …` line; `castsnap` strips both.

If no `~api` request has an `authorization` header, stop and open a **Bug report**: the web app may have changed how it signs in.

### 2. Check the token (optional, writes nothing)

```bash
node bin/castsnap.js auth-check --fid YOUR_FID
```

At the prompt, paste the token once, then press Enter; nothing appears while you paste. It shows how many characters it received, then prints one line, and the account status when the token is accepted:

- `auth-check: OK. Token accepted by https://client.farcaster.xyz; it belongs to fid …, which matches --fid ….` Good: go on.
- Then `Account status: optInStatus=… (from /v2/me)`: your account's status as the app reports it. See [Account status](#account-status).
- `… belongs to fid N, not --fid ….` You are signed in to a different account in that browser.
- `Token check failed: /v2/me returned HTTP 401 …`, or another HTTP code. Both hosts rejected the token. If you pasted it more than once, run the command again and paste it once; otherwise copy a fresh one. If your account is banned or restricted, see [BANNED_ACCOUNTS.md](BANNED_ACCOUNTS.md).

### 3. Run the export

```bash
node bin/castsnap.js export --fid YOUR_FID --private
```

At the prompt, paste the token again, then press Enter. The run prints:

1. one line per source as it finishes;
2. the dataset statuses;
3. the folder;
4. the token self-scan line.

**Host.** `castsnap` uses `https://client.farcaster.xyz` first. If that host rejects the token (401 or 403), `castsnap` retries via `https://farcaster.xyz/~api`, the host the web app itself uses, and stays there for the rest of the run. `--base URL` pins one of the two hosts and turns the fallback off.

**Optional: keep the token in the environment instead of the prompt.** This lets `export` and `verify` share it; `verify` re-scans the export for the token only when `FC_SESSION_TOKEN` is set. The commands below read the token without echoing it and without saving it in your shell history.

In zsh (the macOS default):

```bash
read -rs "FC_SESSION_TOKEN?Token: " && export FC_SESSION_TOKEN
```

In bash:

```bash
read -rsp "Token: " FC_SESSION_TOKEN && export FC_SESSION_TOKEN
```

Then run the export, and `verify` with the folder it printed. When you're done, clear the token:

```bash
unset FC_SESSION_TOKEN
```

### What `--private` fetches

The paths, result keys and page sizes come from the official client's `types.yml` (snapshot 2026-09-30, commit `0c289ed`).

| Dataset | Endpoint | Saved as |
|---|---|---|
| D3 bookmarks | `GET /v2/bookmarked-casts`, 100 per page | `raw/client/bookmarks/`, `normalized/bookmarks.json`, `csv/bookmarks.csv`. Where the node still has it, the signed cast from the protocol goes in `raw/protocol/bookmarked-casts.pb` |
| D10 direct casts | `GET /v2/direct-cast-conversation-list` for each category (default, archived, request, void), then `GET /v2/direct-cast-conversation-messages` for every conversation, 50 per page | `raw/client/dm-conversations-<category>/`, `raw/client/dm-messages/<NNNN>-<conversation>/`, `normalized/dm-conversations.json`, `normalized/dm-messages.json` |
| D11 drafts | `GET /v2/draft-casts` | `normalized/drafts.json` |
| D12 mutes | `GET /v2/get-muted-keywords`, `/v2/get-muted-users`, `/v2/get-muted-channels` | `normalized/muted-keywords.json`, `muted-users.json`, `muted-channels.json` |
| D13 mini apps | `GET /v1/favorite-frames` | `normalized/mini-apps.json` |
| D19 own moderation record | `GET /v2/network-code/public-rap-sheet?fid=<your FID>`, 20 per page, as the app asks for it | `raw/client/moderation-record/`, as it came; not normalized |
| D20 stayed list | `GET /v2/opt-in/following-stayed`, one request | `raw/client/following-stayed/`, as it came; not normalized |
| D14 media | every embed URL of your casts and your bookmarked casts | `media/index.jsonl`, `media/sha256/` |

Every successful response is saved verbatim under `raw/client/`. Error responses are saved truncated, with the token redacted, as `error-NNNN.json`.

D19 and D20 are not in `types.yml`: their paths and page size come from the web app's own code (2026-11). Their answers' shapes aren't documented, so castsnap keeps the pages as they came and counts the entries where it can. A refusal is the dataset's status, for example `unavailable:403`, or `unavailable:no-result` for an answer without a result. D19 and D20 never make the export fail.

### How long it takes

- **A large account can take several hours.** Most of the time goes to the media step, which downloads each media link one at a time and prints no progress yet.
- **Private requests are paced** at one per 600 ms.
- **Bookmark media** downloads at no more than one request per 250 ms per media host.

**Stopping a run:**
- **Ctrl-C once** stops after the current request. It still writes the manifest and checksums, marks the run `interrupted`, and exits with code 130.
- **Ctrl-C twice** exits immediately.
- **There is no resume yet,** so run the export again to get a complete copy.

## Manual checks

`verify` can't see the app, so it prints these steps with the exact command for your export folder. Each check passes or fails.

`castsnap find` prints matching lines in your own terminal. Those lines include DM and bookmark text, so **don't paste them anywhere**; report only how many matched.

**Bookmarks, 5 of 5** (`verify` labels this AC-12(c)):
1. In the app, open your bookmarks.
2. Copy a distinctive phrase from the **newest** bookmark, the **oldest** one (scroll to the bottom), and **3 at random**.
3. Run the command below for each phrase. The check passes when each of the 5 prints at least one line starting with `bookmarks`.

```bash
node bin/castsnap.js find "PASTE_THE_FOLDER_HERE" "PASTE A PHRASE HERE"
```

**Direct casts, 3 of 3** (`verify` labels this AC-18):
1. Pick 3 conversations in the app.
2. In each one, scroll up to the **oldest** message and copy a phrase from it.
3. Run the same `find` command for each phrase. The check passes when each of the 3 prints at least one line starting with `dm-messages`.

`find` also matches cast hashes (a prefix of at least `0x` plus 4 characters), FIDs and usernames.

## Options

| Option | Default | Meaning |
|---|---|---|
| `--out DIR` | `~/FarcasterExports` | Parent folder for the new export folder |
| `--private` | off | Also export bookmarks, DMs, drafts, mutes and mini apps, using your session token |
| `--media LIST` | `own,bookmarks` | Media to download, stored by SHA-256: `own`, `bookmarks`, `own,bookmarks`, or `none`. `bookmarks` needs `--private` |
| `--hub HOST` | `snap.farcaster.xyz:3383` | Protocol source tried first: a gRPC `host:port`, or an `https://` HTTP API base. `castsnap` falls back only between Farcaster's own Snapchain nodes: gRPC on `snap.farcaster.xyz:3383`, then `crackle.farcaster.xyz:3383`, then their HTTP APIs on port `3381` in the same order. Any other `--hub` gets no fallback, so one export never mixes two networks. Farcaster's nodes answer only on ports 3383 and 3381, so a network that allows only web traffic (port 443) blocks them. To export from Hypersnap instead, pass `--hub https://haatz.quilibrium.com`, which answers on port 443; `verify`'s checks are written for Snapchain |
| `--base URL` | `https://client.farcaster.xyz`, then `https://farcaster.xyz/~api` | Pins the client API host, with no fallback. Only those two hosts, or a loopback address for testing, are accepted |

Other commands:

- **`node bin/castsnap.js auth-check --fid N [--base URL]`** checks the session token against `/v2/me` and writes nothing.
- **`node bin/castsnap.js find DIR <text | 0xhash-prefix | fid | username>`** searches an export, for spot checks.
- **`node scripts/import-check.mjs DIR`** rebuilds following, followers and bookmarks (with cast text) from the export alone, with network access blocked. On macOS, `sandbox-exec -p '(version 1)(allow default)(deny network*)' node scripts/import-check.mjs DIR` has the operating system enforce that.
- **`node scripts/print-account-control.mjs DIR`** prints the custody and recovery address on record for the exported account, read offline from its on-chain ID-registry events. It shows each address and its history, marks the recovery address's operator as unknown, and explains how to check who controls that address (its `owner()`, and a Safe multisig's owners) on a block explorer. It makes no network calls and writes nothing.
- **`npm test`** runs the unit and integration tests, on recorded fixtures and a local mock server. It uses no network and no real token.

## Output

- **`manifest.json`** holds every source's host, pages, final-cursor state and status, plus the status of each dataset D1–D15, D19 and D20, and the account status (`accountStatus`; see [Account status](#account-status)). A `--private` run also records the token check (`authCheck`: the host and FID, never the token) and one entry per DM conversation (`directCasts`).
- **`SHA256SUMS`** works with `shasum -a 256 -c SHA256SUMS`. It never lists OS metadata such as `.DS_Store`, which Finder may add later.
- **`raw/protocol/*.pb`** are length-delimited protobuf `Message`/`OnChainEvent` records, with the signed `dataBytes` intact. **`raw/protocol/*.jsonl`** holds the same records as JSON.
- **`raw/client/`** holds the verbatim API pages.
- **`normalized/`** holds the JSON files, with their JSON Schemas in `normalized/schemas/`. Their format, schemaVersion 1, is experimental: a schemaVersion 2 is planned, so files and fields may change.
- **`csv/`** holds following, followers, blocks, channels and, on `--private` runs, bookmarks. `bookmarks.csv` columns: the cast's link (`https://farcaster.xyz/<username>/<first 10 characters of the hash>`, the app's share-link form), then hash, author, timestamp, text and embeds.
- **`media/`** holds `index.jsonl` (each URL's final status, its SHA-256, and whether it came from your casts or a bookmark) and `sha256/` with the content-addressed bytes.
- **`reconciliation.json`** lists every difference between the protocol and the app, each with a reason code: `self_follow`, `hidden_by_client`, `client_only`, `count_mismatch` or `profile_field_mismatch`.

### Account status

Every export prints one line just before `Files:`, and `auth-check` prints it after its `OK` line:

```
Account status: optInStatus=pending publicSpamLabel="2 (unlikely to engage in spammy behavior)" (from profile-after)
```

- **`optInStatus`** is what the app reports for your account. The app's code checks for `pending` and `moderated_out`, and `opted_in` is the third value reported. As far as is known, `pending` means you haven't accepted the Network Code (a No vote reads the same), and `moderated_out` means the app has restricted the account.
- **`publicSpamLabel`** is the app's public spam label for the account. `/v2/me` doesn't carry it, so `auth-check`'s line leaves it out.
- **`nerfed=true`** appears only when the app reports it. The app describes a nerfed account as one that can still post to the protocol but doesn't appear in the Farcaster app.
- **`(not reported)`** means the answer had no such field, and **`not available`** means castsnap got no readable profile.

The line comes from the profile the export fetched last. `manifest.json` keeps every value under `accountStatus`, and a `--private` run adds what `/v2/me` reports, including `neynarScore` and `enabledFeatureFlags`. castsnap copies these values as the app sent them; what they mean may change. The line itself is safe to share.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | A dataset errored, a check failed, or the token was rejected or belongs to another FID (nothing written) |
| 2 | The session token was found in the output: delete the folder |
| 64 | Usage error |
| 130 | Interrupted |

If the summary shows `Lane errors:`, one of the three lanes (protocol, client API or media) stopped early: the datasets it never reached are `error:<lane>-lane-aborted` and the run exits 1, so run the export again.

`Protocol data: every node failed (…)`. Every protocol node castsnap tried failed during this run, so some or all protocol datasets are missing; `verify` shows each dataset's status. Run again later, or from another network (some networks allow only port 443). If it keeps happening, send `verify`'s output and any `marked down for this run` lines with a **Bug report**.

## What to share when you report a result

- the whole `verify` output, which holds statuses and counts only: DM conversations are referred to by number, never by ID or content;
- the `Token self-scan` lines;
- the `Account status:` line;
- your manual check results: bookmarks as N of 5, and direct casts as N of 3.

Replace your home folder path with `~`. Never share the token, file contents or `find` output.
