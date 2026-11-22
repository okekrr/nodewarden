import { Env } from './types';
import { NotificationsHub } from './durable/notifications-hub';
import { BackupTransferRunner } from './durable/backup-transfer-runner';
import { handleRequest } from './router';
import { StorageService } from './services/storage';
import { applyCors, jsonResponse } from './utils/response';
import { runScheduledBackupIfDue } from './handlers/backup';
import {
  isBackendRequestPath,
  isWebVaultHidden,
  webVaultNotFoundResponse,
} from './web-vault-visibility';

let dbInitialized = false;
let dbInitError: string | null = null;
let dbInitPromise: Promise<void> | null = null;

function normalizeRequestUrl(request: Request): Request {
  const url = new URL(request.url);
  const normalizedPathname = url.pathname.length <= 1 ? url.pathname : url.pathname.replace(/\/+$/, '');
  if (normalizedPathname === url.pathname) return request;

  url.pathname = normalizedPathname;
  return new Request(url.toString(), request);
}

function addSearchIndexHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const contentType = String(response.headers.get('Content-Type') || '').toLowerCase();
  const shouldNoIndex =
    url.pathname === '/robots.txt' ||
    contentType.includes('text/html');

  if (!shouldNoIndex) return response;

  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function maybeServeAsset(request: Request, env: Env): Promise<Response | null> {
  if (!env.ASSETS) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (isBackendRequestPath(url.pathname)) return null;

  const response = await env.ASSETS.fetch(request);
  return addSearchIndexHeaders(request, response);
}


async function timingSafeEqualText(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const leftInput = enc.encode(a || '');
  const rightInput = enc.encode(b || '');
  if (leftInput.byteLength !== rightInput.byteLength) return false;
  const leftDigest = await crypto.subtle.digest('SHA-256', leftInput);
  const rightDigest = await crypto.subtle.digest('SHA-256', rightInput);
  const left = new Uint8Array(leftDigest);
  const right = new Uint8Array(rightDigest);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function verifyCronHub(request: Request, env: Env): Promise<boolean> {
  const configured = env.CRONHUB_TOKEN || '';
  if (!configured) return false;
  const provided = request.headers.get('x-cronhub-token') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  return timingSafeEqualText(provided, configured);
}

async function handleCronHubScheduledBackup(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!await verifyCronHub(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  if (url.searchParams.get('dry') === '1') {
    return jsonResponse({ ok: true, dryRun: true, trigger: 'cronhub', time: new Date().toISOString() });
  }

  const run = runScheduledBackupIfDue(env);
  if (url.searchParams.get('async') === '0') {
    try {
      await run;
      return jsonResponse({ ok: true, trigger: 'cronhub', time: new Date().toISOString() });
    } catch (error) {
      console.error('CronHub scheduled backup failed:', error);
      return jsonResponse({ error: 'CronHub scheduled backup failed' }, 500);
    }
  }

  ctx.waitUntil(run.catch((error) => {
    console.error('CronHub scheduled backup failed:', error);
  }));
  return jsonResponse({ ok: true, queued: true, trigger: 'cronhub', time: new Date().toISOString() }, 202);
}

async function ensureDatabaseInitialized(env: Env): Promise<void> {
  if (dbInitialized) return;

  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const storage = new StorageService(env.DB);
      await storage.initializeDatabase();
      dbInitialized = true;
      dbInitError = null;
    })()
      .catch((error: unknown) => {
        console.error('Failed to initialize database:', error);
        dbInitError = error instanceof Error ? error.message : 'Unknown database initialization error';
      })
      .finally(() => {
        dbInitPromise = null;
      });
  }

  await dbInitPromise;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const normalizedRequest = normalizeRequestUrl(request);
    const requestPath = new URL(normalizedRequest.url).pathname;

    if (isWebVaultHidden(env) && !isBackendRequestPath(requestPath)) {
      return webVaultNotFoundResponse(normalizedRequest);
    }

    const assetResponse = await maybeServeAsset(normalizedRequest, env);
    if (assetResponse) {
      return applyCors(normalizedRequest, assetResponse, env);
    }

    await ensureDatabaseInitialized(env);
    if (dbInitError) {
      // Log full error server-side, return generic message to client.
      console.error('DB init error (not forwarded to client):', dbInitError);
      const resp = jsonResponse(
        {
          error: 'Database not initialized',
          error_description: 'Database initialization failed. Check server logs for details.',
          ErrorModel: {
            Message: 'Service temporarily unavailable',
            Object: 'error',
          },
        },
        500
      );
      return applyCors(normalizedRequest, resp, env);
    }

    const normalizedUrl = new URL(normalizedRequest.url);
    if (normalizedUrl.pathname === '/api/cron/scheduled-backup' && normalizedRequest.method === 'POST') {
      const cronResp = await handleCronHubScheduledBackup(normalizedRequest, env, ctx);
      return applyCors(normalizedRequest, cronResp, env);
    }

    const resp = await handleRequest(normalizedRequest, env);
    return applyCors(normalizedRequest, resp, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    void controller;
    await ensureDatabaseInitialized(env);
    if (dbInitError) {
      console.error('Skipping scheduled backup because DB init failed:', dbInitError);
      return;
    }
    ctx.waitUntil(runScheduledBackupIfDue(env).catch((error) => {
      console.error('Scheduled backup failed:', error);
    }));
  },
};

export { NotificationsHub };
export { BackupTransferRunner };
