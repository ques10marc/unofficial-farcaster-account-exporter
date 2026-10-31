# fcx: Farcaster account exporter

`fcx` saves a complete, verifiable copy of one Farcaster account to your own computer, then checks it offline.

> **Early test.** This is pre-release software. Please run it, then tell us what happened; see [Reporting problems](#reporting-problems).

**Unofficial.** Not affiliated with or endorsed by Farcaster, Neynar or Network School.

**Who's behind it.** Built and maintained by [@logonaut.eth](https://farcaster.xyz/logonaut.eth) (FID 4715), and tested on that account first. Announcements and links to this repository come from that account.

## What it saves

- **Public data, no sign-in needed:** your casts and replies, likes and recasts, following, followers, profile, username proofs, verifications, signers and storage, blocks, channel follows, the casts you replied to or reacted to, and the media of your own casts. Most of this is signed protocol data from public Farcaster nodes. The follow lists, blocks and channel follows are also cross-checked against the Farcaster app's public API.
- **Private data, with your session token (`--private`):** what exists only on the Farcaster app's servers: bookmarks, direct casts (DMs), drafts, mutes, favourite mini apps, and the media of bookmarked casts. fcx reads them through the app's own undocumented API, which can change or stop working at any time.

Each run writes a new folder under `~/FarcasterExports/` that only you can read.

## If your account was banned or restricted

Since the October 2026 change of ownership, some accounts have been banned or restricted in the Farcaster app. Nobody yet knows what such an account can still export, so please try it and report back.

- **Protocol data should still export.** It comes from public Farcaster nodes, not from your app account. This is expected but not yet confirmed on a banned account. The app's public API might hide a banned account, which would affect only the cross-checks.
- **Private data depends on whether the app still accepts your session.** Bookmarks and DMs live on the app's servers. fcx can reach them only with a session token the app still accepts. Step 4 below tells you within a minute and writes nothing.
- **Either way, please send us the result** with the **Banned or restricted account** issue form. Failures are just as useful as successes.

Step by step: [docs/BANNED_ACCOUNTS.md](docs/BANNED_ACCOUNTS.md).

## Quick start

**Before you start, you need:**

- **Node 24 or newer** (`node --version`) and **git**. fcx is developed and tested on macOS; Linux and Windows are untested.
- **Your FID**, your account's number. To look it up from your username, run this, replacing `YOUR_USERNAME` with your username (for example `alice` or `alice.eth`), and read the `"fid"` value:

  ```bash
  curl -s 'https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=YOUR_USERNAME'
  ```

- **For private data only:** a desktop browser in which you can still sign in at farcaster.xyz. [docs/USAGE.md](docs/USAGE.md) shows how to copy your session token.

In every command below, replace `YOUR_FID` with your FID.

1. **Get the code:**

   ```bash
   git clone https://github.com/ques10marc/unofficial-farcaster-account-exporter.git
   ```

   ```bash
   cd unofficial-farcaster-account-exporter
   ```

   ```bash
   npm ci
   ```

2. **Export your public data.** This needs no token:

   ```bash
   node bin/fcx.js export --fid YOUR_FID
   ```

3. **Check the export.** The export's last lines print its folder. Pass that folder to `verify`, which exits 0 when no check fails:

   ```bash
   node bin/fcx.js verify PASTE_THE_FOLDER_HERE
   ```

4. **Check your session token.** This writes nothing. Paste the token at the hidden prompt; nothing appears while you paste.

   ```bash
   node bin/fcx.js auth-check --fid YOUR_FID
   ```

5. **If step 4 printed `auth-check: OK`, export everything,** then run `verify` on the new folder as in step 3:

   ```bash
   node bin/fcx.js export --fid YOUR_FID --private
   ```

**Faster, for bookmarks and DMs:** `node scripts/quick-capture.mjs` saves the app's raw data pages ([guide](docs/QUICK_CAPTURE.md)).
- **Time:** bookmarks and DMs usually take minutes; long follower lists take longer.
- **Requirements:** Node 20 or newer, and no `npm ci`.
- **Limits:** it doesn't save media or signed protocol data, and it has no `verify`.

## Staying safe

- **Your session token works like a password.** While it is valid, it gives full access to your account.
  - Paste it only into fcx's hidden prompt, in your own terminal.
  - Never paste it into an issue, a chat, or anyone else's tool.
  - **Anyone who asks you for your token is trying to take over your account,** even if they say they're from this project. The maintainer will never ask for it.
- **What fcx does with the token:** fcx keeps it in memory only. It sends it only to `https://client.farcaster.xyz` or `https://farcaster.xyz/~api`, and never along a redirect. At the end it scans its own output for the token and prints `Token self-scan: N file(s) contain the token.`, where N should be 0.
- **Signing out does not revoke a copied token.** It may stay valid for an unknown time, and there is no known way for you to revoke it.
- **Your export contains your DMs.** Keep it out of git and cloud sync unless you mean to share it.
- **fcx never asks for your seed phrase or recovery phrase.** Anyone who does is not us.

## Reporting problems

[Open an issue](https://github.com/ques10marc/unofficial-farcaster-account-exporter/issues/new/choose) and pick a form:

- **Bug report:** something went wrong.
- **Banned or restricted account:** what you could and couldn't export.
- **Feature request:** something fcx should do.

`fcx verify` output is safe to paste, because it holds statuses and counts only. Never post your token, any DM, bookmark or draft text, export files, or `fcx find` output.

Security problems, such as a token or private data leaking, go through [SECURITY.md](SECURITY.md), not a public issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). AI-assisted contributions are welcome if they are disclosed and a person is accountable for them. Agents should read [AGENTS.md](AGENTS.md).

## License

MIT; see [LICENSE](LICENSE).
