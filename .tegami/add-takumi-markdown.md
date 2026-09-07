---
packages:
  '@pluxel/takumi':
    type: minor
  '@pluxel/takumi-markdown':
    type: major
  '@pluxel/takumi-markdown-typst':
    type: major
---

## Add bounded Markdown and optional Typst math rendering

Add @pluxel/takumi-markdown for GFM document rendering, fixed Rangi code highlighting,
trusted render-local extensions, generated assets, and one final Takumi render after fair
admission. Add @pluxel/takumi-markdown-typst as an optional restricted Typst math SVG extension
that runs formula compilation in the Runtime shared Worker.

Add TakumiPlugin.reserveRender() as the narrow, one-shot document-adapter seam. A reservation
holds caller-aware Takumi admission across bounded preparation and exactly one final render, with
correct capacity ownership through cancellation and non-preemptible native settlement.
