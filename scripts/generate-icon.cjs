#!/usr/bin/env node
/** Generate black square icon + build/icon.ico for Windows exe title bar. */
const fs = require('node:fs');
const path = require('node:path');

async function loadSharp() {
  try {
    return require('sharp');
  } catch {
    console.warn('sharp not installed; run npm install --save-dev sharp for black icon generation.');
    return null;
  }
}

async function makeBlackSquarePng(sharp, src, dest) {
  const img = sharp(src).ensureAlpha();
  const { width, height } = await img.metadata();
  const size = Math.max(width || 256, height || 256);
  const { data, info } = await img
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 16) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
    }
  }

  await sharp(Buffer.from(data), { raw: info }).png().toFile(dest);
}

async function main() {
  const root = path.join(__dirname, '..');
  const srcPng = path.join(root, 'public', 'antleroffice-logo.png');
  const blackPng = path.join(root, 'public', 'antleroffice-logo-black.png');
  const outDir = path.join(root, 'build');
  const outIco = path.join(outDir, 'icon.ico');
  const outPng = path.join(outDir, 'icon.png');

  if (!fs.existsSync(srcPng)) {
    console.error('Missing', srcPng);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const sharp = await loadSharp();
  let iconSource = srcPng;

  if (sharp) {
    await makeBlackSquarePng(sharp, srcPng, blackPng);
    await makeBlackSquarePng(sharp, srcPng, outPng);
    iconSource = outPng;
    console.log('Wrote', blackPng);
    console.log('Wrote', outPng);
  } else {
    fs.copyFileSync(srcPng, outPng);
  }

  try {
    const pngToIco = (await import('png-to-ico')).default;
    const buf = await pngToIco(iconSource);
    fs.writeFileSync(outIco, buf);
    console.log('Wrote', outIco);
  } catch (e) {
    console.warn('ICO generation failed; electron-builder will use PNG.', e.message || e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
