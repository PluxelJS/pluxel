# 配置表单所有权

修改配置表单时，先确定变化属于字段呈现、section baseline 还是提交协议。公开配置声明和服务端验证不由浏览器实现替代；Shell 只编辑 portable plan 允许的投影。

| 所有者                        | 负责的事实                                                          | 不负责                                                     |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| 每个 section 的 TanStack Form | values、字段错误、dirty、独立 saved baseline、撤销和 section submit | RPC cache、其他 section baseline                           |
| `ConfigTabContent`            | 字段 renderer，默认值与 React options 对齐                          | runtime client 与 cache                                    |
| `useConfigForms`              | 在 TanStack Store 注册 form instances，派生 action dock flags       | 再保存一份表单值；普通 value 变化不应产生新 flags snapshot |
| `ConfigForm`                  | 选择提交范围，一次捕获参与的 draft，协调保存全部                    | 复制每 section 的 baseline                                 |
| `useConfigSave`               | Query mutation 请求状态、cache commit、read model refresh、通知     | 把过期结果写回已经改变的表单                               |

卸载 section 时移除 form store 依赖。同插件的多个文档有独立 instances、baseline 和 DOM anchors，不能按 plugin 名共享表单或草稿。

## 提交与并发

当前 section 使用原生 `form.handleSubmit`；保存全部从 dirty sections 构造一个原子 patch。两条路径都通过 `useConfigSave`。Portable plan 不带可执行客户端 schema，完整验证仍由 runtime 决定，字段校验失败必须保留输入。

仅 editable projection 进入 patch，未渲染的子项保留已保存值。响应只有在 form instance 与 draft 仍匹配提交快照时才能 reset 表单。保存全部的 validation errors 要求全部参与快照仍然有效，因为验证可能依赖原本 clean 的 section。同步 admission guard 阻止 React 尚未渲染 pending 时，两个 DOM submit 同时发起写入。

调用方不能把按钮 disabled 当作唯一并发保护，也不能以新服务端 snapshot 无条件覆盖本地 dirty draft。失败、晚到结果和 owner 切换必须由其提交快照判定。

## 组合、目录与布局

独立 section 需要独立保存基线和撤销，所以保留独立 Form。不能仅为减少实例数量换成共享 parent form 的字段分组；只有真实共享 baseline 的字段块才适合分组。采用新 Form API 前核实它是否保留这些边界，不在本文固定第三方版本号或复制其手册。

`FormToc` 只消费本编辑器生成的 anchors，DOM id 按文档实例隔离。配置目录在本地按需展开，不扫描其他文档或 remote renderer，不建立全局目录注册。滚动区域受文档容器约束，字段尽量使用 Mantine 默认尺度；视觉规则见 [Workbench 设计规则](../../../../../../../engineering/WORKBENCH_DESIGN.md)。

## 验证

配置协议或保存改动检查 `shell/tests/workbench-config-save.test.tsx`、`shell/tests/web/config-form-loop.test.tsx` 及受影响的 query/validation 回归；目录改动检查 `shell/tests/workbench-outline.test.tsx`。真实浏览器补查两份同 owner 草稿、取消离开、窄高度滚动和 late MF CSS。只编辑浏览器 draft 没有证明后端保存成功，保存回执也不证明旧 UI draft 未被覆盖。
