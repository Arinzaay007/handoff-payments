/**
 * Browser-only QR encoder for recipient payment pages.
 *
 * It accepts only a normal http(s) URL supplied by the app's canonical payment-page helper and
 * returns a self-contained PNG data URL. No QR payload or recipient data is sent to an external
 * service.
 */
import QRCode from 'qrcode';

function paymentPageDataUrl(paymentPageUrl) {
  const url = new URL(paymentPageUrl);
  if (!/^https?:$/.test(url.protocol)
    || !/^\/@[a-z0-9_]{3,24}$/i.test(url.pathname)
    || url.search || url.hash || url.username || url.password) {
    throw new Error('A valid Handoff payment page is required to create a QR code.');
  }
  return QRCode.toDataURL(url.toString(), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 720,
    color: {
      dark: '#102014',
      light: '#fffefa'
    }
  });
}

// esbuild's IIFE globalName publishes this named export as window.HandoffQr. Do not assign to
// window directly here: the IIFE's final assignment would overwrite that value with undefined.
export { paymentPageDataUrl };
