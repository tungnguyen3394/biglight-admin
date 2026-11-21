# 印刷データ（社内用・非公開）

管理画面「資料請求 › 印刷データ」から、ログインした社員だけがダウンロードできます。`public/` には置きません。

- `manifest.json` に載っているファイルだけが配信されます（`/api/print-file/<ファイル名>`）。
- 会社案内の元データと作り方: `~/Projects/_assets/corporate-web/kaisha-annai-booklet-2026-11-20/`（`src/build.cjs` → `src/render.cjs`）。
- 差し替え: 新しい PDF を同じファイル名で上書きし、`manifest.json` の `updated` を変えて deploy します。
- チラシ（飛び込み営業用、`kind: flyer`）の元データ: `~/Projects/_assets/corporate-web/chirashi-tobikomi-2026-11-20/`（`src/build-kon.cjs` → `src/render.cjs kon`）。各 PDF は 2ページ（表・裏）。
- 営業資料「溶接人材のご提案」（`kind: flyer` + `pick` で見出しを変更）の元データ: `~/Projects/_assets/corporate-web/yosetsu-sales-deck-2026-11-21/`（`src/deck-b.src.html` → `node src/build.cjs deck-b`）。16ページ横、赤字の ○ は確認中の数字。
- 2026-11-21 から CRM の 資料ライブラリ（sales の 営業資料 › 社内資料 と同じ）が 正。`.env` の `CRM_LIBRARY_KEY`（CRM の Actions「setup-library-key」が書く）があれば、同じ id・key のファイルは CRM から出す。鍵が無い／CRM が答えないときは このフォルダの PDF。差し替えは sales（管理者）から。
