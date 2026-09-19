# @pluxel/logging

Explicit Host logging with one process owner, Core Context identity, bounded stores, dynamic Plugin policy, and console/file/custom sinks.

Install with `logging(plan, { policyStore })` in `createHost({ services })`; inspect the selected manager through `host.ctx.logging`.
Policy storage is optional and borrowed. Fork removal clears durable logging metadata through the Host service lifecycle.
Browser clients import DTOs and filters from `@pluxel/logging/protocol`.
Manager construction, active-owner lookup, and Context binding belong to the framework-only `@pluxel/logging/internal` entry; applications install the Host service.

See [logging](../../docs/runtime/logging.md) and [engineering constraints](../../engineering/LOGGING.md).
