import { access, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const activeRoots = ['packages', 'plugins', 'projects', 'scripts', 'vendor', 'local-projects']
const ignoredDirectories = new Set([
	'.artifacts',
	'.cache',
	'.git',
	'.next',
	'.pluxel',
	'.pnpm-store',
	'.sources',
	'.turbo',
	'build',
	'coverage',
	'dist',
	'node_modules',
	'out',
	'target',
])
const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/
const vitestConfigName = /^vitest(?:\.workspace)?\.config\.(?:[cm]?[jt]sx?)$/
const failures = []

const forbiddenTestImports = new Map([
	[
		'@pluxel/core/test',
		new Set([
			'CoreHost',
			'CoreHostConfigHandle',
			'CoreHostConfigPatch',
			'CoreHostLifecycleIssueExpectation',
			'CoreTestContext',
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

const authoritativeDocumentation = [
	'engineering/TESTING.md',
	'docs/development/testing.md',
	'docs/development/source-workspaces.md',
	'packages/test/README.md',
	'engineering/README.md',
	'engineering/proposals/README.md',
]

const publicEntryChecks = new Map([
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
])

const collected = { code: [], locks: [], manifests: [], workspaces: [] }
for (const directory of activeRoots) await collectFiles(resolve(root, directory), collected)

const codeFiles = uniquePaths(collected.code)
const manifestPaths = uniquePaths([resolve(root, 'package.json'), ...collected.manifests])
const lockPaths = uniquePaths(collected.locks)
const workspacePaths = uniquePaths([resolve(root, 'pnpm-workspace.yaml'), ...collected.workspaces])

for (const path of codeFiles) {
	const source = await readFile(path, 'utf8')
	const displayPath = display(path)
	inspectRemovedImports(displayPath, source)
	inspectPublicTestEntry(displayPath, source)
	if (vitestConfigName.test(basename(path))) inspectVitestConfig(displayPath, source)
}

await inspectTestPackageBoundary()
await inspectPresetBoundary()
await inspectTurboTaskGraph()
await inspectManifests()
await inspectVitestBaselines()
await inspectDocumentation()
await inspectProposalRemoval()

if (failures.length > 0) {
	process.stderr.write(`Testing v2 migration gate failed:\n- ${failures.toSorted().join('\n- ')}\n`)
	process.exitCode = 1
} else {
	process.stdout.write(
		`Testing v2 migration gate passed (${codeFiles.length} source files, ${manifestPaths.length} manifests checked)\n`,
	)
}

function inspectRemovedImports(displayPath, source) {
	for (const match of source.matchAll(
		/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])@pluxel\/test\1/g,
	)) {
		reportAt(displayPath, source, match.index, 'removed @pluxel/test root import')
	}
	for (const match of source.matchAll(/(?:^|\n)\s*import\s*(['"])@pluxel\/test\1/g)) {
		reportAt(displayPath, source, match.index, 'removed @pluxel/test root import')
	}
	for (const match of source.matchAll(
		/(?:^|\n)\s*import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+(['"])([^'"]+)\2/g,
	)) {
		const forbidden = forbiddenTestImports.get(match[3])
		if (!forbidden) continue
		for (const rawSpecifier of match[1].split(',')) {
			const normalized = rawSpecifier
				.replaceAll(/\/\*[\s\S]*?\*\//g, '')
				.replace(/^\s*type\s+/, '')
				.trim()
			const imported = normalized.split(/\s+as\s+/)[0]?.trim()
			if (imported && forbidden.has(imported)) {
				reportAt(displayPath, source, match.index, `removed ${match[3]}.${imported} import`)
			}
		}
	}
}

function inspectPublicTestEntry(displayPath, source) {
	for (const symbol of publicEntryChecks.get(displayPath) ?? []) {
		const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g')
		for (const match of source.matchAll(pattern)) {
			failures.push(
				`${displayPath}:${lineAt(source, match.index)}: removed public test entry symbol ${symbol}`,
			)
		}
	}
}

function inspectVitestConfig(displayPath, source) {
	for (const match of source.matchAll(/@pluxel\/test\/(?:setup|lifecycle-matcher)\b/g)) {
		failures.push(
			`${displayPath}:${lineAt(source, match.index)}: removed preset setup/matcher import`,
		)
	}
	for (const match of source.matchAll(
		/(?:\bfrom\s+|\bimport\s*\(\s*)(['"])[^'"]*\/src\/vitest(?:\.[cm]?[jt]sx?)?\1/g,
	)) {
		failures.push(`${displayPath}:${lineAt(source, match.index)}: relative source preset import`)
	}
	for (const openParen of findCalls(source, 'definePluxelVitestConfig')) {
		if (hasTopLevelComma(source, openParen)) {
			failures.push(
				`${displayPath}:${lineAt(source, openParen)}: definePluxelVitestConfig() accepts one config object`,
			)
		}
	}
}

async function inspectTestPackageBoundary() {
	const path = resolve(root, 'packages/test/package.json')
	const manifest = await readJson(path)
	const scripts = manifest.scripts ?? {}
	if (
		typeof scripts.test !== 'string' ||
		scripts.test.includes('source:test-bootstrap') ||
		/\bpnpm\s+run\s+build\b/.test(scripts.test)
	) {
		failures.push(
			'packages/test/package.json: test must consume the Turbo-built preset instead of rebuilding it',
		)
	}
	if (Object.hasOwn(scripts, 'source:test-bootstrap')) {
		failures.push(
			'packages/test/package.json: source:test-bootstrap would create a second preset build path',
		)
	}
	for (const legacyField of ['main', 'module', 'types', 'typings']) {
		if (Object.hasOwn(manifest, legacyField)) {
			failures.push(
				`packages/test/package.json: ${legacyField} would recreate a removed root entry`,
			)
		}
	}
	const allowed = new Set(['./fixtures', './unsafe', './vitest', './package.json'])
	for (const [label, entries] of [
		['exports', manifest.exports],
		['publishConfig.exports', manifest.publishConfig?.exports],
	]) {
		if (!entries || typeof entries !== 'object') {
			failures.push(`packages/test/package.json: ${label} must be an exports object`)
			continue
		}
		for (const entry of Object.keys(entries)) {
			if (!allowed.has(entry))
				failures.push(`packages/test/package.json: unexpected ${label} entry ${entry}`)
		}
		for (const entry of allowed) {
			if (!Object.hasOwn(entries, entry))
				failures.push(`packages/test/package.json: missing ${label} entry ${entry}`)
		}
	}
	for (const removedFile of [
		'packages/test/src/setup.ts',
		'packages/test/src/lifecycle-matcher.ts',
	]) {
		if (await exists(resolve(root, removedFile)))
			failures.push(`${removedFile}: removed test setup still exists`)
	}
}

async function inspectPresetBoundary() {
	const source = await readFile(resolve(root, 'packages/test/src/vitest.ts'), 'utf8')
	if (
		!source.includes('export type PluxelVitestConfig') ||
		!source.includes('pluxel?: PluxelVitestToolchainConfig')
	) {
		failures.push('packages/test/src/vitest.ts: missing one-object PluxelVitestConfig namespace')
	}
	const declaration = source.indexOf('export function definePluxelVitestConfig')
	const openParen = declaration < 0 ? -1 : source.indexOf('(', declaration)
	if (openParen < 0 || hasTopLevelComma(source, openParen)) {
		failures.push('packages/test/src/vitest.ts: definePluxelVitestConfig() must have one parameter')
	}
	for (const token of [
		'setupFiles',
		'toHavePluginLifecycleIssue',
		'expect.extend',
		'lifecycle-matcher',
	]) {
		if (source.includes(token))
			failures.push(`packages/test/src/vitest.ts: preset must not install ${token}`)
	}
}

async function inspectTurboTaskGraph() {
	const source = await readFile(resolve(root, 'turbo.jsonc'), 'utf8')
	const match = /"test"\s*:\s*\{([\s\S]*?)\n\t\t\},/.exec(source)
	if (!match || !/"dependsOn"\s*:\s*\[\s*"@pluxel\/test#build"\s*\]/.test(match[1])) {
		failures.push('turbo.jsonc: every default test task must wait for @pluxel/test#build')
	}
}

async function inspectManifests() {
	for (const path of manifestPaths) {
		const manifest = await readJson(path)
		const displayPath = display(path)
		const scripts = manifest.scripts ?? {}
		for (const [name, command] of Object.entries(scripts)) {
			if (typeof command !== 'string') continue
			if (
				(name.includes('test') || command.includes('vitest')) &&
				command.includes('--conditions')
			) {
				failures.push(`${displayPath}: test script ${name} must not set process-wide --conditions`)
			}
		}
		for (const section of [
			manifest.dependencies,
			manifest.devDependencies,
			manifest.peerDependencies,
			manifest.optionalDependencies,
		]) {
			const version = section?.vitest
			if (version === undefined) continue
			if (version !== 'catalog:test' && !isVitestFive(String(version))) {
				failures.push(`${displayPath}: Vitest must use 5.x (found ${version})`)
			}
		}
		if (await exists(resolve(dirname(path), 'pluxel.sources.jsonc'))) {
			const bootstrap = scripts['source:test-bootstrap']
			if (
				typeof bootstrap !== 'string' ||
				!bootstrap.includes('pluxel source build --package @pluxel/test')
			) {
				failures.push(
					`${displayPath}: source workspace needs precise @pluxel/test config bootstrap`,
				)
			}
			if (typeof scripts.test !== 'string' || !scripts.test.includes('source:test-bootstrap')) {
				failures.push(`${displayPath}: test must run source:test-bootstrap before Vitest`)
			}
		}
	}
}

async function inspectVitestBaselines() {
	for (const path of workspacePaths) {
		const source = await readFile(path, 'utf8')
		for (const match of source.matchAll(/^\s*vitest:\s*['"]?([^\s#'"]+)/gm)) {
			if (!isVitestFive(match[1])) {
				failures.push(
					`${display(path)}:${lineAt(source, match.index)}: Vitest catalog must use 5.x`,
				)
			}
		}
	}
	for (const path of lockPaths) {
		const source = await readFile(path, 'utf8')
		// This is the executable runner resolution. `@vitest/*` can also be a private
		// transitive dependency of an unrelated tool (for example Storybook), so it
		// is not itself a project runner contract.
		for (const match of source.matchAll(/(?:^|[\s'"])vitest@[0-4](?:\.\d+)*(?=[:(\s]|$)/gm)) {
			failures.push(
				`${display(path)}:${lineAt(source, match.index)}: pre-Vitest-5 runner lock entry`,
			)
		}
	}
}

async function inspectDocumentation() {
	const checks = [
		[/from\s+['"]@pluxel\/test['"]/g, 'removed @pluxel/test root import'],
		[/@pluxel\/test\/(?:setup|lifecycle-matcher)\b/g, 'removed preset setup/matcher entry'],
		[
			/\b(?:toHavePluginLifecycleIssue|PluxelVitestOptions|definePluxelVitestWorkspaceConfig)\b/g,
			'removed Testing v1 API',
		],
		[
			/\b(?:createRuntimeHost|createCoreHost|createStaticRuntimeTestHost|openRuntimeSessionTestConnection)\b/g,
			'removed public test host API',
		],
		[/['"][^'"]*\/src\/vitest(?:\.[cm]?[jt]sx?)?['"]/g, 'relative source preset import'],
		[/engineering\/proposals\/testing\b/g, 'removed testing proposal reference'],
	]
	for (const documentPath of authoritativeDocumentation) {
		const path = resolve(root, documentPath)
		const source = await readFile(path, 'utf8')
		for (const [pattern, message] of checks) {
			for (const match of source.matchAll(pattern)) {
				failures.push(`${documentPath}:${lineAt(source, match.index)}: ${message}`)
			}
		}
		for (const openParen of findCalls(source, 'definePluxelVitestConfig')) {
			if (hasTopLevelComma(source, openParen)) {
				failures.push(
					`${documentPath}:${lineAt(source, openParen)}: definePluxelVitestConfig() accepts one config object`,
				)
			}
		}
	}
}

async function inspectProposalRemoval() {
	if (await exists(resolve(root, 'engineering/proposals/testing'))) {
		failures.push(
			'engineering/proposals/testing: current Testing v2 must be declarative documentation',
		)
	}
}

function findCalls(source, name) {
	const calls = []
	for (
		let index = source.indexOf(name);
		index >= 0;
		index = source.indexOf(name, index + name.length)
	) {
		const before = source[index - 1]
		const after = source[index + name.length]
		if ((before && /[\w$]/.test(before)) || (after && /[\w$]/.test(after))) continue
		let cursor = index + name.length
		while (/\s/.test(source[cursor] ?? '')) cursor += 1
		if (source[cursor] === '(') calls.push(cursor)
	}
	return calls
}

function hasTopLevelComma(source, openParen) {
	let parentheses = 0
	let braces = 0
	let brackets = 0
	for (let index = openParen; index < source.length; index += 1) {
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
		if (character === '(') parentheses += 1
		else if (character === ')') {
			parentheses -= 1
			if (parentheses === 0) return false
		} else if (character === '{') braces += 1
		else if (character === '}') braces -= 1
		else if (character === '[') brackets += 1
		else if (character === ']') brackets -= 1
		else if (character === ',' && parentheses === 1 && braces === 0 && brackets === 0) return true
	}
	return true
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

function reportAt(displayPath, source, index, message) {
	if (isExpectedError(source, index)) return
	failures.push(`${displayPath}:${lineAt(source, index)}: ${message}`)
}

function isExpectedError(source, index) {
	const lineStart = source.lastIndexOf('\n', index - 1) + 1
	const before = source.slice(Math.max(0, source.lastIndexOf('\n', lineStart - 2) + 1), lineStart)
	return before.includes('@ts-expect-error')
}

function lineAt(source, index) {
	return source.slice(0, index).split('\n').length
}

function isVitestFive(version) {
	return /^[~^]?5(?:\.\d+){0,2}(?:[-+].*)?$/.test(version)
}

function escapeRegExp(value) {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function display(path) {
	return relative(root, path).replaceAll('\\', '/')
}

function uniquePaths(paths) {
	return [...new Set(paths)]
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'))
}

async function exists(path) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function collectFiles(directory, result) {
	let entries
	try {
		entries = await readdir(directory, { withFileTypes: true })
	} catch (error) {
		if (error?.code === 'ENOENT') return
		throw error
	}
	for (const entry of entries) {
		const path = resolve(directory, entry.name)
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) await collectFiles(path, result)
			continue
		}
		if (!entry.isFile()) continue
		if (sourceExtensions.test(entry.name)) result.code.push(path)
		if (entry.name === 'package.json') result.manifests.push(path)
		if (entry.name === 'pnpm-lock.yaml') result.locks.push(path)
		if (entry.name === 'pnpm-workspace.yaml') result.workspaces.push(path)
	}
}
