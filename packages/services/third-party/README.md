# Bundled filesystem sources and notices

Services bundles the patched ZenFS runtime and declarations, together with the dependencies below.
The public `/fs` and `/fs/browser` backend values belong to this copy; independent installations
need no ZenFS dependency or pnpm patch configuration. Original notices and package metadata are
included in the matching directories. Services changes to ZenFS are dated 2026-10-30 and recorded
in the two accompanying `patches/` files; the other dependencies are unmodified.

| Package          | Version | License           | Published source                                                                  | Upstream source commit                                                                                  |
| ---------------- | ------- | ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@zenfs/core`    | 2.8.3   | LGPL-3.0-or-later | [npm tarball](https://registry.npmjs.org/@zenfs/core/-/core-2.8.3.tgz)            | [ecb25b1bfd81](https://github.com/zen-fs/core/tree/ecb25b1bfd81879ef79052156c0171f215117b59)            |
| `@zenfs/dom`     | 1.2.14  | LGPL-3.0-or-later | [npm tarball](https://registry.npmjs.org/@zenfs/dom/-/dom-1.2.14.tgz)             | [cfa7d8b4ef55](https://github.com/zen-fs/dom/tree/cfa7d8b4ef556056a8f4545311f2b199e39c9434)             |
| `@zenfs/streams` | 1.0.2   | LGPL-3.0-or-later | [npm tarball](https://registry.npmjs.org/@zenfs/streams/-/streams-1.0.2.tgz)      | [15c475f90f24](https://github.com/zen-fs/streams/tree/15c475f90f24496e7c67cde2a1cec5b55ae88837)         |
| `kerium`         | 1.5.0   | MIT               | [npm tarball](https://registry.npmjs.org/kerium/-/kerium-1.5.0.tgz)               | [1e6b82a77e2d](https://github.com/james-pre/kerium/tree/1e6b82a77e2d30b858353bbb8bc0b08ba082e7dc)       |
| `utilium`        | 3.10.0  | LGPL-3.0-or-later | [npm tarball](https://registry.npmjs.org/utilium/-/utilium-3.10.0.tgz)            | [fdafcec21132](https://github.com/james-pre/utilium/tree/fdafcec2113236810b0a4e1c9a3d5320c5a84628)      |
| `memium`         | 1.1.1   | LGPL-3.0-or-later | [npm tarball](https://registry.npmjs.org/memium/-/memium-1.1.1.tgz)               | [47ceb1d05e31](https://github.com/james-pre/memium/tree/47ceb1d05e31923feac7d0289b81eed1507134b5)       |
| `eventemitter3`  | 5.0.4   | MIT               | [npm tarball](https://registry.npmjs.org/eventemitter3/-/eventemitter3-5.0.4.tgz) | [b0144e940ace](https://github.com/primus/eventemitter3/tree/b0144e940ace8add8f335a8adfbed9284eb419f3)   |
| `buffer`         | 6.0.3   | MIT               | [npm tarball](https://registry.npmjs.org/buffer/-/buffer-6.0.3.tgz)               | [f52dffd9df04](https://github.com/feross/buffer/tree/f52dffd9df0445b93c0c9065c2f8f0f46b2c729a)          |
| `base64-js`      | 1.5.1   | MIT               | [npm tarball](https://registry.npmjs.org/base64-js/-/base64-js-1.5.1.tgz)         | [88957c9943c7](https://github.com/beatgammit/base64-js/tree/88957c9943c7e2a0f03cdf73e71d579e433627d3)   |
| `ieee754`        | 1.2.1   | BSD-3-Clause      | [npm tarball](https://registry.npmjs.org/ieee754/-/ieee754-1.2.1.tgz)             | [b60d148be9ca](https://github.com/feross/ieee754/tree/b60d148be9cad718f9ff007c211c2427cdc180a4)         |
| `@noble/hashes`  | 2.4.0   | MIT               | [npm tarball](https://registry.npmjs.org/@noble/hashes/-/hashes-2.4.0.tgz)        | [663c2aeeffc3](https://github.com/paulmillr/noble-hashes/tree/663c2aeeffc308ac0cded59bd32f7c212adacfc2) |

The LGPL components are Copyright © James Prevett and their respective contributors. See their
original `LICENSE.md` and ZenFS `COPYING.md` for the applicable terms and permissions. Other
copyright notices remain in each component's original license. Kerium's published package and
source commit declare MIT but contain no standalone license file; its author metadata and README
are included, with the MIT terms reproduced below.

To rebuild, use the [Pluxel repository](https://github.com/PluxelJS/pluxel), the release's lockfile,
`packages/services/tsdown.config.ts` and these patch files:

```sh
mise exec -- pnpm install --frozen-lockfile
mise exec -- vp run @pluxel/services#compile
```

The fixed upstream npm tarballs above plus the patches reproduce the modified dependency source;
the commit links retain
the original TypeScript source. Patch maintenance and admission checks are documented in
[`patches/README.md`](https://github.com/PluxelJS/pluxel/blob/main/patches/README.md).

When updating this closure, update this inventory and native pack copy list, then run Services'
`test:installed` against real tarballs. It checks independent Node runtime, strict declarations,
browser IndexedDB behavior and notice delivery.

## Kerium MIT terms

Author: James Prevett <jp@jamespre.dev> and contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the “Software”), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
