# Release signing keys

Prism's auto-updater only installs an update whose `.sig` verifies against the
minisign **public** key compiled into the app (`plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`). Whoever holds the matching **private** key can
push code to every installed copy. Treat it accordingly.

## Where the key lives (since 2.2.1)

| What | Where |
| --- | --- |
| Public key | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (in git) |
| Private key | GitHub → repo Settings → Environments → `release` → secret `TAURI_SIGNING_PRIVATE_KEY`. There is **no** repository-level copy. |
| Key password | None. The key was generated without one (see §4). |
| Local copy | `~/.tauri/prism.key` on Rajat's Mac: the file `tauri signer generate` wrote. The secret holds this file's contents as-is. |

Key ID `39f3e4ae0ac6fafb`. `tauri.conf.json`'s pubkey decodes to the same text
as `~/.tauri/prism.key.pub`.

## 1. How a release is protected

- **Environment `release`.** The three `build-*` jobs in
  `.github/workflows/build.yml` run in it, and only they can read the key.
  - Required reviewer: `rajatraina747`.
  - Only `v*` tags may deploy to it.
- **Tag ruleset "Release tags".** Creating, moving or deleting a `refs/tags/v*`
  tag is blocked for everyone except repository admins, i.e. Rajat.

Releasing:

1. Push `main`, then the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
2. The `notes` job runs. The three build jobs then show **Waiting**. Open the
   run and click **Review deployments**. Tick `release`, then click
   **Approve and deploy**.
3. When the run is green, check the draft (§5), then publish it:
   `gh release edit vX.Y.Z -R rajatraina747/prism --draft=false --latest`.
4. Bump the Homebrew cask in `rajatraina747/homebrew-prism`. Set `version`,
   and set `sha256` to the `shasum -a 256` of `Prism_X.Y.Z_aarch64.dmg`.

## 2. Backups

`~/.tauri/prism.key` is the only copy outside GitHub, and GitHub never gives a
secret back. If both are lost, every installed copy is stranded: no future
update can ever verify.

- Keep at least one offline copy of `~/.tauri/prism.key` (USB stick, or an
  encrypted archive somewhere other than this Mac).
- Once a year, check the copy still matches. Compare its `.pub` with the pubkey
  in `tauri.conf.json`:
  `[ "$(cat prism.key.pub)" = "$(jq -r .plugins.updater.pubkey src-tauri/tauri.conf.json)" ]`.

## 3. Rotation (compromise, or a planned change)

Installed apps only trust the old public key, so rotate in two releases:

1. `npx tauri signer generate -w prism-new.key`.
2. **Release N**, still signed with the **old** key, ships the **new** public
   key in `tauri.conf.json`. Every copy that installs N now trusts the new key.
3. Replace the `release` environment's `TAURI_SIGNING_PRIVATE_KEY`:
   `gh secret set TAURI_SIGNING_PRIVATE_KEY --env release -R rajatraina747/prism < prism-new.key`.
4. **Release N+1** onward is signed with the new key. Update §2's backup.

If the old key is known to be **compromised**, an attacker can sign too.
Publish N quickly, say so in the release notes, and remove older releases that
an attacker could replay. The updater has no downgrade protection (S-15).
Copies that never install N need a manual download.

## 4. Why there is no key password

A password would have to live in the same `release` environment as the key,
readable by the same jobs after the same approval. It protects against nothing
the environment doesn't already cover (REVIEW 2026-09-26 M2, decided
2026-09-26). It would matter if the key file itself leaked from this Mac. To
add one:

```sh
brew install minisign
cd "$(mktemp -d)" && base64 -d < ~/.tauri/prism.key > prism.key
minisign -C -s prism.key          # press Enter for the old (empty) password
base64 < prism.key | tr -d '\n' | gh secret set TAURI_SIGNING_PRIVATE_KEY --env release -R rajatraina747/prism
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release -R rajatraina747/prism
```

Then replace `~/.tauri/prism.key` and the offline copy with the new contents,
and `rm -P prism.key`.

## 5. Checking a release was signed by this key

Every signature carries the ID of the key that made it. After the build, all
platforms in the draft's `latest.json` should carry signatures made by key
`39f3e4ae0ac6fafb`:

```sh
cd "$(mktemp -d)" && gh release download vX.Y.Z -R rajatraina747/prism -p latest.json
python3 -c "import json,base64; d=json.load(open('latest.json')); print({base64.b64decode(base64.b64decode(v['signature']).decode().splitlines()[1])[2:10].hex() for v in d['platforms'].values()})"
```
