# 0.2.0 配置页面与 DSH 视觉模型改造

本版本适配 DSH 0.1.7-rc.2。Python 依赖仍为 markitdown 0.1.7 与 markitdown-ocr 0.1.0，不需要更换已经可用的专用 Python 环境。

## 安装更新

停止目标 DSH，将完整源码解压到原插件目录，保留自己的配置文件。在插件目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add .
dsh --profile web
```

`web`（配置档名称）需替换为实际使用的配置档。新增前端模块后请刷新浏览器；若仍加载旧版本，请确认安装目标与源码目录一致。不要只复制 src 文件，package.json、锁文件和 scripts 均有变化。

首次安装仍按 README 创建 Python 专用环境；本次版本升级不改变 Python 依赖基线。

## 使用路径

1. 设置 → 模型：维护公司网关等服务商配置，并为目标模型声明图片输入。
2. 插件 → 已安装 → dsh-document-reader → document-reader 行 → 配置。
3. 视觉服务来源选择“使用 DSH 已配置模型”，选择服务商和图片模型。
4. 打开所需图片说明/文字识别开关，保存。
5. 用一份含图片的文档调用读取工具，查看是否返回完整识别结果；网关需要真实支持所声明的图片输入。

仅改插件配置不必重新构建或重启。源码升级仍需执行上述安装步骤。

## 行为说明

- 主会话模型变化不影响固定视觉模型，不增加自动路由。
- DSH 模式由宿主适配器管理地址、密钥、请求头与协议，Python 不负责该模式的网络请求。
- DSH 模式的图片存入原生附件服务，当前宿主不会自动删除附件，插件缓存清理也不删除附件。
- 旧独立地址配置继续可用，用户显式切换才迁移；没有静默回退。
- 模型能力未知、模型删除、服务商未加载时均不自动选择其他模型。
- 修改解析或视觉配置后，旧续读参数明确失效；请重新读取或搜索。
- 不新增后台连通性探测，也没有“测试图片”按钮；第一次真实文档调用用于确认网关图片能力。

## 验证范围

本次在 Linux、Node 24 与 Python 3.12 下验证：

- TypeScript 编译和 DSH 前端模块加载器产物检查。
- 原生 DSH 配置编辑器真实写入临时配置档；可变引用更新且插件不重启；陈旧版本和无效参数被拒绝。
- 页面交互测试：服务商联动、纯文本/未知能力过滤、保存版本号、冲突拦截、失效模型保留。使用模拟浏览器文档环境执行，未完成真实浏览器视觉验收。
- 原生 DSH 模型服务与附件服务，搭配确定性的测试适配器：精确模型选择、图片传递、流响应汇总、错误脱敏、超时/取消、能力复核、调用上限。
- Python 转换进程 → 二进制管道 → DSH 模型服务完整链路；缓存命中与模型变更后的重新转换。
- 原有 PDF、Word、PowerPoint、Excel、CSV 解析、关键词查找、权限复查、取消、定位、缓存与独立视觉端点回归。

未使用真实公司模型凭据，未声明真实网关识别质量已验证。未在 Windows DSH 桌面或实际浏览器中完成界面验收；当前环境的浏览器安装包下载失败，因此界面验证限于组件交互与模块加载协议。安装后建议按上方使用路径做一次含图片文档的实际验收。

所有新增测试随纯源码包交付。完整测试可在已安装测试依赖的 Python 环境下执行：

```powershell
# 测试专用环境；不会改变正常使用所需依赖定义
python -m pip install -r python/requirements.txt -c python/constraints.lock -r python/requirements-test.txt
$env:DOCUMENT_READER_TEST_PYTHON = (Get-Command python).Source
pnpm build
pnpm test
python -m unittest discover -s tests -p "test_*.py" -v
```
