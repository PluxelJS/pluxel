import { collectObjectEntries, extractFormFields, type FieldNode, type Schema } from 'valibot-form'
import type { ConfigPresentationPlanV3 } from '../../web/protocol'
import { parseConfigPresentationPlanV3 } from '../../web/validation'

type ConfigPresentationSectionInput = Readonly<{
	path: readonly string[]
	fieldName: string
	schema: unknown
}>

/** Compile the original owner and Part declarations into their editable sections. */
export function compileConfigPresentationPlanV3(
	sections: readonly ConfigPresentationSectionInput[],
): ConfigPresentationPlanV3 {
	return parseConfigPresentationPlanV3({
		version: 3,
		sections: sections.map(({ path, fieldName, schema }) => ({
			path,
			fieldName,
			fields: projectConfigFields(schema, fieldName),
		})),
	})
}

function projectConfigFields(schema: unknown, fieldName: string): readonly FieldNode[] {
	if (!schema || typeof schema !== 'object' || !collectObjectEntries(schema as Schema)) {
		return [
			{
				name: fieldName,
				path: fieldName,
				depth: 0,
				meta: { label: fieldName, readOnly: true },
				required: false,
				nullable: false,
				kind: 'unsupported',
				readOnly: true,
				reason: 'Config schema does not expose a supported presentation structure',
			},
		]
	}
	return extractFormFields(schema as Schema)
}
