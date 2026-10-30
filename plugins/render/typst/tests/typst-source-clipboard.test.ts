import { DOMParser } from '@tiptap/pm/model'
import { expect, it } from 'vitest'
import { createTypstSourceProject } from '../src/source/node.js'
import { createTypstSourceEditor } from '../src/tiptap/source-editor.js'

it('parses marked source blocks before the generic code-block rule in the complete editor schema', () => {
	const project = createTypstSourceProject({
		files: { 'body.typ': '#let sales = json("data.json")' },
	})
	const editor = createTypstSourceEditor({ project, path: 'body.typ' })
	try {
		const rules = DOMParser.fromSchema(editor.schema).rules
		const source = rules.findIndex(
			(rule) =>
				'node' in rule && rule.node === 'typstSource' && rule.tag === 'pre[data-typst-source]',
		)
		const code = rules.findIndex(
			(rule) => 'node' in rule && rule.node === 'codeBlock' && rule.tag === 'pre',
		)
		expect(source).toBeGreaterThanOrEqual(0)
		expect(code).toBeGreaterThan(source)
	} finally {
		editor.destroy()
	}
})
