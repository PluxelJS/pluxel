import { f, v } from '@pluxel/runtime'

const HttpsUrl = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(2_048),
	v.url(),
	v.check((value) => {
		const url = new URL(value)
		return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
	}, 'Must be an HTTPS URL without credentials, a query, or a fragment'),
)

const ClaimValue = v.union([
	v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
	v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
		v.minLength(1),
		v.maxLength(32),
	),
])

function hasSafeClaimKeys(value: unknown): boolean {
	return (
		Boolean(value) &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).every(
			(key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype',
		)
	)
}

const PasswordMode = v.strictObject({
	type: v.literal('password'),
})

const PasswordTotpMode = v.strictObject({
	type: v.literal('password-totp'),
})

const OidcMode = v.strictObject({
	type: v.literal('oidc'),
	issuer: v.pipe(HttpsUrl, f.formMeta({ title: 'Issuer URL' })),
	clientId: v.pipe(
		v.string(),
		v.minLength(1),
		v.maxLength(512),
		f.formMeta({ title: 'Client ID' }),
	),
	publicOrigin: v.pipe(
		HttpsUrl,
		v.check(
			(value) => new URL(value).pathname === '/',
			'publicOrigin must be an origin without a path',
		),
		f.formMeta({ title: 'Public origin' }),
	),
	clientKind: v.pipe(
		v.optional(v.picklist(['public', 'confidential'] as const), 'public'),
		f.formMeta({ title: 'Client authentication' }),
	),
	scopes: v.optional(
		v.pipe(
			v.array(
				v.pipe(
					v.string(),
					v.minLength(1),
					v.maxLength(128),
					v.check(
						(value) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value),
						'Must be one OAuth scope token',
					),
				),
			),
			v.minLength(1),
			v.maxLength(16),
		),
		['openid', 'profile', 'email'],
	),
	requiredClaims: v.optional(
		v.pipe(
			v.unknown(),
			v.check(hasSafeClaimKeys, 'Required claims contain an unsupported key'),
			v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(128)), ClaimValue),
			v.check((value) => Object.keys(value).length <= 32, 'At most 32 required claims are allowed'),
		),
	),
})

export const AuthConfig = v.pipe(
	v.strictObject({
		mode: v.pipe(
			v.optional(v.variant('type', [PasswordMode, PasswordTotpMode, OidcMode]), {
				type: 'password',
			}),
			f.formMeta({ title: 'Authentication mode' }),
		),
	}),
	v.check(
		(config) =>
			config.mode.type !== 'oidc' ||
			config.mode.clientKind !== 'confidential' ||
			!config.mode.clientId.includes(':'),
		'Confidential OIDC client IDs cannot contain a colon',
	),
)

export type AuthPluginConfig = v.InferOutput<typeof AuthConfig>
export type AuthMode = AuthPluginConfig['mode']
export type OidcAuthMode = Extract<AuthMode, { type: 'oidc' }>
