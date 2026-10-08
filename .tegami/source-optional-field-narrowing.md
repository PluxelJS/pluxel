---
packages:
  '@pluxel/host': patch
  '@pluxel/services': patch
  '@pluxel/workbench': patch
---

# Compile source consumers with either optional-property mode

Narrow optional addresses and federation references by their values so source consumers and generated Workbench declarations also compile without `exactOptionalPropertyTypes`. Omit unspecified picklist labels from the portable presentation data while preserving supplied labels.
