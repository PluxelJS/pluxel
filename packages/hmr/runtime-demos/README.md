# Runtime demos

This folder contains runtime-loadable demo plugins (not tests).

How to use:

1. Start HMR: `pnpm --filter @pluxel/plugins-host hmr` (or `pnpm --filter @pluxel/hmr hmr`)
2. Open the plugins page in the UI
3. Enable demo plugins and use the **依赖注入** panel:
   - Base providers: `DemoClock.System` / `DemoClock.Fixed` + `DemoClockConsumer`
   - Forks: `DemoWorker` + `DemoWorkerConsumer`
