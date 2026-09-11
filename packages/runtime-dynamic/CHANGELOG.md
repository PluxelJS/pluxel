## @pluxel/runtime-dynamic@1.0.1

### Recover failed candidates without mixing runtime and Workbench generations

Prepare Workbench artifacts before catalog acceptance and activate them at the graph commit boundary. Rejected candidates preserve the running generation's Content and producer builds; superseded background validations cannot publish.

Static Vite retains failed-candidate recovery dependencies independently of the committed graph, including new files, missing imports and package installation metadata. Fixing those dependencies automatically retries the candidate and restores dependent plugins.

Management clients can read and subscribe to independent update attempts. Workbench displays batch progress and bounded failure details in its header, preserving the distinction between rejected updates and current plugin health. Revoked Workbench sessions automatically reload the document after cleanup, with a bounded retry interval and manual fallback for repeated refreshes or authentication failures.

## @pluxel/runtime-dynamic@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
