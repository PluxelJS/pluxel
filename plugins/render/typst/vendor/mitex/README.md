# MiTeX 0.2.7

The editor's generated formula resources contain the fixed MiTeX 0.2.7 runtime from
[Typst's package registry](https://packages.typst.org/preview/mitex-0.2.7.tar.gz),
licensed under Apache-2.0. The package authors are Myriad-Dreamin, OrangeX4,
Enter-tainer, and Shichien; upstream is <https://github.com/mitex-rs/mitex>.

The archive SHA-256 is
`0159e214845e49cbdc332d9d572da112dae5ad248072e0a7680d38c8307c2e15`.

`src/tiptap/mitex-files.json` contains the runtime source, unchanged WASM bytes,
license, and notice. The only upstream source adaptation replaces
`plugin("./mitex.wasm")` with `plugin(bytes(json("mitex.wasm.json")))`. Encoding
the WASM as a JSON byte array keeps the existing synchronous, text-only generated
file contract in both native and browser WASM compilation. Runtime compilation
does not fetch packages or initialize a separate JavaScript converter.

Regenerate the checked-in resource map from the verified archive:

```sh
mise exec -- node plugins/render/typst/vendor/mitex/generate.mjs
```

This maintainer operation requires network access and `tar`; normal builds do
not. Both the package bundle and generated template files retain the license and
notice. Formula-free documents do not need these generated template resources.

The template owns `math.equation` numbering, supplements, and mathematical fonts.
The browser compiler needs the host to load a suitable math font and the template
to select its actual family name. KaTeX and MiTeX share LaTeX input, but do not
promise identical command or macro support.
