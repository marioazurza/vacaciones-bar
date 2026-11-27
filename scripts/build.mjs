// Compila la interfaz:
//  - dist/            → la aplicación que sirve el servidor (npm start)
//  - dist-demo/vacaciones-demo.html → versión de prueba en un único archivo, sin servidor
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const common = {
  bundle: true,
  minify: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  target: ['es2020'],
  legalComments: 'none',
  logLevel: 'warning',
};

const html = (body, head = '') => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2f6fed">
<title>Calendario de vacaciones</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌴</text></svg>">
${head}
</head>
<body>
<div id="app"></div>
${body}
</body>
</html>
`;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({ ...common, entryPoints: { app: 'web/entry-server.jsx' }, outdir: 'dist', format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]' });
writeFileSync('dist/index.html', html('<script type="module" src="/app.js"></script>', '<link rel="stylesheet" href="/app.css">'));

mkdirSync('dist-demo', { recursive: true });
await build({
  ...common, entryPoints: { demo: 'web/entry-demo.jsx' }, outdir: 'dist-demo/tmp', format: 'iife',
  define: {
    __DEMO_ADMIN_USER__: JSON.stringify((process.env.DEMO_ADMIN_USER || 'admin').toLowerCase()),
    __DEMO_ADMIN_PASSWORD__: JSON.stringify(process.env.DEMO_ADMIN_PASSWORD || 'admin'),
  },
});
const js = readFileSync('dist-demo/tmp/demo.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readFileSync('dist-demo/tmp/demo.css', 'utf8');
writeFileSync('dist-demo/vacaciones-demo.html', html(`<script>${js}</script>`, `<style>${css}</style>`));
// Variante para publicar como página de claude.ai (sin esqueleto html/head/body propio)
writeFileSync('dist-demo/artifact.html', `<title>Calendario de vacaciones</title>\n<style>${css}</style>\n<div id="app"></div>\n<script>${js}</script>\n`);
rmSync('dist-demo/tmp', { recursive: true, force: true });
console.log('Compilado: dist/ y dist-demo/vacaciones-demo.html');

// Versión publicada (GitHub Pages) con datos compartidos en Supabase.
mkdirSync('dist-cloud', { recursive: true });
await build({
  ...common, entryPoints: { cloud: 'web/entry-cloud.jsx' }, outdir: 'dist-cloud/tmp', format: 'iife',
  define: {
    __CLOUD_API__: JSON.stringify(process.env.CLOUD_API || 'https://natreivwsrbxfufjrgin.supabase.co/functions/v1/api'),
    __CLOUD_KEY__: JSON.stringify(process.env.CLOUD_KEY || 'sb_publishable_tZsTxUPDRt7cJfvTGWQpOQ_gEp_wIiz'),
  },
});
{
  const cj = readFileSync('dist-cloud/tmp/cloud.js', 'utf8').replace(/<\/script/gi, '<\\/script');
  const cc = readFileSync('dist-cloud/tmp/cloud.css', 'utf8');
  writeFileSync('dist-cloud/index.html', html(`<script>${cj}</script>`, `<style>${cc}</style>`));
  rmSync('dist-cloud/tmp', { recursive: true, force: true });
}

// Servidor para Supabase (Edge Function "api"): un único archivo.
await build({
  ...common, entryPoints: ['edge/handler.js'], outfile: 'dist-edge/index.js', format: 'esm', platform: 'neutral',
  external: ['npm:*', 'node:*'],
});
console.log('Compilado: dist-edge/index.js (Supabase)');
