import * as v from 'valibot'

/** Exact chat-completions URL; credentials belong exclusively to Vault. */
export const InvoiceConfig = v.object({
	timeoutMs: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(600_000)),
		180_000,
	),
	maxConcurrent: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)), 1),
	/** Maximum automatic text-CAPTCHA submissions; retry only after an explicit incorrect-code response. */
	captchaAttempts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3)), 1),
	vlm: v.optional(
		v.object({
			endpoint: v.pipe(
				v.string(),
				v.url(),
				v.check((value) => {
					const url = new URL(value)
					return (
						url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
					)
				}, 'Use an HTTPS chat-completions URL without credentials, query or fragment'),
			),
			model: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
			credentialKey: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
			maxOutputTokens: v.optional(
				v.pipe(v.number(), v.integer(), v.minValue(256), v.maxValue(16_384)),
				4096,
			),
		}),
	),
})

export const InvoiceCredentialSchema = v.object({ apiKey: v.pipe(v.string(), v.minLength(1)) })
export const InvoiceVaultSchema = v.record(v.string(), InvoiceCredentialSchema)
