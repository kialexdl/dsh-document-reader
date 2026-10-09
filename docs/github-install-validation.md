# GitHub 安装适配测试记录

> 以下为 2026-10-08 的 0.3.2 历史测试记录。当前发布版本为 0.3.4，安装地址与步骤见 [界面安装说明](ui-install.md)。历史测试不等同于当前版本远程 DSH 安装验收。

测试日期：2026-10-08。当前为 0.3.2 的安装适配测试版，尚未创建或发布 GitHub 仓库，需用户完成云端验收后再决定发布。

## 本轮修改

- 将 lib 纳入未来 Git 仓库交付，提供含源码和预编译产物的 GitHub-ready ZIP。
- 不增加 prepare、prepack、preinstall、install 或 postinstall；避免 pnpm 的 Git 依赖构建审批挡住界面安装。
- 新增包完整性检查，验证后端入口、类型、DSH 前端模块、Cordis patch、Python 脚本及依赖锁文件、提示词和许可文件。
- 修复 npm 包遗漏 NOTICE、测试后可能打入 Python bytecode cache 的交付问题。
- 增加中文界面安装、首次 Python 设置、更新和验收说明。

原 0.3.2 的 src、python、prompts 和既有 tests 文件与输入源码包逐字节比对，未修改。宿主及 Python 依赖版本、现有锁文件未改动。

## 自动验证结果

环境：Linux，Node 24.19.0，pnpm 11.25.0，Python 3.12.14；DSH 依赖精确为 0.2.1-alpha.1。

- 冻结锁文件安装：通过。
- TypeScript 后端和 DSH 前端构建：通过。
- Node 测试：39 / 39 通过，0 失败、0 跳过；已设置 DOCUMENT_READER_TEST_PYTHON，包含真实 Loader → FS → subprocess → Python bridge 的集成测试。
- Python 测试：19 / 19 通过。
- Python 安装脚本：在独立 venv 全新安装成功；doctor 确认 markitdown 0.1.7、markitdown-ocr 0.1.0 和源码哈希。
- 普通安装包检查：后端、前端、Python 运行资源和许可文件完整，不包含 node_modules、venv、__pycache__ 或 pyc。
- Git 依赖安装检查：将交付目录提交到仅本机使用的临时 Git 仓库；在全新的消费目录使用 pnpm add git+file URL 安装，消费端 allowBuilds 为空。安装成功，不需要本插件构建审批；安装后的后端可直接导入，前端、Python 脚本和锁文件均存在。

本地 Git URL 验证覆盖 Git 依赖打包 / 安装路径，不等同于从 GitHub 网络下载；尚未创建远程仓库，因此没有实际 GitHub 发布地址、远程安装或 CI 结果。

## 人工验收范围

云测试环境的安装、启用、配置页以及文档读取流程需结合实际运行状态确认。用户仍需亲自验收后再决定是否创建仓库。Windows ACL、共享盘、真实图片模型和用户文档尚未验证；本轮没有调用用户的真实模型服务。

操作步骤见 [GitHub 界面安装说明](ui-install.md)。
