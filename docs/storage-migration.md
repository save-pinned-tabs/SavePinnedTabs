# Synchronized storage migration

Legacy tab-set keys are stable identities: each key is the Base64 representation of the set name. Migration hashes that key with Web Crypto SHA-256, uses the first 128 bits, and sets the UUID version and variant bits. SHA-256 and UTF-8 encoding are specified consistently in Chromium and Firefox, so every device derives the same set ID without synchronizing a legacy-key map.

A migration is restart-safe because the derived ID is stable across attempts and the recovered document remains staged in local storage until a complete synchronized generation is verified. A legacy record arriving after migration resolves to the same ID. Exact name-and-tab matches are also recognized, covering records already migrated by older releases.

Document versions define identity semantics explicitly:

- Version 2 assigned random UUIDs during legacy migration and persisted the assignment in `migration.legacyIds`.
- Version 3 derives UUIDs deterministically and does not create migration metadata.

`src/storage/migration/v2-documents.ts` is the isolated compatibility adapter for version-two documents. `migration/unversioned-records.ts` recognizes the older scattered set records, while `migration/migrate-storage-state.ts` combines validated historical sources into current synchronized and local documents. No code infers a document version or identity strategy from the shape or value of an ID.

A retained version-two mapping remains necessary because an offline device can upload its legacy record after another device migrated it. Browser sync exposes no proof that every device has retired its legacy source, so those compatibility mappings cannot be removed automatically. Version-three migrations never create them, and the `migration` object is omitted when no compatibility entries exist.

The generation envelope remains version 3 and uses `savePinnedTabs:index` plus generation-owned chunk keys. Chunks are written and verified before one index write atomically makes the generation active. This envelope version is independent of the document version: it may contain a readable version-two compatibility document or a current version-three document.

Quota accounting is the UTF-8 byte length of each storage key plus `JSON.stringify(value)`, matching browser synchronized-storage accounting for the encoded key and JSON value. The 142-set benchmark compares equivalent version-three documents in the same generation envelope, with and without the historical identity map, and requires a meaningful aggregate reduction.
