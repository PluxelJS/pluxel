# S3 buckets and credentials

## Current state

::slot[status]

Credential rotation is available only for a bucket whose active backend is `remote-vault`. Local and anonymous buckets report `not-applicable` and leave Vault untouched.

## Replace Vault credentials

::slot[rotate]

Choose a configured bucket ID. The form writes a replacement access-key record to that bucket's Vault namespace and key. It does not read or display the previous record, and submitted values are not returned in the action result.

The running S3 client keeps the credential snapshot loaded at startup. After saving, restart S3Plugin through normal Plugin management so the replacement takes effect. If the replacement is invalid for the configured endpoint, that restart will fail instead of falling back to anonymous access.

Initial provisioning remains a deployment operation: when any referenced record is missing or invalid, S3Plugin fails startup atomically and therefore cannot publish this Content.
