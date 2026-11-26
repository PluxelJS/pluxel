# valibot-form

Valibot schema-driven field planning for software configuration forms.

The package is split into a lightweight core entry and optional UI adapters:

- `valibot-form`: metadata factories, input projection, and portable field extraction and reading.
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
import { extractFormFields, parseFormFields } from 'valibot-form'

const fields = extractFormFields(configSchema)
const received = parseFormFields(JSON.parse(JSON.stringify(fields)))
```

`extractFormFields` accepts `object`, `strictObject`, and intersections of these object schemas. Empty objects produce an empty list. Duplicate intersection keys and non-renderable subtrees carry an `unsupported` reason. `required` describes missing input keys and `nullable` describes explicit `null`. Input constraints stop at the first transform.

`parseFormFields` accepts unknown input and returns an owned, deeply readonly tree. Invalid field data throws a `TypeError` with its location. The transport owns its message budget, envelope and version or slot checks. Array items, record values, and union branches are templates. Use the bound path for values and issues, including numeric array indices and literal string keys.

String, number and boolean literal fields carry their exact input in `literal`. `matchingUnionBranches(field, draft)` finds branches compatible with the keys and types already present. An unfinished draft can match several branches. `unionBranchLiteral(branch)` returns the value a selector supplies for a whole-value literal such as `false`. A read-only property inside an object still needs a value from the caller. Numeric and text picklist choices retain their original types after selection.

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

Tools that track declarations can pass `{ onFailureSchema }` as the third argument. When a schema node accounts for a failed projection, the callback receives that node once. Its identity stays local to the caller and the failure result remains portable.

## Web Adapter

`valibot-form/web` is intentionally optional. It depends on React, Mantine, TanStack Form, Tabler Icons, and dnd-kit through optional peer dependencies.

Install those peers only when using the web adapter:

```sh
vp add valibot-form valibot react react-dom @mantine/core @mantine/hooks @tanstack/react-form @tabler/icons-react @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

```tsx
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import { AutoForm, webRenderers, type ScalarRendererProps } from 'valibot-form/web'

function PortControl({ node, ...props }: ScalarRendererProps<'number'>) {
	return <webRenderers.number {...props} node={{ ...node, step: 10 }} />
}

export function ConfigEditor() {
	return (
		<MantineProvider>
			<AutoForm schema={configSchema} renderers={{ number: PortControl }}>
				<AutoForm.Fields />
				<AutoForm.Actions>
					{({ reset }) => (
						<button type="button" onClick={() => reset()}>
							Reset draft
						</button>
					)}
				</AutoForm.Actions>
			</AutoForm>
		</MantineProvider>
	)
}
```

`renderers` applies to the instance's string, number, boolean, and picklist controls, including collection rows. Each receives a kind-specific `node`, raw `value`, actual typed `path`, `errors`, and `inputProps` for changes, blur, locking and accessibility. A pending collection input uses an empty path until confirmation. Forward its `inputProps.onKeyDown` from a custom text or number input to support Enter to add the row. The built-in multi-select picker owns the entire array value. Explicit null controls preserve a raw `null`, and number format metadata displays a formatted value alongside the raw editor.

Schema mode takes `formOpts.defaultValues` or uses `getDefaults(schema)` and edits `InferInput`. Assign validators and submit logic through `formOpts`. Plan mode takes `fields` and explicit draft defaults, with validation and submission owned by the caller.

For sparse configuration editors, pass the saved raw input to `prepareEditableConfigFields(fields, saved)` before rendering. Use `buildEditableConfigPatch(fields, draft, saved)` to save and `editableConfigPaths(fields, saved)` for a scoped reset. Apply `remove` before merging `set`. A draft key whose value is `undefined` removes that override. `null`, `false` and an empty object are explicit saved values. The helper preserves unprojected or protected saved values, including collections unsafe to replace.
