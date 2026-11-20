# 印刷データ（社内用・非公開）

管理画面「資料請求 › 印刷データ」から、ログインした社員だけがダウンロードできます。`public/` には置きません。

- `manifest.json` に載っているファイルだけが配信されます（`/api/print-file/<ファイル名>`）。
- 会社案内の元データと作り方: `~/Projects/_assets/corporate-web/kaisha-annai-booklet-2026-11-20/`（`src/build.cjs` → `src/render.cjs`）。
- 差し替え: 新しい PDF を同じファイル名で上書きし、`manifest.json` の `updated` を変えて deploy します。
