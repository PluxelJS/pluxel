import { readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const scanRoots = ['packages', 'plugins', 'projects', 'docs']
const ignoredDirectories = new Set([
	'.git',
	'.pluxel',
	'.turbo',
	'.cache',
	'coverage',
	'dist',
	'node_modules',
])
const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/
const documentationExtensions = /\.(?:mdx?|jsonc?)$/
const failures = []

const forbiddenPublicImports = new Map([
	[
		'@pluxel/core/test',
		new Set([
			'CoreHost',
			'CoreHostConfigHandle',
			'CoreHostConfigPatch',
			'CoreTestContext',
			'CoreHostLifecycleIssueExpectation',
			'assertPluginLifecycleIssue',
			'createCoreContext',
			'createCoreHost',
			'findPluginLifecycleIssue',
			'pluginLifecycleIssuePlugins',
			'withCoreContext',
			'withCoreHost',
		]),
	],
	[
		'@pluxel/runtime/test',
		new Set([
			'RuntimeHost',
			'RuntimeHostConfigHandle',
			'RuntimeHostConfigPatch',
			'RuntimeTestContext',
			'assertPluginLifecycleIssue',
			'createRuntimeContext',
			'createRuntimeHost',
			'findPluginLifecycleIssue',
			'pluginLifecycleIssuePlugins',
		]),
	],
	[
		'@pluxel/runtime-static/test',
		new Set([
			'RuntimeSessionTestConnection',
			'createStaticRuntimeTestHost',
			'openRuntimeSessionTestConnection',
		]),
	],
	['@pluxel/runtime-dynamic', new Set(['createDynamicDevRuntime'])],
])

const canonicalHostFactories = new Set([
	'createCoreTestHost',
	'createRuntimeTestHost',
	'startStaticApplicationTestHost',
])
const canonicalHostTypes = new Set(['CoreTestHost', 'RuntimeTestHost', 'StaticApplicationTestHost'])
const forbiddenHostMembers = new Set(['cfg', 'commitAllowFail', 'ctx', 'fetch', 'fork'])
const dynamicEntryFunctions = new Set(['dynamicRuntimeVitePlugin', 'startDynamicDevRuntime'])
const publicEntryForbiddenSymbols = new Map([
	[
		'packages/core/src/test.ts',
		['createCoreContext', 'createCoreHost', 'withCoreContext', 'withCoreHost'],
	],
	[
		'packages/runtime/src/test.ts',
		['createRuntimeContext', 'createRuntimeHost', 'RuntimeHost', 'RuntimeTestContext'],
	],
	[
		'packages/runtime-static/src/test.ts',
		['createStaticRuntimeTestHost', 'openRuntimeSessionTestConnection'],
	],
	['packages/runtime-dynamic/src/index.ts', ['createDynamicDevRuntime']],
])

const files = (
	await Promise.all(scanRoots.map((directory) => collectFiles(resolve(root, directory))))
).flat()

for (const path of files) {
	const source = await readFile(path, 'utf8')
	const displayPath = relative(root, path).replaceAll('\\', '/')
	if (sourceExtensions.test(path)) inspectSource(displayPath, source)
	else if (documentationExtensions.test(path)) inspectDocumentation(displayPath, source)
}

await inspectPackageExports()
await inspectTegamiIntent()

if (failures.length > 0) {
	process.stderr.write(`Testing v2 migration gate failed:\n- ${failures.toSorted().join('\n- ')}\n`)
	process.exitCode = 1
} else {
	process.stdout.write(`Testing v2 migration gate passed (${files.length} files checked)\n`)
}

function inspectSource(displayPath, source) {
	const factoryBindings = new Set()
	const hostTypeBindings = new Set()
	const dynamicBindings = new Set()
	const namespaceBindings = new Map()
	const allForbiddenImports = new Set(
		[...forbiddenPublicImports.values()].flatMap((symbols) => [...symbols]),
	)
	const importPattern = /(?:^|\n)\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g
	for (const match of source.matchAll(importPattern)) {
		const clause = match[1]
		const moduleName = match[3]
		if (moduleName === '@pluxel/test') {
			reportAt(displayPath, source, match.index, 'removed @pluxel/test root import')
		}
		const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1]
		if (namespace) namespaceBindings.set(namespace, moduleName)
		const named = /\{([\s\S]*?)\}/.exec(clause)?.[1]
		if (!named) continue
		for (const rawSpecifier of named.split(',')) {
			const specifier = rawSpecifier.replace(/\/\*[\s\S]*?\*\//g, '').trim()
			if (!specifier) continue
			const normalized = specifier.replace(/^type\s+/, '').trim()
			const [imported, local = imported] = normalized.split(/\s+as\s+/)
			if (!imported || !local) continue
			const isRelativeTestEntry =
				moduleName.startsWith('.') && /(?:^|\/)(?:src\/)?(?:internal-)?test(?:\.[cm]?ts)?$/.test(moduleName)
			if (
				forbiddenPublicImports.get(moduleName)?.has(imported) ||
				(isRelativeTestEntry && allForbiddenImports.has(imported))
			) {
				reportAt(displayPath, source, match.index, `removed ${moduleName}.${imported} import`)
		}
			if (canonicalHostFactories.has(imported)) factoryBindings.add(local)
			if (canonicalHostTypes.has(imported)) hostTypeBindings.add(local)
			if (dynamicEntryFunctions.has(imported)) dynamicBindings.add(local)
		}
	}
	for (const match of source.matchAll(/(?:^|\n)\s*import\s*(['"])@pluxel\/test\1/g)) {
		reportAt(displayPath, source, match.index, 'removed @pluxel/test root import')
	}
	for (const match of source.matchAll(/\bimport\s*\(\s*(['"])@pluxel\/test\1\s*\)/g)) {
		reportAt(displayPath, source, match.index, 'removed dynamic @pluxel/test root import')
	}

	const hostBindings = new Set()
	for (const typeName of hostTypeBindings) {
		const pattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*:\\s*${escapeRegExp(typeName)}\\b`, 'g')
		for (const match of source.matchAll(pattern)) hostBindings.add(match[1])
	}
	for (const factory of factoryBindings) {
		const pattern = new RegExp(
			`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)[^=;\\n]*=\\s*(?:await\\s+)?${escapeRegExp(factory)}\\s*\\(`,
			'g',
		)
		for (const match of source.matchAll(pattern)) hostBindings.add(match[1])
	}
	for (const namespace of namespaceBindings.keys()) {
		for (const factory of canonicalHostFactories) {
			const pattern = new RegExp(
				`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)[^=;\\n]*=\\s*(?:await\\s+)?${escapeRegExp(namespace)}\\s*\\.\\s*${factory}\\s*\\(`,
				'g',
			)
			for (const match of source.matchAll(pattern)) hostBindings.add(match[1])
		}
	}
	for (const host of hostBindings) {
		for (const member of forbiddenHostMembers) {
			const pattern = new RegExp(`\\b${escapeRegExp(host)}\\s*\\.\\s*${member}\\b`, 'g')
			for (const match of source.matchAll(pattern)) {
				reportAt(displayPath, source, match.index, `removed public host member .${member}`)
		}
		}
		const parameterlessCommit = new RegExp(
			`\\b${escapeRegExp(host)}\\s*\\.\\s*commit\\s*\\(\\s*\\)`,
			'g',
		)
		for (const match of source.matchAll(parameterlessCommit)) {
			reportAt(displayPath, source, match.index, 'parameterless staged host.commit()')
		}
	}
	for (const [namespace, moduleName] of namespaceBindings) {
		for (const symbol of forbiddenPublicImports.get(moduleName) ?? []) {
			const pattern = new RegExp(`\\b${escapeRegExp(namespace)}\\s*\\.\\s*${symbol}\\b`, 'g')
			for (const match of source.matchAll(pattern)) {
				reportAt(displayPath, source, match.index, `removed ${moduleName}.${symbol} access`)
			}
		}
	}
	const dynamicCallNames = new Set(dynamicBindings)
	for (const namespace of namespaceBindings.keys()) {
		for (const entry of dynamicEntryFunctions) dynamicCallNames.add(`${namespace}\\s*\\.\\s*${entry}`)
	}
	for (const name of dynamicCallNames) {
		const pattern = new RegExp(`\\b${name}\\s*\\(\\s*\\{`, 'g')
		for (const match of source.matchAll(pattern)) {
			const objectStart = source.indexOf('{', match.index)
			const configProperty = findTopLevelObjectProperty(source, objectStart, 'config')
			if (configProperty !== undefined) {
				reportAt(
					displayPath,
					source,
					configProperty,
					'dynamic runtime options must use entry, not config',
				)
			}
		}
	}
	for (const symbol of publicEntryForbiddenSymbols.get(displayPath) ?? []) {
		const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g')
		for (const match of source.matchAll(pattern)) {
			reportAt(displayPath, source, match.index, `removed public entry symbol ${symbol}`)
		}
	}
}

function inspectDocumentation(displayPath, source) {
	const checks = [
		[/from\s+['"]@pluxel\/test['"]/g, 'removed @pluxel/test root import'],
		[/\bcreateRuntimeHost\b/g, 'removed createRuntimeHost symbol'],
		[/\bcreateCoreHost\b/g, 'removed createCoreHost symbol'],
		[/\bcreateStaticRuntimeTestHost\b/g, 'removed createStaticRuntimeTestHost symbol'],
		[/\bopenRuntimeSessionTestConnection\b/g, 'removed static Runtime Session test helper'],
		[/\bcreateDynamicDevRuntime\b/g, 'removed createDynamicDevRuntime symbol'],
		[/\bcommitAllowFail\s*\(/g, 'removed commitAllowFail() call'],
		[/\.(?:cfg|fork)\s*\(/g, 'removed staged host helper'],
		[/dynamicRuntimeVitePlugin\s*\(\s*\{\s*config\s*:/g, 'dynamic Vite options must use entry'],
	]
	for (const [pattern, message] of checks) {
		for (const match of source.matchAll(pattern)) {
			const line = source.slice(0, match.index).split('\n').length
			failures.push(`${displayPath}:${line}: ${message}`)
		}
	}
}

async function inspectPackageExports() {
	const manifestPath = resolve(root, 'packages/test/package.json')
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
	for (const legacyField of ['main', 'module', 'types', 'typings']) {
		if (Object.hasOwn(manifest, legacyField)) {
			failures.push(
				`packages/test/package.json: ${legacyField} would recreate a removed package root entry`,
			)
		}
	}
	const allowedEntries = new Set(['./fixtures', './unsafe', './vitest', './package.json'])
	for (const [field, exports] of [
		['exports', manifest.exports],
		['publishConfig.exports', manifest.publishConfig?.exports],
	]) {
		if (!exports || typeof exports !== 'object') {
			failures.push(`packages/test/package.json: ${field} must be an exports object`)
			continue
		}
		for (const removed of ['.', './setup']) {
			if (Object.hasOwn(exports, removed)) {
				failures.push(
					`packages/test/package.json: ${field} still publishes removed ${removed} entry`,
				)
			}
		}
		for (const entry of Object.keys(exports)) {
			if (!allowedEntries.has(entry)) {
				failures.push(`packages/test/package.json: ${field} contains unexpected entry ${entry}`)
			}
		}
	}
}

async function inspectTegamiIntent() {
	const required = new Set([
		'@pluxel/core',
		'@pluxel/runtime',
		'@pluxel/test',
		'@pluxel/runtime-static',
		'@pluxel/runtime-dynamic',
	])
	const entries = await readdir(resolve(root, '.tegami'), { withFileTypes: true })
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue
		const source = await readFile(resolve(root, '.tegami', entry.name), 'utf8')
		const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source)
		if (!match) continue
		const frontmatter = parse(match[1])
		const packages = frontmatter?.packages ?? frontmatter
		for (const name of required) {
			const value = packages?.[name]
			const type = typeof value === 'string' ? value : value?.type
			if (type === 'major') required.delete(name)
		}
	}
	for (const name of required) failures.push(`.tegami: missing pending major intent for ${name}`)
}

function reportAt(displayPath, source, index, message) {
	const prefix = source.slice(0, index)
	const previousLines = prefix.split('\n').slice(-3, -1)
	if (previousLines.some((line) => line.includes('@ts-expect-error'))) return
	const line = prefix.split('\n').length
	const lastNewline = prefix.lastIndexOf('\n')
	const column = index - lastNewline
	failures.push(`${displayPath}:${line}:${column}: ${message}`)
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Finds an own property on a call's object-literal argument without scanning into later source.
 * This is deliberately a small lexical check rather than a TypeScript AST dependency: the
 * repository compiler package no longer exposes the legacy parser API used by governance scripts.
 */
function findTopLevelObjectProperty(source, objectStart, property) {
	if (objectStart < 0 || source[objectStart] !== '{') return undefined
	let braces = 0
	let parentheses = 0
	let brackets = 0
	for (let index = objectStart; index < source.length; index += 1) {
		const character = source[index]
		const next = source[index + 1]
		if (character === '/' && next === '/') {
			index = skipLineComment(source, index + 2)
			continue
		}
		if (character === '/' && next === '*') {
			index = skipBlockComment(source, index + 2)
			continue
		}
		if (character === "'" || character === '"' || character === '`') {
			index = skipQuoted(source, index, character)
			continue
		}
		if (character === '{') braces += 1
		else if (character === '}') {
			braces -= 1
			if (braces === 0) return undefined
		} else if (character === '(') parentheses += 1
		else if (character === ')') parentheses -= 1
		else if (character === '[') brackets += 1
		else if (character === ']') brackets -= 1
		else if (
			braces === 1 &&
			parentheses === 0 &&
			brackets === 0 &&
			isIdentifierStart(character)
		) {
			let end = index + 1
			while (isIdentifierPart(source[end])) end += 1
			if (source.slice(index, end) === property) {
				const previous = previousSignificantCharacter(source, index - 1)
				const after = nextSignificantCharacter(source, end)
				if ((previous === '{' || previous === ',') && (after === ':' || after === ',' || after === '}')) {
					return index
				}
			}
			index = end - 1
		}
	}
	return undefined
}

function skipLineComment(source, index) {
	const newline = source.indexOf('\n', index)
	return newline < 0 ? source.length : newline
}

function skipBlockComment(source, index) {
	const close = source.indexOf('*/', index)
	return close < 0 ? source.length : close + 1
}

function skipQuoted(source, index, quote) {
	for (let cursor = index + 1; cursor < source.length; cursor += 1) {
		if (source[cursor] === '\\') {
			cursor += 1
			continue
		}
		if (source[cursor] === quote) return cursor
	}
	return source.length
}

function previousSignificantCharacter(source, index) {
	while (index >= 0 && /\s/.test(source[index])) index -= 1
	return source[index]
}

function nextSignificantCharacter(source, index) {
	while (index < source.length && /\s/.test(source[index])) index += 1
	return source[index]
}

function isIdentifierStart(character) {
	return character !== undefined && /[A-Za-z_$]/.test(character)
}

function isIdentifierPart(character) {
	return character !== undefined && /[\w$]/.test(character)
}

async function collectFiles(directory) {
	let entries
	try {
		entries = await readdir(directory, { withFileTypes: true })
	} catch (error) {
		if (error?.code === 'ENOENT') return []
		throw error
	}
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = resolve(directory, entry.name)
			if (entry.isDirectory()) {
				return ignoredDirectories.has(entry.name) ? [] : collectFiles(path)
			}
			return sourceExtensions.test(entry.name) || documentationExtensions.test(entry.name)
				? [path]
				: []
		}),
	)
	return nested.flat()
}
