# Static 发行物完整性与签名

`staticApplication()` 会在完整 Node 发行目录组装完成后自动生成 `pluxel-distribution.json`。它覆盖 server chunks、
`pluxel-deployment.json`、Workbench/public、业务 `public/`、Node artifacts、residual `node_modules`、SBOM 和允许的 symlink。
Runtime 启动不会读取清单或签名，也不会增加文件扫描、hash、crypto、网络或后台任务。

## 创建与检查

如果没有其他任务继续写入 `dist/`，构建生成的清单已经是 final。业务 SPA、SBOM 或 packaging task 在构建后继续写文件时，必须在
最后一次写入后重新 finalization：

```sh
pluxel distribution create ./dist
pluxel distribution inspect ./dist
```

`inspect` 只比较 schema、deployment facts 和完整 artifact inventory，不认证发行者。任何新增、删除、修改、symlink target
变化、escaping/circular symlink、case-fold 冲突或特殊 filesystem entry 都会失败。持久化、日志、数据库、上传和 cache 必须放在
distribution root 外，否则它们会改变不可变发行物。

## 私有发行流水线签名

Claims 文件位于 distribution 外，只接受三个公开字符串且至少一个存在：

```json
{
	"version": "1.4.0",
	"revision": "8f91d22",
	"distributionId": "01J00000000000000000000000"
}
```

代码从能力所有者导入 deterministic statement、DSSE PAE 与 envelope helper。下面使用本地 Ed25519 PEM 演示；生产流水线可以把
`pae` bytes 交给 KMS/HSM，再把返回的 signature bytes 装入相同 envelope：

```ts
import { readFile, writeFile } from 'node:fs/promises'
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import {
	createDistributionDsseEnvelope,
	createDistributionStatement,
	createDssePreAuthenticationEncoding,
	DISTRIBUTION_DSSE_PAYLOAD_TYPE,
	fingerprintDistributionKey,
	readDistributionReleaseClaims,
	serializeDistributionDsseEnvelope,
} from '@pluxel/rolldown/distribution'

const manifest = await readFile('dist/pluxel-distribution.json')
const claims = readDistributionReleaseClaims(
	JSON.parse(await readFile('private/release-claims.json', 'utf8')),
)
const statement = createDistributionStatement(manifest, claims)
const privateKey = createPrivateKey(await readFile('private/issuer-private.pem'))
const publicKey = createPublicKey(privateKey)
const pae = createDssePreAuthenticationEncoding(DISTRIBUTION_DSSE_PAYLOAD_TYPE, statement)
const envelope = createDistributionDsseEnvelope(statement, [
	{
		keyid: fingerprintDistributionKey(publicKey),
		sig: sign(null, pae, privateKey).toString('base64'),
	},
])

await writeFile('dist/pluxel-distribution.dsse.json', serializeDistributionDsseEnvelope(envelope))
```

接收方只信任命令行明确提供的 Ed25519 public key：

```sh
pluxel distribution verify ./dist \
	--key ./issuer-public.pem \
	--report ./evidence.json
```

Artifact 旁边出现的 key、`keyid`、product 名称或 package metadata 都不会建立信任。报告使用稳定 code，区分缺少 manifest/
attestation、不支持版本或算法、结构或签名无效、key 不受信、subject digest 不匹配、manifest 无效和 artifact mismatch。

## 可选交付标记

客户级弱关联不是签名发行证明的依赖。需要时使用同一 claims 文件，在最终 manifest 和签名前执行：

```sh
pluxel distribution mark ./dist \
	--claims ./private/release-claims.json \
	--record-out ./private/delivery-record.json

pluxel distribution create ./dist
```

Marker 只在 `dist/pluxel-delivery.json` 保存随机 256-bit token；`distributionId` 和映射只存在于 root 外的 private record。检查样本：

```sh
pluxel distribution correlate ./suspected-copy \
	--delivery-record ./private/delivery-record.json \
	--report ./correlation.json
```

结果只表示 token 是否与这份 record 相同。Token 可被删除、复制或移植，因此不能据此判断样本来源、泄露者、主观意图、授权范围或
法律责任。需要证据保全时，必须另外签名并外部保存 private record。
