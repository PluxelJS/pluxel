---
title: 静态应用发行物
description: 创建、检查并签名验证可搬运的静态 Node 应用目录。
---

需要把静态应用复制到另一台机器，或确认部署文件没有缺失和改动时，为最终构建目录创建发行清单。普通启动不需要读取清单，也不会因此计算哈希或发送遥测。

已有完成构建的 `dist/` 时，在安装了 CLI 与 `@pluxel/rolldown` 的项目里运行：

```sh
pnpm exec pluxel distribution create ./dist
pnpm exec pluxel distribution inspect ./dist
```

`inspect` 返回 `INTACT` 表示目录与清单一致。把整个目录复制到目标环境后，再运行一次 `inspect`；若还需要确认发行者身份，继续阅读下面的签名与 `verify` 流程。

starter 的 `pnpm build` 已在 `host/dist` 上执行 create，可直接 `pnpm exec pluxel distribution inspect ./host/dist`。不要在已有签名的交付目录中重建清单来掩盖差异。

## 输入必须是最终目录

本页假设静态应用目录已经构建完成。宿主入口和 `staticApplication()` 配置见[配置插件宿主](../getting-started/host-setup.md)。

构建会先写入 server chunks、`pluxel-deployment.json`、Workbench/public、Node artifacts 与 residual `node_modules`。如果后续任务还会写 SPA、SBOM 或业务 `public/`，必须等最后一个写入者结束后再执行 `distribution create`。

持久化数据、日志、数据库、上传与 cache 必须位于 distribution root 外。协议没有 mutable subtree 或 exclusion glob。

## 五个 CLI 动作

| 动作        | 用途                                                               | 会验证发行者吗 |
| ----------- | ------------------------------------------------------------------ | -------------- |
| `create`    | 根据当前完整目录重建 deterministic artifact manifest               | 否             |
| `inspect`   | 将目录与 manifest 比较，发现新增、删除或修改                       | 否             |
| `verify`    | 验证 DSSE trusted issuer、签名 subject 和完整目录                  | 是             |
| `mark`      | 在 finalization 前写入 inert marker，并在目录外保存 private record | 否             |
| `correlate` | 比较 marker 与一份 private record 的随机 token                     | 否             |

### Create

```sh
pluxel distribution create ./dist
```

manifest 从 `pluxel-deployment.json` 读取 application name、catalog hash、Node target 和 headless/workbench variant，并记录所有 regular file 的 size/SHA-256 与允许的 symlink target。`pluxel-distribution.json` 和 `pluxel-distribution.dsse.json` 自身不进入 inventory。

### Inspect

```sh
pluxel distribution inspect ./dist
```

成功 code 是 `INTACT`。`MANIFEST_ABSENT`、`MANIFEST_INVALID` 或 `ARTIFACT_MISMATCH` 会使 CLI 失败；difference 会区分 missing、unexpected、modified 和 unsupported entry。Inspect 只证明“当前目录仍等于 manifest”，不证明谁创建了 manifest。

walker 还拒绝 path escaping、NFC/case-fold collision、越出 root 或成环的 symlink、FIFO/socket/device 等特殊 entry。V1 不证明 mtime、owner、ACL、xattr、POSIX mode、空目录或 archive container metadata，因此必须先由可信步骤安全解包再验证目录。

### Verify

```sh
pluxel distribution verify ./dist \
	--key ./release-issuer.ed25519.pub.pem \
	--report ../reports/verification.json
```

`--key` 可重复；至少要给一个显式 trusted public key。key 与可选 report 必须位于 distribution root 外。V1 只支持 Ed25519，并要求至少一个 trusted signature 成功；artifact 旁边附带的 key 不能自行建立信任。

稳定 verification code 按处理优先级为：`MANIFEST_ABSENT`、`ATTESTATION_ABSENT`、`ATTESTATION_UNSUPPORTED`、`ATTESTATION_INVALID`、`SIGNATURE_UNTRUSTED`、`SUBJECT_MISMATCH`、`MANIFEST_INVALID`、`ARTIFACT_MISMATCH`、`VERIFIED`。CI 应按 code 分支，不解析 message。

### Mark 与 Correlate

```json
{
	"version": "2.4.0",
	"revision": "8d4f9ac",
	"distributionId": "release-2026-08-16-prod"
}
```

```sh
# 必须在 create/finalization 之前执行，让 marker 进入 artifact inventory。
pluxel distribution mark ./dist \
	--claims ../private/release-claims.json \
	--record-out ../private/delivery-record.json

pluxel distribution create ./dist

pluxel distribution correlate ./dist \
	--delivery-record ../private/delivery-record.json \
	--report ../reports/correlation.json
```

`mark` 要求 claims 包含 `distributionId`，创建 `pluxel-delivery.json` 和一份 root 外的 private record；二者共享随机 256-bit token。marker 不含客户身份，也不改变 Runtime 或前端行为。

Correlation 只会返回 `DELIVERY_MARK_MATCH` 或 `DELIVERY_MARK_NONE`。token 可以被删除、复制或移植，因此 match 只表示与该 record 相等，不代表 attribution、authorization、intent、chain of custody 或法律结论。

## DSSE 签名流程

CLI 故意没有 `distribution sign`。私钥、KMS client、issuer policy 和签名操作必须留在发布流水线；Pluxel 只提供确定性 statement/PAE/envelope helpers 和离线 verifier。

正确顺序是：

```text
完成所有 artifact（可选先 mark）
  -> distribution create
  -> 读取 manifest 原始 bytes
  -> createDistributionStatement(manifestBytes, claims)
  -> createDssePreAuthenticationEncoding(payloadType, statementBytes)
  -> 在外部 Ed25519/KMS signer 中签 PAE bytes
  -> createDistributionDsseEnvelope(statementBytes, signatures)
  -> serialize 到 pluxel-distribution.dsse.json
  -> distribution verify --key trusted-public-key
```

核心 API 来自 `@pluxel/rolldown/distribution`：

```ts twoslash
import {
	DISTRIBUTION_DSSE_PAYLOAD_TYPE,
	createDistributionDsseEnvelope,
	createDistributionStatement,
	createDssePreAuthenticationEncoding,
	fingerprintDistributionKey,
	serializeDistributionDsseEnvelope,
} from '@pluxel/rolldown/distribution'
```

statement 是 in-toto Statement v1，唯一 subject 是 manifest 原始 bytes 的 SHA-256；predicate claims 只允许 `version`、`revision`、`distributionId`，且至少一个存在。用 `createDssePreAuthenticationEncoding()` 生成标准 DSSE PAE bytes 后再交给外部 signer。signature `keyid` 可为空，或使用 `fingerprintDistributionKey()` 生成的 SHA-256 SPKI fingerprint。

`pluxel-distribution.dsse.json` 被 manifest 明确排除，因此可在 create 后写入而不使 inventory 失效；不要在签名后修改其他 artifact。V1 不实现 threshold、certificate chain、transparency log、revocation 或 trusted timestamp，需要这些保证时由外层 release system 提供。

## 发布门禁

1. 在干净 staging 目录完成所有构建和可选 marker。
2. 最后一次写入后执行 `distribution create`。
3. 在隔离流水线对 manifest statement 的 PAE bytes 签名。
4. 用独立配置的 trusted public key 执行 `distribution verify`。
5. 将目录复制/归档后，在解包副本上再次 verify。
6. 将 verification report、private delivery record 和可信时间证据保存在 distribution root 外。

Dynamic workspace 是可变 source graph，不生成这种 artifact manifest。公开 raw schema 位于 `@pluxel/rolldown/distribution/schema.json`。
