---
packages:
  '@pluxel/plugin-wretch': major
  '@pluxel/plugin-fonts': major
  '@pluxel/create': minor
---

## Persist official plugin preferences through Host TinyBase

Wretch managed settings now use one provider-owned TinyBase Store with separate
consumer rows. Saves and resets wait for Host `flush()` before applying settings;
the provider serializes all row commits and rejects further saves after a backing
failure. `WretchSettingsCleanupError` identifies cleanup failure after a setting
was already saved and applied.

Fonts stores its default-family preference in the provider Store and publishes
the selection after `flush()`. Font binaries and their atomic resource envelopes
continue to use FS. Headless core font and HTTP capabilities still run without
optional services.

Managed HTTP settings and font preferences now require the TinyBase service and
the exact shared TinyBase peer version. Host standard services include it. Remove
the old per-consumer JSON settings and default-font JSON storage paths; existing
data requires an explicit offline conversion, with no startup migration or dual
reader.

Generated Todo plugins use a native TinyBase table, validate restored data, keep
empty collections empty across restart, and let Host autosave synchronous domain
mutations. Their tests and the required HTTP consumer install the state service
explicitly.
