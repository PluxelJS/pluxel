---
packages:
  '@pluxel/runtime':
    type: minor
  '@pluxel/runtime-static':
    type: patch
  '@pluxel/runtime-dynamic':
    type: patch
---

## Recover failed candidates without mixing runtime and Workbench generations

Prepare Workbench artifacts before catalog acceptance and activate them at the graph commit boundary. Rejected candidates preserve the running generation's Content and producer builds; superseded background validations cannot publish.

Static Vite retains failed-candidate recovery dependencies independently of the committed graph, including new files, missing imports and package installation metadata. Fixing those dependencies automatically retries the candidate and restores dependent plugins.

Management clients can read and subscribe to independent update attempts. Workbench displays batch progress and bounded failure details in its header, preserving the distinction between rejected updates and current plugin health. Revoked Workbench sessions automatically reload the document after cleanup, with a bounded retry interval and manual fallback for repeated refreshes or authentication failures.
