# Exporting a banned or restricted account

Since the October 2026 change of ownership, the Farcaster app has banned or restricted some accounts. This guide is for people in that position who want a copy of their data.

## What's known, and what isn't

- **Your protocol data should still be reachable.** Casts, reactions, follows, followers and your profile are signed messages stored on public Farcaster nodes, not in your app account. castsnap reads them with no sign-in. *This is expected, but not yet confirmed on a banned account.*
- **Your bookmarks and DMs live only on the app's servers.** castsnap can reach them only with a session token that the app still accepts. Nobody yet knows whether a banned or restricted account can still sign in, or whether an existing signed-in session keeps working. Step 3 below finds out without writing anything.
- **castsnap doesn't read your account's status in the app, and `auth-check` shows only the HTTP code, not the app's reason.** Some sites show a restricted account as `moderated_out`. If yours does, say so on the report form: castsnap has not yet been run on such an account. You can help us learn where the app says so without sharing any content. In a terminal (on Windows, Git Bash), go into your export folder, then run the search. It skips the folders and files that hold DMs, bookmarks and drafts, and prints only how many files match in each folder:

  ```bash
  cd "PASTE_THE_FOLDER_HERE"
  ```

  ```bash
  grep -r -l -i -E 'moderated.?out' --exclude-dir='dm-*' --exclude-dir=bookmarks --exclude-dir=drafts --exclude='dm-*' --exclude='bookmark*' --exclude='drafts*' . | cut -d/ -f2-4 | sort | uniq -c
  ```

  Send only the lines it prints. If it prints nothing, say so: that is a result too.
- **Older DMs may already be gone.** Some conversations have disappearing-message settings, so the server deletes their older messages over time. Each export saves what is still there on that day.

**Please report your result** with the **Banned or restricted account** issue form, whatever happens. Each result tells the next person what to expect.

## Before you start

- **Node 24 or newer** (`node --version`) and **git**.
- **Your FID.** Look it up with the command in [USAGE.md](USAGE.md#before-you-start). This works whatever your account's status in the app.
- **Get the code and install it** (see the [README](../README.md#quick-start)): `git clone`, then `cd` into the folder, then `npm ci --ignore-scripts`.

In every command below, replace `YOUR_FID` with your FID.

## 1. Export your public data now

This needs no token and no sign-in:

```bash
node bin/castsnap.js export --fid YOUR_FID
```

Then check the folder it printed:

```bash
node bin/castsnap.js verify "PASTE_THE_FOLDER_HERE"
```

Keep this export whatever happens in the next steps.

## 2. Try to get a session token

1. **On a desktop browser, try signing in at https://farcaster.xyz.**
2. **If you're still signed in somewhere,** for example a browser you used before the ban, try that browser first. An existing session may still hold a working token. *This is untested.*
3. **If you can reach any page of the web app,** copy the token as described in [USAGE.md](USAGE.md#1-copy-your-session-token-desktop-browser).

If you can't sign in anywhere, castsnap can't reach your bookmarks or DMs. Skip to step 5.

## 3. Check the token (writes nothing)

```bash
node bin/castsnap.js auth-check --fid YOUR_FID
```

At the hidden prompt, paste the token once, then press Enter.
- **`auth-check: OK`**: the app still accepts your session. Go on to step 4.
- **`Token check failed: /v2/me returned HTTP 401`** or **`403`**: the app refused the token. If you pasted it more than once, run step 3 again and paste it once. Otherwise, copy a fresh token once and try again. If it still fails, go to step 5.

## 4. Save your private data

**On native Windows, skip this step for now,** and use a Mac or a Linux machine if you can: on Windows, neither the quick capture nor `--private` can make the folder readable only by you.

The quick capture is the fastest way to secure bookmarks and DMs. Run it first:

```bash
node scripts/quick-capture.mjs
```

Then run the full export, which adds signed casts, media and offline checks:

```bash
node bin/castsnap.js export --fid YOUR_FID --private
```

Check it with `verify`, as in step 1. A private dataset may come back as `unavailable:<reason>` rather than `complete`. That means the app refused that part, which is worth reporting too.

## 5. Report what happened

Open the **Banned or restricted account** issue form. It asks only for outcomes:
- whether you could sign in;
- the `auth-check` result;
- whether each export finished.

Your FID and username aren't needed.

## Stay safe

- **Never give your session token, seed phrase or recovery phrase to anyone** offering to export your data for you, including anyone claiming to be from this project or to be @logonaut.eth. The maintainer will never ask you for them.
- **Get castsnap only from its repository,** `github.com/ques10marc/unofficial-farcaster-account-exporter`, the one [@logonaut.eth](https://farcaster.xyz/logonaut.eth) links to. Copies elsewhere may have been altered to steal tokens.
- **Your export contains your DMs.** Store it somewhere private.
