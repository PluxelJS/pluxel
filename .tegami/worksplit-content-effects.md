---
packages:
  '@pluxel/workbench':
    type: patch
  '@pluxel/services':
    type: patch
  '@pluxel/plugin-wretch':
    type: patch
---

## Settle Shell content resources through Worksplit effects

Use one content hook for editing decisions and one effect lifetime for each View or Content
activation. Remove the document resource registry and replay-specific activation retention;
preserve editing revisions and the SDK's Bridge-before-handle release order. Programmatic close
receipts and native UI issues each have one reporting owner. Tool admission preflight no longer
triggers live tab save callbacks.

Keep browser-only management and Shell Host types as erased imports so the rebuilt browser
entry does not evaluate the Node-only Host loader.

Read the current validated Shell manifest on each navigation so rebuilding its assets does not
leave an existing HTTP handler serving deleted chunk names.

Record Wretch's existing TinyBase peer version in its generated publication metadata so the
installed package declaration matches the artifacts used by the Host.
