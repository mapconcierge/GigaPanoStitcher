# PanoramaStitcher

[English](#english) | [日本語](#日本語)

## Demo

https://mapconcierge.github.io/PanoramaSticher/

---

## English

### Overview

**PanoramaStitcher** is a fully client-side web application that stitches up to 300 JPEG images shot on a motorized pan/tilt head (GigaPan device) into a single high-resolution panorama — either a flat **Rectangle** or a **360° Equirectangular** image — entirely in your browser.

- No backend server: 100% static (HTML / CSS / JS / WASM), hostable on GitHub Pages
- Computer vision runs locally via WebAssembly (OpenCV.js) with GPU acceleration
- Your photos never leave your PC

### Development status

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | UI shell, Leaflet map, drag-and-drop upload | ✅ Done |
| 2 | GigaPan shooting-pattern logic + interactive thumbnail matrix | ✅ Done |
| 3 | Exif GPS/timestamp parsing → map marker | ✅ Done |
| 4 | OpenCV.js (WASM) stitching engine | ✅ Done |
| 5 | Exif GPS injection + KML PhotoOverlay export | ✅ Done |

### Usage

1. **Load images** — Drag and drop your JPEG files (up to 300) onto the drop zone, or click it to browse. Files are automatically sorted by filename (natural sort), which restores the GigaPan capture order. Dropping files anywhere on the page is safe — they are routed into the uploader.
2. **Matrix & shooting pattern** — Enter the number of **rows (elevation)** and **columns (azimuth)**, then select the shooting pattern used by your GigaPan head:
   - *Capture order*: Azimuth first (row by row) / Elevation first (column by column)
   - *Direction*: Clockwise (left → right) / Counter-clockwise (right → left)
   - *Scan*: Parallel (raster) / Zig-zag (serpentine)
   - *Start row*: Top / Bottom (left/right is implied by Direction)

   Click **Arrange grid** to lay the thumbnails out in a matrix. You can then drag and drop thumbnails to fix any misplacement, or remove/add images.
3. **Shooting location** — The map (right panel) shows a draggable 📷 camera marker. When your photos contain Exif GPS, the location of the last shot is used automatically; otherwise it defaults to Tokyo Station, or your current position via the **📍 My location** button. Drag the marker to correct the location — it is written into the output JPEG's Exif.
4. **Stitch** — Choose the output mode (**360° Equirectangular** or **Rectangle**) and click **Stitch panorama**. Feature extraction and blending run in a Web Worker using OpenCV.js (WASM).
5. **Export** — Download the stitched panorama as a JPEG with the corrected GPS coordinates injected into its Exif. Check **"Bundle a KML PhotoOverlay for Google Earth"** to get a .kmz (KML PhotoOverlay + the JPEG) that opens directly in Google Earth.

### Running locally

No build step is required. Serve the repository root with any static file server:

```bash
git clone https://github.com/mapconcierge/PanoramaSticher.git
cd PanoramaSticher
python3 -m http.server 8080
# open http://localhost:8080
```

> **Note:** Opening `index.html` via `file://` will not work because the app uses ES modules — use an HTTP server.

### Tech stack

| Purpose | Library | Notes |
|---------|---------|-------|
| Map | [Leaflet](https://leafletjs.com/) 1.9.4 + OpenStreetMap standard layer | WGS84 (EPSG:4326) coordinates |
| Exif reading | [exifr](https://github.com/MikeKovarik/exifr) 7.1.3 | GPS + DateTimeOriginal |
| Exif writing | [piexifjs](https://github.com/hMatoba/piexifjs) 1.0.6 | GPS injection into output JPEG |
| Archiving | [JSZip](https://stuk.github.io/jszip/) 3.10.1 | .kmz (KML + JPEG) bundling |
| Computer vision | OpenCV.js 4.10.0 (WASM, vendored) | Loaded in a Web Worker on first stitch |

All CDN assets are version-pinned with Subresource Integrity (SRI) hashes.

### Data sources & licenses

- Code: [MIT License](LICENSE)
- Map tiles: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL)
- Your uploaded photos are processed entirely in the browser and are never sent to any server

### Author

Taichi FURUHASHI ([@mapconcierge](https://github.com/mapconcierge)) — Furuhashi Lab., School of Global Studies and Collaboration, Aoyama Gakuin University

### Related links

- Repository: https://github.com/mapconcierge/PanoramaSticher
- Sister project: [PhotoOverlayCreator](https://github.com/mapconcierge/PhotoOverlayCreator) — KML PhotoOverlay creation & editing tool

---

## 日本語

### 概要

**PanoramaStitcher** は、電動パン/チルト雲台（GigaPan デバイス）で連続撮影した最大 300 枚の JPEG 画像を、ブラウザだけで 1 枚の高解像度パノラマ（平面 **Rectangle** または **360度 Equirectangular**）に合成する、完全クライアントサイドの Web アプリです。

- バックエンドサーバ不要：100% 静的（HTML / CSS / JS / WASM）で GitHub Pages にホスト可能
- 画像処理は WebAssembly（OpenCV.js）+ GPU アクセラレーションでローカル実行
- 写真データは PC の外に送信されません

### 開発状況

| フェーズ | 機能 | 状況 |
|---------|------|------|
| 1 | UI シェル・Leaflet 地図・ドラッグ&ドロップ読み込み | ✅ 完了 |
| 2 | GigaPan 撮影パターン解析 + サムネイルマトリクス編集 UI | ✅ 完了 |
| 3 | Exif GPS/タイムスタンプ解析 → 地図マーカー連携 | ✅ 完了 |
| 4 | OpenCV.js（WASM）スティッチングエンジン | ✅ 完了 |
| 5 | Exif GPS 書き込み + KML PhotoOverlay 出力 | ✅ 完了 |

### 使い方

1. **画像の読み込み（Load images）** — JPEG ファイル（最大 300 枚）をドロップゾーンにドラッグ&ドロップするか、クリックしてファイルを選択します。ファイル名の自然順ソートにより GigaPan の撮影順が自動的に復元されます。ページ上のどこにドロップしても安全にアップローダへ取り込まれます。
2. **マトリクスと撮影パターン（Matrix & shooting pattern）** — **行数（仰角方向 / rows）** と **列数（方位角方向 / columns）** を入力し、GigaPan 雲台の撮影パターンを選択します：
   - *Capture order（撮影順）*: Azimuth first（行ごと）/ Elevation first（列ごと）
   - *Direction（回転方向）*: Clockwise（左→右）/ Counter-clockwise（右→左）
   - *Scan（走査）*: Parallel（ラスタ）/ Zig-zag（つづら折り）
   - *Start row（開始行）*: Top（上段から）/ Bottom（下段から）— 左右は Direction で決まります

   **Arrange grid** をクリックするとサムネイルがマトリクス状に配置されます。ドラッグ&ドロップで並べ替え・削除・追加が可能です。
3. **撮影地点（Shooting location）** — 右パネルの地図にドラッグ可能な 📷 カメラマーカーが表示されます。写真に Exif GPS がある場合は最後に撮影された 1 枚の位置が自動採用され、ない場合は東京駅、または **📍 My location** ボタンで現在地が初期位置になります。マーカーをドラッグして撮影地点を修正でき、その座標が出力 JPEG の Exif に書き込まれます。
4. **合成（Stitch）** — 出力モード（**360° Equirectangular** / **Rectangle**）を選び **Stitch panorama** をクリックします。特徴点抽出と合成は OpenCV.js（WASM）を用いて Web Worker 内で実行されます。
5. **書き出し（Export）** — 合成したパノラマを、修正済み GPS 座標を Exif に埋め込んだ JPEG としてダウンロードします。**"Bundle a KML PhotoOverlay for Google Earth"** にチェックを入れると、Google Earth でそのまま開ける .kmz（KML PhotoOverlay + JPEG）を出力します。

### ローカルでの実行

ビルド不要です。リポジトリのルートを任意の静的ファイルサーバで配信してください：

```bash
git clone https://github.com/mapconcierge/PanoramaSticher.git
cd PanoramaSticher
python3 -m http.server 8080
# http://localhost:8080 を開く
```

> **注意:** ES modules を使用しているため、`file://` で `index.html` を直接開いても動作しません。必ず HTTP サーバ経由でアクセスしてください。

### 技術スタック

| 用途 | ライブラリ | 備考 |
|------|-----------|------|
| 地図 | [Leaflet](https://leafletjs.com/) 1.9.4 + OpenStreetMap 標準レイヤ | 座標系は WGS84（EPSG:4326） |
| Exif 読み込み | [exifr](https://github.com/MikeKovarik/exifr) 7.1.3 | GPS + DateTimeOriginal |
| Exif 書き込み | [piexifjs](https://github.com/hMatoba/piexifjs) 1.0.6 | 出力 JPEG への GPS 埋め込み |
| アーカイブ | [JSZip](https://stuk.github.io/jszip/) 3.10.1 | .kmz（KML + JPEG）生成 |
| 画像処理 | OpenCV.js 4.10.0（WASM・同梱） | 初回スティッチ時に Web Worker 内でロード |

CDN アセットはすべてバージョン固定 + Subresource Integrity（SRI）ハッシュ付きです。

### データソース・ライセンス

- コード: [MIT License](LICENSE)
- 地図タイル: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）
- アップロードした写真はすべてブラウザ内で処理され、サーバには一切送信されません

### 著者

古橋大地 / Taichi FURUHASHI（[@mapconcierge](https://github.com/mapconcierge)）— 青山学院大学 地球社会共生学部 古橋研究室

### 関連リンク

- リポジトリ: https://github.com/mapconcierge/PanoramaSticher
- 姉妹プロジェクト: [PhotoOverlayCreator](https://github.com/mapconcierge/PhotoOverlayCreator) — KML PhotoOverlay 作成・編集ツール
