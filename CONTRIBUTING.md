# Contributing to fcx

Thank you for helping. fcx handles people's private messages, and a credential that gives full access to their account, so a few rules come first.

## Ground rules for everyone

- **Never post a session token** anywhere: not in an issue, a PR, a commit, a log or a screenshot. If you posted one by mistake, see [SECURITY.md](SECURITY.md).
- **Never post private data.** That includes DM, bookmark or draft text, export files, and `fcx find` output. `fcx verify` output is fine to share, because it holds statuses and counts only.
- **Replace your home folder path with `~`** in anything you paste.
- **Your FID and username are optional.** Including them links your report to your Farcaster account.

## Reporting a bug

Use the **Bug report** issue form. It asks for:

- the command you ran
- its exit code
- what you expected
- the last lines of output
- your OS
- `node --version`
- the fcx commit (`git rev-parse --short HEAD`)

## Banned or restricted accounts

If the Farcaster app banned or restricted your account, please fill in the **Banned or restricted account** form, whatever the outcome. Nobody yet knows what such an account can still export, and every result helps.

## Security problems

Don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Proposing a change

- **Small fixes:** open a PR directly, with a test that fails without your fix.
- **Anything larger,** such as a new dataset, a new or upgraded dependency, or a change to the output format: open an issue first, so we can agree on the approach before you write it.
- **Every PR fills in the template,** including the AI-assistance section.

## AI-assisted contributions

fcx itself is developed with AI coding assistants. AI help is welcome under three rules:

1. **Disclose it.** Say in the PR description which tools you used and what for; one line is enough. A commit trailer such as `Co-Authored-By:` or `Assisted-by:` is welcome, but it doesn't replace the disclosure in the PR.
2. **A person is accountable for every change.** You must have read and understood every line you submit, and run the tests yourself. You must be able to answer review questions without handing them back to a tool.
3. **No PRs opened by agents on their own.** A person must review each change and decide to open the PR. We close PRs opened by an agent on its own without review.

Automated dependency-update PRs, such as Dependabot's, fall under rule 3, because no person decides to open them. Upgrading a dependency also needs an agreed issue first (see [Code guidelines](#code-guidelines)). So we don't accept them: to suggest an upgrade, open an issue.

The same rules apply to issues and comments. An AI-written report is fine once a person has checked that it is accurate and contains no private data.

Agents working in this repository: read [AGENTS.md](AGENTS.md).

## Development setup

You need Node 24 or newer, and git. fcx runs its TypeScript directly with Node's type stripping, so there is no build step.

```bash
npm ci
```

```bash
npm test
```

```bash
npm run typecheck
```

`npm test` runs offline, against recorded public fixtures and a local mock server. It uses no network and no real token.

## Code guidelines

- **Match the style of the surrounding code.**
- **Dependencies are pinned to exact versions.** Adding or upgrading one needs an agreed issue first. fcx handles session tokens, so every dependency is part of its security boundary.
- **Tests never touch the network or real account data.** Use `test/mock-server.ts` and the recorded public fixtures in `test/fixtures/`.
- **Never commit export folders** (`fc-export-*`, `quick-*`). `.gitignore` excludes them.

## Review and merging

- **There is no CI yet.** Run `npm test` and `npm run typecheck` before you open a PR, as the template asks. The maintainer runs both again before merging.
- **A maintainer reviews every PR,** and reads the diff before running any of its code locally.
- **The maintainer merges.**
