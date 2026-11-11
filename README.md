# 纪要一键归档 · Recap Archiver

Chrome 插件（Manifest V3）。打开分享页点一下，把**完整原件 + 结构化 Markdown + 元信息**打包成一个 ZIP 下载到浏览器下载目录。

**核心是通用性**：不绑定域名、不绑定 class 名。靠 DOM 结构推断识别章节 / 模块 / 图解 / 步骤，换一套完全不同的页面模板也不用改代码。已用两份结构截然不同的真实纪要验证（见下）。

---

## 安装

1. Chrome 地址栏打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录 `recap-archiver-extension/`
4. 建议把插件固定到工具栏（拼图图标 → 图钉）

> 纯静态 MV3，不需要 npm、不需要构建。分发包 `纪要一键归档_Chrome插件_v1.0.1.zip` 里 **`manifest.json` 就在最外层**：解压后直接选解压出来的那个文件夹即可加载（当前版本 1.0.1）。也可直接选本源码目录 `recap-archiver-extension/`。
>
> ⚠️ **别选多套了一层的外层文件夹**。Chrome 只认「直接含 `manifest.json` 的目录」，选错层级会报「清单文件缺失或不可读取 / 无法加载清单」。判断方法：打开你选的目录，应该第一眼就看到 `manifest.json`、`background.js`、`popup.html`。
>
> **关于自动安装（实测 Chrome 156，结论：必须手动点一次）**。三层限制叠加：
>
> 1. 正式版禁用命令行 `--load-extension`（加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 也无效）。
> 2. 默认 `--user-data-dir` 不允许开 `--remote-debugging-port`，报 `DevTools remote debugging requires a non-default data directory`。绕法：建一个**目录 junction** 指向同一个 `User Data`，用这个非默认路径字符串启动即可开调试端口（本次已验证能连上 CDP，且读写的确实是日常 profile）。
> 3. 但 CDP 命令 `Extensions.loadUnpacked` 是**会话级**加载：写进 `Secure Preferences` 的是 `location: 4` 临时条目，Chrome 按日常方式重启后会把它清理掉（实测重启后扩展 ID 归零，只剩 `pinned_extensions` 残留），**不是持久安装**。
>
> 也试过 `chrome://extensions` 页面的 `chrome.developerPrivate.loadUnpacked({ path })`，Chrome 156 直接拒绝：`Unexpected property: 'path'` —— UI 同款持久链路无法通过 API 传路径、绕不开系统文件夹选择框。
>
> 因此**唯一可靠的永久安装就是上面 3 步手动加载**（约 30 秒，只需做一次）。CDP 方式适合临时测试：`test/e2e-headless.js`（本地壳页 + 跨域 iframe）与 `test/e2e-share.js`（**真实分享链接**）都会自动起一个临时 profile 的 Chrome、通过 CDP 加载扩展并跑端到端；`test/e2e-live.js` 则连到手动装好扩展的实例。三者重启即失效，不改变日常 Chrome。

## 使用

1. 打开分享链接（或任意网页）
2. 点工具栏图标 → 弹窗里点 **「一键归档到下载目录」**
3. 浏览器下载目录出现 `标题_日期.zip`

默认 ZIP 内含 4 个文件：

| 文件 | 说明 |
|---|---|
| `xxx.md` | 完整文字版：章节 / 模块 / 全部图解，含图解关系、直播原话出处、图注、SVG 内文字 |
| `xxx.html` | 内容页原始 HTML（含 DOCTYPE）。目标页面的 CSS/SVG/脚本全内联，离线可看可交互；通用网页的外链 CSS/图片仍需联网 |
| `xxx_meta.json` | 标题、日期、来源、识别模板、结构统计、**完整性自检结果** |
| `xxx_封面.png` | 分享封面（best-effort，失败自动跳过） |

弹窗里可切换：是否打包 ZIP、是否附带外层页面原件、是否下载封面等。关闭「打包为单个 ZIP」会分多个文件下载（Chrome 可能弹出批量下载确认）。

---

## 通用性怎么做的

`lib/infer.js` 不看 class 名，按 DOM 形状打 `data-ax` 语义标记：

| 推断规则 | 判定依据 |
|---|---|
| 章节条 `part` | 浅层 DIV/SECTION，直接含 1 个 H2，文本短、子元素少 |
| 章节号 `part-no` | 章节条内匹配 `PART 1` / `1` 的短文本 |
| 内容卡 `module` | SECTION/ARTICLE/DIV 直接含 1 个 H3，且不在其它 part/module 内 |
| 图解 `figure` | 任意带 `figcaption` 或 `data-visual-*` 的 FIGURE |
| 步骤 `step` | ≥2 个同构兄弟节点，各自以短数字标记开头 |
| 对照卡 `card` | ≥2 个同构兄弟 DIV，各自有明确的 H4 标题 |

`converter.js` 优先读 `data-ax`，class 名只是兜底 —— 所以老模板（`section.part` + `article.module`）和全新模板（`div.part` + `section.card`）都能正确还原。`lib/adapters.js` 只负责站点身份、元信息和极少量微调；**新增站点通常一行代码都不用写**。真要定制，追加一个适配器对象即可。

