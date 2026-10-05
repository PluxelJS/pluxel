import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync as readlink,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import { fileURLToPath } from 'node:url'
import { discoverCliCheckout } from '../source/registry'

export interface DevelopmentSource {
	kind: 'git' | 'release'
	root: string
	version: string
}
interface DevelopmentState {
	version: 1
	source: DevelopmentSource
	complete: boolean
}
const statePath = '.pluxel/development.json'
const skillPath = '.agents/skills/pluxel-development'
const agentStart = '<!-- pluxel:development -->'
const agentEnd = '<!-- /pluxel:development -->'
const instructions = `${agentStart}\n\nFor Pluxel development, read .agents/skills/pluxel-development/SKILL.md and docs/pluxel/development/index.md.\nMissing generated resources: Git users run their upstream CLI's source install; npm users install dependencies then run pnpm exec pluxel workspace setup.\nKeep upstream instructions in their source; maintain only project-specific constraints here.\n${agentEnd}`

export function developmentSource(moduleUrl = import.meta.url): DevelopmentSource {
	const git = Object.values(discoverCliCheckout(moduleUrl))[0]
	let root = dirname(realpathSync(fileURLToPath(moduleUrl)))
	while (!existsSync(resolve(root, 'package.json'))) {
		const parent = dirname(root)
		if (parent === root) throw new Error('Cannot locate CLI package')
		root = parent
	}
	const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
	return { kind: git ? 'git' : 'release', root: git ?? root, version: manifest.version }
}

