import { expect, it } from 'vitest'
import { completeSourcePaths, relativePath, resolveSourcePath } from '../src/tiptap/source-paths.js'

const from = 'sections/body.typ'
const files = [
	'main.typ',
	from,
	'sections/actions.typ',
	'sections/nested/extra.typ',
	'components/blocks.typ',
	'components/charts/chart.typ',
	'data/sales.json',
]

it('completes only children of the current directory and excludes the current file and data', () => {
	expect(completeSourcePaths(files, from, '').map((item) => item.label)).toEqual([
		'../',
		'nested/',
		'actions.typ',
	])
	expect(completeSourcePaths(files, from, 'act')).toEqual([
		{ value: 'actions.typ', label: 'actions.typ', directory: false },
	])
	expect(completeSourcePaths(files, from, '../c')).toEqual([
		{ value: '../components/', label: 'components/', directory: true },
	])
	expect(completeSourcePaths(files, from, '../components/').map((item) => item.label)).toEqual([
		'../',
		'charts/',
		'blocks.typ',
	])
})

it('keeps explicit relative spelling while resolving parent and workspace-root paths', () => {
	expect(completeSourcePaths(files, from, './a')[0]?.value).toBe('./actions.typ')
	expect(completeSourcePaths(files, from, '/components/bl')[0]?.value).toBe(
		'/components/blocks.typ',
	)
	expect(resolveSourcePath(from, '../components/blocks.typ')).toBe('components/blocks.typ')
	expect(resolveSourcePath(from, '/components/blocks.typ')).toBe('components/blocks.typ')
	expect(resolveSourcePath(from, '../../outside.typ')).toBeUndefined()
	expect(completeSourcePaths(files, from, '../../')).toEqual([])
	expect(relativePath(from, 'components/blocks.typ')).toBe('../components/blocks.typ')
})

it('bounds visible choices while allowing a specific filename past that bound to be completed', () => {
	const large = Array.from({ length: 1000 }, (_, index) => `chapters/chapter-${index}.typ`)
	expect(completeSourcePaths(large, 'main.typ', 'chapters/')).toHaveLength(30)
	expect(completeSourcePaths(large, 'main.typ', 'chapters/chapter-999')).toEqual([
		{ value: 'chapters/chapter-999.typ', label: 'chapter-999.typ', directory: false },
	])
})