转换在**页面 isolated world 的 DOM 副本**上完成，绝不修改你正在看的页面；保存的 HTML 原件是抓取时的原始字符串，未受推断影响。MV3 Service Worker 没有 DOM API，所以只在后台做编排、ZIP 打包和下载。

---

## 实测结果（2026-11-08，v1.0.1 于 2026-11-11 复测）

用真实 Chrome 156 + 已安装扩展 + 真实分享页跑通：

| 页面 | 模板 | 章节 / 模块 / 图解 | 文本覆盖 | 结果 |
|---|---|---|---|---|
| 搭建家庭的第二大脑 | `section.part` + `article.module` | 6 / 23 / 21 | 168 行，缺失 0 | 通过 |
| 超级团队落地：Manus 的可插拔实践 | `div.part` + `section.card` | 5 / 14 / 11 | 139 行，缺失 0 | 通过 |
| 新链接端到端（真实 Chrome + CDP 触发） | inferred | 5 / 14 / 11 | 139 行，缺失 0 | ZIP 89,778 B，4 个产物 |
| **v1.0.1 真实链接复测**（2026-11-11，临时 profile + CDP 自动加载） | inferred | 5 / 14 / 11 | 139 行，缺失 0 | ZIP 89,792 B，4 个产物，全绿 |

v1.0.1 复测用 `node test/e2e-share.js` 完成：真实 Chrome 156 打开线上分享页 → 站点适配器正确识别「微信输入法 · AI 录音笔」→ 归档 ZIP 内含 8,721 字符 MD、保留 DOCTYPE 的 HTML 原件、封面 PNG、`meta.json`（`extensionVersion: 1.0.1`、`completeness.missing: 0`、`sourceUrl` 为真实分享链接）。

新链接归档 ZIP 已落到浏览器下载目录，内含 8,731 字符 MD、57,805 字节 HTML 原件、`meta.json`（`template: inferred`、`completeness.missing: 0`）、封面 PNG。

**页面本身下发的是 AI 生成的图文纪要，不是逐字转写稿**，没有 transcript / 音频可保存。

---

## 验证命令

| 命令 | 作用 |
|---|---|
| `node test/verify.js` | 旧模板全量回归：结构、覆盖率、ZIP、后台编排（mock Chrome API） |
| `node test/verify-page.js <frame.html> <shell.html> [out.md]` | **任意页面**通用回归，顺便导出 MD |
| `node test/verify-fixes.js` | 缺陷回归：iframe/srcdoc/降级链路、DOCTYPE、外壳元数据、适配器选择、文件名、封面格式、超大文件、并发 |
| `node test/e2e-headless.js` | **无需手动安装**：临时 profile + CDP 加载扩展，本地起「外壳 + 跨域 iframe」服务，跑完检查 ZIP 内容（Python 3） |
| `node test/e2e-share.js [shareUrl] [extensionDir]` | **真实分享链接**端到端：临时 profile + CDP 加载扩展，校验 ZIP 四产物、文本覆盖、DOCTYPE 与元信息；第二参数传解压后的分发包目录可验证「包本身可加载」 |
| `node test/e2e-live.js [port] [shareUrl] [extId]` | 在已装扩展的真实 Chrome 里跑真实分享页端到端归档（需 `--remote-debugging-port`） |
| `node test/make_icons.py` | 重新生成图标 |

样本自带在 `test/fixtures/`，无需外部归档目录。改转换规则后前五条都要重跑。

**跑真实链接测试需要你自己的分享链接**（仓库里不含任何真实 `share_token`）。三种方式任选：

```bash
node test/e2e-share.js "https://r.qq.com/wetype/voicerecorder?share_token=shr-你的token"
SHARE_URL="https://r.qq.com/...?share_token=shr-你的token" node test/e2e-share.js
cp test/.local-share-url.example test/.local-share-url   # 填入自己的链接后直接 node test/e2e-share.js
```

`test/.local-share-url` 已被 `.gitignore` 忽略，不会进版本库。`fixtures/` 里的 `share_token` 均为 `shr-EXAMPLE...` 占位符。

**验证状态（2026-11-11 · v1.0.1）**：JS 语法、manifest 引用、两种模板的结构计数与文本覆盖、ZIP（Python `zipfile` 独立解压）、后台编排、缺陷回归、真实 Chrome 端到端（跨域 iframe 降级注入 + **真实分享链接归档**） —— 全部通过。唯一没能自动化的是「在你日常 profile 里点击安装」这一步，原因见安装章节。`e2e-headless.js` / `e2e-share.js` 只用于测试：临时 profile 加载扩展，退出即失效，不会改动日常 Chrome。

---

## 目录

