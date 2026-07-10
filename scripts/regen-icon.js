'use strict';
const sharp = require('sharp');
const { default: pngToIco } = require('png-to-ico');
const fs = require('fs');

async function run() {
  const src = 'Icon1.png';
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const sizePaths = [];

  for (const size of icoSizes) {
    const p = `assets/icons/icon-${size}.png`;
    await sharp(src)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(p);
    console.log('wrote', p);
    sizePaths.push(p);
  }

  // Update the main icon.png (1024px)
  await sharp(src)
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile('assets/icons/icon.png');
  console.log('wrote assets/icons/icon.png');

  const icoBuffer = await pngToIco(sizePaths);
  fs.writeFileSync('assets/icons/icon.ico', icoBuffer);
  console.log('wrote assets/icons/icon.ico');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
