---
packages:
  '@pluxel/services': major
  '@pluxel/workbench': major
  '@pluxel/auth': major
  '@pluxel/wretch': major
  '@pluxel/fonts': major
---

## Make pure-data RPC contracts explicit

Management, Workbench and official Plugin RPC methods that return data or receipts now use `*Dto`.
This includes authentication `stateDto`/`submitDto`, session `logoutDto`, Workbench `layoutDto`,
Content `subscribeDto`/`loadDto`/`runDto`, and Plugin `snapshotDto` and data-returning mutations.
Void commands, capability acquisition, subscriptions returning handles, mixed bootstrap/open results,
local Plugin methods and local client facades retain their domain names. No previous RPC names remain
as aliases. Management protocol major is now 7 and the session profile is 2; clients and servers must
be deployed together.

Producers validate their DTO output with existing domain parsers or the new
`assertWorkbenchDto()` from `@pluxel/workbench/server`. The assertion checks bounded pure data without
copying, freezing, disposing or changing its identity; clients continue to validate and own received
values. Content subscription registration remains owned by its root even though `subscribeDto`
returns the initial data snapshot.

RPC targets keep internal lifecycle and implementation helpers off their remotely callable surface.
Author examples, UI consumers, tests and API documentation use the same contracts.
