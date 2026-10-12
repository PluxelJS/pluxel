# Typst native navigation binding

This directory owns a small patch to the Typst 0.7 Node binding. `NodeTypstDocument.navigation()` extracts source ranges, page coordinates and heading positions from the **same compiled document** used for vector/PDF export. It neither compiles a second document nor starts a server. The remaining upstream API is unchanged.

`source_map.rs` implements navigation and physical page metadata; `page_render.rs` renders retained pages to PNG with Typst’s native rasterizer. `compiler.patch` only registers that module and adds its direct Typst, typst-render and tiny-skia dependencies (including the lockfile entry). Upstream is pinned to `Myriad-Dreamin/typst.ts` commit `0501ced21131dccc68d12c5602cdb20909a52541`; dependencies use its committed Cargo lockfile. Upstream licenses remain in the downloaded source checkout.

## Build

Install Git, Rustup with Rust **1.97.1**, and the native C/C++ linker for your platform. Windows requires the Visual Studio C++ build tools and the MSVC Rust toolchain. Then run:

```sh
rustup toolchain install 1.97.1 --profile minimal
node plugins/render/typst/native/build.mjs
```

Build on the target platform and architecture. The script runs `cargo +1.97.1 build --release --locked -p typst-ts-node-compiler` and installs `native/compiler.node`. Missing prerequisites or failed compilation are errors; there is no fallback to a different compiler. The package build must invoke this preparation before packaging its native artifact.

The private `.build/source` checkout is reset to the pinned revision on a rebuild. `.build/target` is the default Cargo cache; set `CARGO_TARGET_DIR` to reuse another persistent cache. `CARGO_BUILD_TARGET` cross compilation is intentionally rejected. The script skips compilation only when the platform, architecture, source/patch/build-script fingerprint and output artifact hash match its stamp. After an interrupted build, remove `.build/build.lock` if it remains.

Do not commit native binaries, build caches or machine-specific stamps. Each platform's CI builds its own artifact; distributing a package includes the resulting `compiler.node`.

## Navigation contract

The returned JSON has `points`, `outline` and `pages` arrays. Source paths are slash-separated relative paths inside the compiler workspace; package and outside-workspace sources are excluded, as are generated `inputs/` files. Callers should additionally restrict navigation to files present in their workspace snapshot.

Point source ranges use **1-based lines and UTF-16 columns**, with exclusive end positions. Page numbers are 1-based. `x`, `y`, `width`, `height` use Typst points in page coordinates. Nested group transforms are applied to all four corners and reported as axis-aligned bounds. Text uses glyph advance bounds; images and shapes use their layout geometry. These are navigation hit areas, not pixel-accurate glyph outlines. Generated content without a resolvable source span has no point. One source expression can produce multiple points/pages.

The mapping has a hard limit of 200,000 points. Exceeding it throws an explicit error; a partial mapping is never returned as success. Outline entries contain the compiler's heading title, level and page position.

## Retained page images

`NodeTypstDocument.renderPage(page, scale, region, maxBytes)` renders an existing page and returns PNG bytes, pixel dimensions and the actual pixel-aligned region in points. It uses `typst-render` and `tiny-skia`, already present in the pinned dependency graph. No compiler is invoked. Cropping follows full-page rasterization, preserving page-relative gradients and backgrounds exactly. Scale is positive and at most 8; even a crop requires the full raster to fit 8192 pixels per side and 16 million pixels total. Encoded PNG bytes have the caller's output limit. Public session error and cancellation semantics are documented in the plugin usage documentation.
