# Quick capture: run guide

`scripts/quick-capture.mjs` saves a quick copy of the data that exists only on the Farcaster app's servers, using your own session token. It's a single file with no dependencies.

**What it captures:**
- bookmarks
- DMs
- drafts
- mutes
- favourite mini apps
- channel follows
- blocks
- following and followers
- your profile counts, before and after the run

**What it doesn't capture:**
- **Media files.** Image and video bytes aren't downloaded; the saved cast JSON keeps their URLs.
- **Your signed protocol messages** (casts, reactions, follows). The full exporter, `fcx`, fetches those; see [USAGE.md](USAGE.md).

Your follows and followers are also on the protocol, so they are at less risk than bookmarks and DMs.

> **If your account is banned or restricted, or you plan to vote "decline":** run this soon. Nobody knows how long the app will keep serving such accounts' private data. See also [BANNED_ACCOUNTS.md](BANNED_ACCOUNTS.md).

## Before you start

- **Node 20 or newer** (`node --version`). You don't need `npm ci`.
- **A desktop browser** in which you can sign in at farcaster.xyz.

## Security (read first)

- **The token is a password.** While it is valid, it gives full access to your account.
  - Paste it only into the script's hidden prompt, in your own terminal.
  - **Never paste it into an issue, a chat, or anywhere else.**
- **What the script does with it:**
  - It never writes the token to disk and never prints it.
  - At the end, it scans its own output for the token and reports how many files contain it. The number should be 0.
- **Signing out may not revoke the token.** Nobody yet knows whether signing out of farcaster.xyz revokes it.
- **The output is private.** It goes to `~/FarcasterExports/`. The folder and each file in it are readable only by you (modes 0700 and 0600). It contains your DMs, so don't put it in git or cloud sync unless you mean to.

## 1. Copy your session token (desktop browser)

Follow step 1 of "Private data" in [USAGE.md](USAGE.md#1-copy-your-session-token-desktop-browser). In short:
1. Sign in at farcaster.xyz.
2. Open developer tools, then the **Network** tab, and reload the page.
3. Filter by `~api`, and click a request.
4. Copy the value of its `authorization` header. The word `Bearer` can stay; the script strips it.

## 2. Run it

From the project folder, run the command below and paste the token at the hidden prompt. Nothing appears while you paste; press Enter afterwards.

```bash
node scripts/quick-capture.mjs
```

The script finds your FID from the token. To capture only the public endpoints, with no token, run `node scripts/quick-capture.mjs --public-only --fid YOUR_FID` instead.

**How long it takes:**
- **Bookmarks, DMs and the rest** usually take minutes.
- **The following and followers lists** come last. The server allows 500 requests per hour, each returning 50 accounts. That's about 25,000 accounts per hour, so a long list takes a while.

**Interrupting:** press **Ctrl-C** once. The script finishes the current request and writes the manifest. Everything captured up to that point is kept and marked `interrupted`. A second Ctrl-C exits immediately.

**The two API hosts:** the script first tries `https://client.farcaster.xyz`. If that host rejects your token, it retries via `https://farcaster.xyz/~api`, the host the web app itself uses.

## 3. Check the results (pass/fail)

These checks refer to the folder the script printed as `Output:`.

**QC-1: everything has a recorded status.** The script exits with code 0, and every line it prints has a status.
- **Normal statuses:**
  - `complete`
  - `empty`
  - `unavailable:<HTTP code>`, meaning the server refused that endpoint
  - `partial:…`, for DM conversations only
- If **every** DM line shows `unavailable:401` or `unavailable:403`, the app isn't serving your DMs to this token. Please report that with the **Banned or restricted account** form (if that applies) or a **Bug report**.

**QC-2: bookmarks, following and followers each reached the last page.** This command passes when it prints `True` at the end of all three lines:

```bash
python3 -c "import json,glob,sys; m=json.load(open(sorted(glob.glob(sys.argv[1]+'/quick-*/manifest.json'))[-1])); [print(k, m['endpoints'][k]['status'], m['endpoints'][k]['lastCursorEmpty']) for k in ('bookmarks','following','followers')]" ~/FarcasterExports
```

**QC-3: no token in the output.** The last line the script prints must be `Token self-scan: 0 file(s) contain the token.`

**QC-4: your newest and oldest bookmarks are present.**
1. In the app, open your bookmarks, and copy a distinctive phrase from the **newest** one.
2. Scroll to the bottom, and copy a phrase from the **oldest** one.
3. Search for each phrase with the command below. The check passes (2 of 2) when each search prints a file path.

```bash
grep -rl "PASTE A PHRASE HERE" ~/FarcasterExports/quick-*/bookmarks/
```

**Checksums (optional).** To confirm the files are intact, run the command below, using the exact folder path the script printed. Every line should end in `OK`.

```bash
cd PASTE_THE_FOLDER_HERE && shasum -a 256 -c SHA256SUMS
```

## 4. Reporting results

Share these, using the issue forms:
- the script's printed summary: the `Account`, `Capturing` and `Files` lines, which hold only counts and statuses;
- the self-scan line;
- your QC-4 result.

Replace your home folder path with `~`. Never share file contents or the token.
