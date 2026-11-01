# Spec: Farcaster account exporter (`castsnap`)

This describes what `castsnap` 0.1.0 exports and how `castsnap verify` grades an export. How to run it is in [USAGE.md](USAGE.md).

## Interface

| Command | Purpose |
|---|---|
| `castsnap export --fid N [--out DIR] [--private] [--media own,bookmarks\|own\|bookmarks\|none] [--hub HOST] [--base URL]` | Run an export |
| `castsnap auth-check --fid N [--base URL]` | Confirm the session token belongs to the FID, via `/v2/me`. Writes nothing |
| `castsnap verify DIR [--json]` | Check hashes, signatures and schemas, and run the automatable acceptance checks |
| `castsnap find DIR <query>` | Search an export, for manual spot checks |

Options and exit codes are in [USAGE.md](USAGE.md).

## Datasets

Every export's `manifest.json` gives each dataset a status: `complete`, `empty`, or `unavailable:<reason>`. A dataset can also be `error:<reason>`; when a lane stops early, the datasets it never reached are `error:<lane>-lane-aborted`. Without `--private`, D3 and D10–D13 are `unavailable:private-not-requested`.

| ID | Dataset | Manifest sources | Needs `--private` |
|---|---|---|---|
| D1 | Following | `protocol:links`, `client:following`, `protocol:link-compact-state` | no |
| D2 | Followers | `protocol:followers`, `client:followers` | no |
| D3 | Bookmarks, with the signed cast where the node still has it | `client:bookmarks`, `protocol:bookmarked-casts` | yes |
| D4 | Own casts and replies | `protocol:casts` | no |
| D5 | Likes and recasts | `protocol:reactions` | no |
| D6 | Profile, username proofs, verifications | `protocol:user-data`, `protocol:verifications`, `protocol:username-proofs`, `client:profile-before`, `client:profile-after` | no |
| D7 | Signers, on-chain events, storage | `protocol:onchain-events-*`, `protocol:onchain-signers-active`, `protocol:signers-by-fid`, `protocol:key-messages`, `protocol:storage-before`, `protocol:storage-after`, `protocol:storage-lends` | no |
| D8 | Blocks | `protocol:links`, `client:blocked-users` | no |
| D9 | Channel follows | `client:channels` | no |
| D10 | Direct casts | `client:dm-conversations-<category>` for default, archived, request and void; `client:dm-messages` | yes |
| D11 | Drafts | `client:drafts` | yes |
| D12 | Muted keywords, users and channels | `client:muted-keywords`, `client:muted-users`, `client:muted-channels` | yes |
| D13 | Favourite mini apps | `client:favorite-mini-apps` | yes |
| D14 | Media of own casts and bookmarked casts | `media:own`, `media:bookmarks` | for bookmarks only |
| D15 | Context casts: parents of replies, and reacted-to casts | `protocol:context-casts` | no |

## Output layout

Each run writes a new directory that is never modified afterwards: every file is written exactly once. Directory mode is 0700; file mode is 0600.

```
fc-export-<fid>-<UTC>/
  manifest.json          every source's host, pages, final-cursor state and status; each dataset's status
  SHA256SUMS             every file except OS metadata
  raw/protocol/*.pb      length-delimited protobuf Message / OnChainEvent records, signed dataBytes intact
  raw/protocol/*.jsonl   the same records as JSON
  raw/client/            verbatim API pages
  normalized/            versioned JSON (schemaVersion 1, experimental), with JSON Schemas in normalized/schemas/
  csv/                   following, followers, blocks, channels; bookmarks on --private runs
  media/                 index.jsonl (each URL's final status, sha256 and origin) and sha256/ (the bytes)
  reconciliation.json    differences between the protocol and the app, each with a reason code
```

Reason codes come from a closed set: `self_follow`, `hidden_by_client`, `client_only`, `count_mismatch`, `profile_field_mismatch`. File-by-file detail is in [USAGE.md](USAGE.md) "Output".

**Exports from before the rename.** castsnap was called `fcx` until 2026-10-31. An export written then says `"tool": "fcx"` in `manifest.json`, and its schemas carry `$id`s under `https://fcx.local/schemas/v1/`. `castsnap verify` and `scripts/import-check.mjs` read it exactly as they read a current export. Both `https://fcx.local/schemas/v1/…` and `https://castsnap.local/schemas/v1/…` identify schemaVersion 1, so the new `$id` is not a format change.

