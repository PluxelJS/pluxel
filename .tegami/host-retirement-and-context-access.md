---
packages:
  '@pluxel/context': major
  '@pluxel/core': major
  '@pluxel/host': major
  '@pluxel/services': major
  '@pluxel/rolldown': major
  '@pluxel/test': major
  '@pluxel/cli': patch
---

## Complete Host ownership and retire the Runtime package

HostApplication is the single application contract for development and production. Environment facts
move to @pluxel/host/environment; applications explicitly select configuration and Vault deployment
inputs with `envBinding()` and `fileBinding()`. Production launchers use Host plus explicitly composed
HTTP services. The Runtime package,
its parallel Vite driver, production adapters, toolchain aliases and author barrels are removed.

RootContext.require accepts installed root/all capabilities; owner Context.require accepts owner/all
capabilities. Root references carry root authority and are not a sandbox. The development console can
therefore use dev.ctx.require without a separate service resolver or a new require namespace.

Management commands are an explicit @pluxel/services/management/commands service installed by servicesPreset.
Generic Commands and standardServices keep an initially empty command catalog. Regression suites,
benchmarks and type probes now live with their owning packages; test hosts use actual Host service plans.

The CLI no longer installs Workbench as an unused direct dependency; applications select it through
their own service composition.
