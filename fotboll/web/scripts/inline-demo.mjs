// Packs the demo build into one self-contained HTML file (no service worker,
// no separate assets), suitable for sharing or embedding.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist-demo');
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const js = html.match(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)">/)[1];
const css = html.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/)[1];
const script = readFileSync(path.join(dist, js), 'utf8').replaceAll('</script', '<\\/script');
const style = readFileSync(path.join(dist, css), 'utf8');

const page = `<!doctype html>
<html lang="so">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1e5aa8">
<title>Nidaamka UKCS</title>
<style>${style}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${script}</script>
</body>
</html>
`;
const out = path.join(dist, 'iqra-fotboll-demo.html');
writeFileSync(out, page);
console.log(`Wrote ${out} (${(page.length / 1024).toFixed(0)} KiB)`);
