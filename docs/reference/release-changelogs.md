---
doc-schema-version: 1
summary: "Prepare release notes and publish approved documentation updates"
title: "Release changelogs"
read_when:
  - Prepare release notes and publish approved documentation updates
---

Use this reference when you need to prepare release notes and publish approved documentation updates. For the release sequence, start with [Release policy](/reference/RELEASING).

## Release changelog artifacts

`CHANGELOG.md` is the generated release index. Each release has one complete
`CHANGELOG/YYYY.M.PATCH.md` file. Existing complete contribution records are
also retained in `CHANGELOG/records/YYYY.M.PATCH.md`, independently of later
editorial changes. Historical releases without records gain no invented data.
Initial release generation keeps its existing Highlights, Changes, Fixes and
contribution-record format; it does not automatically run the later docs rewrite.

Use the shared changelog owner rather than parsing the root index as release
notes:

```bash
node scripts/release-changelog.mjs read --version YYYY.M.PATCH
node scripts/release-changelog.mjs read --version YYYY.M.PATCH --ref <exact-sha-or-tag>
node scripts/release-changelog.mjs read --version YYYY.M.PATCH --record
node scripts/release-changelog.mjs write --version YYYY.M.PATCH --file /path/to/initial-section.md
pnpm changelog:check
```

The reader supports older tagged commits that still use a monolithic changelog.
Current writes require the split layout and update the selected entry, its
matching record and index together. Initial generation refuses to overwrite a
docs mirror. Historical duplicate version headings are preserved in their
original order, but automated single-release selection refuses an ambiguous
version. Generated files retain their source bytes; use their generator and
`changelog:check`, not a general-purpose formatter.

### Changelog-only evidence reuse

After product qualification, a later Release SHA may reuse Code SHA evidence
under `split-changelog-release-v1` only when the complete delta:

- Adds or modifies `CHANGELOG/YYYY.M.PATCH.md` for the selected release.
- Optionally adds or modifies that release's matching record and modifies the
  root `CHANGELOG.md` index.
- Contains no other paths, other releases, renames or deletions.

Beta package versions select the stable-base entry and matching record. For
example, `2026.9.5-beta.1` uses `CHANGELOG/2026.9.5.md` and
`CHANGELOG/records/2026.9.5.md`, as release-note generation does.

Docs-source changes do not qualify for this narrow reuse policy. Historical
root-only receipts retain `changelog-only-release-v1` and its original exact
`CHANGELOG.md` delta; they are not relabeled as split-layout evidence. Either
form reuses product validation only: the new Release SHA's package and image
bytes still require their own qualification.

## Post-release documentation publication

Approved detailed docs may replace the initial release prose after publication.
This is a separate documentation update, not another package release. The docs
are the editorial source; publish their complete flat Markdown mirror in the
same source PR so both presentations stay synchronized.

```bash
pnpm changelog:from-docs --version YYYY.M.PATCH \
  --source docs/releases/YYYY.M.PATCH.md \
  --output CHANGELOG/YYYY.M.PATCH.md
pnpm changelog:check
```

For a release spread across several docs pages, repeat `--source` in the
approved reading order. Keep one complete flat file even when it is too large
for GitHub's rendered preview; provide its Raw/download link. The renderer
removes presentation wrappers, promotes accordion titles to headings, expands
docs links and retains the prose, warnings, references, credits, code, tables
and images. Unsupported markup fails rather than silently dropping content.

The first-line mirror marker records the ordered source paths and exact source
digest. It is provenance, not publication approval. `changelog:check` checks
marked mirrors against their sources; historical unmarked release files are
not automatically rewritten. Any later edit to a mirrored docs source must
regenerate its flat file in the same PR. Preserve the frozen contribution
record and unrelated index entries when updating reader-facing prose.

After the exact approved source PR merges and the deployed docs are verified,
the release-notes publication workflow can update only the GitHub Release body:

- Show the version, verified PR/direct-commit/contributor counts, a Raw
  changelog link, and the reader-friendly docs link.
- Include one alphabetically deduplicated thanks list covering all verified
  contributors, including `@steipete`: PR and direct-commit authors, coauthors
  and credited issue contributors. Exclude bots; a mention or comment alone
  does not establish credit.
- Preserve the existing `### Release verification` section byte-for-byte.
  Check both the 125,000-character and 125,000-byte limits; never truncate
  credits or verification to fit.

Source merge, deployed docs and Release-body publication are separate results.
An unchanged earlier deployment or a coalesced later deployment is acceptable
only when the publication workflow proves its source lineage and exact approved
docs bytes. Re-read the live body and source before application, require the
exact publication approval and comparison, and verify the result afterward.
If interrupted, reconcile the existing PR or already-applied body and resume
only incomplete steps; do not repeat an uncertain remote write.

Initial publishing and proof-append helpers refuse a body marked
`openclaw-release-publication:docs-v1`. Do not rerun them to overwrite the
post-docs body. GitHub manages native contributor avatars and assets; exact
avatar counts are informational. This documentation workflow never retags a
release, rebuilds binaries, republishes assets or changes registry selectors.
