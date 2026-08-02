import { randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { type ArgValues, define } from 'gunshi'
import {
	distributionCommandDefinition,
	distributionCorrelateArgs,
	distributionCorrelateDefinition,
	distributionCreateDefinition,
	distributionInspectDefinition,
	distributionMarkArgs,
	distributionMarkDefinition,
	distributionRootArgs,
	distributionVerifyArgs,
	distributionVerifyDefinition,
} from '../command-manifest'

type RootValues = ArgValues<typeof distributionRootArgs>
type VerifyValues = ArgValues<typeof distributionVerifyArgs>
type MarkValues = ArgValues<typeof distributionMarkArgs>
type CorrelateValues = ArgValues<typeof distributionCorrelateArgs>

export const distributionCreateCommand = define({
	...distributionCreateDefinition,
	async run(ctx) {
		const distribution = await import('@pluxel/rolldown/distribution')
		const root = resolveRoot(ctx.values as RootValues)
		const manifest = await distribution.createDistributionManifest(root)
		ctx.log(
			`[distribution] created ${distribution.DISTRIBUTION_MANIFEST_FILE} with ${manifest.entries.length} entries`,
		)
	},
})

export const distributionInspectCommand = define({
	...distributionInspectDefinition,
	async run(ctx) {
		const distribution = await import('@pluxel/rolldown/distribution')
		const report = await distribution.inspectDistribution(resolveRoot(ctx.values as RootValues))
		ctx.log(
			JSON.stringify(
				{
					reportVersion: report.reportVersion,
					ok: report.ok,
					code: report.code,
					manifestSha256: report.manifestSha256,
					producer: report.manifest?.producer,
					application: report.manifest?.application,
					entries: report.manifest?.entries.length,
					differences: report.differences,
				},
				undefined,
				2,
			),
		)
		if (!report.ok) throw new Error(`[distribution] inspection failed: ${report.code}`)
	},
})

export const distributionVerifyCommand = define({
	...distributionVerifyDefinition,
	async run(ctx) {
		const values = ctx.values as VerifyValues
		const distribution = await import('@pluxel/rolldown/distribution')
		const root = resolveRoot(values)
		const keyPaths = normalizeMany(values.key)
		if (keyPaths.length === 0)
			throw new TypeError('[distribution] verify requires --key <public.pem>')
		const trustedKeyPaths = await Promise.all(
			keyPaths.map((path) => assertExistingPathOutsideRoot(root, path, 'trusted key')),
		)
		const report = await distribution.verifyDistribution(
			root,
			await Promise.all(trustedKeyPaths.map((path) => readFile(path))),
		)
		if (values.report) {
			await writeJsonReport(root, values.report, 'verification report', report)
		}
		ctx.log(JSON.stringify(report, undefined, 2))
		if (report.code !== 'VERIFIED') {
			throw new Error(`[distribution] verification failed: ${report.code}`)
		}
	},
})

export const distributionMarkCommand = define({
	...distributionMarkDefinition,
	async run(ctx) {
		const values = ctx.values as MarkValues
		if (!values.claims || !values['record-out']) {
			throw new TypeError('[distribution] mark requires --claims and --record-out')
		}
		const distribution = await import('@pluxel/rolldown/distribution')
		const root = resolveRoot(values)
		const claimsPath = await assertExistingPathOutsideRoot(root, values.claims, 'release claims')
		const claims = distribution.readDistributionReleaseClaims(
			JSON.parse(await readFile(claimsPath, 'utf8')) as unknown,
		)
		if (!claims.distributionId) {
			throw new TypeError('[distribution] delivery marker requires claims.distributionId')
		}
		const record = await distribution.markDistribution({
			root,
			claims,
			recordOut: resolve(values['record-out']),
		})
		ctx.log(`[distribution] delivery marker created for ${record.distributionId}`)
	},
})

export const distributionCorrelateCommand = define({
	...distributionCorrelateDefinition,
	async run(ctx) {
		const values = ctx.values as CorrelateValues
		if (!values['delivery-record']) {
			throw new TypeError('[distribution] correlate requires --delivery-record')
		}
		const distribution = await import('@pluxel/rolldown/distribution')
		const root = resolveRoot(values)
		const recordPath = await assertExistingPathOutsideRoot(
			root,
			values['delivery-record'],
			'delivery record',
		)
		const record = distribution.readDeliveryRecord(
			JSON.parse(await readFile(recordPath, 'utf8')) as unknown,
		)
		const report = await distribution.correlateDistribution({ root, deliveryRecord: record })
		if (values.report) {
			await writeJsonReport(root, values.report, 'correlation report', report)
		}
		ctx.log(JSON.stringify(report, undefined, 2))
	},
})

export const distributionCommand = define({
	...distributionCommandDefinition,
	async run() {},
})

function resolveRoot(values: RootValues): string {
	return resolve(values.root || '.')
}

function normalizeMany(value: string | readonly string[] | undefined): string[] {
	if (value === undefined) return []
	return Array.isArray(value) ? [...value] : [value]
}

function assertOutsideRoot(root: string, candidate: string, label: string): void {
	const child = relative(root, candidate)
	if (child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))) {
		throw new TypeError(`[distribution] ${label} must be outside the distribution root`)
	}
}

async function assertExistingPathOutsideRoot(
	root: string,
	pathInput: string,
	label: string,
): Promise<string> {
	const path = resolve(pathInput)
	assertOutsideRoot(root, path, label)
	const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)])
	assertOutsideRoot(realRoot, realPath, label)
	return realPath
}

async function resolveOutputOutsideRoot(
	root: string,
	pathInput: string,
	label: string,
): Promise<string> {
	const path = resolve(pathInput)
	assertOutsideRoot(root, path, label)
	await mkdir(dirname(path), { recursive: true })
	const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(path))])
	assertOutsideRoot(realRoot, realParent, label)
	return resolve(realParent, basename(path))
}

async function writeJsonReport(
	root: string,
	pathInput: string,
	label: string,
	report: unknown,
): Promise<void> {
	const path = await resolveOutputOutsideRoot(root, pathInput, label)
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
	try {
		await writeFile(temporary, `${JSON.stringify(report, undefined, 2)}\n`, {
			encoding: 'utf8',
			flag: 'wx',
		})
		await rename(temporary, path)
	} finally {
		await rm(temporary, { force: true }).catch((): undefined => undefined)
	}
}
