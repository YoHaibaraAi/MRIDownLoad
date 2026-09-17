# 影像云 DICOM 下载器

这是一个 Chrome / Edge Manifest V3 扩展。它在已正常授权打开的影像云页面中读取当前检查，把选中 Series 的原始 DICOM 下载到浏览器内存，并按 Series 目录生成一个本地 ZIP。

扩展只处理当前页面已经获准查看的检查；不实现登录、验证码或权限绕过，不枚举其他检查，不要求复制 Cookie/token，也不会把 DICOM 上传到第三方。

## 安装

### Chrome

1. 打开 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录（包含 `manifest.json` 的目录）。

### Edge

1. 打开 `edge://extensions/`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目目录。

修改代码后，请在扩展管理页点击本扩展的“重新加载”，并刷新影像页面。

## 使用

1. 通过正常方式打开 `https://hos-turn-service.rwjiankang.com:5447/` 下有权访问的报告或阅片页面。
2. 如页面尚未加载影像，先打开任意一个影像序列并等待画面出现。
3. 点击右下角“DICOM 下载”。
4. 检查日期、部位、Series 和张数，保留全部勾选或只选择部分 Series。
5. 点击“下载选中的 DICOM”。下载过程中不要关闭或刷新页面。
6. 浏览器会保存一个不含患者姓名、手机号或证件号的 ZIP，例如 `20260101_STUDY_DICOM.zip`（实际文件名来自当前检查日期与描述）。

ZIP 在浏览器内存中生成。大型检查可能占用约为 DICOM 总大小加 ZIP 工作区的内存；内存不足时建议分 Series 下载。

## 权限与隐私

- 扩展只匹配 `https://hos-turn-service.rwjiankang.com:5447/*`。
- `manifest.json` 不申请 `<all_urls>`、Cookie、debugger、webRequestBlocking 或下载管理权限。
- 下载请求复用当前页面已有的正常会话，并且只发往当前医院站点的同源 `/dsiteapi/`。
- 站点移动端会把当前会话授权值放在同源 `sessionStorage` 并由自身请求拦截器加入 `Authorization`；扩展只在发起医院同源请求时自动复用该值，不保存、不显示也不记录它。
- ZIP 在浏览器本地生成，不使用 CDN、代理服务器或第三方上传。
- 本地 `reference/` 和开发分析资料含敏感调试信息，已由 `.gitignore` 排除，禁止提交或分享。

## 常见问题

- **找不到 Vue store**：等待页面完全加载后重试。Series 元数据会尝试回退到当前分享 URL 的 `QuerySeriesInfoByUrl` 接口。
- **curSerieAe 未初始化**：扩展会读取移动端同源 iframe 的 Vue 状态，并缓存当前页面初始化期间最后一次非空的 AE。若仍为空，请刷新页面，或先打开任意影像序列并等待影像加载完成后重试；扩展最多等待约 10 秒。
- **staticKey 获取失败**：确认页面会话仍有效，刷新后重试。扩展会先读页面状态，再回退到 `POST /dsiteapi/sm4/secret`。
- **API 请求失败**：检查页面本身能否正常阅片，以及登录/分享链接是否过期。失败单张会自动重试 3 次（500/1000/2000 ms）。
- **ZIP 内存不足**：关闭其他占用内存的标签页，或拆成少量 Series 分批下载。
- **某些文件没有 `DICM` 标记**：扩展只把长度明显异常的数据判为失败；合法 DICOM 数据集可能没有 Part 10 preamble，因此不会仅因缺少标记丢弃。

## 调试日志

默认不输出 UID 等调试信息。在影像页面的开发者工具 Console 中执行：

```js
localStorage.setItem("RWJ_DICOM_DEBUG", "1")
```

刷新页面后启用以 `[RWJ-DICOM]` 开头的有限日志。关闭：

```js
localStorage.removeItem("RWJ_DICOM_DEBUG")
```

请勿把包含医疗数据的日志或 HAR 发到公开位置。

## 开发与测试

```bash
npm ci
npm test
npm run check
```

`npm test` 覆盖独立 OpenSSL 验证的公开 SM4-ECB-PKCS#7 向量、空字符串 helper 行为、ZIP 路径清理和 `imageNumber` 排序。`npm run check` 还校验 Manifest V3、权限、运行时远程 URL、硬编码密钥及 manifest 引用文件。如需在本机分析自己抓取的 HAR，可运行 `node scripts/analyze-har.mjs reference/<本地文件>.har`；不要上传 HAR 或患者数据。

## 代码结构

```text
manifest.json
src/
  page-bridge.js   # MAIN world：有限扫描 Vue 2 store，只返回下载所需状态
  content.js       # 任务编排、页面状态轮询和保存 ZIP
  api.js           # 同源 API、staticKey 与加密参数
  sm4.js           # 本地 SM4 ECB + PKCS#7
  downloader.js    # 并发 4、重试、取消、DICOM 校验与 ZIP
  ui.js            # 页面悬浮面板与进度
  content.css
vendor/
  jszip.min.js     # 本地 vendored JSZip，不访问 CDN
tests/
reference/         # 仅本地调试；整个目录不进入 Git
```
