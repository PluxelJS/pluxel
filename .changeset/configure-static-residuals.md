---
'@pluxel/rolldown': minor
---

Allow frozen Node applications to declare residual packages and packages that require full tracing.
Resolve declarations from the application root so native loaders and other runtime-only
`createRequire()` dependencies are copied even when they are absent from the ESM module graph.
Preserve NFT-selected files for workspace-linked packages while recording them in the deployment
manifest like ordinary installed residual dependencies.
