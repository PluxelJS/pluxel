## @pluxel/runtime-static@1.0.1

### Restore HMR after installing a missing package

Keep recovery watches active when package resolution searches overlapping ancestor directories, so installing a previously missing dependency automatically retries the failed application update.

### Recover failed candidates without mixing runtime and Workbench generations

Prepare Workbench artifacts before catalog acceptance and activate them at the graph commit boundary. Rejected candidates preserve the running generation's Content and producer builds; superseded background validations cannot publish.

Static Vite retains failed-candidate recovery dependencies independently of the committed graph, including new files, missing imports and package installation metadata. Fixing those dependencies automatically retries the candidate and restores dependent plugins.

Management clients can read and subscribe to independent update attempts. Workbench displays batch progress and bounded failure details in its header, preserving the distinction between rejected updates and current plugin health. Revoked Workbench sessions automatically reload the document after cleanup, with a bounded retry interval and manual fallback for repeated refreshes or authentication failures.

### Recover Workbench definition hot updates across edits, failures and file replacement

Refresh standalone Workbench definitions and imported helpers within the same semantic generation as Plugin facts. Reject superseded transforms, discard failed parsing work, withdraw deleted publications, and preserve committed facts when a candidate is rejected. Generated Bridge and renderer projection files now use revision-specific paths.

Static Vite development handles file creation and deletion through the same update queue as edits, allowing recreated definitions and their dependent plugins to recover without restarting dev.

## @pluxel/runtime-static@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
