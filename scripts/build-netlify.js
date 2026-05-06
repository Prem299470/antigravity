const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const filesToCopy = [
  'index.html',
  'style.css',
  'app.js',
];

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const relativePath of filesToCopy) {
  const sourcePath = path.join(rootDir, relativePath);
  const targetPath = path.join(distDir, relativePath);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing required file for Netlify build: ${relativePath}`);
  }

  fs.copyFileSync(sourcePath, targetPath);
}

console.log(`Prepared Netlify publish directory at ${distDir}`);
