# valibot-form

Valibot schema-driven field planning for software configuration forms.

The package is split into a lightweight core entry and optional UI adapters:

- `valibot-form`: metadata factories, schema metadata reading, and field planning.
- `valibot-form/web`: React form rendering for Mantine-based web apps.

Use the default entry for startup configuration, plugin configuration, CLI prompts, config-file editors, and any environment where you only need to describe or inspect a Valibot schema.

```ts
import * as v from 'valibot'
import * as f from 'valibot-form'

export const configSchema = v.object({
	port: v.pipe(
		v.number(),
		v.minValue(1),
		v.maxValue(65535),
		f.formMeta({ title: 'Port', description: 'HTTP listen port' }),
		f.numberMeta({ step: 1 }),
	),
	mode: v.pipe(
		v.picklist(['development', 'production'] as const),
		f.formMeta({ title: 'Mode' }),
		f.picklistMeta({
			control: 'segmented',
			labels: {
				development: 'Development',
				production: 'Production',
			},
		}),
	),
})
```

`formMeta()` groups `title` and `description` with form presentation preferences. It emits a standard
Valibot `metadata()` action, so schema tooling and the form planner read the same title and description.
Requiredness, choices, formats, and validation bounds still come directly from Valibot schemas and
validation actions. Type-specific metadata factories only add presentation choices such as layout,
placeholders, and control variants.

For renderers or tools, inspect the schema without importing React or Mantine:

```ts
import { extractFormFields } from 'valibot-form'

const fields = extractFormFields(configSchema)
```

Host/build tooling that needs to transport one raw input path can use the same core entry without running validation or defaults:

```ts
import { projectRawInput } from 'valibot-form'

const projection = projectRawInput(configSchema, ['port'])
if (projection.ok) {
	console.log(projection.transport) // number
	console.log(projection.inputDescription) // number (finite, >= 1, <= 65535)
}
```

`projectRawInput()` stays on the pre-transform side of a Valibot schema. It structurally derives `string`, `number`, `boolean`, or `json` transport plus portable descriptions/constraints; it never calls validation, transforms, lazy getters, or default getters. Missing, ambiguous, custom, `unknown`, and otherwise non-unique scalar targets return a discriminated failure instead of guessing a codec.

## Web Adapter

`valibot-form/web` is intentionally optional. It depends on React, Mantine, TanStack Form, Tabler Icons, and dnd-kit through optional peer dependencies.

Install those peers only when using the web adapter:

```sh
pnpm add valibot-form valibot react react-dom @mantine/core @mantine/hooks @tanstack/react-form @tabler/icons-react @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

```tsx
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import { AutoForm } from 'valibot-form/web'

export function ConfigEditor() {
	return (
		<MantineProvider>
			<AutoForm schema={configSchema}>
				<AutoForm.Fields />
				<AutoForm.Actions />
			</AutoForm>
		</MantineProvider>
	)
}
```

## TUI Adapter Direction

A terminal UI should be a separate adapter rather than a replacement for `valibot-form/web`.

Recommended shape:

- Keep `valibot-form` as the shared schema metadata and field planning layer.
- Add a separate package or subpath, for example `valibot-form/tui`.
- Depend on a terminal renderer there, such as Ink for React-style TUIs or a prompt library for simple sequential setup flows.
- Reuse `extractFormFields()` so web, TUI, CLI, and config-file tooling interpret schemas the same way.

This keeps startup configuration lightweight while still allowing richer web configuration screens where Mantine already exists in the host app.
