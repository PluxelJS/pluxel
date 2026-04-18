import * as OTPAuth from 'otpauth'

const OTP_ALGORITHM = 'SHA1'
const OTP_SECRET_BYTES = 20
const OTP_WINDOW = 1
const OTP_DIGITS = 6
const OTP_PERIOD_SECONDS = 30

function createTotp(params: {
	issuer: string
	username: string
	secret: string
}): OTPAuth.TOTP {
	return new OTPAuth.TOTP({
		issuer: params.issuer.trim() || 'Pluxel',
		label: params.username,
		algorithm: OTP_ALGORITHM,
		digits: OTP_DIGITS,
		period: OTP_PERIOD_SECONDS,
		secret: params.secret,
	})
}

export function generateOtpSecret(): string {
	return new OTPAuth.Secret({ size: OTP_SECRET_BYTES }).base32
}

export function generateTotpCode(secret: string, now = Date.now()): string {
	return createTotp({
		issuer: 'Pluxel',
		username: 'ops',
		secret,
	}).generate({ timestamp: now })
}

export function verifyTotpCode(secret: string, code: string, now = Date.now()): boolean {
	const normalizedCode = code.trim()
	if (!/^\d{6}$/.test(normalizedCode)) return false
	try {
		return (
			createTotp({
				issuer: 'Pluxel',
				username: 'ops',
				secret,
			}).validate({
				token: normalizedCode,
				timestamp: now,
				window: OTP_WINDOW,
			}) !== null
		)
	} catch {
		return false
	}
}

export function buildOtpAuthUrl(params: {
	issuer: string
	username: string
	secret: string
}): string {
	return createTotp({
		issuer: params.issuer,
		username: params.username,
		secret: params.secret,
	}).toString()
}
