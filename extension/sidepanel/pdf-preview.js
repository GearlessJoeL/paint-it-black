import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

const MAX_CACHE_ENTRIES = 6;
const pdfBytesCache = new Map();

async function fetchPdfBytes(pdfUrl, { forceReload = false, signal } = {}) {
  if (!forceReload && pdfBytesCache.has(pdfUrl)) {
    return pdfBytesCache.get(pdfUrl);
  }

  const res = await fetch(pdfUrl, { cache: 'no-store', signal });
  if (!res.ok) {
    throw new Error(`Could not load PDF preview (HTTP ${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Evict oldest entry when cache grows beyond limit
  if (pdfBytesCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = pdfBytesCache.keys().next().value;
    if (oldestKey) pdfBytesCache.delete(oldestKey);
  }
  pdfBytesCache.set(pdfUrl, bytes);
  return bytes;
}

export function clearPdfPreviewCache(urlPrefix = '') {
  if (!urlPrefix) {
    pdfBytesCache.clear();
    return;
  }
  for (const key of [...pdfBytesCache.keys()]) {
    if (key.startsWith(urlPrefix)) {
      pdfBytesCache.delete(key);
    }
  }
}

/**
 * Render all pages of a PDF crisply onto high-DPI canvases inside containerEl.
 * Returns { numPages, cancelled }.
 */
export async function renderPdfPreview({
  pdfUrl,
  containerEl,
  zoom = 1,
  forceReload = false,
  signal,
  onPageClick = null,
}) {
  const bytes = await fetchPdfBytes(pdfUrl, { forceReload, signal });
  if (signal?.aborted) return { numPages: 0, cancelled: true };

  // Pass a fresh copy to PDF.js because the worker transfers/detaches the underlying ArrayBuffer
  const dataCopy = new Uint8Array(bytes);
  const loadingTask = pdfjsLib.getDocument({
    data: dataCopy,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  try {
    const pdfDoc = await loadingTask.promise;
    if (signal?.aborted) return { numPages: 0, cancelled: true };

    const numPages = pdfDoc.numPages;
    const containerWidth = Math.max(240, (containerEl.clientWidth || 320) - 16);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    const fragment = document.createDocumentFragment();

    for (let pageNum = 1; pageNum <= numPages; pageNum += 1) {
      if (signal?.aborted) return { numPages: 0, cancelled: true };

      const page = await pdfDoc.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const fitScale = containerWidth / baseViewport.width;
      const cssScale = fitScale * zoom;
      const cssViewport = page.getViewport({ scale: cssScale });
      const renderViewport = page.getViewport({ scale: cssScale * dpr });

      const sheet = document.createElement('div');
      sheet.className = 'pdf-page-sheet';

      if (numPages > 1) {
        const pageTag = document.createElement('span');
        pageTag.className = 'pdf-page-tag';
        pageTag.textContent = `Page ${pageNum} / ${numPages}`;
        sheet.append(pageTag);
      }

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));
      canvas.style.width = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Resume PDF preview page ${pageNum} of ${numPages}`);

      if (onPageClick) {
        canvas.classList.add('is-clickable');
        canvas.addEventListener('click', onPageClick);
      }

      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvasContext: ctx,
        viewport: renderViewport,
      }).promise;

      sheet.append(canvas);
      fragment.append(sheet);
    }

    if (signal?.aborted) return { numPages: 0, cancelled: true };

    containerEl.replaceChildren(fragment);
    return { numPages, cancelled: false };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}
