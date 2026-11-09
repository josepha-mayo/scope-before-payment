# Workflow dependencies

All third-party Actions are pinned to full commits from their official
`actions/*` repositories. The inline comments identify the reviewed release.
The November 9, 2026 update uses the Node.js24 runtime declared by each pinned
`action.yml` rather than depending on GitHub's Node20 compatibility override.

- [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)
- [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)
- [setup-python v7.1.0](https://github.com/actions/setup-python/releases/tag/v7.1.0)
- [upload-artifact v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2)

Checkout does not persist Git credentials. Node setup explicitly disables
automatic package-manager caching; these jobs use clean dependency installs.
Artifact uploads explicitly retain ZIP packaging and exclude hidden files.
The existing paths, retention periods, read-only permissions and invented test
data remain the boundary. An artifact is test evidence, not provider qualification.

For an update, resolve the official release tag to its commit, inspect that
commit's manifest and migration notes, then update every affected workflow.
Verify the full Linux/Windows/PostgreSQL/browser suite, raw recording artifact
and applicable public-boundary smoke before merging. Confirm downloadable
artifacts remain usable. Never replace a pin with a floating version tag.
