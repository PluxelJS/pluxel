import { readFile } from 'node:fs/promises'
import { createTypstSourceLibrary } from '@pluxel/plugin-typst/source/library'
import type { TypstSourceComponent } from '@pluxel/plugin-typst/source'
import type { ExampleId } from './examples'

export const fontFamilies = ['Noto Serif CJK SC', 'Liberation Serif']

/** This example is an ordinary source project; library resources are explicit seed files. */
export async function sourceExample(example: ExampleId = 'report'): Promise<{
	files: Record<string, string>
	components: readonly TypstSourceComponent[]
	writablePaths: readonly string[]
}> {
	if (example === 'application-form') {
		const paths = ['main.typ', 'data/application.json']
		return {
			files: {
				...(await createTypstSourceLibrary()),
				...Object.fromEntries(
					await Promise.all(
						paths.map(async (path) => [
							path,
							await readFile(new URL(`./public/application-form/${path}`, import.meta.url), 'utf8'),
						]),
					),
				),
			},
			components: [],
			writablePaths: ['data/application.json'],
		}
	}
	const paths = [
		'main.typ',
		'sections/analysis.typ',
		'sections/actions.typ',
		'sections/appendix.typ',
		'components/blocks.typ',
		'data/sales.json',
		'assets/brand.svg',
	]
	const files = {
		...(await createTypstSourceLibrary()),
		...Object.fromEntries(
			await Promise.all(
				paths.map(async (path) => [
					path,
					await readFile(new URL(`./public/source-report/${path}`, import.meta.url), 'utf8'),
				]),
			),
		),
	}
	return {
		files,
		writablePaths: [
			'sections/analysis.typ',
			'sections/actions.typ',
			'sections/appendix.typ',
			'data/sales.json',
		],
		components: [
			{
				module: 'components/blocks.typ',
				name: 'metrics',
				label: '指标卡',
				parameters: {
					title: { type: 'string' as const, label: '标题' },
					accent: { type: 'string' as const, label: '底色' },
				},
				data: 'data',
			},
			{
				module: 'components/blocks.typ',
				name: 'revenue-chart',
				label: '营收图表',
				parameters: {},
				data: 'data',
			},
		],
	}
}
