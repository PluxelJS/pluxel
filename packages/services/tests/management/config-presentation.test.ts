import { expect, test } from 'vitest'
import * as v from 'valibot'
import { picklistMeta } from 'valibot-form'
import { projectFormPresentationFields } from '../../src/management/api/presenters/configPresentation.ts'

test('picklist presentation omits undefined labels while preserving supplied labels', () => {
	const schema = v.object({
		role: v.pipe(
			v.picklist(['reader', 'editor']),
			picklistMeta({ labels: { reader: 'Reader', editor: undefined } }),
		),
	})
	const [field] = projectFormPresentationFields(schema)
	expect(field).toMatchObject({
		kind: 'picklist',
		options: ['reader', 'editor'],
		labels: { reader: 'Reader' },
	})
	if (field?.kind !== 'picklist') throw new Error('Expected a picklist field')
	expect(field.labels).not.toHaveProperty('editor')
})
