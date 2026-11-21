import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const MAX_PDF_TEXT = 80_000;

export function extractResumePdfText(bytes, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: 'resume-pdf-text', bytes },
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Reading this PDF took too long. Try a smaller text-based PDF.')), timeoutMs);
    worker.on('message', (message) => {
      if (message.error) finish(new Error(message.error));
      else finish(null, message.text);
    });
    worker.on('error', () => finish(new Error('Could not read this PDF. Upload a text-based PDF or a LaTeX file.')));
    worker.on('exit', (code) => {
      if (!settled) finish(new Error(`PDF reader stopped before returning text (code ${code}).`));
    });
  });
}

if (!isMainThread && workerData?.kind === 'resume-pdf-text') {
  let parser;
  try {
    const { PDFParse } = await import('pdf-parse');
    parser = new PDFParse({
      data: new Uint8Array(workerData.bytes),
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const result = await parser.getText();
    if (result.total > 12) throw new Error('Please choose a resume PDF with no more than 12 pages.');
    const text = String(result.text || '').trim();
    if (text.length < 40) throw new Error('This PDF has no readable resume text. Upload a text-based PDF or a LaTeX file.');
    if (text.length > MAX_PDF_TEXT) throw new Error('This PDF contains too much text. Choose a shorter resume.');
    parentPort.postMessage({ text });
  } catch (error) {
    const known = /no more than|no readable|too much text/.test(error.message || '');
    parentPort.postMessage({ error: known ? error.message : 'Could not read this PDF. Upload an unencrypted text-based PDF or a LaTeX file.' });
  } finally {
    await parser?.destroy().catch(() => {});
  }
}
