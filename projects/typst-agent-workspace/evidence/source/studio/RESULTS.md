# Studio 源码权威验收

2026-10-30，Linux。完整桌面验收使用已安装 Electron、生产 preload/MessagePort/后端与真实 Typst 编译，仅替换系统文件选择器；正文、表单、文件树和 Monaco 走真实 UI。完整命令与平台参数见 [commands.txt](./commands.txt)。

- Studio 全套：31 个文件，218 项通过；1 项 Windows ACL 测试按平台跳过。`tsc --noEmit`、相关格式/lint/类型检查、renderer 构建通过。
- 完整桌面：24 组路径通过，无未捕获 renderer 错误；普通及重复退出均等待后端清理，进程退出 0。见 [desktop.json](./desktop.json)。
- 源码文件视图：真实 Monaco 编辑正文与 JSON、快捷键保存后，磁盘、表单与正文一致；同一输入的失败草稿通过原生确认后整份重载。先在文件页保存再打开报表也保持内容。见 [回执](source-file-views.json)、[保存后](source-file-shared-save.png)和[重载后](source-file-report-reloaded.png)。未保存草稿的首次交接、在途保存及外部冲突另由状态回归覆盖。
- 当前重连专项：同一页面经历 2 代后端替换，继续编辑、可选表格省略和两次原生 PDF 保存均通过；每次显示回执与保存快照版本相同，旧连接提示在恢复后消失。见 [recovery.json](./recovery.json)。
- 正文：中文 IME 与补充平面字符、格式菜单连续操作、编辑器滚动关闭菜单后列表内继续输入、表格、源码环境保护、共享数据历史、候选过期/接纳/撤销/重做、Agent lease 捕获与接纳均已验证。
- 双向定位：从真实预览字段产生 NodeSelection，再点击作者文字产生 TextSelection，实际预览高亮出现；使用该显示回执导出 PDF。重开后 `.typ` 字节和格式保持。摘要、源码 SHA-256 与原生回执见 [body.json](./body.json)。
- 容量：5 个真实已打开报表超过 4 个 native session 的容量；刷新及重连批次顺序编译，批次开始时的 `preferredPreview` 最后处理。真实银行表单保存与 PDF 导出通过；回归同时覆盖失败后继续、dispose 后停止请求。
- Schema：新字段与对应输入快照接纳后才一起发布。用户立即填写新增必填字段，普通 `data.json` 成功落盘，无伪 CAS 冲突；真实外部冲突仍要求明确选择保留版本。
- 尾段：Monaco completion/hover、Typst 错误保留上次成功画面及修复、文件 CRUD、外部修改、配置错误修复、ZIP 导出/导入与普通 `data.json` 往返通过。

## 可复核产物

| 产物                                                                                                               | 实际内容                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [agent-body.png](./agent-body.png)                                                                                 | Agent 接纳源码后，同一 compile revision 的原生 PNG，1191×1684                        |
| [body-navigation.png](./body-navigation.png)                                                                       | 正文与预览定位完成后的桌面                                                           |
| [body-reopened.png](./body-reopened.png)                                                                           | 重开后的源码、格式及预览                                                             |
| [imported-workspace.png](./imported-workspace.png)                                                                 | ZIP 导入后银行数据与预览                                                             |
| [body.pdf](./body.pdf)、[body-reopened.pdf](./body-reopened.pdf)                                                   | 真实原生导出，均 52,496 字节                                                         |
| [workspace.pdf](./workspace.pdf)                                                                                   | 银行表单原生导出，59,154 字节                                                        |
| [recovery-generation-1.pdf](./recovery-generation-1.pdf)、[recovery-generation-2.pdf](./recovery-generation-2.pdf) | 两代后端重连后分别保存的真实 PDF                                                     |
| [recovery-recovered.png](./recovery-recovered.png)                                                                 | 第二代重连后的表单数据与预览                                                         |
| [artifacts.json](./artifacts.json)                                                                                 | PNG/PDF 的字节数与 SHA-256                                                           |
| [pdf-inspection.json](./pdf-inspection.json)                                                                       | 独立 PDF 读取器核实实际文字与解码内容；重开前后源码保持，不要求 PDF 元数据或字节相同 |
| [runtime.json](./runtime.json)                                                                                     | 2026-10-28 已完成的独立进程/native 生命周期验收摘要                                  |

截图与原生 PNG 已目视检查。只保存必要回执和源码哈希，未复制完整项目快照、MiTeX 数据、供应商设置或认证信息。

## 验证边界

保存与预览编译有各自的回执。autosave 已落盘但树刷新尚未完成时，旧编译回执的导出会明确拒绝 `REVISION_CONFLICT`；完整桌面与重连验收均在实际显示预览的 `sourceRevision` 与已保存 `storageVersion` 一致后导出，不重试失败导出，也不额外调用 compile 抢占 UI 会话。完整桌面的三个导出回执记录在 `desktop.json`。后端容量与版本校验未放宽。

Agent 验收使用真实工具、lease、源码接纳和 native 编译/PNG；没有调用付费模型生成。当前完整桌面和专项重连均使用本机 Linux Wayland。此前 headless 未完成新增原生确认弹窗，独立探针同样未完成；没有用 mock 绕过该弹窗。复验中的定位器、显示环境、过期回执与快速重命名现场见 [复查记录](review-attempts.txt)。未据此宣称 Windows/macOS 桌面兼容或长期稳定性。
