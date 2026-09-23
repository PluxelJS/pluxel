# S3 buckets and credentials

## Current state

::slot[status]

Credential rotation is available only for a bucket whose active backend is `remote-vault`. Local and anonymous buckets report `not-applicable` and leave Vault untouched.

## Replace Vault credentials

::slot[rotate]

Choose a configured bucket ID. The form writes a replacement access-key record to that bucket's Vault namespace and key. It does not read or display the previous record, and submitted values are not returned in the action result.

The running plugin observes its credential record and replaces the client used by new requests after a saved update. Existing requests may finish with their previous snapshot. Missing or malformed records reject subsequent client access instead of falling back to anonymous access. Environment and file bindings are read-only; update their source and restart the application to change them.

Initial provisioning remains a deployment operation: when any referenced record is missing or invalid, S3Plugin fails startup atomically and therefore cannot publish this Content.
