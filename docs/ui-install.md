# GitHub 地址界面安装

构建基线：DSH 0.2.1-alpha.1；宿主兼容范围：`>=0.2.0-rc.2 <0.3.0-0`；插件版本为 0.3.4。指定图片直接同步解析，成功后缓存；详见 [0.3.4 升级说明](upgrade-0.3.4.md)。

## 当前发布状态

安装地址：[https://github.com/kialexdl/dsh-document-reader](https://github.com/kialexdl/dsh-document-reader)。仓库包含 0.3.4 源码及同版本预构建产物。实际远程 DSH 界面安装仍需在目标环境验收，发布源码不代表该安装流程已实测。

## 用户安装流程

1. 启动安装目标配置档对应的兼容 DSH（最低 0.2.0-rc.2），打开侧栏“插件”。
2. 选择“添加插件” → “安装第三方插件”。
3. 输入 `https://github.com/kialexdl/dsh-document-reader`，点击“安装”。需要网络可访问该仓库和 npm registry，运行 DSH 的环境需能执行 Git。
4. 安装完成后点击“立即启用”。DSH 默认先以停用状态安装。
5. 打开 dsh-document-reader 中 document-reader 行的“配置”，确认页面正常显示。
6. 首次使用还需安装 Python 依赖，见下一节；在配置页选择图片服务商和图片模型并保存。只读取原生文字时可关闭图片说明和图片文字识别。

插件不会自行选择主会话模型，也不会自动更改现有模型配置或凭据。

## Python 是独立的一次性设置

GitHub 安装只交付 Node 插件、前端和 Python 脚本，不自动安装解释器或运行 pip。必须已有 Python 3.12。

可以下载并解压同版本源码包，在该目录运行原有安装入口，无需先执行 pnpm install / build：

Windows：

```powershell
py -3.12 .\scripts\setup_python.py
```

Linux / macOS：

```sh
DOCUMENT_READER_PYTHON=python3.12 bash scripts/setup-python.sh
```

安装脚本创建专用 venv，安装锁定的 markitdown 0.1.7、markitdown-ocr 0.1.0 及传递依赖，并检查版本和源码哈希。不会修改全局 Python。将脚本输出的完整路径填入配置页的 `python.executable`。默认位置也可由插件自动发现；显式填写路径有利于排查运行用户不同的问题。

也可直接使用安装到 DSH 配置档的包内 `scripts/setup_python.py`；不必重新克隆仓库。若已经存在可用的同版本 Python 环境，本次无需重新安装。

## 为什么发布 lib 而不依赖 prepare

DSH 的插件管理使用 pnpm 安装包。Git 依赖若声明 prepare/prepack 等构建步骤，pnpm 可能先返回 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。DSH 0.2.1-alpha.1 的“允许这些脚本并重试”主要处理普通依赖脚本的 `ERR_PNPM_IGNORED_BUILDS`，不能把这两个审批流程混为一谈。

本包的 GitHub 安装目录包括已经构建的 `lib/index.js`、类型声明、后端依赖模块和 `lib/client.js`；保留 `dsh.bundle.patch`、前端依赖声明和浏览器平台标记。安装不运行本插件的构建或 Python 设置脚本。

若依赖仍提示普通构建脚本审批，请查看提示中具体包名，仅允许你信任并确实需要的包。不要通过全局允许全部构建脚本或关闭检查来解决。若提示 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，请确认安装地址指向这份预构建目录，没有误装旧的带安装构建钩子的版本。

## 维护者更新和打包

修改源码后必须先更新构建结果，再一起提交；不要只提交 src。`lib` 不再被 .gitignore 排除。

仓库根目录直接包含 `package.json`、`cordis.patch.yml` 和 `lib`，不要再多套一层插件目录。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:github
pnpm package:source
```

`pnpm check` 完成 TypeScript / 前端构建、Node 测试和包内容检查。若已安装 Python 测试环境，应设置 `DOCUMENT_READER_TEST_PYTHON` 以运行真实 Loader 集成测试，并单独运行 Python 测试。未设置时 Node 集成测试会明确跳过。

- `dist/dsh-document-reader-0.3.4-github.zip`：包含源码、测试、锁文件和 lib，可作为 GitHub 仓库目录；不包含 node_modules、venv 或密钥。
- `dist/dsh-document-reader-0.3.4-source.zip`：只含源码、测试、锁文件等，不含 lib；不能原样作为免构建的 GitHub 安装仓库。
- 普通 npm / pnpm pack 安装包：通过 package.json 的 files 列表包含 lib、Python、提示词、安装脚本、文档和 Cordis patch。

不要为纯 GitHub 安装再添加 prepare/prepack/install/postinstall。编译产物必须与所提交的源代码同批验证。

## 更新已安装版本

当前 DSH 界面没有独立的版本更新选择器。更新前记录现有配置，通过插件管理卸载旧包，再用目标版本的 GitHub 地址重新安装、启用，并重启 DSH、刷新浏览器。源码文件替换不等同于运行中的后端已重新加载。不要自行假定卸载一定保留所有自定义配置。

## 验收清单

- 界面安装成功，插件显示 0.3.4，并可从停用切换为启用。
- 配置页面和服务商 / 图片模型选项正常，保存后重新打开保持正确值。
- 原生文字文档读取和关键词搜索正常，结果有来源定位。
- Python 未配置时插件仍可安装、启用，实际转换时给出明确依赖错误。
- 配置可用 Python 后再次转换成功；图片调用需要实际图片服务商，未配置时不要把安装成功等同于图片识别已验收。
- 禁用 / 重新启用、重启后再次读取均正常。

云端 Linux 测试不能代替 Windows ACL、共享盘、真实图片模型和用户文档的最终验收。
