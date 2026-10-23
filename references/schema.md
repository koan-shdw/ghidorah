# Schema 2 repository map

The canonical engine is `scripts/cli.mjs`. Schema 1 and its folder-only scanner are retired.

## Files and trust

- `.repo-map/index.json`: generated snapshot and content-hash parse cache.
- `.repo-map/index.txt`: bounded overview; use a task query for more useful context.
- `.repo-map/map.html`: optional offline view, generated only with `--html`.
- `REPO-MAP-NOTES.json`: authored explanations; never overwritten by the engine.

A fingerprint covers indexed paths and full content hashes, inventory mode and read issues.
Generated outputs do not enter the fingerprint. Asset binaries, secrets by filename, dependencies,
build output and links are excluded. Changes outside that declared scope are not detected.
Default scan limits: 20000 indexed files, 80 MB total and 1 MB per file. Exceeded limits and failed
reads are reported as issues, never size-only hashes masquerading as verified content.

`--check` reads a saved index and independently inventories the working tree. It fails for missing
maps, analyzer/fingerprint/notes changes, partial scans, invalid notes or stale/unverified claims.
It does not regenerate the map. It proves neither semantic correctness nor test coverage.

## Top-level fields

| Field | Meaning |
|---|---|
| `schema` | 2 |
| `analyzer` | Parser-version cache key |
| `repo`, `generatedAt` | Display name and snapshot time |
| `fingerprint` | SHA-256 of indexed paths/hashes, scope mode and issues |
| `scope` | Plain-language exclusions and non-Git behaviour |
| `partial`, `issues` | Read, parse and limit failures; each issue has path/reason |
| `files` | Indexed file rows, not full source bodies |
| `edges` | Resolved local AST imports |
| `unresolved` | External, alias, dynamic or ambiguous imports retained explicitly |
| `claims`, `notesHash`, `notesError` | Authored claims and evidence validation |
| `stats` | Changed/reused file counts, bytes read and elapsed milliseconds |

File rows contain `path`, `hash`, `bytes`, `lines`, `status`, `symbols`, `imports`.
Statuses are `parsed`, `inventory-only`, `parse-error` and `parser-unavailable`. JS/TS and Python
have syntax-tree outlines; other accepted text formats are inventory-only.
Symbols contain `name`, `kind`, `line`, `endLine` and a bounded source `signature`.
Edges contain `from`, `to`, `line`, `kind: import`, and provenance `evidence`.
An import edge is not a call graph or runtime trace; tests importing a module do not prove coverage.

## Authored claims

The notes object has a `claims` array. Each item contains:

- `kind`: `purpose`, `flow`, `invariant` or `area`.
- `text`: a non-empty explanation, at most 1200 characters.
- `evidence`: at most 30 objects with repository-relative `path`, exact lowercase SHA-256 `hash`
  from the indexed file, and positive 1-based `line` within that file.

The whole notes file is limited to 100000 bytes and 100 claims. Invalid notes produce `notesError`;
legacy summary/area formats are not silently trusted. No model-generated claim is created by scanning.

A claim is `unverified` when evidence is empty, `current` when every cited file hash and line
matches, and `stale` otherwise. Rewording alone never renews evidence. Re-read source before
changing a hash. Even `current` means evidence bytes match, not that the authored interpretation
has been independently proved. Keep descriptions concise and record IPC/dynamic relationships
as interpretations with evidence, not as fabricated import edges.

## Queries and display

Queries rank lexical matches in filenames, symbol names/signatures and current claims, then include
one-hop imports/importers. No embeddings, remote service or LLM is used. The budget is a character
limit, not a token estimate. Output discloses omitted rows; narrow the query or use `--file`.
The circle graph aggregates the same file index and supports 2D/3D, rotation and lexical highlights.
Repository text is rendered as data; it must never become instructions or executable markup.
