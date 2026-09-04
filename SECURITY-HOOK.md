# Security hook playbook (copy to another repo)

Use this file to add the **same virus / malware scan flow** to a new project.
Do not reinvent it. Copy the files, then tune only the deploy/Vercel bits.

**Policy (apply this in every repo):**

- Do **not** scan on `git commit`.
- Do **not** scan on every push or pull request.
- Do **not** add `prepare` that installs a Git pre-commit trampoline.
- Scan **only before deploy** (`bash .githooks/pre-commit --ci`).
- Protect `main`: require a pull request; block force pushes and direct pushes.

Working reference: this repo (`App-Builder` / App Builder MR-Supplement).

---

## What you get

| Layer | When it runs |
| --- | --- |
| Local `git commit` | **No scan.** The hook exits immediately unless `--ci`. |
| Push / pull request | **No scan.** Do not add `security-precommit.yml`. |
| Deploy (VPS) | After sync of `main`, **before** install/build. Failure restores the previous release. |
| Deploy (Vercel) | Inside `build` only when `VERCEL=1` or `GITHUB_ACTIONS=true`. |

Git **cannot** turn on local hooks from a clone/pull (that would be remote code execution). Do not reintroduce `prepare` + `--install` — that made every commit slow.

---

## 1. Copy the hook

From a reference repo, copy:

```text
.githooks/pre-commit
```

Then:

```bash
chmod +x .githooks/pre-commit
```

Do **not** run `bash .githooks/pre-commit --install`.
Do **not** set `git config core.hooksPath`.

If this repo **already** had a commit-time scan, disable the local trampoline on every machine (and tell teammates):

```bash
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Remove `prepare` from `package.json` if it still calls `--install`.

### What the hook does (only with `--ci`)

- Indicator scan for known malware strings (NullReceiver / fake-font campaign)
- `polin-rider-scanner` (`npx` unless installed locally)
- **Fonts:** keep real WOFF/WOFF2/TTF/OTF. Remove a font-named file **only** if it is a JS/malware payload. Do not ignore `*.woff2` in `.gitignore`
- `--ci`: scan only, no file deletes

Local commit with an old trampoline still present: the version-controlled hook exits `0` when not in CI. Still replace `.git/hooks/pre-commit` as above so Git does not even invoke the script.

---

## 2. `package.json` (no auto-install)

Add a manual scan script. **Do not** add `prepare` that installs Git hooks.

```json
{
  "scripts": {
    "security:scan": "bash .githooks/pre-commit --ci"
  }
}
```

Optional hosted build (Vercel): prefix the existing `build` so **hosted** builds scan; local `pnpm run build` should not if you keep the `VERCEL` / `GITHUB_ACTIONS` guard:

```json
{
  "scripts": {
    "security:scan": "bash .githooks/pre-commit --ci",
    "build": "bash -c 'if [ \"${VERCEL:-}\" = \"1\" ] || [ \"${GITHUB_ACTIONS:-}\" = \"true\" ]; then bash .githooks/pre-commit --ci; fi' && <your existing build>"
  }
}
```

For GitHub **validate** jobs, use a build script **without** the scan (example: `build:ci`) so CI is fast. The VPS deploy job runs `--ci` after sync.

---

## 3. GitHub Action (deploy only)

Do **not** create `.github/workflows/security-precommit.yml`.
Do **not** add a `security-scan` job on every `push` / `pull_request`.

If that workflow already exists in the target repo, **delete it**.

Scan only in the **deploy** workflow on `main`, after code is synced to the server and **before** `pnpm install` / `npm ci` / build.

---

## 4. Gate GitHub deploy (VPS / self-hosted)

1. `validate` on `ubuntu-latest` (install + build, **no** malware scan).
2. `deploy` `needs: [validate]` on the self-hosted runner.
3. Capture `PREV_SHA`, sync `origin/main`.
4. Run the scan. On failure, restore `PREV_SHA` and skip install/restart.

```yaml
      - name: Virus / malware scan (block server deploy if infected)
        id: malware_scan
        run: |
          set -euo pipefail
          cd "${{ env.VPS_APP_PATH }}"
          bash .githooks/pre-commit --ci

      - name: Restore previous release after failed scan
        if: ${{ failure() && steps.malware_scan.outcome == 'failure' && env.PREV_SHA != '' }}
        run: |
          set -euo pipefail
          cd "${{ env.VPS_APP_PATH }}"
          git reset --hard "${{ env.PREV_SHA }}"
```

Reference: this repo `.github/workflows/deploy.yml`.

---

## 5. Gate Vercel (or any `npm run build` host)

Use the `build` prefix in section 2. If the scan fails, Vercel does not ship that commit.

Amplify / other host CI: run `bash .githooks/pre-commit --ci` in **preBuild** or the deploy job only — not on every PR.

---

## 6. Protect `main` (GitHub settings, not YAML)

Workflows cannot block force-push or direct push. In the target repo:

1. **Settings → Rules → Rulesets** (or **Branches**).
2. Target `main`.
3. Require a pull request before merging (no direct push).
4. Block force pushes.
5. Optionally block branch deletion.

Apply this on every repo that uses this playbook.

---

## 7. Checklist for a new repo

- [ ] Copy `.githooks/pre-commit` and `chmod +x`
- [ ] Confirm the hook **exits 0** when not `--ci` / not CI (no commit-time scan)
- [ ] Add `security:scan` in `package.json`
- [ ] **Remove** `prepare` that runs `--install` (if present)
- [ ] **Delete** `.github/workflows/security-precommit.yml` (if present)
- [ ] Do **not** add a per-push / per-PR scan workflow
- [ ] Do **not** run `--install`; neutralize `.git/hooks/pre-commit` if an old trampoline exists
- [ ] Do **not** add `*.woff2` to `.gitignore`
- [ ] VPS deploy: scan after sync, before install; restore previous SHA on failure
- [ ] Vercel: scan inside `build` only when `VERCEL=1`
- [ ] Verify: `bash .githooks/pre-commit --ci` (this **does** scan — expected)
- [ ] Confirm `git commit` does **not** print scanner output
- [ ] Commit and push the hook + deploy workflow (not `.git/hooks/`)
- [ ] Protect `main`: require a pull request, block force pushes

---

## 8. Verify

```bash
# Must scan (deploy path)
bash .githooks/pre-commit --ci

# Must do nothing (commit path)
bash .githooks/pre-commit
```

`--ci` expect: indicator scan passed, then scanner `safe=true` (vendor hits under `node_modules/` / `.next/` are ignored).

Bare hook with no args: empty / instant exit `0`.

---

## Tune per project

Keep the hook behavior the same (no commit scan; `--ci` only).
Change only:

- Node version in the **deploy validate** job if the app is not on 22
- Package manager (`npm` vs `pnpm`)
- Deploy job names / `VPS_APP_PATH` / process name
- Vercel vs Amplify vs VPS gating snippet
