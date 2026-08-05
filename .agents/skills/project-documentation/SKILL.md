---
name: project-documentation
description: Organize, create, migrate, or review Viewport Lab documentation using this repository's docs/ and local-doc/ conventions. Use when a request involves project design/reference documents, company-internal integration notes, deployment runbooks, troubleshooting records, document placement, or documentation indexes.
---

# Viewport Lab 文档规范

将文档放入正确的目录，保留当前项目的命名、结构与敏感信息边界。

## 先读取现状

1. 阅读 `local-doc/README.md`；它是本地文档分类与索引的事实来源。
2. 列出 `docs/` 与 `local-doc/` 的现有文件；为本次主题各读取一份最接近的同类文档。
3. 检查 `.gitignore`，确认 `local-doc/` 仍被忽略。不要因为整理文档而把它加入 Git。
4. 若文档已有链接、脚本路径或命令，迁移前先搜索引用，避免留下失效链接。

## 选择存放位置

| 内容 | 位置 | 规则 |
| --- | --- | --- |
| 可公开提交的设计决策、产品/技术参考、布局说明 | `docs/<主题>/` | 沿用已有子目录与文件名风格；内容应可随代码提交。 |
| 公司专用基础设施、内网网关、内部接入约定 | `local-doc/company/` | 只写可共享的流程和占位符，不写凭证。 |
| 部署、更新、恢复、排障等可执行步骤 | `local-doc/runbooks/` | 写清前置条件、命令、验证、回滚或故障处理。 |
| 阶段性排查、实验、决策依据、踩坑结论 | `local-doc/worklogs/YYYY-MM/` | 使用当前年月；记录事实、结论与遗留风险。 |

不要把公司内部地址、账号、SSH 密码、API Key、VHost 凭证或真实 token 写入任何文档。示例一律使用占位符。

## 编写与整理流程

1. 先判断文档是“长期参考/设计”“可执行手册”还是“阶段记录”，再选择目录；不因文件名相似而混放。
2. 新建文档时使用清晰标题，先给结论或目的；只保留对读者有用的小节。可按内容选择：背景、适用范围、步骤、验证、限制、排障、参考链接。
3. 整理已有文档时优先移动或改名，并用 `apply_patch` 更新引用；不要静默删除仍有价值的历史结论。
4. 新增、移动或删除 `local-doc/` 文件后，同时更新 `local-doc/README.md` 的目录树和对应索引项。
5. `docs/` 不重复记录本地敏感运行细节；`local-doc/` 不复制可提交设计文档全文，只保留内部补充。

## 完成前检查

1. 检查 Markdown 链接、相对路径和目录树是否仍正确。
2. 用 `git diff --check` 检查格式；确认 `local-doc/` 没有被意外纳入提交范围。
3. 在交付中说明新增或调整了哪些文档，并指出任何未能归类或需要用户决定的内容。
