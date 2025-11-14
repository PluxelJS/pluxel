import { query, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'
import type { InferOutput } from 'valibot'

import type { PackageLoadIssue as ServiceIssue } from '../../services/market/PackageService'
import { PackageLoadIssueEntry } from '../schema'

type IssueOutput = InferOutput<typeof PackageLoadIssueEntry>

export function createMarketModule(pCtx: PlxContext) {
	return resolver({
		packageLoadIssues: query(v.array(PackageLoadIssueEntry)).resolve(() =>
			pCtx.packageService.listLoadIssues().map(serializeIssue),
		),
	})
}

function serializeIssue(issue: ServiceIssue): IssueOutput {
	return {
		__typename: 'PackageLoadIssue',
		spec: {
			__typename: 'PackageIssueSpec',
			name: issue.spec.name,
			version: issue.spec.version ?? null,
			tag: issue.spec.tag ?? null,
			target: issue.spec.target,
			raw: issue.spec.raw,
		},
		source: issue.source,
		message: issue.message,
		error: formatUnknownError(issue.error),
		moduleId: issue.moduleId ?? null,
		recordedAt: issue.recordedAt,
	}
}

function formatUnknownError(error: unknown): string | null {
	if (error == null) return null
	if (error instanceof Error) return error.stack ?? error.message
	if (typeof error === 'string') return error
	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}
