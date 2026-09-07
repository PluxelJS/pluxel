export {
	S3,
	S3BucketNotFoundError,
	S3NotRunningError,
	S3UnsupportedOperationError,
} from './capability.ts'
export type { S3Bucket, S3Client } from './capability.ts'
export { S3Config, S3CredentialsError, S3Plugin } from './s3.ts'
export type { S3AccessKeyCredentials, S3BucketConfig, S3PluginConfig } from './s3.ts'
export type {
	CompleteMultipartUploadResult,
	CopyObjectOptions,
	CopyObjectResult,
	DeleteObject,
	DeleteObjectResult,
	ExistResponseCode,
	ListBucketResponse,
	ListMultipartUploadResponse,
	ListObject,
	Logger as S3Logger,
	UploadPart,
} from 's3mini'
