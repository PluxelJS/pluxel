import { readFile } from 'node:fs/promises'
import { createTypstSourceLibrary } from '@pluxel/plugin-typst/source/library'
import type { TypstSourceComponent } from '@pluxel/plugin-typst/source'

export const fontFamilies = ['Noto Serif CJK SC', 'Liberation Serif']

/** This example is an ordinary source project; library resources are explicit seed files. */
export async function sourceExample(): Promise<{
	files: Record<string, string>
	components: readonly TypstSourceComponent[]
}> {
	const paths = [
		'main.typ',
		'sections/analysis.typ',
		'sections/actions.typ',
		'template/blocks.typ',
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
		components: [
			{
				module: 'template/blocks.typ',
				name: 'metrics',
				label: '指标卡',
				parameters: { title: { type: 'string' as const, label: '标题' } },
				data: 'data',
			},
			{
				module: 'template/blocks.typ',
				name: 'revenue-chart',
				label: '营收图表',
				parameters: {},
				data: 'data',
			},
		],
	}
}
