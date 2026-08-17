#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const cliManifestPath = require.resolve('@pluxel/cli/package.json')
const cliManifestRoot = dirname(cliManifestPath)
const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8'))
const cliBin =
	typeof cliManifest.bin === 'string'
		? cliManifest.bin
		: cliManifest.bin && typeof cliManifest.bin === 'object'
			? cliManifest.bin.pluxel
			: undefined

if (!cliBin) {
	console.error(`[pluxel] Resolved @pluxel/cli at ${cliManifestPath}, but it has no pluxel bin.`)
	process.exit(1)
}

const pluxelBin = resolve(cliManifestRoot, cliBin)
globalThis[Symbol.for('pluxel.cli.direct')] = true
globalThis[Symbol.for('pluxel.cli.startupCwd')] ??= process.cwd()
process.argv = [process.argv[0], pluxelBin, 'new', ...process.argv.slice(2)]
await import(pathToFileURL(pluxelBin).href)
