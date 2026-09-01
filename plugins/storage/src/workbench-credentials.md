# S3 credentials

## Current state

::slot[status]

Credential rotation is available only when the active backend is `remote-vault`. Local and anonymous providers report `not-applicable` and leave Vault untouched.

## Replace Vault credentials

::slot[rotate]

The form writes a replacement access-key record to the configured Vault namespace and key. It does not read or display the previous record, and submitted values are not returned in the action result.

The running S3 client keeps the credential snapshot loaded at startup. After saving, restart this S3 Plugin generation through normal Plugin management so the replacement takes effect. If the replacement is invalid for the configured endpoint, that restart will fail instead of falling back to anonymous access.

Initial provisioning remains a deployment operation: when the referenced record is missing or invalid, the S3 Plugin fails startup and therefore cannot publish this Content.
