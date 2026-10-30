import type { JSONContent } from '@tiptap/core'
import type { TypstSourceProject } from '../source/state-types.js'
import { typstSourceLibrary } from '../source/library.js'
import { matchesInsertion, type InsertEntry } from './insert-commands.js'

const decode = (value: string | Uint8Array) =>
	typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value)
function relative(from: string, to: string): string {
	const base = from.split('/').slice(0, -1),
		target = to.split('/')
	while (base.length > 0 && target.length > 0 && base[0] === target[0]) {
		base.shift()
		target.shift()
	}
	return [...base.map(() => '..'), ...target].join('/')
}
function literal(value: string | number): string {
	if (typeof value === 'number') return String(value)
	if (!value.isWellFormed()) throw new Error('字段路径含无效 Unicode')
	let text = '"'
	for (const character of value) {
		const code = character.codePointAt(0)!
		text +=
			character === '"' || character === '\\'
				? `\\${character}`
				: character === '\n'
					? '\\n'
					: character === '\r'
						? '\\r'
						: character === '\t'
							? '\\t'
							: code < 0x20 || code === 0x7f
								? `\\u{${code.toString(16)}}`
								: character
	}
	return text + '"'
}

/** The catalog is derived from ordinary files and the project's one declaration list. */
export function sourceInsertEntries(
	project: TypstSourceProject,
	path: string,
): { entries(query: string): InsertEntry[]; problems: string[] } {
	const snapshot = project.snapshot(),
		projection = project.open(path)
	const components: InsertEntry[] = [],
		problems: string[] = []
	let library: string | undefined
	const pluginPayloads = new Set<string>()
	for (const [file, contents] of Object.entries(snapshot.files)) {
		if (!file.endsWith('.typ')) continue
		try {
			if (decode(contents) !== typstSourceLibrary) continue
			library ??= file
			// The ordinary reference library imports this JSON-encoded WASM plugin.
			// It is a compilation resource, not a document-data choice.
			pluginPayloads.add([...file.split('/').slice(0, -1), 'mitex/mitex.wasm.json'].join('/'))
		} catch {}
	}
	const json: { file: string; value: unknown }[] = []
	for (const [file, contents] of Object.entries(snapshot.files)) {
		if (!file.endsWith('.json') || pluginPayloads.has(file)) continue
		try {
			json.push({ file, value: JSON.parse(decode(contents)) })
		} catch {
			problems.push(`${file}：修复 JSON 后可插入其数据字段。`)
		}
	}
	let alias = 'pluxelInserted',
		suffix = 1
	// This is a conservative absence check, never a parser or a rewrite of existing imports.
	while (projection.source.includes(alias)) alias = `pluxelInserted${++suffix}`
	const command =
		(module: string, node: JSONContent): InsertEntry['command'] =>
		(chain) =>
			chain
				.command(() => project.revision === snapshot.revision)
				.insertContent(node)
				.command(({ tr, state }) => {
					tr.insert(
						0,
						state.schema.node('typstSource', {
							source: `#import ${literal(relative(path, module))} as ${alias}`,
							role: 'environment',
						}),
					)
					return true
				})
	for (const component of project.components) {
		if (
			!Object.hasOwn(snapshot.files, component.module) ||
			!/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(component.name) ||
			(component.data && !/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(component.data))
		) {
			problems.push(`${component.label}：模块或调用名称无效，修复声明后再插入。`)
			continue
		}
		if (component.data && json.length === 0)
			problems.push(`${component.label}：请先添加可解析的 JSON 文件，再明确选择数据绑定。`)
		for (const selected of component.data ? json : [undefined]) {
			const resource = selected && relative(path, selected.file)
			const source = `#${alias}.${component.name}(${selected ? `${component.data}: json(${literal(resource!)})` : ''})`
			components.push({
				id: `component:${component.module}:${component.name}:${selected?.file ?? ''}`,
				title: selected ? `${component.label} · ${selected.file}` : component.label,
				description: `${component.module} · ${component.name}；参数使用模板默认，可在插入后编辑`,
				keywords: ['component', '组件', component.module, component.name, selected?.file ?? ''],
				icon: 'code',
				group: '模板组件',
				command: command(component.module, {
					type: 'typstComponent',
					attrs: {
						module: component.module,
						name: component.name,
						label: component.label,
						parameters: component.parameters,
						props: {},
						binding: selected ? { file: selected.file, source: resource } : null,
						source,
					},
				}),
			})
		}
	}
	if (json.length > 0 && !library)
		problems.push(
			'数据字段插入需要项目内的普通 Pluxel 引用库；请由宿主添加 createTypstSourceLibrary() 返回的文件。',
		)
	return {
		problems,
		entries(query) {
			const entries = components.filter((entry) => matchesInsertion(entry, query)).slice(0, 100)
			if (!library || entries.length === 100) return entries
			for (const { file, value: rootValue } of json) {
				for (const { value, keys } of scalarFields(rootValue)) {
					const title = `${file} · ${keys.join('.') || '整个值'}`
					const keywords = ['field', '字段', file, ...keys.map(String)]
					if (!matchesInsertion({ title, keywords }, query)) continue
					const source = `#${alias}.field(json(${literal(relative(path, file))}), (${keys.map(literal).join(', ')}${keys.length > 0 ? ',' : ''}))`
					entries.push({
						id: `field:${file}:${JSON.stringify(keys)}`,
						title,
						description: String(value).slice(0, 80),
						keywords,
						icon: 'field',
						group: '数据字段',
						command: command(library, { type: 'typstField', attrs: { file, path: keys, source } }),
					})
					if (entries.length === 100) return entries
				}
			}
			return entries
		},
	}
}

/** Walk on demand, without allocating an entry per array member or limiting path depth. */
function* scalarFields(root: unknown) {
	type Key = string | number
	const stack: { keys: Key[]; values: Iterator<[Key | undefined, unknown]> }[] = [
		{ keys: [], values: new Map([[undefined, root]]).entries() },
	]
	while (stack.length > 0) {
		const frame = stack.at(-1)!
		const next = frame.values.next()
		if (next.done) {
			stack.pop()
			continue
		}
		const [key, value] = next.value
		const keys = key === undefined ? frame.keys : [...frame.keys, key]
		if (value !== null && typeof value === 'object') {
			stack.push({
				keys,
				values: Array.isArray(value) ? value.entries() : Object.entries(value).values(),
			})
		} else yield { value, keys }
	}
}
