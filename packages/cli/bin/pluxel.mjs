#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distCli = resolve(__dirname, '../dist/cli.mjs')

if (existsSync(distCli)) {
	await import(pathToFileURL(distCli).href)
} else {
	console.error('[pluxel] CLI build is missing.')
	console.error('Run `pnpm --filter @pluxel/cli build` before invoking the workspace CLI.')
	process.exit(1)
}
