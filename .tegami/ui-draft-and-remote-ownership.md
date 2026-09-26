---
packages:
  '@pluxel/workbench': patch
  'valibot-form': major
---

## Acquire remote values only after React commit

`useRemoteValue` no longer starts reads or subscriptions during render. StrictMode replay shares
one owner; dependency changes isolate reads and late subscriptions are released after unmount.
The imperative `createRemoteValue` retains eager acquisition and explicit disposal.

## Type AutoForm options against input drafts

Schema forms now infer Valibot input values instead of transformed outputs. Both form modes
accept typed TanStack options and infer submit callbacks. `submit()` returns its completion
Promise and propagates callback rejection; DOM-submit callbacks remain responsible for displaying failures.
