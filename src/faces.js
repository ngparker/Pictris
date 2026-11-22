// Face detection, so photos can be framed around the people in them.
// Uses a small vendored model (face-api, MIT; ~1.5 MB, loaded only when needed and cached by the
// service worker). Results are stored with each photo, so each photo is analysed once.

let loading = null;
function load() {
  if (!loading) {
    loading = (async () => {
      const faceapi = await import('../vendor/face-api/face-api.esm.js');
      await faceapi.nets.tinyFaceDetector.loadFromUri(new URL('../vendor/face-api/', import.meta.url).href);
      return faceapi;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/**
 * Bounding box of all faces in the image, normalised to 0..1, or null if there are none.
 * Throws if detection itself is unavailable (caller should leave the photo unanalysed).
 */
export async function detectFace(bitmap) {
  const faceapi = await load();
  const MAX = 640;
  const sc = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * sc)), h = Math.max(1, Math.round(bitmap.height * sc));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const found = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.45 }));
  // Ignore specks (faces in the far background); keep everyone else in frame.
  const boxes = found.map((d) => d.box).filter((b) => b.width * b.height > w * h * 0.0015);
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
  const cl = (v) => Math.min(1, Math.max(0, v));
  return { x: cl(x0 / w), y: cl(y0 / h), w: cl((x1 - x0) / w), h: cl((y1 - y0) / h) };
}
