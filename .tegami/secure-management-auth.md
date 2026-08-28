---
packages:
  '@pluxel/auth':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-static':
    type: major
  '@pluxel/create':
    type: patch
---

## Protect Management with an official authentication provider

Add the official Auth Plugin with mutually exclusive OIDC, password, and password plus TOTP modes.
The provider is owned by the normal Plugin lifecycle and protects Workbench, Management APIs, and
Security for every peer once ready; while it is absent or unready, only the physical loopback peer
can recover and remote access fails closed with SSH guidance.

Listen on `0.0.0.0` by default in production templates and support direct TLS termination through
paired inline-PEM or PEM-file-path certificate/key inputs with an optional private-key passphrase.
Reject insecure remote authentication entry requests before invoking providers, and give provider
authorization callbacks a body-free request view so Management operation payloads remain owned by
their target handlers.
