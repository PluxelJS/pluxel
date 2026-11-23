import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
	dependencies,
	isPackageName,
	packageDocument,
	record,
	type PackageDocument,
	type Manifest,
} from './package-document.ts'
import type { LocalPackageLocation } from './contracts.ts'

const readmeLimit = 256 * 1024
const manifestLimit = 1024 * 1024

function missing(error: unknown) {
	return record(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

export async function textFile(path: string, limit: number) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = await file.stat()
		if (!stat.isFile()) throw new Error('Package document must be a regular file')
		const bytes = Buffer.alloc(Math.min(stat.size, limit) + 1)
		let length = 0
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
			if (!bytesRead) break
			length += bytesRead
		}
		return { text: bytes.toString('utf8', 0, Math.min(limit, length)), truncated: length > limit }
	} finally {
		await file.close()
	}
}

export async function manifestAt(directory: string): Promise<Manifest> {
	const file = await textFile(join(directory, 'package.json'), manifestLimit)
	if (file.truncated) throw new Error('The installed package manifest exceeds 1 MiB')
	const value: unknown = JSON.parse(file.text)
	if (!record(value) || typeof value.name !== 'string')
		throw new Error('Invalid installed package manifest')
	return value
}

// Follow Node's ancestor node_modules lookup from the actual issuer, including pnpm peer slots.
// Read the package directory itself so restrictive or conditional exports never execute code.
async function findDependency(issuer: string, name: string) {
	for (let directory = issuer; ; directory = dirname(directory)) {
		try {
			if (basename(directory) !== 'node_modules')
				return await realpath(join(directory, 'node_modules', name))
		} catch (error) {
			if (!missing(error)) throw error
		}
		if (dirname(directory) === directory) return null
	}
}

export async function readLocalPackage(
	location: LocalPackageLocation,
	applicationRoot: string,
	managed: readonly Readonly<{ name: string; packageRoot: string }>[],
): Promise<PackageDocument | null> {
	if (
		!location ||
		!['application', 'managed'].includes(location.source) ||
		!Array.isArray(location.path) ||
		location.path.length === 0 ||
		location.path.length > 64 ||
		!location.path.every(isPackageName)
	)
		throw new TypeError('Expected a local package source and a path of package names')
	const [name, ...edges] = location.path
	let directory: string | null
	if (location.source === 'managed')
		directory = managed.find((pkg) => pkg.name === name)?.packageRoot ?? null
	else {
		let app: Manifest | undefined
		try {
			app = await manifestAt(applicationRoot)
		} catch (error) {
			if (!missing(error)) throw error
		}
		directory = app?.name === name ? applicationRoot : await findDependency(applicationRoot, name)
	}
	if (!directory) return null
	let manifest = await manifestAt(directory)
	for (const dependency of edges) {
		if (!dependencies(manifest).some((item) => item.name === dependency)) return null
		directory = await findDependency(directory, dependency)
		if (!directory) return null
		manifest = await manifestAt(directory)
	}
	const files = await readdir(directory, { withFileTypes: true })
	const names = files
		.filter((file) => file.isFile())
		.map((file) => file.name)
		.sort()
	const readme = ['readme.md', 'readme.markdown', 'readme', 'readme.txt']
		.map((candidate) => names.find((file) => file.toLowerCase() === candidate))
		.find(Boolean)
	return packageDocument(
		manifest.name as string,
		manifest,
		readme ? await textFile(join(directory, readme), readmeLimit) : null,
	)
}
