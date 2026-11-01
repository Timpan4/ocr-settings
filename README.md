# ocr-settings

The settings page at https://ocr.timpan.dev/settings/ for the shared
[OpenCodeReview](https://github.com/alibaba/open-code-review) settings used by
[`Timpan4/ocr-review`](https://github.com/Timpan4/ocr-review). Saving commits
`settings.json` to `main` in that repository, and the next review uses it.

It runs on wall-e next to the OCR review history viewer, behind the same
oauth2-proxy and Authentik sign-in (`wall-e-infra`, `apps/review-runners`).

## How it works

- `GET /settings/` reads `settings.json` from the branch and shows a form.
- `POST /settings/` validates the form with the same rules as the review
  workflow, then commits through the GitHub contents API with the blob SHA the
  page was loaded with. If the file changed in the meantime, GitHub rejects the
  write and the page shows the current values instead.
- Unchanged forms commit nothing. The commit message lists the changed keys and
  the signed-in user from oauth2-proxy's `X-Forwarded-Email` header.
- POSTs whose `Origin` is not `PUBLIC_ORIGIN` are refused.
- It listens on `127.0.0.1` by default. Only oauth2-proxy in the same pod
  should reach it, because it trusts the forwarded user headers.

Commits come from the `ocr-settings` GitHub App, which has Contents read and
write on `Timpan4/ocr-review` only.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PUBLIC_ORIGIN` | Public origin, e.g. `https://ocr.timpan.dev`. |
| `SETTINGS_REPO` | Repository holding `settings.json`, e.g. `Timpan4/ocr-review`. |
| `SETTINGS_PATH` | File path. Default `settings.json`. |
| `SETTINGS_BRANCH` | Branch. Default `main`. |
| `GITHUB_APP_CLIENT_ID` | The App's client ID (JWT issuer). |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID on the account. |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Path to the App's PEM private key. |
| `LISTEN_HOST`, `LISTEN_PORT` | Default `127.0.0.1` and `8080`. |

## Development

```sh
bun install
bun test
bun run typecheck
```

The validation rules in `src/settings.ts` must match the `Load settings` step
in `Timpan4/ocr-review/.github/workflows/review.yml`.

## Releases

Push a `vX.Y.Z` tag. The release workflow tests, builds and pushes
`ghcr.io/timpan4/ocr-settings:X.Y.Z`, and wall-e's Kargo pipeline promotes it.
