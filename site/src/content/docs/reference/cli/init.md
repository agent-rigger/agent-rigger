---
title: init
description: "Run the first-launch wizard: probe catalog access, record the configuration, offer a first install."
---

## Synopsis

```
rigger init [--yes] [--scope=<user|project>]
```

`init` runs the first-launch wizard: it asks for a [catalog](/reference/glossary/#catalog)
repository URL, verifies access to it, records the resolved configuration, and then offers to
install a first set of artifacts. Configuration is written only after access is confirmed, so a
failed run leaves nothing on disk. Running it again starts from the saved state.

## Arguments

`init` takes no positional arguments.

## Flags

| Flag      | Effect                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--yes`   | Accept defaults and show no prompt: skip the assistant picker (fall back to on-disk detection) and, in the proposed install, select the catalog's required and recommended entries without a picker. |
| `--scope` | The [scope](/reference/glossary/#scope) the proposed install writes to (`user` or `project`, default `user`).                                                                                        |

## Steps

1. **Catalog URL.** The wizard asks `Enter the catalog repository URL:`.
2. **Access probe.** It runs `git ls-remote` against the URL with ambient credentials. If the
   repository is reachable, no authentication question is asked. If it is not, the wizard asks
   `Select authentication method:` with three options: `Provider CLI (gh / glab)`,
   `HTTPS (credential helper)`, and `SSH key`. The chosen method is applied and the probe repeats.
   A method that still fails ends the run with an actionable message that names the command to run
   (`gh auth login` or `glab auth login` for the provider-CLI method), exit `1`, and nothing is
   persisted.
3. **Assistants.** The wizard asks `Which assistant(s) do you want to configure?` as a
   multi-select over `claude` and `opencode`. Selecting none is allowed. `copilot` is not offered:
   it is reserved and has no [adapter](/reference/glossary/#adapter) yet.
4. **Persist.** Only now is the configuration written: the catalog is recorded under the name
   `principal`, together with the authentication method (when one was negotiated) and the selected
   assistants.
5. **Proposed install.** After a successful persist, the wizard fetches the catalog and offers a
   picker. Entries the catalog marks [required](/reference/glossary/#required) are pre-checked and
   cannot be unchecked; [recommended](/reference/glossary/#recommended) ones are pre-checked and
   can be opted out. The install targets every assistant configured in step 3.

A configuration written by an earlier run is read first and merged, so a second `init` only updates
the fields the new run resolves. Re-running with the same answers changes nothing
([idempotence](/reference/glossary/#idempotence)).

## Interactive vs non-interactive

In an interactive terminal all steps run as above. Under `--yes`, the assistant picker and the
install picker are skipped: the proposal installs the required and recommended defaults directly.

In a non-interactive session without `--yes`, `init` stops after persisting the configuration and
skips the proposed install; the assistants are taken from on-disk detection rather than a prompt.
Run `install` later to add artifacts.

## Output

On success the wizard prints a summary:

```
Catalog      : https://github.com/org/repo.git (principal)
Auth method  : ssh
Assistant(s) : claude, opencode
Config saved : /Users/you/.config/agent-rigger/config.json
```

The `Auth method` line is omitted when ambient access worked. If the post-persist fetch fails, the
configuration stays saved and the output adds:

```
Catalog fetch failed. Run `install` later to install artifacts from the catalog.
```

## Exit codes

| Code  | Condition                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Configuration persisted (with or without a proposed install).                                                                                                                                           |
| `1`   | Authentication failed; nothing was persisted.                                                                                                                                                           |
| `2`   | Invalid flag value (for example a bad `--scope`).                                                                                                                                                       |
| `130` | A prompt was cancelled with Ctrl+C. A cancel up to the persist step (step 4) leaves nothing on disk; a cancel in the proposed-install picker (step 5) exits `130` with the configuration already saved. |

See [exit codes](/reference/exit-codes) for the shared contract.

## Example

```
rigger init
```
