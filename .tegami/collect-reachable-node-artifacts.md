---
packages:
  '@pluxel/rolldown':
    type: patch
---

## Collect dependency Node artifacts in static applications

Merge immutable Node module and worker artifacts from every package reachable through the bundled
server graph into the static deployment, deduplicate identical artifact keys, and reject conflicting
content or missing referenced keys instead of producing a deployment with unavailable worker tasks.
