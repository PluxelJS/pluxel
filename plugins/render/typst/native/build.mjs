import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const cache = join(root, '.build')
const source = join(cache, 'source')
const output = join(root, 'compiler.node')
const stampPath = join(root, 'compiler.stamp.json')
const revision = '0501ced21131dccc68d12c5602cdb20909a52541'
const upstream = 'https://github.com/Myriad-Dreamin/typst.ts.git'
const toolchain = '1.99.1'
const target = process.env.CARGO_TARGET_DIR
	? resolve(process.env.CARGO_TARGET_DIR)
	: join(cache, 'target')
const binaryName = {
	win32: 'typst_ts_node_compiler.dll',
	darwin: 'libtypst_ts_node_compiler.dylib',
	linux: 'libtypst_ts_node_compiler.so',
}[process.platform]
if (!binaryName) throw new Error(`Unsupported native compiler platform: ${process.platform}`)
if (process.env.CARGO_BUILD_TARGET) {
	throw new Error(
		'Cross compilation is unsupported; build the compiler on its target OS and architecture.',
	)
}
const hash = createHash('sha256').update(
	`${revision}:${toolchain}:${process.platform}:${process.arch}`,
)
for (const file of ['build.mjs', 'compiler.patch', 'source_map.rs', 'page_render.rs']) {
	hash.update(await readFile(join(root, file)))
}
const fingerprint = hash.digest('hex')
try {
	const stamp = JSON.parse(await readFile(stampPath, 'utf8'))
	const artifactHash = createHash('sha256')
		.update(await readFile(output))
		.digest('hex')
	if (stamp.fingerprint === fingerprint && stamp.artifactHash === artifactHash) {
		console.log(`[typst:native] Ready (${process.platform}-${process.arch}).`)
		process.exit(0)
	}
} catch (error) {
	if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
}
function run(command, args, cwd = root) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, CARGO_TARGET_DIR: target },
			stdio: 'inherit',
		})
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) resolveRun()
			else reject(new Error(`${command} exited with ${signal ?? code}`))
		})
	})
}
await mkdir(cache, { recursive: true })
const lock = join(cache, 'build.lock')
try {
	await mkdir(lock)
} catch (error) {
	if (error.code === 'EEXIST')
		throw new Error(
			`Native build already locked: ${lock}. If a prior build was interrupted, remove this directory and retry.`,
			{ cause: error },
		)
	throw error
}
try {
	console.log(`[typst:native] Building ${revision} for ${process.platform}-${process.arch}.`)
	await run('cargo', [`+${toolchain}`, '--version'])
	await mkdir(source, { recursive: true })
	try {
		await access(join(source, '.git'))
	} catch {
		await run('git', ['init', source])
	}
	await run('git', ['fetch', '--depth', '1', upstream, revision], source)
	await run('git', ['checkout', '--force', '--detach', revision], source)
	await run('git', ['apply', '--unidiff-zero', '--check', join(root, 'compiler.patch')], source)
	await run('git', ['apply', '--unidiff-zero', join(root, 'compiler.patch')], source)
	for (const file of ['source_map.rs', 'page_render.rs']) {
		await copyFile(join(root, file), join(source, 'packages/typst.node/src', file))
	}
	await run(
		'cargo',
		[`+${toolchain}`, 'build', '--release', '--locked', '-p', 'typst-ts-node-compiler'],
		source,
	)
	const artifact = join(target, 'release', binaryName)
	await copyFile(artifact, `${output}.tmp`)
	await rename(`${output}.tmp`, output)
	const artifactHash = createHash('sha256')
		.update(await readFile(output))
		.digest('hex')
	await writeFile(
		stampPath,
		`${JSON.stringify({ fingerprint, artifactHash, revision, toolchain, platform: process.platform, arch: process.arch }, null, 2)}\n`,
	)
	console.log(`[typst:native] Built ${output}`)
} finally {
	await rm(lock, { recursive: true, force: true })
	await rm(`${output}.tmp`, { force: true })
}
