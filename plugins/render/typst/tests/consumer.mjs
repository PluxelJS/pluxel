#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
for (const file of [
	'dist/index.mjs',
	'dist/browser.mjs',
	'dist/source.mjs',
	'dist/source/browser.mjs',
	'dist/source/library.mjs',
	'dist/source/typst_ast_bg.wasm',
	'dist/tiptap.mjs',
	'dist/tiptap/react.mjs',
	'dist/tiptap/style.css',
	'native/compiler.node',
]) {
	await access(resolve(root, file)).catch(() => {
		throw new Error(`Build @pluxel/plugin-typst before consumer acceptance: missing ${file}`)
	})
}
const child = spawn('vp', ['test', 'run', '--config', 'tests/consumer.config.mts'], {
	cwd: root,
	env: process.env,
	stdio: 'inherit',
})
child.once('error', (error) => {
	console.error(error)
	process.exitCode = 1
})
child.once('exit', (code) => {
	process.exitCode = code ?? 1
})