## Secrets and privacy

**The session token** is needed only for `--private` and `auth-check`. You copy it from your browser's developer tools, as [USAGE.md](USAGE.md) shows. `castsnap` reads it from a hidden prompt or from `FC_SESSION_TOKEN`.
- It is never written to disk or to logs, and it is redacted from error messages.
- It is sent only on private requests, only to `https://client.farcaster.xyz` or `https://farcaster.xyz/~api` (or a loopback address, for testing), and redirects are never followed with it.
- It is checked against `--fid` before anything is written. A rejected token, or one that belongs to another FID, ends the run with exit 1 and no output directory.
- If the token is ever found in the output, the run exits 2. Delete that folder.

**What `castsnap` never handles.** A seed phrase, a recovery phrase or a custody key.

**Where exports go.** By default, a new directory under `~/FarcasterExports/`; `--out` changes the parent directory. The repo's `.gitignore` also excludes `fc-export-*`, `quick-*/` and `FarcasterExports/` as a second safeguard.

## Data sources

**Protocol data.**
- **Canonical source:** gRPC `GetAll*MessagesByFid` on `snap.farcaster.xyz:3383` (TLS, no key). It returns adds *and* removes, so exported counts can equal `storageLimitsByFid.used` exactly (AC-13). The raw protobuf includes `dataBytes`, so messages validate byte-for-byte (AC-04).
- **Fallbacks:** only Farcaster's own Snapchain nodes, which Snapchain lists in `src/network/mesh/nodes.rs`: first gRPC on `crackle.farcaster.xyz:3383`, then the HTTP APIs (`https://snap.farcaster.xyz:3381`, then `https://crackle.farcaster.xyz:3381`). A `--hub` that names either node is tried first and falls back to the rest; any other `--hub` gets no fallback. So one export never mixes two networks.
- **Hypersnap:** `haatz.quilibrium.com` runs Hypersnap, a Snapchain fork that mirrors Snapchain today but is planned to become a separate chain. `castsnap` uses it only when you pass it with `--hub`.
- **HTTP gap:** the HTTP API omits reaction and link removes, so a run whose reactions or links come from an HTTP API records AC-13's gap as `unavailable:http-omits-removes` rather than as a pass.
- **Followers:** `linksByTargetFid`. Pagination ends on an empty token **or** `base64("[null,null]")`, and repeated tokens are treated as an error. `pageSize` applies per shard; `castsnap` uses 1000.

**App data.**
- **Host:** `https://client.farcaster.xyz`, falling back to `https://farcaster.xyz/~api`.
- **`/v2/following` and `/v2/followers`:** these allow 50 accounts per page, 20 requests per 10 s, and 500 per hour.
- **Private endpoints** (`--private`): listed in [USAGE.md](USAGE.md) "What `--private` fetches". They declare no rate limit, so `castsnap` paces them at one request per 600 ms.

## Network etiquette

- One request at a time per host. Protocol, client API and media run as three concurrent lanes, because they use different hosts.
- A 429 is retried after its `Retry-After`, or with exponential backoff from 30 s. Retryable protocol errors are retried with backoff. A 5xx from the primary client host switches the run to the fallback host.
- Media URLs are chosen by cast authors, so they are untrusted. A URL whose host is, or resolves to, a loopback, private, link-local or multicast address is refused, including an IPv4 address written as IPv6, and so is a redirect to one; at most 5 redirects are followed. The connection goes only to an address that passed this check, so a host can't pass it with one DNS answer and then be reached at another. Media are requested without compression, and a compressed response is refused. Each file is capped at 100 MiB. Once the stored media reach 20 GiB, the remaining URLs are skipped without a request and listed in `media/index.jsonl` with an error.
- Requests to protocol nodes name `castsnap` in their user-agent: `castsnap/VERSION (+https://github.com/ques10marc/unofficial-farcaster-account-exporter)`, followed over gRPC by the gRPC library's own. Requests to the client API and to media hosts send Node's default, `node`.
- There is no resume yet: after an interruption, run the export again. It writes a new directory.

## Acceptance criteria

`castsnap verify` reports each criterion as PASS, FAIL or N/A. N/A means the run did not cover it, for example private data on a run without `--private`. An export passes when every P0 criterion passes. P1 and P2 criteria cover lower-priority data. AC-22, the manual parts of AC-12 and AC-18, and AC-16's repo search and `git status` are checked by hand; `verify` prints the manual steps. The IDs AC-05 to AC-09 are not used.

