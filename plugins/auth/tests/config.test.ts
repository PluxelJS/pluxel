import { v } from '@pluxel/runtime'
import { describe, expect, it } from 'vitest'
import { AuthConfig } from '../src/config.ts'

const oidcMode = {
	type: 'oidc',
	issuer: 'https://issuer.example',
	clientId: 'pluxel',
	publicOrigin: 'https://admin.example',
} as const

describe('authentication config boundary', () => {
	it('rejects ambiguous URL components', () => {
		expect(v.safeParse(AuthConfig, { mode: oidcMode }).success).toBe(true)
		expect(
			v.safeParse(AuthConfig, {
				mode: { ...oidcMode, issuer: 'https://issuer.example?tenant=one' },
			}).success,
		).toBe(false)
		expect(
			v.safeParse(AuthConfig, {
				mode: { ...oidcMode, publicOrigin: 'https://admin.example/?tenant=one' },
			}).success,
		).toBe(false)
	})

	it.each(['__proto__', 'constructor', 'prototype'])(
		'rejects the dangerous claim key %s',
		(key) => {
			const requiredClaims = Object.create(null) as Record<string, string>
			requiredClaims[key] = 'admin'
			expect(v.safeParse(AuthConfig, { mode: { ...oidcMode, requiredClaims } }).success).toBe(false)
		},
	)

	it('requires one printable OAuth token per scope and an unambiguous confidential client ID', () => {
		expect(
			v.safeParse(AuthConfig, { mode: { ...oidcMode, scopes: ['openid profile'] } }).success,
		).toBe(false)
		expect(
			v.safeParse(AuthConfig, {
				mode: { ...oidcMode, clientKind: 'confidential', clientId: 'tenant:client' },
			}).success,
		).toBe(false)
	})
})
