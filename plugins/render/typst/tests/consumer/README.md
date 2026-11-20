# Independent Typst editor consumer

This consumer reads ordinary `.typ`, JSON and resource files through the built public source/editor entries. The [source editing guide](../../../../../docs/plugins/rendering/typst-editor.md) owns the API contract.

## Browser playground

From the workspace root:

```sh
vp run @pluxel/plugin-typst#compile
vp exec pitchfork start typst
```

Open the registered `http://typst.pluxel.localhost:8088` URL. The Vite consumer uses built package entries. Rebuild after changing the package; page code uses the existing Vite server. The server's compiler is an explicitly isolated public `@pluxel/test` host, not an accessor into a running application. The file-workspace consumer separately demonstrates ordinary Host constructor injection.

The server-side package entries are loaded by Node with the Vite configuration. After rebuilding those artifacts, use `pitchfork restart typst` to load the new package bytes; this consumer has `scripts: false`. Ordinary page and stylesheet edits use Vite HMR.

The playground declares `color-scheme: light dark` and follows the system theme. Editor controls and page surfaces share that scheme; the rendered document keeps its original colors on white paper. Hosts can explicitly choose light or dark through their document's `color-scheme`.

All three examples share the [playground](http://typst.pluxel.localhost:8088). One Worksplit owns the left border tools, editing tabs and neighboring preview group. **文件** shows the `report` and `application-form` folders; **章节** opens the project-book navigator. Switching tools or examples keeps the URL, document client, edited tabs and drafts. Clicking an unedited file or chapter reuses its temporary editor tab; editing keeps it so the next item opens in another tab. Selecting an editing tab reveals its navigator and matching preview. Source and document previews occupy the same right-hand group as separate native tabs. Native tab selection, closing, dragging, splitting and maximizing retain their Worksplit semantics. Each source folder retains its own project and edit history. The report keeps the `typst-source-project-v2` save key; the application form keeps `typst-source-application-v1`. Saving and reopening act on the current folder or document.

The host in `main.tsx` creates and starts the session before binding `<Workbench instance>`, and owns final disposal on page/HMR teardown. Each persistent editor declares `useContentController` for title, focus, save and token-bound departure decisions; ordinary effects borrow `useContent()` and `runEffect`. Shared source projects and `DocumentClient` still own drafts, file history, save checkpoints and private-document request ordering. Native `createLink` resolves chapter targets lazily from the captured source; adjacent previews use `reveal` and do not request editor focus. This consumer does not attach browser history, persist native layouts or use SplitView. The exact source revision, dependency corrections and actual-host results are recorded in [the migration record](../../../../../engineering/records/worksplit-adoption.md).

### Chapter book

Open **分章项目书** from **章节**. Edit rich text, tables, native Typst formulas and captions, insert references, or create and reorder chapters. **Typst 源码** reads the selected chapter and **应用源码** submits it through the same revision-checked edit path. An edit updates the chapter file and project history. Undoing a chapter creation returns to an existing chapter so redo remains available. Pending inputs in this project govern its save and PDF actions.

`document-private/project.ts` reads individual chapters with `parseTypstDocument()` and accepts both input forms through `printTypstDocument()`. References carry their actual Typst labels. The demo's same-origin session action `source` accepts `{ chapterId, baseRevision }` and returns `{ source, revision }`. The `edit` action accepts `{ chapterId, baseRevision, content }`. For a source view or Agent the content is `{ kind: 'typst', source }`. For rich text it is `{ kind: 'tiptap', document }`. This wire belongs to the demo host. [Session and result types](document-contract.ts)

`document-private/server.ts` opens the fixed template once per compiler session and passes `/inputs/chapters.json` and `/inputs/chapters/<id>.typ` with each layout update. It filters real source spans to exposed chapters and returns page PNG URLs and the current navigation. Links and their targets come from the same compile, and the preview pauses location tracking while its geometry is stale. PDF download uses the same successful revision's native PDF with text and links. The demo publishes an approved vector edition of the illustration at `/body-assets/architecture.svg` and includes that edition in the PDF. Host configuration determines permission to use original assets or published editions.

Local drafts survive requests in flight. The page lease is distinct from the document ID stored in localStorage. A save compares the lease's stored base version with the current version and atomically publishes a directory of ordinary `chapters/*.typ` files and `chapters.json`. A conflicting save leaves the published files intact. Reload reads those chapter files through a new lease. The service owns a temporary directory and clears it at shutdown. A host can instead provide durable application storage and enforce its own authorization.

### Complete source workspaces

The application example keeps its supplied `main.typ` read-only and opens `data/application.json` for filling. This tracked fixture is a blank initial input: `applicationType` is `new`, and the other six fields are empty strings. Its host-owned `ApplicationForm` supplies ordinary text, multiline text, single choice and date controls. Text edits commit on blur or single-line Enter, with one project history entry per field; multiline Enter stays a newline and Escape discards the current draft. Choosing an application type commits immediately. Saving or switching examples after a blur uses the accepted project state. Draft conflicts remain visible instead of overwriting an external revision.

The supplied fixed form keeps A4, 15mm margins, the four-column structure and blank space for short responses. Its two long cells reserve minimum space and use normal table continuation when content grows. The original fractional rows could compile successfully while long text overlapped later cells; native probes therefore check actual pages and rendered content as well as compile success. Chinese paragraphs and blank lines preserve their content across pages. Very long unbroken ASCII strings, or extreme student-ID/date strings entered through source, can still overflow horizontally without a native warning. Field lengths and further typography rules remain application/template decisions; this sample does not silently truncate stored text or add invisible characters.

The explorer shows actual `.typ`, JSON, library and resource paths, with read-only files marked in the tree. The supplied templates and component definitions retain their filling permissions; the report opens the analysis, actions and appendix body files and business JSON. The template fixes one metrics instance while the body freely composes another instance of the same component. Inline fields, fixed regions and charts read the same JSON data.

Use **新建文件** to enter a root-relative path such as `sections/chapter.typ`. Enter creates an empty editable `.typ` file in the current folder; nested directories follow its path. Creation is one undoable project transaction, preserves previous history and rejects duplicate or invalid paths. Type content and include the chapter from an editable body file through the existing path completion. The folder's `main.typ` document preview opens in the neighboring group automatically, preserving the complete layout while editing a chapter. There is no separate preview-entry selection. Saved file snapshots include created files; reopening reconstructs their writable status from the host's authored/new-file boundary. Reload starts at the report's default file. The consumer is a desktop workspace. Worksplit keeps the same file tool and tab groups when the viewport changes; the host does not automatically maximize groups or collapse panels at screen breakpoints.

Structured editing and source editing change the same `.typ` files. Component controls update literal call parameters; this consumer supplies a custom title/color form through `renderComponentParameters`, while the editor retains apply/cancel, source admission and history. Data controls default to read-only. This playground explicitly opens its whole business JSON through `editableFields: [{ file: 'data/sales.json', path: [] }]`; filling apps can list individual fields instead. Those controls update their own file, including when shown inside a read-only template, and cannot override file or view writability. Figure captions/labels, cross-file references, LaTeX helpers and preserved unknown syntax remain ordinary project source. It does not store Tiptap JSON or generate body regions. Saved projects use the `typst-source-project-v2` localStorage key for this example; previous example saves are left untouched.

Static imports have compact native rows with editable module/binding controls and links to project modules. The insert and slash menus offer two fixed actions: import definitions or include a chapter. Both use a relative path input with immediate directory completion and optional import bindings. Enter or a click opens a directory or inserts the chosen file immediately; Tab only completes the path and leaves the form available for configuration. Static includes remain movable native rows; the chapter stays in its own file and appears in the compiled preview. `sections/appendix.typ` is an editable independent chapter for trying include. Imports, chapters, component parameters, data fields and source repair share floating forms, keyboard behavior and theme; scalar fields accept ordinary values without JSON quoting. Unapplied file-source and parameter drafts stay with their retained editor tabs. A floating form hides with its owner and restores its draft when that tab is selected again; it does not block opening another file. Saving and PDF export require the relevant project's inputs to be applied or canceled, including portaled controls. Preview text clicks focus and scroll the matching source selection, also across files or from source mode.

Clicking structured body text also reveals and highlights its compiled preview without moving editing focus or changing the active tab. The current caret is followed after a new compilation and when the preview pane becomes visible; “跟随光标” can disable automatic following. Fields locate their native call span. Components whose rendered output only retains definition spans explicitly report unavailable instance navigation. Imported library files and resources keep their actual paths in the file tree and routed editor tabs.

“保存项目” stores the ordinary text-file table in this browser's localStorage. “重新打开” restores that snapshot; invalid Typst can be saved. Unapplied source/parameter drafts must first be applied or canceled. Storage failures retain the in-memory project and are reported. This browser fixture accepts text resources (including SVG); the core also supports binary files, and the disk workspace owns its own persistence boundary.

Each mounted project preview owns one debounced compiler session, shared by that project's editor tabs. Switching editor tabs preserves the preview and session; closing the preview or leaving the page releases its session. Source revision, successful compile revision and displayed preview revision are distinct. Failed compilation keeps the draft, reports the actual diagnostics and marks the old preview; current-only PDF and source navigation remain disabled until it recovers. The server serializes requests and closes its own session on page release. Page/outline/zoom controls use the public preview view.

## Real browser acceptance

Use the user's existing Playwright WebSocket service; this driver never launches a browser or downloads browser binaries:

```sh
cd plugins/render/typst
vp exec node tests/consumer/source-check.mjs
```

Optional environment variables: `PLAYWRIGHT_WS_ENDPOINT`, `PLUXEL_TYPST_URL`, `TYPST_SOURCE_EVIDENCE`. The driver validates native import edits/insertion/module links, byte-preserving no-op save, actual Chinese selection/input, `@` completion, rich caption and cross-file label rename, unknown inline source repair, JSON-only changes, invalid source preservation/stale preview/recovery, and save/reopen. `preview-navigation.mjs` clicks real SVG and editor text in both directions, checks the actual native rectangle/page, focus and visibility, repeats the same caret click, toggles following and checks automatic following after compilation and undo. Theme checks switch system preferences and explicit host overrides without reloading, measure key UI text contrast, and capture light/dark desktop views, floating forms and source/template inputs. Preview paper stays white. It writes screenshots and JSON results, and explicitly releases only its page's native sessions before closing the shared remote browser connection.

`source-file-check.mjs` exercises directory navigation, Tab completion followed by configuration and cancel, a single Enter on a file candidate, a file click and Enter on a complete path. Each confirmation must insert once without another button click. It verifies actual native imports/includes, the new chapter in the native outline, opening the original editable file and one undo restoring every original file byte.

`source-controls-check.mjs` checks repeated triggers, draft preservation, exclusive popups, Tab dismissal, explicit focus return and synthetic composition guards. This tests event handling, not an operating system input method. `parameter-check.mjs` temporarily mounts the ordinary public editor from `parameter-fixture.tsx` without a custom parameter renderer, then verifies numeric zero, empty numeric input, boolean/string defaults and byte-preserving undo. The temporary editor is disposed before the remaining main-page checks.

`field-check.mjs` uses a fixed-template fixture to verify default display-only fields, explicit field/subtree/whole-JSON editing, derived array lengths, read-only data inspection, file/view writability overrides and byte-preserving undo. It exercises ordinary React props on the public editor and disposes its temporary view after checking desktop/mobile presentation.

`application-check.mjs` opens the real application folder through the file tree, fills all controls, verifies a focused field commits before a single save click, checks field-level undo/redo, source preservation, literal special characters and multiline input, native continuation, PDF download, save/reload, example storage isolation and light/dark desktop presentation. The native application regression reads the same authored files and distinguishes short one-page forms from long content that must continue onto additional pages.

`workspace-check.mjs` checks native temporary-tab reuse, edited-tab retention and floating draft preservation when opening another file, creates and edits actual chapter files, includes them through path completion into the complete main document, checks project history, validates rejected paths, and saves/reloads the ordinary files. It also drags native tabs into a split and back and verifies unchanged source bytes.

`document-check.mjs` drives the chapter book through its rendered controls. It exercises source and rich-text edits, native formulas, stable references, concurrent typing, chapter history, and save/reopen. It checks real PNG changes, bidirectional location tracking, link hit areas, and PDF download, and inspects public responses, published assets and rejected private routes. Run it with `vp exec node plugins/render/typst/tests/consumer/document-check.mjs` from the workspace root. The `typst-document-codec`, `typst-document-project`, `typst-document-native` and `typst-document-service` suites cover strict conversion, chapter history, actual dynamic-source navigation and competing saves.

Complete source editing and native rendering have regressions in `tests/typst-source-*.test.ts`. Selection UI, preview, session, resource and WASM each have focused tests.

## Isolated package acceptance

```sh
vp run @pluxel/plugin-typst#compile
vp exec node plugins/render/typst/tests/consumer.mjs
```

`acceptance.ts` stages actual dist/native files outside the workspace, expands publish exports and checks phased dependency boundaries, strict declarations, Node/Web source projection, a real headless Editor, React bundling and real native output. It explicitly installs peer dependencies with `npm --legacy-peer-deps --ignore-scripts`; it does not claim registry publishing or every package manager's default peer resolution. The package remains private.

Results and broader ordinary-file round trips are maintained in [the independent workspace](../../../../../projects/typst-agent-workspace/README.md) and its `evidence/source` directory. A test command listed here is not a claim that it passed after every subsequent edit; consult the recorded results.
