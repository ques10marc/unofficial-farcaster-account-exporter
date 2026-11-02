# Security policy

castsnap handles a session token that gives full access to a Farcaster account, and it writes people's private messages to disk. Please report security problems privately.

## How to report

Use GitHub's private vulnerability reporting: on this repository's **Security** tab, choose **Report a vulnerability**. Please don't open a public issue or PR for a security problem.

Include:

- what you found
- the castsnap commit
- how to reproduce it with a fake token or the test mock server (`test/mock-server.ts`)

Never include a real token or real private data.

## What counts

For example:

- the token is written to disk, printed, logged, or left in an error message;
- the token is sent anywhere other than `https://client.farcaster.xyz` or `https://farcaster.xyz/~api`, or is sent along a redirect;
- an export folder or file can be read by other users of the same computer;
- private data is sent anywhere other than the user's own disk;
- a dependency behaves maliciously.

## If you posted your token by mistake

1. Delete the post or comment.
2. Sign out of farcaster.xyz in every browser, then sign in again. In a test this did not end a copied token, but it does no harm.
3. Treat the token as exposed for as long as it works: there is no known way for you to revoke it. To check whether it still works, run `node bin/castsnap.js auth-check --fid YOUR_FID` and paste the old token. Once it no longer works, the check fails with HTTP 401.

## Official source

castsnap is not on npm. Any npm package named castsnap is not from this project; the only official source is https://github.com/ques10marc/unofficial-farcaster-account-exporter.

## Supported versions

Only the latest commit on `main`.

## Response

This is a small volunteer project. We aim to acknowledge reports within a week.
