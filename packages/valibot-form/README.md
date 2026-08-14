# valibot-form

Valibot schema metadata for software configuration forms.

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
		f.formMeta({ label: 'Port', description: 'HTTP listen port' }),
		f.numberMeta({ step: 1 }),
	),
	mode: v.pipe(
		v.picklist(['development', 'production'] as const),
		f.formMeta({ label: 'Mode' }),
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

For renderers or tools, inspect the schema without importing React or Mantine:

```ts
import { extractFormFields } from 'valibot-form'

const fields = extractFormFields(configSchema)
```

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
