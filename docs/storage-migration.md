# Synchronized storage migration

Legacy tab-set keys are stable identities: each key is the Base64 representation of the set name. Migration hashes that key with Web Crypto SHA-256, uses the first 128 bits, and sets the UUID version and variant bits. SHA-256 and UTF-8 encoding are specified consistently in Chromium and Firefox, so every device derives the same set ID without synchronizing a legacy-key map.

A migration is restart-safe because the derived ID is stable across attempts and the recovered document remains staged in local storage until a complete synchronized generation is verified. A legacy record arriving after migration resolves to the same ID. Exact name-and-tab matches are also recognized, covering records already migrated by older releases.

`migration.legacyIds` remains readable for version-two documents created before deterministic IDs. A retained entry is necessary when an older release assigned a random UUID: it preserves identity if that legacy record arrives on another device. New deterministic migrations do not add these entries. Deterministic entries are discarded during recovery, and the entire `migration` object is omitted when no compatibility entries remain. Non-deterministic compatibility entries cannot be retired automatically because browser sync exposes no proof that every independently syncing device has deleted its legacy source.

Version-four generations use the compact `s:i` index key and `s:<generation>:<chunk>` chunk keys. The index still lists every owned chunk, preserving generation ownership and the atomic switch: chunks are written and verified first, then one index write makes the generation active. Readers continue to accept the version-three `savePinnedTabs:index` format and version-two `savePinnedTabs:sync` documents.

Quota accounting is the UTF-8 byte length of each storage key plus `JSON.stringify(value)`, matching browser synchronized-storage accounting for the encoded key and JSON value. The 142-set benchmark compares the persisted version-four state against the equivalent version-three document with its legacy identity map and requires at least a 10% aggregate reduction.
