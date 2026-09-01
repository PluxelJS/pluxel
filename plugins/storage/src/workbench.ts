import { f, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'

const CredentialValue = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(4_096),
	v.check((value) => value.trim().length > 0 && !/[\r\n]/.test(value), 'Enter a valid credential'),
)

const S3CredentialRotation = v.object({
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

const S3OperationsStatus = v.object({
	backend: v.pipe(
		v.picklist(['local', 'remote-anonymous', 'remote-vault']),
		f.formMeta({ title: 'Active backend' }),
	),
	credentialRotation: v.pipe(
		v.picklist(['not-applicable', 'available', 'restart-required']),
		f.formMeta({ title: 'Credential rotation' }),
	),
})

export type S3OperationsStatus = v.InferOutput<typeof S3OperationsStatus>

export const S3Workbench = workbench.define({
	credentials: workbench.content({
		document: workbench.markdown(import.meta.url, './workbench-credentials.md', {
			status: workbench.data(S3OperationsStatus),
			rotate: workbench.action({
				label: 'Replace Vault credentials',
				input: S3CredentialRotation,
				confirm:
					'This replaces the configured Vault record. The running S3 client keeps its current credentials until the Plugin is restarted.',
			}),
		}),
		placement: workbench.route('/storage/s3/credentials', {
			title: 'S3 credentials',
			icon: workbench.icons.ShieldLock,
			navigation: { label: 'S3 credentials' },
			order: 70,
		}),
	}),
})
