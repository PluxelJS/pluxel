# 应用发行物完整性与来源证明

`@pluxel/rolldown/distribution` 定义 Node 应用 artifact set、in-toto/DSSE 和可选 delivery marker。发行工具生成和验证这些文件，应用启动不读取 inventory、计算 hash 或验证签名。

## Finalization 所有权

`pluxel()` 在 server chunks、`pluxel-deployment.json`、Workbench/public、Node artifacts 和 nf3 residual packages 组装完成后调用 `createDistributionManifest()`，输出 `pluxel-distribution.json`。声明 config environment bootstrap 的应用在此之前生成 `.env.example` 并纳入 inventory，真实 `.env` 不参与生成或加载。

后续还有任务写入 `dist/` 时，release pipeline 在最后一次写入后显式运行 `pluxel distribution create ./dist`，调用同一 finalizer。Application name、catalog hash、Node target 与 headless/workbench variant 来自 deployment metadata，`pluxel()` 不接收 claims、signer 或 trust 配置。

## Artifact set v1

Schema 位于 `@pluxel/rolldown/distribution/schema.json`。编码为 compact UTF-8 JSON + LF，字段顺序固定，entry 按规范化路径的 UTF-8 bytes 排序。

Inventory 包含 root 内每个 regular file 和允许的 symlink：deployment metadata、server/public、Node artifacts、residual `node_modules`、SBOM 和可选 `pluxel-delivery.json`。只排除 root 的 `pluxel-distribution.json` 与 `pluxel-distribution.dsse.json`；persistence、logs、database、uploads 和 cache 必须放在 distribution root 外。

共享 walker 校验：

- 相对 `/` 路径为 NFC，拒绝 NUL、反斜杠、absolute/drive path、空 segment、`.` 和 `..`。
- 拒绝 NFC 与 portable case-fold collision。
- Symlink 使用保持在 real root 内的相对 target，拒绝中间 symlink 逃逸和 cycle。
- Hard link 每个 path 独立记录 bytes；FIFO、socket、device 等特殊 entry 拒绝。

V1 证明 file set、regular file size/SHA-256 和 symlink target。Mtime、owner、ACL、xattr、POSIX mode、空目录和 archive container metadata 不在证明范围。Verifier 接收已经安全解包的目录，不 import 应用 entry。

## 签名 Attestation

`createDistributionStatement()` 生成确定性的 in-toto Statement v1 bytes，唯一 subject 是 manifest 原始 bytes 的 SHA-256。Predicate 只接受 `version`、`revision`、`distributionId`，至少一个存在；claims 由 issuer 提供。

`createDssePreAuthenticationEncoding()` 生成标准 DSSE PAE bytes。流水线在外部签名，再用 `createDistributionDsseEnvelope()` / `serializeDistributionDsseEnvelope()` 写入 `pluxel-distribution.dsse.json`。Build API 不接收 private key、KMS client、callback、shell command 或 trust policy。

V1 offline verification 使用调用方显式提供的 Ed25519 public key，至少一份 trusted signature 验证成功。`keyid` 为空或为 `fingerprintDistributionKey()` 生成的 SHA-256 SPKI fingerprint，制品旁的 key 本身不能建立信任。Threshold、certificate chain、transparency log、revocation 和 trusted timestamp 留给外部系统。

Report 使用 `reportVersion: 1`、`verifierVersion: 1`、稳定 top-level code 和 difference list。检查按以下优先级报告：

1. `MANIFEST_ABSENT`
2. `ATTESTATION_ABSENT`
3. `ATTESTATION_UNSUPPORTED`
4. `ATTESTATION_INVALID`
5. `SIGNATURE_UNTRUSTED`
6. `SUBJECT_MISMATCH`
7. `MANIFEST_INVALID`
8. `ARTIFACT_MISMATCH`
9. `VERIFIED`

## 可选 Delivery marker

`markDistribution()` 写入 `pluxel-delivery.json`，仅含 schema version 和随机 256-bit base64url token。Distribution 外的私有 delivery record 保存同一 token 和 release claims 的 `distributionId`。Marker 不含客户身份，也不修改其他制品或运行行为。

`correlateDistribution()` 只返回 `DELIVERY_MARK_MATCH` 或 `DELIVERY_MARK_NONE`，表示 token 与私有 record 是否相等，不证明使用者身份、授权或保管链。Token 可删除、复制或移植；来源调查需要独立保存 record，并另行提供签名、可信时间戳或 append-only 约束。

## 动态来源的证明范围

Standalone 为封闭 bundle，拒绝 sources；modules 保留真实 package imports 和 Node/Workbench inventory，启动按 sharedPackages 准入 identity。构建边界见 [Application Build](APPLICATION_BUILD.md)。

Modules finalization 记录已构建目录，部署端外部 package 安装不在证明范围。可变来源目录位于发行目录外；Package Manager 的 immutable revisions 由其发布记录维护。

## 实现与验证

`packages/rolldown/src/distribution/` 拥有 schema、walker、manifest、attestation 和 marker；`packages/rolldown/tests/distribution.test.ts` 覆盖确定性 bytes、路径/链接拒绝、文件变化、签名信任和失败优先级。

发行检查在最后一次写入后 finalization，核对额外/缺失/篡改文件、symlink containment 与 verifier 不 import entry。搬离 workspace 的启动检查和签名/inventory 检查分别验证运行与完整性。
