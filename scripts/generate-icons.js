'use strict';
const sharp = require('sharp');
const { default: pngToIco } = require('png-to-ico');
const fs = require('fs');

/**
 * Remove a white (or near-white) background from an RGBA image buffer.
 */
function removeWhiteBackground(data) {
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i],
      g = out[i + 1],
      b = out[i + 2];
    if (r > 240 && g > 240 && b > 240) {
      out[i + 3] = 0;
    } else if (r > 200 && g > 200 && b > 200) {
      const whiteness = Math.min(r, g, b);
      out[i + 3] = Math.round((255 - whiteness) * (255 / 55));
    }
  }
  return out;
}

async function run() {
  fs.mkdirSync('assets/icons', { recursive: true });

  const { data, info } = await sharp('Icon.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const cleaned = removeWhiteBackground(data);

  const base = () =>
    sharp(cleaned, {
      raw: { width: info.width, height: info.height, channels: 4 },
    }).png();

  await base()
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toFile('assets/icons/icon.png');
  console.log('assets/icons/icon.png written (1024x1024)');

  const icoSizes = [16, 32, 48, 64, 128, 256];
  const sizePaths = [];
  for (const size of icoSizes) {
    const p = `assets/icons/icon-${size}.png`;
    await base()
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toFile(p);
    sizePaths.push(p);
    console.log(`assets/icons/icon-${size}.png written`);
  }
  const icoBuffer = await pngToIco(sizePaths);
  fs.writeFileSync('assets/icons/icon.ico', icoBuffer);
  console.log(`assets/icons/icon.ico written (${icoSizes.join(', ')} px)`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
