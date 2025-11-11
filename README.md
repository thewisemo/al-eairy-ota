# Al Eairy OTA — Starter Pack

This repo contains:
- `.github/workflows/ota-scan.yml` (GitHub Actions workflow; runs daily)
- `scrape.mjs` (Playwright scraper)
- `package.json` (dev deps)
- `data/.gitkeep` (empty placeholder for data folder)

## How to use
1) Upload these files to your **public** GitHub repository root.
2) Open the **Actions** tab, enable workflows, then **Run workflow** once.
3) After it finishes, check `data/latest.json`. Click **Raw** and copy the URL.
4) In Google Apps Script, paste that raw URL in `REMOTE_JSON_URL` and create a daily trigger.
