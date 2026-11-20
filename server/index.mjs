import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import { buildToolEnv, loadConfig } from './config.mjs';
import { createDefaultRegistry } from './agents/registry.mjs';
import { TailorService } from './tailor-service.mjs';

function isAllowedOrigin(origin) {
  if (!origin) return true; // Direct local CLI / curl / non-browser client
  return (
    origin.startsWith('chrome-extension://') ||
    origin === 'http://127.0.0.1' ||
    origin.startsWith('http://127.0.0.1:') ||
    origin === 'http://localhost' ||
    origin.startsWith('http://localhost:')
  );
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function writeSseEvent(res, eventName, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createCompanionServer({ config: customConfig, registry: customRegistry } = {}) {
  const config = loadConfig(customConfig);
  const env = buildToolEnv(config);
  const registry = customRegistry || createDefaultRegistry({ config, env });
  const service = new TailorService({ config, registry });

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      sendJson(res, 403, { error: 'Forbidden origin. Only Chrome extensions and localhost are permitted.' });
      return;
    }

    setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${config.host}:${config.port}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/api/ping') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        const forceRefresh = url.searchParams.get('refresh') === '1';
        const health = await service.getHealth({ forceRefresh });
        sendJson(res, 200, health);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/warmup') {
        const body = await readJsonBody(req);
        const warm = await service.warmup(body);
        sendJson(res, 200, warm);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/reconnect') {
        const body = await readJsonBody(req);
        const health = await service.reconnect(body);
        sendJson(res, 200, health);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/history') {
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
        const items = await service.listHistory(limit);
        sendJson(res, 200, { items });
        return;
      }

      // Download generated PDF by in-memory job ID
      const jobPdfMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/pdf$/);
      if (req.method === 'GET' && jobPdfMatch) {
        const job = service.getJob(decodeURIComponent(jobPdfMatch[1]));
        if (!job) {
          sendJson(res, 404, { error: 'Job not found' });
          return;
        }
        const pdfBytes = await fs.readFile(job.pdfPath);
        const inline = url.searchParams.get('inline') === '1';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdfBytes.length,
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${job.pdfFilename}"`,
          'Cache-Control': 'no-store',
        });
        res.end(pdfBytes);
        return;
      }

      // Fetch full tailored details + revision list (powers Quick PDF Review for history items)
      const tailoredDetailsMatch = pathname.match(/^\/api\/tailored\/([a-z0-9][a-z0-9-]*)\/details$/);
      if (req.method === 'GET' && tailoredDetailsMatch) {
        const details = await service.getTailoredDetails(tailoredDetailsMatch[1]);
        if (!details) {
          sendJson(res, 404, { error: 'Tailored resume not found' });
          return;
        }
        sendJson(res, 200, details);
        return;
      }

      // Download a specific historical revision PDF (v1, v2, ...)
      const revPdfMatch = pathname.match(/^\/api\/tailored\/([a-z0-9][a-z0-9-]*)\/revisions\/(\d+)\/pdf$/);
      if (req.method === 'GET' && revPdfMatch) {
        const resolved = await service.resolveRevisionPdf(revPdfMatch[1], Number(revPdfMatch[2]));
        if (!resolved) {
          sendJson(res, 404, { error: 'Revision PDF not found' });
          return;
        }
        const pdfBytes = await fs.readFile(resolved.pdfPath);
        const inline = url.searchParams.get('inline') === '1';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdfBytes.length,
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${resolved.pdfFilename}"`,
          'Cache-Control': 'no-store',
        });
        res.end(pdfBytes);
        return;
      }

      // Restore an earlier revision as the active draft on disk
      const revRestoreMatch = pathname.match(/^\/api\/tailored\/([a-z0-9][a-z0-9-]*)\/revisions\/(\d+)\/restore$/);
      if (req.method === 'POST' && revRestoreMatch) {
        const restored = await service.restoreRevision(revRestoreMatch[1], Number(revRestoreMatch[2]));
        sendJson(res, 200, restored);
        return;
      }

      // Download generated PDF by tailored folder slug (persists across server restarts)
      const tailoredPdfMatch = pathname.match(/^\/api\/tailored\/([a-z0-9][a-z0-9-]*)\/pdf$/);
      if (req.method === 'GET' && tailoredPdfMatch) {
        const resolved = await service.resolveHistoryPdf(tailoredPdfMatch[1]);
        if (!resolved) {
          sendJson(res, 404, { error: 'Tailored PDF not found' });
          return;
        }
        const pdfBytes = await fs.readFile(resolved.pdfPath);
        const inline = url.searchParams.get('inline') === '1';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdfBytes.length,
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${resolved.pdfFilename}"`,
          'Cache-Control': 'no-store',
        });
        res.end(pdfBytes);
        return;
      }

      // Main tailoring, regenerate, and smart chat endpoints (Server-Sent Events stream over POST)
      if (
        req.method === 'POST' &&
        (pathname === '/api/tailor' || pathname === '/api/regenerate' || pathname === '/api/chat')
      ) {
        const body = await readJsonBody(req);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();

        const abortController = new AbortController();
        // Only abort if the response stream terminates early before finishing.
        // Note: on POST requests, req emits 'close' as soon as the request body finishes reading,
        // so we listen to `res.on('close')` rather than `req.on('close')`!
        res.on('close', () => {
          if (!res.writableEnded) {
            abortController.abort();
          }
        });

        // Keepalive SSE comment every 15s so Chrome never times out long agent runs
        const keepalive = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) {
            res.write(': keepalive\n\n');
          }
        }, 15_000);

        try {
          if (pathname === '/api/chat') {
            await service.runChatTurn(body, {
              signal: abortController.signal,
              emit: (eventName, data) => writeSseEvent(res, eventName, data),
            });
          } else if (pathname === '/api/regenerate') {
            await service.runRegenerateJob(body, {
              signal: abortController.signal,
              emit: (eventName, data) => writeSseEvent(res, eventName, data),
            });
          } else {
            await service.runTailorJob(body, {
              signal: abortController.signal,
              emit: (eventName, data) => writeSseEvent(res, eventName, data),
            });
          }
        } catch (err) {
          writeSseEvent(res, 'error', {
            code: err.code || 'TAILOR_FAILED',
            message: err.message || 'Request failed',
          });
        } finally {
          clearInterval(keepalive);
          if (!res.writableEnded) {
            res.end();
          }
        }
        return;
      }

      sendJson(res, 404, { error: `Route not found: ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Bad request' });
    }
  });

  server.on('close', () => {
    registry.disposeAll?.();
  });

  return { server, config, service, registry };
}

// Start server when executed directly
const entryHref = process.argv[1]
  ? pathToFileURL(fsSync.realpathSync(path.resolve(process.argv[1]))).href
  : '';
if (import.meta.url === entryHref) {
  const { server, config, service } = createCompanionServer();
  server.listen(config.port, config.host, () => {
    console.log(`[resume-tailor] Companion Server (${process.platform}) listening on http://${config.host}:${config.port}`);
    console.log(`[resume-tailor] Resume repository: ${config.resumeRepoDir}`);
    console.log(`[resume-tailor] Antigravity CLI:   ${config.agyBin}`);
    // Background zero-token warmup (caches `agy models` & pre-inits 1 idle worker)
    service.warmup().catch(() => {});
  });
}
