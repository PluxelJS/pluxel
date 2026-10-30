# Independent Typst source consumer

This consumer reads ordinary `.typ`, JSON and resource files through the built public source/editor entries. The [source editing guide](../../../../../docs/plugins/rendering/typst-editor.md) owns the API contract.

## Browser playground

From the workspace root:

```sh
mise exec -- vp run @pluxel/plugin-typst#compile
mise exec -- pitchfork start typst
```

Open the registered `http://typst.pluxel.localhost:8088` URL. The Vite consumer uses built package entries. Rebuild after changing the package; page code uses the existing Vite server. The server's compiler is an explicitly isolated public `@pluxel/test` host, not an accessor into a running application. The file-workspace consumer separately demonstrates ordinary Host constructor injection.

The file selector opens one shared source project. Structured editing and source editing change the same `.typ` files; component controls update literal call parameters, JSON controls update the named JSON file. The seed has two body files, a template module, a real JSON-driven chart, figure captions/labels, cross-file references, LaTeX helpers and preserved unknown syntax. It does not store Tiptap JSON or generate body regions.

“保存项目” stores the ordinary text-file table in this browser's localStorage. “重新打开” restores that snapshot; invalid Typst can be saved. Unapplied source/parameter drafts must first be applied or canceled. Storage failures retain the in-memory project and are reported. This browser fixture accepts text resources (including SVG); the core also supports binary files, and the disk workspace owns its own persistence boundary.

Editing is debounced into one existing compiler session per page. Source revision, successful compile revision and displayed preview revision are distinct. Failed compilation keeps the draft, reports the actual diagnostics and marks the old preview; current-only PDF and source navigation remain disabled until it recovers. The server serializes requests and closes its own session on page release. Page/outline/zoom controls use the public preview view.

## Real browser acceptance

Use the user's existing Playwright WebSocket service; this driver never launches a browser or downloads browser binaries:

```sh
cd plugins/render/typst
mise exec -- node tests/consumer/source-check.mjs
```

Optional environment variables: `PLAYWRIGHT_WS_ENDPOINT`, `PLUXEL_TYPST_URL`, `TYPST_SOURCE_EVIDENCE`. The driver validates byte-preserving no-op save, actual Chinese selection/input, `@` completion, rich caption and cross-file label rename, unknown inline source repair, JSON-only changes, invalid source preservation/stale preview/recovery, and save/reopen. It writes desktop/mobile screenshots and JSON results. It explicitly releases only its page's native sessions before closing the shared remote browser connection.

Model and native rendering regressions live in `tests/typst-source-*.test.ts`; selection UI, preview, session, resource and WASM tests remain independent. The previous region-JSON and Markdown candidate drivers were retired with their implementation, not retained as a second body pipeline. Source tests cover their remaining report capabilities.

## Isolated package acceptance

```sh
mise exec -- vp run @pluxel/plugin-typst#compile
mise exec -- node plugins/render/typst/tests/consumer.mjs
```

`acceptance.ts` stages actual dist/native files outside the workspace, expands publish exports and checks phased dependency boundaries, strict declarations, Node/Web source projection, a real headless Editor, React bundling and real native output. It explicitly installs peer dependencies with `npm --legacy-peer-deps --ignore-scripts`; it does not claim registry publishing or every package manager's default peer resolution. The package remains private.

Results and broader ordinary-file round trips are maintained in [the independent workspace](../../../../../projects/typst-agent-workspace/README.md) and its `evidence/source` directory. A test command listed here is not a claim that it passed after every subsequent edit; consult the recorded results.
