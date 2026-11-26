import { MarketError, object } from '../protocol'

type ReviewFacts = Readonly<{ license: string | null; archiveBytes: number }>
type ReviewPolicy = Readonly<{ requireLicense?: boolean; maxArchiveBytes?: number }>
export type PackageReview = (facts: ReviewFacts) => void

function reviewPolicy(raw: string | undefined): ReviewPolicy {
	if (raw === undefined) return {}
	const policy: unknown = JSON.parse(raw)
	if (
		!object(policy) ||
		Object.keys(policy).some((key) => key !== 'requireLicense' && key !== 'maxArchiveBytes') ||
		(policy.requireLicense !== undefined && typeof policy.requireLicense !== 'boolean') ||
		(policy.maxArchiveBytes !== undefined &&
			(typeof policy.maxArchiveBytes !== 'number' ||
				!Number.isSafeInteger(policy.maxArchiveBytes) ||
				policy.maxArchiveBytes < 1))
	) {
		throw new Error('MARKET_REVIEW expects requireLicense and/or a positive maxArchiveBytes')
	}
	return { requireLicense: policy.requireLicense, maxArchiveBytes: policy.maxArchiveBytes }
}

export function createPackageReview(raw: string | undefined): PackageReview {
	const { requireLicense, maxArchiveBytes } = reviewPolicy(raw)
	return (facts) => {
		if (requireLicense && !facts.license?.trim())
			throw new MarketError('review-license-required', 'A license declaration is required', 422)
		if (maxArchiveBytes !== undefined && facts.archiveBytes > maxArchiveBytes)
			throw new MarketError('review-archive-size', 'The archive exceeds the review size limit', 422)
	}
}
