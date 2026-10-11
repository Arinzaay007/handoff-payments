// Verifies the browser bundle publishes the local QR encoder as window.HandoffQr. This catches an
// easy-to-miss IIFE global-name error where assigning window.HandoffQr inside the entry module is
// overwritten by esbuild's final global assignment.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

test('the QR browser bundle exposes a working local payment-page encoder', async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/qr-client.js')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'HandoffQr',
    write: false,
    minify: true
  });
  const dom = new JSDOM('<!doctype html>', {
    runScripts: 'outside-only',
    url: 'https://handoff.test/'
  });
  const { window } = dom;
  // jsdom does not currently expose these browser globals by default; real supported browsers do.
  window.TextEncoder = global.TextEncoder;
  window.TextDecoder = global.TextDecoder;
  const renderedPixels = [];
  window.HTMLCanvasElement.prototype.getContext = () => ({
    clearRect() {},
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image) {
      renderedPixels.push(image.data.length);
    }
  });
  window.HTMLCanvasElement.prototype.toDataURL = type => `data:${type};base64,qr-test`;

  window.eval(result.outputFiles[0].text);

  assert.equal(typeof window.HandoffQr?.paymentPageDataUrl, 'function');
  const dataUrl = await window.HandoffQr.paymentPageDataUrl('https://handoff.test/@morgan');
  assert.equal(dataUrl, 'data:image/png;base64,qr-test');
  assert.equal(renderedPixels.length, 1, 'the encoder renders a local canvas image');
  assert.ok(renderedPixels[0] > 0);
  assert.throws(
    () => window.HandoffQr.paymentPageDataUrl('https://handoff.test/@morgan?amount=25'),
    /valid Handoff payment page/i
  );
});
