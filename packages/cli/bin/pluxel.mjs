#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distCli = resolve(__dirname, '../dist/cli.mjs')
const startupCwd = process.cwd()
const startupCwdSymbol = Symbol.for('pluxel.cli.startupCwd')
const directModeSymbol = Symbol.for('pluxel.cli.direct')

globalThis[startupCwdSymbol] ??= startupCwd

if (!globalThis[directModeSymbol]) {
	const delegated = await delegateToProjectLocalCli(startupCwd)
	if (delegated) {
		await import(pathToFileURL(delegated).href)
	} else {
		await runCurrentCli()
	}
} else {
	await runCurrentCli()
}

async function runCurrentCli() {
	if (existsSync(distCli)) {
		await import(pathToFileURL(distCli).href)
	} else {
		console.error('[pluxel] CLI build is missing.')
		console.error('Run `pnpm --filter @pluxel/cli build` before invoking the workspace CLI.')
		process.exit(1)
	}
}

async function delegateToProjectLocalCli(cwd) {
	const projectManifest = await findNearestCliDeclaration(cwd)
	if (!projectManifest) return undefined

	const currentExecutable = await realpath(fileURLToPath(import.meta.url))
	const localExecutable = await resolveDeclaredCliBin(projectManifest)
	let localRealpath
	try {
		localRealpath = await realpath(localExecutable)
	} catch (error) {
		console.error(`[pluxel] Resolved project-local @pluxel/cli bin, but it is missing.`)
		console.error(`Expected executable: ${localExecutable}`)
		process.exit(1)
	}
	if (localRealpath === currentExecutable) return undefined
	process.argv[1] = localExecutable
	return localExecutable
}

async function findNearestCliDeclaration(startDir) {
	let dir = resolve(startDir)
	while (true) {
		const manifestPath = resolve(dir, 'package.json')
		try {
			const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
			if (declaresLocalCli(manifest)) return { dir, path: manifestPath }
		} catch (error) {
			if (!isNotFound(error)) throw error
		}

		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

function declaresLocalCli(manifest) {
	return Boolean(
		manifest &&
		typeof manifest === 'object' &&
		(hasOwn(manifest.dependencies, '@pluxel/cli') ||
			hasOwn(manifest.devDependencies, '@pluxel/cli')),
	)
}

async function resolveDeclaredCliBin(projectManifest) {
	const require = createRequire(projectManifest.path)
	let cliManifestPath
	try {
		cliManifestPath = require.resolve('@pluxel/cli/package.json')
	} catch (error) {
		console.error(`[pluxel] ${projectManifest.path} declares @pluxel/cli, but it is not installed.`)
		console.error('Run the project package manager install before invoking `pluxel`.')
		process.exit(1)
	}

	const cliManifestRoot = dirname(cliManifestPath)
	const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8'))
	const bin =
		typeof cliManifest.bin === 'string'
			? cliManifest.bin
			: cliManifest.bin && typeof cliManifest.bin === 'object'
				? cliManifest.bin.pluxel
				: undefined
	if (!bin) {
		console.error(`[pluxel] Resolved @pluxel/cli at ${cliManifestPath}, but it has no pluxel bin.`)
		process.exit(1)
	}
	return resolve(cliManifestRoot, bin)
}

function hasOwn(value, key) {
	return Boolean(
		value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key),
	)
}

function isNotFound(error) {
	return (
		error &&
		typeof error === 'object' &&
		'code' in error &&
		(error.code === 'ENOENT' || error.code === 'MODULE_NOT_FOUND')
	)
}
