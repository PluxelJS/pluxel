# Pluxel Projects

`projects/` contains product-scale validation, not the shortest onboarding path. Each project has a
different role:

| Project                | Level                          | Purpose                                                                                                         |
| ---------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `chatbots`             | Advanced reference application | Plugin graph, optional platform capabilities, lifecycle cleanup, domain persistence and management projections. |
| `external-api-gateway` | Vertical solution              | External tool protocol, providers, billing, Vault and public API integration.                                   |

For a new application, generate the canonical monorepo starter instead:

```bash
pluxel new --template app-monorepo --name @acme/my-app
```

The starter is intentionally smaller than these projects and is verified as a standalone
consumer. Product projects may contain domain-specific tradeoffs and should not be copied as a
whole.
