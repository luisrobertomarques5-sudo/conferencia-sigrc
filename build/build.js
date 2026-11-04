// Gera a versão minificada, o favorito (bookmarklet) e a página de instalação (index.html).
// Uso: node build/build.js
const fs = require('fs'); const { execFileSync } = require('child_process'); const path = require('path');
const R = p => path.resolve(__dirname, '..', p);
fs.mkdirSync(R('dist'), { recursive: true });
execFileSync('npx', ['--yes', 'terser@5', R('src/conferencia-sigrc.js'), '--compress', 'passes=2', '--mangle', '--comments', '/^!/', '-o', R('dist/conferencia-sigrc.min.js')], { stdio: 'inherit' });
const min = fs.readFileSync(R('dist/conferencia-sigrc.min.js'), 'utf8').replace(/^\/\*![\s\S]*?\*\/\s*/, '');
const bm = 'javascript:' + encodeURIComponent(min + ';void 0');
const versao = (fs.readFileSync(R('src/conferencia-sigrc.js'), 'utf8').match(/VERSAO = '([^']+)'/) || [])[1];
const d = new Date(); const pad = n => String(n).padStart(2, '0');
const html = fs.readFileSync(R('build/instalar.template.html'), 'utf8').replace('__BOOKMARKLET__', bm).replace('__VERSAO__', versao).replace('__DATA__', `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`);
fs.writeFileSync(R('index.html'), html);
console.log('ok: dist/conferencia-sigrc.min.js', min.length, 'bytes · index.html', html.length, 'bytes · versão', versao);
