import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from '../../../packages/rolldown/node_modules/rolldown/dist/index.mjs'

const root = import.meta.dirname
const packageLink = resolve(root, 'node_modules/@fixture/records-provider')
const outputDir = mkdtempSync(join(tmpdir(), 'pluxel-rpc-build-'))
mkdirSync(dirname(packageLink), { recursive: true })
symlinkSync(resolve(root, 'provider'), packageLink, 'dir')

try {
	const { artifacts, build } = await import('./check.mjs')
	const { publication: packagePublication } = await import('./package-entry.ts')
	for (const [entry, message] of [
		['publisher-any.ts', /any cannot produce an exact client declaration/],
		['publisher-indexed.ts', /index-signature DTO is not supported/],
		['publisher-date.ts', /Date is not a JSON DTO/],
		['publisher-union.ts', /unsupported wire schema/],
	]) {
		const { publication } = await import(pathToFileURL(resolve(root, entry)).href)
		assert.throws(() => build(publication, entry), message)
	}
	const packageArtifact = build(packagePublication, 'package-entry.ts')
	assert.equal(packageArtifact.contract.hash, artifacts.baseline.contract.hash)
	assert.equal(packageArtifact.declaration, artifacts.baseline.declaration)
	assert(
		packageArtifact.references.some((item) => item.file === 'provider/commands.ts'),
		'package export must resolve to the real Command declaration',
	)
	assert(
		packageArtifact.sources.some((item) => item.file === 'provider/dto.ts'),
		'cross-package Receipt must be included in source binding',
	)

	async function compile(entry, expected) {
		let bound = false
		const input = resolve(root, entry)
		const { publication } = await import(pathToFileURL(input).href)
		const current = build(publication, entry)
		const referenceImports = current.references
			.map(({ file, export: name }, index) => {
				assert.match(name, /^[A-Za-z_$][\w$]*$/)
				return `import { ${name} as __rpcCommand${index} } from './${file.replace(/\.ts$/, '.js')}';`
			})
			.join('\n')
		const bindings = current.references
			.map(({ method }, index) => `${JSON.stringify(method)}: __rpcCommand${index}`)
			.join(', ')
		const bundle = await rolldown({
			input,
			plugins: [
				{
					name: 'rpc-publication-binding-probe',
					transform(code, id) {
						if (id !== input) return null
						if (expected.integrity !== current.integrity) {
							this.error(`stale RPC artifact at publication site: ${entry}`)
						}
						bound = true
						return `${referenceImports}\n${code}\nexport const rpcPublication = Object.freeze({ api: publication, bindings: Object.freeze({ ${bindings} }), artifact: ${JSON.stringify(
							{
								format: expected.format,
								integrity: expected.integrity,
								contract: expected.contract,
								methods: expected.methods,
								types: expected.types,
							},
						)} });\n`
					},
				},
			],
		})
		try {
			const result = await bundle.write({
				dir: outputDir,
				format: 'esm',
				entryFileNames: `${entry}.mjs`,
			})
			assert(bound, `publication transform must run for ${entry}`)
			const output = result.output.find((item) => item.type === 'chunk' && item.isEntry)
			assert(output)
			const generated = await import(pathToFileURL(resolve(outputDir, output.fileName)).href)
			assert.equal(generated.rpcPublication.api, generated.publication)
			assert.equal(generated.rpcPublication.artifact.integrity, expected.integrity)
			assert.equal(generated.rpcPublication.artifact.contract.hash, expected.contract.hash)
			return { generated, code: readFileSync(resolve(outputDir, output.fileName), 'utf8') }
		} finally {
			await bundle.close()
		}
	}

	const packageBuild = await compile('package-entry.ts', packageArtifact)
	const receipt = await packageBuild.generated.publication.commands.write.execute({
		id: 'build',
		offset: '2',
	})
	assert(receipt.isOk())
	assert.equal(receipt.value.operationId, 'build:2')
	assert.match(packageBuild.code, /rpcPublication/)
	for (const [method, command] of Object.entries(packageBuild.generated.rpcPublication.bindings))
		assert.equal(command, packageBuild.generated.publication.commands[method])
	const originalWrite = packageBuild.generated.publication.commands.write
	packageBuild.generated.publication.commands.write = { ...originalWrite }
	assert.notEqual(
		packageBuild.generated.rpcPublication.bindings.write,
		packageBuild.generated.publication.commands.write,
		'publish can reject a descriptor-identical but different Command object',
	)
	packageBuild.generated.publication.commands.write = originalWrite

	await assert.rejects(
		compile('publisher-binding.ts', artifacts.baseline),
		/stale RPC artifact at publication site/,
	)
	await assert.rejects(
		compile('publisher-docs.ts', artifacts.baseline),
		/stale RPC artifact at publication site/,
	)
	const docsBuild = await compile('publisher-docs.ts', artifacts.docs)
	assert.equal(
		docsBuild.generated.rpcPublication.artifact.contract.hash,
		artifacts.baseline.contract.hash,
	)
	assert.notEqual(
		docsBuild.generated.rpcPublication.artifact.integrity,
		artifacts.baseline.integrity,
	)

	console.log(
		JSON.stringify(
			{
				rolldownPackageImport: true,
				bundledPublicationBinding: true,
				exactCommandIdentity: true,
				staleCommandBindingRejected: true,
				staleDocsArtifactRejected: true,
				docsHashStable: true,
				unsupportedDtosRejected: true,
			},
			null,
			2,
		),
	)
} finally {
	rmSync(outputDir, { recursive: true, force: true })
	rmSync(packageLink, { force: true })
}
