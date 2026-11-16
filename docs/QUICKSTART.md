# Quick start, step by step

This guide takes you from a new terminal to a checked export of your public Farcaster data, one command at a time. The [README](../README.md#quick-start) has the same steps in short.

## Before you start

- **Node 24 or newer** and **git**. The steps below check both.
- **Disk space.** A large account's export, with its media, can take a few gigabytes, and your computer needs room to spare while it runs. Check your free space first.
- **Time.** How long the export takes depends on your account: see [How long it takes](USAGE.md#how-long-it-takes).
- **No token.** This guide exports your public data, which needs no token. For bookmarks, DMs and other private data, see [Private data](#private-data).

## Pick your system

- **macOS or Linux:** follow [macOS and Linux](#macos-and-linux).
- **Windows, in Git Bash:** follow [macOS and Linux](#macos-and-linux). Git Bash comes with Git for Windows and runs those commands as written.
- **Windows, in PowerShell:** follow [Windows PowerShell](#windows-powershell). In cmd, use PowerShell instead.

## macOS and Linux

1. **Open a terminal.** On macOS, open the **Terminal** app (in Applications, then Utilities). On Linux, open your terminal app. On Windows, open **Git Bash**.

2. **Check Node and git.** Run each command on its own line. Each prints a version number:

   ```bash
   node --version
   ```

   ```bash
   git --version
   ```

   You need Node 24 or newer, so the first number must be 24 or higher. If either command isn't found, see [If something goes wrong](#if-something-goes-wrong).

3. **Find your FID**, your account's number. Replace `YOUR_USERNAME` with your username (for example `alice` or `alice.eth`), run this, and read the `"fid"` value:

   ```bash
   curl -s 'https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=YOUR_USERNAME'
   ```

   In every command below, replace `YOUR_FID` with that number.

4. **Get the code** and install its pinned dependencies:

   ```bash
   git clone https://github.com/ques10marc/unofficial-farcaster-account-exporter.git
   ```

   ```bash
   cd unofficial-farcaster-account-exporter
   ```

   ```bash
   npm ci --ignore-scripts
   ```

   `npm ci` may report vulnerabilities in libraries that castsnap's dependencies use. [Run it](USAGE.md#run-it) in USAGE.md explains them.

5. **Export your public data.** This needs no token:

   ```bash
   node bin/castsnap.js export --fid YOUR_FID
   ```

   The export goes into a new folder under `~/FarcasterExports`. Its last line starts with `Files:` and ends with the `verify` command for that folder.

6. **Check the export.** Copy the `verify` command from the `Files:` line, or type this with your folder in place of `PASTE_THE_FOLDER_HERE`:

   ```bash
   node bin/castsnap.js verify "PASTE_THE_FOLDER_HERE"
   ```

7. **Open the folder.** On macOS:

   ```bash
   open ~/FarcasterExports
   ```

   On Linux:

   ```bash
   xdg-open ~/FarcasterExports
   ```

   In Git Bash, open File Explorer and go to the `FarcasterExports` folder in your user folder.

If you choose another folder with `--out`: on Linux, castsnap doesn't recognize a folder that a sync app keeps in your home folder, such as `~/Dropbox`, so keep your export out of one yourself.

## Windows PowerShell

This section is written for Windows PowerShell 5.1, which comes with Windows. Public export and `verify` were tested on Windows 11. The commands should also work in PowerShell 7, which is untested. Windows permissions and `--private` on native Windows: hands-on test pending.

In PowerShell:

- **Type `curl.exe`, not `curl`.** In Windows PowerShell 5.1, `curl` runs `Invoke-WebRequest` instead.
- **Don't use `~` in a path.** Write `$HOME\FarcasterExports` instead.
- **Put quotes around paths,** especially ones with spaces.
- **Run each command on its own line.**

1. **Open PowerShell.** Open the Start menu, type `PowerShell`, and choose **Windows PowerShell**.

2. **Check Node and git.** Each command prints a version number:

   ```powershell
   node --version
   ```

   ```powershell
   git --version
   ```

   You need Node 24 or newer, so the first number must be 24 or higher. If either command isn't recognized, see [If something goes wrong](#if-something-goes-wrong).

3. **Find your FID**, your account's number. Replace `YOUR_USERNAME` with your username (for example `alice` or `alice.eth`), run this, and read the `"fid"` value:

   ```powershell
   curl.exe -s "https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=YOUR_USERNAME"
   ```

   In every command below, replace `YOUR_FID` with that number.

4. **Get the code** and install its pinned dependencies:

   ```powershell
   git clone https://github.com/ques10marc/unofficial-farcaster-account-exporter.git
   ```

   ```powershell
   cd unofficial-farcaster-account-exporter
   ```

   ```powershell
   npm ci --ignore-scripts
   ```

   `npm ci` may report vulnerabilities in libraries that castsnap's dependencies use. [Run it](USAGE.md#run-it) in USAGE.md explains them. If PowerShell says it can't load `npm.ps1` because running scripts is disabled, see [If something goes wrong](#if-something-goes-wrong).

5. **Export your public data.** This needs no token:

   ```powershell
   node bin/castsnap.js export --fid YOUR_FID
   ```

   The export goes into a new folder under `$HOME\FarcasterExports`. Its last line starts with `Files:` and ends with the `verify` command for that folder. To see how the export ended, run this: `0` means it finished without errors, and `1` means a dataset errored, so run the export again.

   ```powershell
   $LASTEXITCODE
   ```

6. **Check the export.** Copy the `verify` command from the `Files:` line, or type this with your folder in place of `PASTE_THE_FOLDER_HERE`:

   ```powershell
   node bin/castsnap.js verify "PASTE_THE_FOLDER_HERE"
   ```

7. **Open the folder:**

   ```powershell
   explorer "$HOME\FarcasterExports"
   ```

**If you want, check `SHA256SUMS` yourself.** `verify` already does this; this runs the same check with Windows' own tools. Run it last, because it moves PowerShell into the export folder. It prints nothing when every file matches, and `FAILED:` with the file's name for each one that doesn't:

```powershell
Set-Location "PASTE_THE_FOLDER_HERE"
Get-Content SHA256SUMS | ForEach-Object { $h,$f = $_ -split '  ',2; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash -ne $h) { "FAILED: $f" } }
```

## What you'll see

The export prints its progress, then a few lines worth reading:

- `Privacy: …`: whether only your account can read the export folder, and the kind of place it's in.
- `Account status: …`: your account's status as the app reports it. What each part means is in [FIELDS.md](FIELDS.md#the-account-status-line).
- `Files: …`: how many files the export wrote, and the `verify` command for its folder.

`verify` prints one line per check, then a `Result:` line with how many checks passed, failed or don't apply (`N/A`, such as the private checks on a public export). It exits 0 when no check fails. If it lists manual checks, see [Manual checks](USAGE.md#manual-checks).

## What's in your export

[FIELDS.md](FIELDS.md) explains each dataset in your export, and the fields of the files castsnap builds, in plain words. [Output](USAGE.md#output) in USAGE.md lists the folder's layout.

## Private data

Bookmarks, DMs, drafts and other private data need your session token and `--private`. Read [Private data](../README.md#private-data) in the README first: the token works like a password. Windows permissions and `--private` on native Windows: hands-on test pending.

## Your own node

If you run your own node, add `--hub HOST:PORT` (gRPC) or `--hub https://…` (its HTTP API), and castsnap reads the protocol data from that node first. If it isn't one of Farcaster's nodes (`snap.farcaster.xyz` or `crackle.farcaster.xyz`), castsnap doesn't fall back to another node when it fails. The export's `manifest.json` records which node answered each source (`sources.*.host`). Your session token never goes to `--hub`: it goes only to `https://client.farcaster.xyz` and `https://farcaster.xyz/~api`, and never along a redirect.

## If something goes wrong

- **Node isn't found, or its version is below 24:** install Node 24 or newer from [nodejs.org](https://nodejs.org), then open a new terminal.
- **git isn't found:** install it from [git-scm.com](https://git-scm.com), then open a new terminal.
- **PowerShell can't load `npm.ps1` because running scripts is disabled:** run `npm.cmd ci --ignore-scripts` instead. This hasn't been tested yet.
- **castsnap warns about the export folder, or `--private` stops because of it:** [Security (read first)](USAGE.md#security-read-first) in USAGE.md lists what it checks.
- **Anything else:** see [Reporting problems](../README.md#reporting-problems) in the README.