```
recap-archiver-extension/
├── manifest.json            MV3 声明
├── background.js            Service Worker：编排、打包、下载
├── capture.js               注入页面：定位 iframe、取原件、调用适配器
├── popup.html/css/js        弹窗 UI 与选项
├── lib/
│   ├── infer.js             ★ 结构推断（通用性的核心）
│   ├── converter.js         DOM → Markdown（纯函数，无依赖）
│   ├── adapters.js          站点识别、元信息、DOM 微调
│   └── zip.js               极简 ZIP（store + CRC32 + UTF-8 文件名）
├── icons/                   16/48/128 PNG
├── test/
│   ├── fixtures/            两种模板的真实页面样本
│   ├── verify.js            旧模板全量回归
│   ├── verify-page.js       任意页面通用回归
│   ├── verify-fixes.js      缺陷回归（真实 DOM + mock Chrome API）
│   ├── e2e-headless.js      无人值守真实 Chrome 端到端（本地壳页 + 跨域 iframe）
│   ├── e2e-share.js         无人值守真实 Chrome 端到端（真实分享链接）
│   ├── e2e-live.js          连手动安装实例跑真实分享页
│   ├── harness*.html        验证时自动生成（不入库）
│   ├── .local-share-url.example  私有链接配置模板
│   └── make_icons.py
├── .gitignore
├── 技术方案.md              可复用方法论与规则表
└── README.md
```

## 仓库内容与隐私

- 代码与文档**不含**真实分享凭证、账号密码、邮箱、手机号、本地绝对路径。所有 `share_token` 均已替换为 `shr-EXAMPLE...` 占位符。
- `test/fixtures/*.html` 是抓取自公开分享页的静态版式样本，用于验证通用 DOM 推断；只含纪要正文与外链 CDN 资源地址，不含姓名、联系方式、登录态或 Cookie。封面 URL 仍指向公开 CDN 路径（不含访问凭证）。不想公开这些样本可直接删除 `test/fixtures/`，只影响本地回归测试，不影响扩展运行。
- 真实分享链接只放在本机 `test/.local-share-url`，已被 `.gitignore` 忽略；`e2e-share.js` / `e2e-live.js` 从参数、环境变量或该文件读取，不会把链接写进仓库。

## 已知边界

| 情况 | 行为 |
|---|---|
| 想要逐字稿 / 音频 | 拿不到，需从录音笔原记录导出 |
| 本地 `file://` 页面 | 需在 `chrome://extensions` 打开「允许访问文件网址」 |
| 跨域封面图 | 跳过并在结果 / `meta.json` 的 `archiveNotes` 里说明；请求 10 秒超时 |
| 单个输出 > 约 1.3 MB | Chrome 的 URL 长度上限约 2 MB，base64 后约 1.3 MB 二进制；超限直接报可操作的提示，不再以 `Invalid url` 失败。关掉「内容 HTML 原件」通常可解 |
| 跨域 iframe 正文 | 顶层 fetch 被 CORS 挡住时降级为逐帧注入；`activeTab` 不覆盖的子框架仍可能失败，错误写入 `fallbackErrors` |
| 通用网页的外链 CSS / 图片 | HTML 原件保留原始外链，离线打开时这部分需联网（目标录音笔页面全内联，不受影响） |
| 依赖 JS 异步渲染的正文 | 若归档不全，刷新等渲染完再点 |
| `chrome://` 等保留页 | 直接报错，不归档 |

## 修复记录（2026-11-11 · v1.0.1）

| 问题 | 修复 |
|---|---|
| 站点适配器基础分 100，`generic` 最高 70，任意网页都被误判为「微信输入法 AI 录音笔」 | 站点适配器必须先有 URL / frame / 内容标记证据才参与评分 |
| 降级为子框架注入后，标题、日期、封面、原始分享链接全部丢失 | 顶层外壳上下文随注入参数传入每个子框架 |
| 子框架批量注入时一个不可达帧让整批失败并静默归档空壳 | 逐帧注入、逐帧捕获；跳过 `about:`/`data:`/`chrome:` 帧；失败原因写入结果与 `meta.json` |
| `documentElement.outerHTML` 丢 DOCTYPE，归档页进 quirks 模式 | 序列化时补回 DOCTYPE |
| `srcdoc` iframe 被忽略；非 HTTP iframe 制造无意义的失败 | 支持 `srcdoc`，过滤不可 fetch 的协议 |
| `credentials:'omit'` 丢同源登录态；`res.text()` 固定 UTF-8 导致 GBK 页面乱码 | 改 `same-origin`，按 `Content-Type` 的 charset 解码 |
| 更新扩展时 `onInstalled` 重置用户选项 | 已有配置一律不覆盖 |
| 封面恒存 `.png`、无超时、HTML 错误页也可能被存成图片 | 按 content-type / URL 推断扩展名，10 秒超时，非图片响应丢弃 |
| 标题含控制字符、尾点、Windows 保留名 | 文件名清洗 |
| Nuxt 里 `\uXXXX` 转义的标题 / 封面 URL 未解码 | 适配器统一反转义 |
| 并发归档、后台挂起、超大 data: URL 的含糊报错 | 加并发锁、弹窗 60 秒超时、明确的容量提示 |
| CDP `Browser.setDownloadBehavior` | 测试时会把下载重定向到指定目录并丢失文件名；正常用户点击不受影响 |