| ID | P | PASS when… |
|---|---|---|
| AC-01 | P0 | `castsnap export` exits 0, and every dataset D1–D15 in the manifest has status `complete`, `empty`, or `unavailable:<reason>`. Zero have status `error`. |
| AC-02 | P0 | Every paginated source records that its final page returned an empty cursor or token. |
| AC-03 | P0 | `castsnap verify` recomputes SHA256SUMS with 0 mismatches. |
| AC-04 | P0 | **Messages and signers**, all three must hold: (a) 100% of exported protocol messages pass offline blake3 hash and ed25519 signature checks using `@farcaster/core`; (b) every message in the FID's own sets (casts, reactions, links, user data, verifications, storage lends, link compact state) carries the FID; (c) every such message's signer is authorized for the FID, as proven by the export alone: either by an on-chain signer ADD event, or by a gasless `KEY_ADD` that is exported, passes (a), carries a custody EIP-712 signature that recovers to the FID's custody address at the `KEY_ADD`'s time (from the exported ID-registry events), lists the message's type in its scopes, and whose TTL covers the message. TTL coverage follows Snapchain's sliding rule, with message timestamps in place of the block timestamps the export does not hold: walking the key's exported `KEY_ADD`s, `KEY_REMOVE`s and messages in timestamp order, a `KEY_ADD` sets the key's last use to its timestamp, a `KEY_REMOVE` ends the key until a later `KEY_ADD`, each message must fall no later than last use + TTL, and a message more than 300 s after the last use moves it to the message's timestamp. Followers, context casts and bookmarked casts are fetched for context and get check (a) only. |
| AC-10 | P0 | **Following**, all three must hold: (a) the protocol following count, excluding any self-follow, equals the app profile's `followingCount` exactly; (b) zero accounts appear in the client `/v2/following` list but not in the protocol set; (c) every protocol-only account is listed in `reconciliation.json` as `hidden_by_client`, or as `self_follow` for the self-follow. |
| AC-11 | P0 | **Followers**, all four must hold: (a) protocol follower pagination ends on an empty or all-null shard token; (b) the client `/v2/followers` list is captured in full, ending on an empty cursor; (c) the number of accounts in the client list but not in the protocol set is ≤ max(2, 0.5%) of the client list, and each is listed in `reconciliation.json`; (d) the manifest reports both the protocol count and the app count. There is deliberately no "± app count" clause: the protocol can legitimately list several times as many followers as the app shows. |
| AC-12 | P0 | **Bookmarks**, all three must hold: (a) pagination reaches an empty cursor; (b) 100% of bookmarks include the full cast: hash, author FID, text, timestamp and embeds; (c) in a manual spot check, `castsnap find` finds **5 of 5** bookmarks you pick: the newest, the oldest, and 3 at random. |
| AC-13 | P0 | **Casts, reactions and links:** for each store, the exported message count equals `storageLimitsByFid.used`, captured before and after the run. |
| AC-14 | P0 | **Profile:** username, display name, bio, profile picture and URL match exactly between the protocol's `userData` and the client profile. |
| AC-15 | P0 | **Portability:** every `normalized/` file validates against its JSON Schema with 0 errors. Each CSV parses with a standard parser, and its row count equals the matching JSON count. An offline import-check script (`scripts/import-check.mjs`) rebuilds following, followers, and bookmarks with cast text, using no network access. |
| AC-16 | P0 | **Security:** a search of the export and of the repo for the token finds 0 hits; this is also tested with a sentinel fake token. `git status` shows no export files. The export directory mode is 0700. |
| AC-17 | P1 | **Channels:** pagination is exhausted, and the count equals the length of the client's channel list. |
| AC-18 | P1 | **DMs:** pagination is exhausted for every conversation. In a manual check of the oldest message in 3 conversations you pick, 3 of 3 are found. |
| AC-19 | P1 | **Media:** 100% of embed URLs have a recorded final status, and ≥ 95% of image URLs in the account's own casts and bookmarked casts are downloaded and stored by hash. |
| AC-20 | P1 | **Blocks, context casts, signers and storage** are each exported, with pagination exhausted. |
| AC-21 | P2 | **Drafts, muted keywords and mini apps** are each `complete` or `unavailable:<reason>`. |
| AC-22 | P0 | **Setup:** going from a fresh clone to a finished export takes ≤ 3 documented commands. |