function targets(source: DevelopmentSource) {
	return new Map([
		['docs/pluxel', resolve(source.root, source.kind === 'git' ? 'docs' : 'dist/resources/docs')],
		[skillPath, resolve(source.root, source.kind === 'git' ? skillPath : 'dist/resources/skill')],
	])
}
function state(root: string): DevelopmentState | undefined {
	const path = resolve(root, statePath)
	if (!existsSync(path)) return undefined
	const value = JSON.parse(readFileSync(path, 'utf8'))
	if (
		value?.version !== 1 ||
		!['git', 'release'].includes(value.source?.kind) ||
		typeof value.source?.root !== 'string' ||
		!isAbsolute(value.source.root) ||
		typeof value.source?.version !== 'string' ||
		typeof value.complete !== 'boolean'
	) {
		throw new Error(`Invalid development setup state: ${path}`)
	}
	return value
}
function stat(path: string) {
	try {
		return lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		return undefined
	}
}
export function assertDevelopmentBinding(
	root: string,
	source: DevelopmentSource,
	previous = state(root),
) {
	if (
		previous &&
		(previous.source.kind !== source.kind ||
			(source.kind === 'git' && previous.source.root !== source.root))
	) {
		throw new Error(
			`Development source mismatch at ${root}: expected ${previous.source.root}, got ${source.root}. Use the bound CLI; setup does not switch sources.`,
		)
	}
}
function assertNotTracked(root: string, path: string) {
	let repository = root
	while (!existsSync(resolve(repository, '.git'))) {
		const parent = dirname(repository)
		if (parent === repository) return
		repository = parent
	}
	const result = spawnSync('git', ['-C', root, 'ls-files', '--', path], { encoding: 'utf8' })
	if (result.error) throw result.error
	if (result.status === 0 && result.stdout.trim())
		throw new Error(
			`Generated path is tracked by Git: ${path}. Remove it from the index before setup.`,
		)
}
function assertParents(root: string, path: string) {
	let parent = dirname(resolve(root, path))
	while (parent !== root) {
		const item = stat(parent)
		if (item && (!item.isDirectory() || item.isSymbolicLink()))
			throw new Error(`Setup parent must be a real directory: ${parent}`)
		parent = dirname(parent)
	}
}
export function preflightDevelopmentSetup(root: string, source = developmentSource()) {
	root = realpathSync(root)
	if (source.kind === 'git' && root === source.root) return
	const previous = state(root)
	assertDevelopmentBinding(root, source, previous)
	for (const [path, target] of targets(source)) {
		if (!existsSync(target)) throw new Error(`Missing development resource: ${target}`)
		readFileSync(resolve(target, path === skillPath ? 'SKILL.md' : 'development/index.md'), 'utf8')
		assertParents(root, path)
		assertNotTracked(root, path)
		const current = stat(resolve(root, path))
		if (current) {
			const oldTarget = previous && targets(previous.source).get(path)
			if (
				!current.isSymbolicLink() ||
				!oldTarget ||
				resolve(dirname(resolve(root, path)), readlink(resolve(root, path))) !== oldTarget
			) {
				throw new Error(
					`Refusing to replace unmanaged development resource: ${resolve(root, path)}`,
				)
			}
		}
	}
	for (const path of ['.gitignore', 'AGENTS.md', statePath]) {
		assertParents(root, path)
		const item = stat(resolve(root, path))
		if (item && (!item.isFile() || item.isSymbolicLink()))
			throw new Error(`Setup requires a regular file: ${resolve(root, path)}`)
	}
	const agents = existsSync(resolve(root, 'AGENTS.md'))
		? readFileSync(resolve(root, 'AGENTS.md'), 'utf8')
		: ''
	if (
		(agents.includes(agentStart) || agents.includes(agentEnd)) &&
		!new RegExp(`${agentStart}[\\s\\S]*?${agentEnd}`).test(agents)
	)
		throw new Error('Malformed Pluxel AGENTS block')
}
function writeAtomic(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true })
	const temp = `${path}.${process.pid}.tmp`
	try {
		writeFileSync(temp, text)
		renameSync(temp, path)
	} finally {
		rmSync(temp, { force: true })
	}
}
export function markDevelopmentIncomplete(root: string, source = developmentSource()) {
	if (source.kind === 'git' && realpathSync(root) === source.root) return
	writeAtomic(
		resolve(root, statePath),
		JSON.stringify({ version: 1, source, complete: false }, null, 2) + '\n',
	)
}
export function setupDevelopmentWorkspace(root: string, source = developmentSource()) {
	root = realpathSync(root)
	if (source.kind === 'git' && root === source.root) return []
	preflightDevelopmentSetup(root, source)
	mkdirSync(resolve(root, '.pluxel'), { recursive: true })
	const lock = resolve(root, '.pluxel/source-install.lock')
	let ownsLock = false
	try {
		writeFileSync(lock, String(process.pid), { flag: 'wx' })
		ownsLock = true
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== 'EEXIST' ||
			readFileSync(lock, 'utf8').trim() !== String(process.pid)
		)
			throw new Error(`Another setup/install owns ${lock}`, { cause: error })
	}
	try {
		preflightDevelopmentSetup(root, source)
		markDevelopmentIncomplete(root, source)
		for (const [path, target] of targets(source)) {
			const output = resolve(root, path)
			mkdirSync(dirname(output), { recursive: true })
			const temp = `${output}.${process.pid}.tmp`
			try {
				symlinkSync(
					process.platform === 'win32' ? target : relative(dirname(output), target),
					temp,
					process.platform === 'win32' ? 'junction' : 'dir',
				)
				renameSync(temp, output)
			} finally {
				rmSync(temp, { force: true })
			}
		}
		const ignorePath = resolve(root, '.gitignore')
		let ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : ''
		for (const path of ['/.pluxel/', '/.pnpmfile.cjs', '/docs/pluxel', `/${skillPath}`]) {
			if (!ignore.split(/\r?\n/).includes(path))
				ignore += `${ignore.endsWith('\n') || !ignore ? '' : '\n'}${path}\n`
		}
		writeAtomic(ignorePath, ignore)
		const agentPath = resolve(root, 'AGENTS.md')
		const agents = existsSync(agentPath)
			? readFileSync(agentPath, 'utf8')
			: '# Project instructions\n'
		writeAtomic(
			agentPath,
			agents.includes(agentStart)
				? agents.replace(new RegExp(`${agentStart}[\\s\\S]*?${agentEnd}`), instructions)
				: `${agents.trimEnd()}\n\n${instructions}\n`,
		)
		writeAtomic(
			resolve(root, statePath),
			JSON.stringify({ version: 1, source, complete: true }, null, 2) + '\n',
		)
		return [...targets(source)].map(([path, target]) => `${resolve(root, path)} -> ${target}`)
	} finally {
		if (ownsLock) rmSync(lock, { force: true })
	}
}
export function diagnoseDevelopmentWorkspace(root: string, source = developmentSource()): string[] {
	root = realpathSync(root)
	if (source.kind === 'git' && root === source.root) return []
	const fix = source.kind === 'git' ? 'pluxel source install' : 'pnpm exec pluxel workspace setup'
	try {
		if (existsSync(resolve(root, '.pluxel/source-install.lock')))
			return [`Development install in progress at ${root}`]
		const current = state(root)
		assertDevelopmentBinding(root, source, current)
		if (!current?.complete) return [`Development setup incomplete at ${root}; run ${fix}`]
		const errors: string[] = []
		for (const [path, target] of targets(source)) {
			const output = resolve(root, path)
			readFileSync(
				resolve(output, path === skillPath ? 'SKILL.md' : 'development/index.md'),
				'utf8',
			)
			if (
				!stat(output)?.isSymbolicLink() ||
				!existsSync(output) ||
				realpathSync(output) !== realpathSync(target)
			)
				errors.push(`Development resource mismatch: ${output}; expected ${target}; run ${fix}`)
		}
		if (current.source.version !== source.version)
			errors.push(`Development resources need refresh; run ${fix}`)
		return errors
	} catch (error) {
		return [
			`Development resource mismatch at ${root}: ${error instanceof Error ? error.message : String(error)}; run ${fix}`,
		]
	}
}
