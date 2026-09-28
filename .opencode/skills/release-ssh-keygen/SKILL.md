---
name: release-ssh-keygen
description: "GitHub deployment SSH key setup."
slash: true
metadata:
  opencode/autoinvoke: false
---

# Release SSH Keygen

Create a dedicated SSH key for this project's GitHub deployment access. Follow the workflow in order and stop on errors instead of improvising around them.

## Rules (BLOCKER)

- Never overwrite or delete an existing key.
- Never display, copy, or transmit the private key; only the public key.
- Key generation must run non-interactively and without a passphrase.
- Write the SSH config entry and add remotes only after the user explicitly confirms.
- When an SSH config host entry or a remote already exists, change nothing; report it instead.
- The GitHub guide must state that the key is stored as a read-only deployment key.
- All user-facing output is in the project's language.

## Workflow

1. Determine the project name from the current working directory (directory base name) and derive:
   - kebab-case name, for example `my-project`
   - snake_case name, for example `my_project`
2. Show both derived names and ask the user to confirm them or to provide a different name. Use the confirmed names in all following steps.
3. Run the script [keygen.sh](keygen.sh) from this skill directory with `sh <skill-dir>/keygen.sh <snake_case_name>`. The script:
   - reports `STATUS: exists` without generating when `~/.ssh/gh_<snake_case_name>` is already present,
   - otherwise generates an Ed25519 key without a passphrase non-interactively at `~/.ssh/gh_<snake_case_name>` and reports `STATUS: created`,
   - prints the public key.
4. Show the result and the public key to the user. Report either that the key already exists or that it was created. In both cases include this short GitHub guide (adapted to the project's language) and note that the key must be stored as a read-only deployment key:

   > GitHub.com → open the repository → **Settings** → **Deploy keys** → **Add deploy key** → paste the public key → leave **Allow write access** unchecked → **Add key**. The key is then read-only.

5. Prepare the SSH config entry:

   ```
   Host gh-<kebab-case-name>
       HostName github.com
       User git
       IdentityFile ~/.ssh/gh_<snake_case_name>
       IdentitiesOnly yes
   ```

   - Check `~/.ssh/config` for an existing `Host gh-<kebab-case-name>` entry.
   - If it exists: show the existing entry and tell the user that it already exists. Change nothing.
   - Otherwise: show the entry and ask whether to append it to `~/.ssh/config` (create the file if missing, set permissions to `600`). Write only after confirmation.

6. Configure the git remote:
   - Read `git remote get-url origin`.
   - If `origin` is missing: ask the user for the repository URL. After confirmation, add `origin` with that URL and `deploy` in the SSH form.
   - If `origin` exists: derive `<owner>/<repo>` from its URL and build the deploy URL `git@gh-<kebab-case-name>:<owner>/<repo>.git`.
   - If a remote named `deploy` already exists: change nothing and include in the summary that it already exists, showing its URL.
   - Otherwise: ask for confirmation and then run `git remote add deploy <deploy-url>`.
7. Summarize:
   - Key path and whether it was created or already existed
   - Public key
   - SSH config status (added, already existed, or skipped)
   - Remote status (`deploy` with URL, already existed, or skipped)
   - Reminder that the GitHub deployment key must be stored as read-only

## Output

- Key status (created or already existed), key path, and public key
- SSH config status (added, already existed, or skipped)
- Remote status (`deploy` added, already existed with URL, or skipped)
- Reminder that the GitHub deployment key must be stored as read-only
