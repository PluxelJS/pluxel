#!/usr/bin/env node
import { spawn } from 'node:child_process'
import {
	access,
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	rmdir,
} from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

type CreateOptions = {
	directory: string
	install: boolean
	help: boolean
	version: boolean
}

type StarterAssets = {
	template: string
	docs: string
}

type PlannedFile = {
	relativePath: string
	sourcePath: string
	mode: number
}

const packageRoot = resolve(import.meta.dirname, '..')

try {
	const options = parseArguments(process.argv.slice(2))
	if (options.help) {
		printHelp()
		process.exit(0)
	}
	if (options.version) {
		const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
			version: string
		}
		console.info(manifest.version)
		process.exit(0)
	}

	const assets = await resolveAssets()
	const destination = resolve(process.cwd(), options.directory)
	await createProject(assets, destination)
	console.info(`\nCreated the Pluxel example workspace at ${destination}`)
	console.info('Versioned Pluxel documentation is available in docs/pluxel/.')

	if (options.install) {
		console.info('\nInstalling dependencies with pnpm…')
		await run('pnpm', ['install'], destination)
	}

	console.info(`\nNext: cd ${relative(process.cwd(), destination) || '.'}`)
	if (!options.install) console.info('      pnpm install')
	console.info('      pnpm dev')
} catch (error) {
	console.error(`[create-pluxel] ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
}

function parseArguments(args: readonly string[]): CreateOptions {
	let directory: string | undefined
	let install = true
	let help = false
	let version = false
	for (const argument of args) {
		if (argument === '--help' || argument === '-h') {
			help = true
			continue
		}
		if (argument === '--version' || argument === '-v') {
			version = true
			continue
		}
		if (argument === '--install') {
			install = true
			continue
		}
		if (argument === '--no-install') {
			install = false
			continue
		}
		if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`)
		if (directory !== undefined) throw new Error('Only one destination directory may be provided')
		directory = argument
	}
	if (help && version) throw new Error('Use either --help or --version')
	return { directory: directory ?? 'pluxel-example', install, help, version }
}

function printHelp(): void {
	console.info(`create-pluxel [directory] [options]

Create the fixed Pluxel example monorepo and its version-matched documentation.

Options:
  --install       Install dependencies with pnpm (default)
  --no-install    Copy the project without installing dependencies
  -h, --help      Show this help
  -v, --version   Show the package version`)
}

async function resolveAssets(): Promise<StarterAssets> {
	const candidates = [
		{
			template: resolve(packageRoot, 'dist/template'),
			docs: resolve(packageRoot, 'dist/docs'),
		},
		{
			template: resolve(packageRoot, 'template'),
			docs: resolve(packageRoot, '../../docs'),
		},
	]
	for (const candidate of candidates) {
		if ((await isDirectory(candidate.template)) && (await isDirectory(candidate.docs))) {
			return candidate
		}
	}
	throw new Error('Starter assets are missing. Reinstall @pluxel/create or run its build first.')
}

async function createProject(assets: StarterAssets, destination: string): Promise<void> {
	const destinationState = await inspectDestination(destination)
	const parent = dirname(destination)
	await mkdir(parent, { recursive: true })
	const staging = await mkdtemp(resolve(parent, '.create-pluxel-'))
	try {
		await copyTree(assets.template, staging, (path) => (path === 'gitignore' ? '.gitignore' : path))
		await copyTree(assets.docs, resolve(staging, 'docs/pluxel'))
		if (destinationState === 'empty-directory') {
			await rmdir(destination)
		}
		await rename(staging, destination)
	} catch (error) {
		await rm(staging, { recursive: true, force: true })
		throw error
	}
}

async function inspectDestination(destination: string): Promise<'missing' | 'empty-directory'> {
	try {
		const stat = await lstat(destination)
		if (stat.isSymbolicLink()) throw new Error(`Destination must not be a symlink: ${destination}`)
		if (!stat.isDirectory()) throw new Error(`Destination is not a directory: ${destination}`)
		const entries = await readdir(destination)
		if (entries.length > 0) throw new Error(`Destination is not empty: ${destination}`)
		return 'empty-directory'
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return 'missing'
		throw error
	}
}

async function copyTree(
	source: string,
	destination: string,
	mapRelativePath: (path: string) => string = (path) => path,
): Promise<void> {
	const plan: PlannedFile[] = []
	await collectFiles(source, '', plan)
	for (const item of plan) {
		const mapped = mapRelativePath(item.relativePath)
		const destinationPath = resolve(destination, mapped)
		if (relative(destination, destinationPath).startsWith('..')) {
			throw new Error(`Asset path escapes the destination: ${mapped}`)
		}
		await mkdir(dirname(destinationPath), { recursive: true })
		await copyFile(item.sourcePath, destinationPath)
		await chmod(destinationPath, item.mode)
	}
}

async function collectFiles(root: string, current: string, plan: PlannedFile[]): Promise<void> {
	const directory = resolve(root, current)
	const directoryStat = await lstat(directory)
	if (directoryStat.isSymbolicLink()) throw new Error(`Refusing to copy symlink: ${directory}`)
	if (!directoryStat.isDirectory()) throw new Error(`Expected asset directory: ${directory}`)
	const entries = await readdir(directory, { withFileTypes: true })
	entries.sort((left, right) => left.name.localeCompare(right.name))
	for (const entry of entries) {
		const relativePath = current ? `${current}/${entry.name}` : entry.name
		const sourcePath = resolve(root, relativePath)
		if (entry.isSymbolicLink()) throw new Error(`Refusing to copy symlink: ${sourcePath}`)
		if (entry.isDirectory()) {
			await collectFiles(root, relativePath, plan)
			continue
		}
		if (!entry.isFile()) throw new Error(`Refusing to copy non-regular file: ${sourcePath}`)
		const stat = await lstat(sourcePath)
		if (!stat.isFile()) throw new Error(`Refusing to copy non-regular file: ${sourcePath}`)
		plan.push({ relativePath, sourcePath, mode: stat.mode & 0o777 })
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		await access(path)
		return (await lstat(path)).isDirectory()
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return false
		throw error
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
	await new Promise<void>((accept, reject) => {
		const child = spawn(process.platform === 'win32' ? `${command}.cmd` : command, args, {
			cwd,
			stdio: 'inherit',
		})
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) accept()
			else reject(new Error(`${command} exited with ${signal ?? `code ${code}`}`))
		})
	})
}
