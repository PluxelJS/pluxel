import { f, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { isS3BucketId } from './validation.ts'

const MAX_BUCKETS = 64

const CredentialValue = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(4_096),
	v.check((value) => value.trim().length > 0 && !/[\r\n]/.test(value), 'Enter a valid credential'),
)

const S3CredentialRotation = v.object({
	bucketId: v.pipe(
		v.string(),
		v.check(isS3BucketId, 'Enter a valid configured bucket ID'),
		f.formMeta({ title: 'Bucket ID' }),
	),
	accessKeyId: v.pipe(
		CredentialValue,
		v.maxLength(256),
		f.formMeta({ title: 'Access key ID' }),
		f.stringMeta({ control: 'password' }),
	),
	secretAccessKey: v.pipe(
		CredentialValue,
		f.formMeta({ title: 'Secret access key' }),
		f.stringMeta({ control: 'password' }),
	),
})

export type S3CredentialRotationInput = v.InferOutput<typeof S3CredentialRotation>

const S3BucketOperationsStatus = v.object({
	id: v.pipe(
		v.string(),
		v.check(isS3BucketId, 'Expected a valid bucket ID'),
		f.formMeta({ title: 'Bucket ID' }),
	),
	backend: v.pipe(
		v.picklist(['local', 'remote-anonymous', 'remote-vault']),
		f.formMeta({ title: 'Active backend' }),
	),
	credentialRotation: v.pipe(
		v.picklist(['not-applicable', 'available', 'restart-required']),
		f.formMeta({ title: 'Credential rotation' }),
	),
})

const S3OperationsStatus = v.object({
	buckets: v.pipe(
		v.array(S3BucketOperationsStatus),
		v.maxLength(MAX_BUCKETS),
		f.formMeta({ title: 'Buckets' }),
	),
})

export type S3OperationsStatus = v.InferOutput<typeof S3OperationsStatus>

export const S3Workbench = workbench.define({
	buckets: workbench.content({
		document: workbench.markdown(import.meta.url, './workbench-credentials.md', {
			status: workbench.data(S3OperationsStatus),
			rotate: workbench.action({
				label: 'Replace Vault credentials',
				input: S3CredentialRotation,
				confirm:
					'This replaces the selected bucket Vault record. Its running client keeps the current credentials until S3Plugin is restarted.',
			}),
		}),
		placement: workbench.route('/storage/s3', {
			title: 'S3 buckets',
			icon: workbench.icons.ShieldLock,
			navigation: { label: 'S3 buckets' },
			order: 70,
		}),
	}),
})
