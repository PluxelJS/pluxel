import { v } from '@pluxel/runtime'
import { describe, expect, it } from 'vitest'
import { S3Config } from '../src/index.ts'

describe('S3 capability', () => {
	it('uses one discriminated config contract and defaults to local storage', () => {
		expect(v.parse(S3Config, {})).toEqual({
			buckets: [
				{
					id: 'default',
					backend: {
						type: 'local',
						rootDir: '.pluxel/s3',
						bucketName: 'local',
						syncWrites: true,
					},
				},
			],
		})
		expect(
			v.safeParse(S3Config, {
				buckets: [
					{
						id: 'default',
						backend: { type: 'remote', endpoint: 'https://bucket.example.com' },
					},
				],
			}).success,
		).toBe(false)
		expect(
			v.safeParse(S3Config, {
				buckets: [
					{ id: 'assets', backend: { type: 'local' } },
					{ id: 'assets', backend: { type: 'local' } },
				],
			}).success,
		).toBe(false)
	})
})
