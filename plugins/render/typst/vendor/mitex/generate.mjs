import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Maintainer operation only. Normal builds and document compilation are offline.
const archiveUrl = 'https://packages.typst.org/preview/mitex-0.2.7.tar.gz'
const archiveSha256 = '0159e214845e49cbdc332d9d572da112dae5ad248072e0a7680d38c8307c2e15'
const sourceFiles = ['mitex.typ', 'specs/mod.typ', 'specs/prelude.typ', 'specs/latex/standard.typ']
const directory = await mkdtemp(join(tmpdir(), 'pluxel-mitex-vendor-'))
try {
	const response = await fetch(archiveUrl)
	if (!response.ok) throw new Error(`MiTeX archive request failed: ${response.status}`)
	const archive = new Uint8Array(await response.arrayBuffer())
	if (createHash('sha256').update(archive).digest('hex') !== archiveSha256)
		throw new Error('MiTeX archive digest does not match the reviewed version')
	const archivePath = join(directory, 'mitex.tar.gz')
	const unpacked = join(directory, 'package')
	await writeFile(archivePath, archive)
	await mkdir(unpacked)
	execFileSync('tar', ['-xzf', archivePath, '-C', unpacked])
	const files = {}
	for (const path of sourceFiles) {
		let source = await readFile(join(unpacked, path), 'utf8')
		if (path === 'mitex.typ') {
			const original = 'plugin("./mitex.wasm")'
			if (source.split(original).length !== 2)
				throw new Error('MiTeX plugin loader no longer matches the reviewed adaptation')
			source = source.replace(original, 'plugin(bytes(json("mitex.wasm.json")))')
		}
		files[`_editor/mitex/${path}`] = source
	}
	// Typst's bytes(json(...)) preserves the existing text-only generated-file contract.
	files['_editor/mitex/mitex.wasm.json'] = JSON.stringify([
		...(await readFile(join(unpacked, 'mitex.wasm'))),
	])
	const license = await readFile(join(unpacked, 'LICENSE'), 'utf8')
	files['_editor/mitex/LICENSE'] = license
	files['_editor/mitex/NOTICE'] =
		'MiTeX 0.2.7 by Myriad-Dreamin, OrangeX4, Enter-tainer, and Shichien.\n' +
		'Source: https://github.com/mitex-rs/mitex\n' +
		'Licensed under Apache-2.0; see LICENSE.\n' +
		'Pluxel modification: load the unchanged WASM from a JSON byte array.\n'
	await writeFile(new URL('LICENSE', import.meta.url), license)
	const target = new URL('../../src/tiptap/mitex-files.json', import.meta.url)
	await writeFile(target, `${JSON.stringify(files, null, '\t')}\n`)
	console.log(`Generated ${fileURLToPath(target)} from MiTeX 0.2.7`)
} finally {
	await rm(directory, { recursive: true, force: true })
}
