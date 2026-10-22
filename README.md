# Lens Translate

**English** · [中文](#中文说明)

A read-only Figma plugin for reading Chinese designs in English, or English designs in Chinese. Select text, a component or a frame, and a small window next to it shows the translation. Lens never edits your file.

## Install (once)

1. Download `lens-translate.zip` from the [latest release](../../releases/latest) and unzip it somewhere permanent. Figma loads the plugin from this folder, so moving or deleting the folder breaks it.
2. Open the **Figma desktop app** and open any design file. Plugins in development can't be imported in the browser.
3. Go to **Plugins → Development → Import plugin from manifest…** and choose `manifest.json` from the unzipped folder.
4. Run it from **Plugins → Development → Lens Translate**.

To run plugins you need edit access to the file or a Dev Mode seat. View-only seats can't run plugins.

## First-time setup

You'll get an **API URL** and an **API key** from your team. Lens has no service or key built in.

1. Run Lens and click **Settings** (top right).
2. Keep Provider set to **Team API**.
3. Paste the **API base URL**, then the **API key**.
4. Click **Test**. When you see `Connected · … · <English sentence>`, click **Save**.

Your key is stored only in Figma's plugin storage on this computer. It's never written into design files. **Haiku 5.5** is the default model. **Sonnet 4.6** handles nuanced wording better, but it's slower and costs more.

## Everyday use

- **Select to translate.** Click text, a component or a frame, and Lens translates all of its visible text. On a Mac, `⌘ + click` selects a text layer nested inside a component.
- **Read in** switches the target language between English and 简体中文.
- **Follow** keeps the small window next to your selection. Turn it off to drag the window wherever you want it. **Expand** opens the full reader, and **Mini** brings back the small window.
- **Pin** keeps the current region in the reader while you browse other parts of the canvas.
- **Copy** copies all translations.
- **Mirror** (in the expanded reader) shows a preview of the frame. Hover over text in the preview to see its translation.
- With **Auto-translate** off, Lens only reads the text. Click **Translate** to request translations.
- **Terminology** (Settings → Advanced) holds your team's preferred terms, one per line, for example `布防 = Arm`.

## Good to know

- Lens sends the selected text plus light context (page name, layer names) to your team's API. Frame previews never leave Figma.
- Text that is already plain English, and text that is only numbers, times or symbols, is shown as-is and isn't sent to the model.
- Each selection reads up to 160 text layers. For large boards, select one region at a time.
- Lens can't read text inside images, text converted to outlines (vectors), or comments.
- Each error message says what went wrong, such as an invalid key, exhausted quota or unavailable service. **Retry** only re-sends the text that didn't finish.

---

## 中文说明

Lens Translate 是一个只读的 Figma 插件，可以把中文设计稿翻成英文阅读，也可以把英文稿翻成中文。点选文字、组件或画板，旁边的小窗就会显示译文。插件不会修改设计稿。

### 安装（只需一次）

1. 从 [最新版本](../../releases/latest) 下载 `lens-translate.zip`，解压到一个固定的位置。插件从这个文件夹加载，移动或删除文件夹后就用不了了。
2. 打开 **Figma 桌面端**，进入任意 Design 文件。开发中的插件不能在网页版导入。
3. 菜单 **Plugins → Development → Import plugin from manifest…**，选择文件夹里的 `manifest.json`。
4. 之后从 **Plugins → Development → Lens Translate** 运行。

运行插件需要文件的编辑权限或 Dev Mode 席位，只能查看（View）的席位不能运行插件。

### 首次设置

API 地址和 API key 由团队提供，插件本身不带任何服务地址或 Key。

1. 运行插件，点右上角 **Settings**。
2. Provider 保持 **Team API**。
3. 先填 **API base URL**，再粘贴 **API key**。
4. 点 **Test**，看到 `Connected · … · 英文译文` 后点 **Save**。

Key 只保存在这台电脑的 Figma 插件存储里，不会写进设计文件。默认模型是 **Haiku 5.5**；**Sonnet 4.6** 措辞更好，但更慢、费用更高。

### 日常使用

- **点选即翻译**：点选文字、组件或画板，翻译其中所有可见的文字。macOS 上用 `⌘ + 点击` 可以直接选中组件里的文字图层。
- **Read in**：切换目标语言，English 或简体中文。
- **Follow**：小窗跟着选区走；关闭后可以把窗口拖到固定位置。**Expand** 打开完整阅读器，**Mini** 切回小窗。
- **Pin**：固定当前区域，浏览画布其他地方时内容不变。
- **Copy**：复制全部译文。
- **Mirror**（在完整阅读器里）：显示画板预览，鼠标移到预览里的文字上就能看到对应译文。
- 关闭 **Auto-translate** 后，插件只读取文字，点 **Translate** 才会翻译。
- **Terminology**（Settings → Advanced）：填写团队术语，每行一条，例如 `布防 = Arm`。

### 注意事项

- 选中的文字和少量上下文（页面名、图层名）会发送到团队的 API。画板预览不会离开 Figma。
- 本身已经是纯英文的文本，以及只有数字、时间或符号的文本，会直接显示原文，不发给模型。
- 每次选区最多读取 160 个文字图层，大稿请分区域选。
- 无法识别图片里的文字、转成轮廓（矢量）的文字和评论。
- 出错时会说明原因，比如 Key 无效、额度用完、服务暂不可用。点 **Retry** 只重发没完成的部分。

---

## Development · 开发

Requires Node.js 18+. There are no dependencies. · 需要 Node.js 18+，没有其他依赖。

```sh
npm run build    # bundle src/ into ui.html · 把 src/ 打包成 ui.html
npm test         # unit tests · 单元测试
npm run preview  # local UI harness with a simulated translator at http://127.0.0.1:49173 · 本地预览，使用模拟翻译
```

`code.js` is the Figma-side entry point and only reads the document. The UI lives in `src/` (`ui.html`, `style.css`, `core.js`, `ui.js`). After editing those files, run `npm run build`.

`code.js` 是 Figma 端入口，只读取文档。界面代码在 `src/`（`ui.html`、`style.css`、`core.js`、`ui.js`），修改后运行 `npm run build`。
