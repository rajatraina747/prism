# Release signing keys

Prism's auto-updater only installs an update whose `.sig` verifies against the
minisign **public** key compiled into the app (`plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`). Whoever holds the matching **private** key can
push code to every installed copy. Treat it accordingly.

## Where the key lives

| What | Where |
| --- | --- |
| Public key | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (in git) |
| Private key | GitHub → repo Settings → Secrets → `TAURI_SIGNING_PRIVATE_KEY` |
| Key password | GitHub secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty until step 1 below is done) |
| Offline backup | Password manager entry "Prism updater key" + one offline copy (encrypted USB / printed) |

Only the three `build-*` jobs in `.github/workflows/build.yml` receive the key,
and only they have `contents: write`.

## 1. Encrypt the existing key (one-off, no rotation)

Adding a password does **not** change the key pair, so installed copies keep
updating. `TAURI_SIGNING_PRIVATE_KEY` holds the base64 of a minisign secret-key
file.

```sh
brew install minisign                     # free
cd "$(mktemp -d)"
pbpaste | base64 -d > prism.key           # copy the current secret value first
minisign -C -s prism.key                  # set a new password (it asks for the old one; press Enter if none)
base64 < prism.key | tr -d '\n' | pbcopy  # new secret value
```

1. Paste it into `TAURI_SIGNING_PRIVATE_KEY`, and put the password into
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
2. Update the offline backup with the encrypted file. Store the password
   separately.
3. `rm -P prism.key`, then clear the clipboard.
4. Check it on the next tag: all three build jobs must upload `.sig` files.
   `latest.json` must list signatures for every platform.

## 2. Backups

- Keep two copies of the encrypted key, in different places, plus the password
  in a password manager. If you lose the private key, every installed copy is
  stranded: no future update can ever verify.
- Once a year, restore from the backup and sign a test file
  (`minisign -S -s prism.key -m README.md`). Verify it against the pubkey in
  `tauri.conf.json`.

## 3. Rotation (compromise, or a planned change)

Installed apps only trust the old public key, so rotate in two releases:

1. `npx tauri signer generate -w prism-new.key` (with a password).
2. **Release N**, still signed with the **old** key, ships the **new** public
   key in `tauri.conf.json`. Every copy that installs N now trusts the new key.
3. Swap both GitHub secrets to the new key and password.
4. **Release N+1** onward is signed with the new key.

If the old key is known to be **compromised**, an attacker can sign too.
Publish N quickly, say so in the release notes, and remove older releases that
an attacker could replay. The updater has no downgrade protection (S-15).
Copies that never install N need a manual download.
