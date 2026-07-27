---
'@pluxel/commands': minor
---

Add a transport-neutral schema-first command kernel with flat discoverable descriptors, explicit
query/mutation behavior, validated input/output, Agent/MCP tool projection, and strict argv routing.
JSON-backed TypeBox transforms act as private input/output codecs
while descriptors and carriers remain strict JSON. Output is optional for `CommandResult<void>`
commands, input defaults never mask missing handler output, and catalogs remain deterministic.
Argv help derives choices and defaults from command schemas, failed text input carries bounded
correction hints, and invalid schema defaults fail when the command is defined.
The argv router accepts both raw command text and token arrays already split by a CLI runtime.
Bindings use explicit `positionals`, generated `options`, and optional tails; `--` disables option
parsing without skipping pending positionals. Registry and router construction use one public
factory entry each, with their class names retained only as types.
Conventional scalar inputs and trailing prose remain positionals, generated options, and text tails
rather than being reparsed through ParseBox. Shared domain DSLs remain one annotated string contract
and use the existing TypeBox Transform boundary to deliver the application-owned ParseBox mapping
product to execution across Agent, argv, HTTP, registry, and direct calls. Argv may carry that string
through a quoted option or an unquoted text tail without changing the parsing boundary. Input
Transforms preserve deliberate structured validation errors, and parser-only DSLs can retain their
source instead of implementing an otherwise-unused formatter. Text-tail keys are contextually
limited to string wire fields and checked again when bound; JSON tails remain available for every
command field.
