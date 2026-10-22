# Lens · Bilingual Reader

A read-only Figma plugin for reading Chinese designs in English (or English designs in Chinese). Select text, a component or a frame, and a small window next to it shows the translation. Lens never edits your file.

## Install (once)

1. Download `lens-bilingual-reader.zip` from the [latest release](../../releases/latest) and unzip it somewhere permanent. Figma loads the plugin from this folder, so moving or deleting the folder breaks it.
2. Open the **Figma desktop app** and open any design file. Plugins in development can't be imported in the browser.
3. Go to **Plugins → Development → Import plugin from manifest…** and choose `manifest.json` from the unzipped folder.
4. Run it from **Plugins → Development → Lens · Bilingual Reader**.

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

## Development

Requires Node.js 18+. There are no dependencies.

```sh
npm run build    # bundle src/ into ui.html
npm test         # unit tests
npm run preview  # local UI harness with a simulated translator at http://127.0.0.1:49173
```

`code.js` is the Figma-side entry point and only reads the document. The UI lives in `src/` (`ui.html`, `style.css`, `core.js`, `ui.js`). After editing those files, run `npm run build`.
