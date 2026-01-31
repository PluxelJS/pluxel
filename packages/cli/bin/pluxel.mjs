#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distCli = resolve(__dirname, '../dist/cli.mjs')

if (!existsSync(distCli)) {
	console.error('[pluxel] CLI build missing. Run `pnpm --filter @pluxel/cli build` first.')
	process.exit(1)
}

await import(pathToFileURL(distCli).href)
