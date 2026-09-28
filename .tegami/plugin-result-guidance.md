---
packages:
  '@pluxel/auth': patch
---

## Preserve unexpected credential hashing failures

Credential setup returns expected input and hashing-capacity failures through its existing DTO codes.
Unexpected crypto failures now reject with a safe diagnostic message instead of claiming the password
is invalid; credentials are neither persisted nor applied. The setup RPC boundary strips diagnostic
causes from unexpected mutation rejections while preserving the existing expected-failure DTOs.
Plugin author guidance and executable
official-plugin examples explain selective Better Result adaptation and transport/resource boundaries.
