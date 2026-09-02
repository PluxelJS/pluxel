# Management authentication plugin design

## Ownership

Runtime owns the control WebSocket, physical peer/TLS facts, pre-auth quotas, Cap’n Web target admission and the three exact unauthenticated HTTP routes. `@pluxel/auth` is an ordinary generation-owned provider registered through `ctx.managementAccess.provide()`.

The plugin owns credential verification, OIDC, opaque browser sessions, one-use cookie commits, login failure state and credential persistence. It does not own the listener, Workbench root, Management operations or generic HTTP routing.

## Provider state machine

`open(request, context)` returns one disposable session:

```text
valid session cookie -> authenticated
password             -> password submit -> authenticated
password-totp        -> password submit -> TOTP submit -> authenticated
oidc                 -> fixed navigation path -> callback -> new document
unready/withdrawn    -> access_unavailable
```

Password submit accepts only the exact `{ password: string }` record. TOTP submit accepts only `{ code: string }`. A session has a two-minute deadline, becomes terminal after success/failure, and implements idempotent `[Symbol.dispose]`. It retains no password, TOTP code or raw token.

Successful password/TOTP authentication creates the principal authority for the current socket and a separate 60-second commit ticket. The ticket is random, digest-keyed, single-use and bound to secure/local cookie kind. Expired or evicted tickets remove their otherwise unreachable session. Cookie commit accepts a bounded same-origin JSON POST and returns only an empty status plus `Set-Cookie`.

The optional provider-session `logout()` revokes the captured or newly-issued server session before returning a 60-second, single-use clear-cookie ticket. Runtime sends that result over Cap’n Web and closes the complete socket epoch. Clearing the HttpOnly cookie reuses `commitCookie`; there is no logout HTTP route and a skipped clear commit cannot restore the revoked session.

## HTTP boundary

Provider HTTP methods are capability-specific, not a generic router:

- `oidcStart` serves only the fixed authorization navigation path;
- `oidcCallback` consumes the fixed callback;
- `commitCookie` consumes a single-use commit ticket.

They cannot return access state, layout, Management data or capabilities. Password/TOTP login, HTTP logout/setup, generic `handle()`, HTTP authorization and bearer authentication do not exist.

## Workbench setup boundary

The browser-safe `@pluxel/auth/workbench` entry exports the exact `AuthWorkbench.setup` Direct View descriptor and its input/result
types. The owning Plugin publishes that View at `/auth/setup`; no Runtime setup resource, generic capability registry or second transport
exists. Each open creates a fresh `AuthSetupTarget` and `CredentialProvisioning`, both bound to the open signal and Plugin generation.

`snapshot()` is a closed union over the configured mode and `configured`, `setup-required` or `unavailable` readiness. Mutations require
the Runtime-issued physical-loopback recovery principal and a current `setup-required` snapshot. Remote provider principals are denied,
configured credentials cannot be overwritten, public OIDC accepts no secret, and unavailable Vault state fails closed. Successful mutation
commits the Vault record before updating in-memory readiness, revokes old cookie sessions and returns the resulting snapshot.

TOTP enrollment belongs to one opened target and has bounded count, attempts and lifetime. View close/abort, socket epoch invalidation,
owner stop or replacement disposes every pending enrollment. Failures use the stable `AuthSetupFailureCode` union; raw storage/crypto
errors do not cross the RPC boundary.

The renderer uses one descriptor-bound scope with an owned snapshot query and typed mutation invalidation. Query and mutation resources
detach their RPC results before React observes them. The TOTP enrollment mutation is reset immediately after its detached result is
extracted, so the renderer retains only the local UI draft needed to render the enrollment step; that draft is cleared on step reset,
successful submission, snapshot transition and renderer unmount. A shared client-side gate also prevents credential mutations from
overlapping across separate mutation hooks.

This setup flow remains one Direct View instead of splitting selected modes into Content. The fixed definition covers password,
password-TOTP, public OIDC and confidential OIDC; TOTP must reveal an enrollment secret/provisioning URI and then confirm it against
bounded state owned by the same opened target. A Content split would either expose permanently inapplicable actions or duplicate the
mode/readiness UI and mutation authority. The simpler password and client-secret forms remain steps of this same credential state machine.

## Credential and lifecycle rules

Vault records remain versioned `management-account-v1` and `oidc-client-secret-v1` values. Password verification uses bounded async scrypt. TOTP verification serializes record mutation and persists `lastAcceptedCounter` before success. OIDC uses Authorization Code + PKCE with bounded discovery/token/JWKS IO.

Credential provisioning remains a transport-free domain service behind the setup target, with password setup, bounded TOTP
enrollment/confirmation and confidential client-secret mutation. A headless distribution has neither the View nor another provisioning API:
it must use public OIDC, start with a pre-provisioned Vault record, or reuse persistence configured by a Workbench-capable deployment.

All sessions, tickets, challenges, enrollments, rate limits and OIDC pending/cache state belong to one Plugin generation. Stop, replacement or rollback withdraws the provider and clears them deterministically.
