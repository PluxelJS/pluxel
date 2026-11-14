---
packages:
  '@pluxel/plugin-auth': minor
  '@pluxel/plugin-canvas': minor
  '@pluxel/plugin-echarts': minor
  '@pluxel/plugin-fonts': minor
  '@pluxel/plugin-invoice': minor
  '@pluxel/plugin-playwright': minor
  '@pluxel/plugin-takumi': minor
  '@pluxel/plugin-takumi-markdown': minor
  '@pluxel/plugin-wretch': minor
---

# Publish generated Plugin control entries

Export `./control` alongside the implementation and record its generated manifest
in `pluxel.control`. Scripts can import pure descriptors, original public class
types and configuration input/output types with readable Schema source
descriptions. Published exports include the same control entry. The actual
material is generated and verified by the normal Plugin build pipeline.
