'use strict';
const { openSession } = require('./cdp.js');
const fs = require('fs');

(async () => {
  const out = process.argv[2] ||
  require('path').join(require('os').tmpdir(), 'qw_shot.png');   // /tmp does not exist on Windows
  const { session: s } = await openSession();
  try { await s.send('Page.enable', {}, 15000); } catch (e) {}
  const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 80000);
  if (!r || !r.data) throw new Error('no screenshot data');
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('wrote', out, Buffer.from(r.data, 'base64').length, 'bytes');
  s.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
