/**
 * H3/Nuxt Signature Verification Middleware
 *
 * Provides middleware for verifying Anlyon webhook signatures
 * in H3/Nuxt applications.
 *
 * @example
 * ```typescript
 * // server/middleware/anlyon.ts (Nuxt 3)
 * import { defineAnlyonMiddleware } from '@anlyonhq/sdk/h3'
 *
 * export default defineAnlyonMiddleware({
 *   routes: ['/api/webhook'],
 * })
 * ```
 */

import {
  WebCryptoReceiver,
  SignatureVerificationError,
} from '../crypto/web-crypto';
import type { H3Event } from './serve';

/**
 * Configuration options for the middleware
 */
export interface MiddlewareConfig {
  /**
   * The signing secret used to verify webhook signatures.
   */
  signingSecret?: string;

  /**
   * Maximum allowed time difference in seconds between the signature
   * timestamp and current time.
   * @default 300 (5 minutes)
   */
  clockTolerance?: number;

  /** Require delivery attribution for this environment. */
  expectedEnvironmentId?: string;

  /**
   * Routes to apply signature verification to.
   * Supports simple path matching.
   */
  routes?: string[];

  /**
   * Custom error handler for signature verification failures.
   */
  onError?: (error: SignatureVerificationError, event: H3Event) => void | Promise<void>;
}

/**
 * Get signing secret from environment
 */
function getSigningSecret(): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.ANLYON_SIGNING_SECRET;
  }
  return undefined;
}

/**
 * Read raw body from H3 event
 */
async function readRawBody(event: H3Event): Promise<string> {
  if (event._requestBody) {
    return event._requestBody;
  }

  const req = event.node.req;

  return new Promise((resolve, reject) => {
    let body = '';

    const nodeReq = req as unknown as NodeJS.ReadableStream & {
      on(event: string, listener: (...args: unknown[]) => void): void;
    };

    nodeReq.on('data', (chunk: Buffer | string) => {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });

    nodeReq.on('end', () => {
      event._requestBody = body;
      resolve(body);
    });

    nodeReq.on('error', reject);
  });
}

/**
 * Get header value
 */
function getHeader(event: H3Event, name: string): string | null {
  const value = event.node.req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

/**
 * Send JSON error response
 */
function sendError(event: H3Event, message: string, statusCode: number): void {
  event.node.res.statusCode = statusCode;
  event.node.res.setHeader('Content-Type', 'application/json');
  event.node.res.end(JSON.stringify({ error: message }));
}

/**
 * Check if path matches any of the configured routes.
 */
function matchesRoute(path: string, routes: string[]): boolean {
  return routes.some((route) => {
    if (route.endsWith('*')) {
      const prefix = route.slice(0, -1);
      return path.startsWith(prefix);
    }
    return path === route;
  });
}

/**
 * Create H3/Nuxt middleware for Anlyon signature verification.
 *
 * Apply this middleware to routes that receive Anlyon webhooks.
 *
 * @param config - Configuration options
 * @returns H3 middleware function
 *
 * @example
 * ```typescript
 * // server/middleware/anlyon.ts (Nuxt 3)
 * import { defineAnlyonMiddleware } from '@anlyonhq/sdk/h3'
 *
 * export default defineAnlyonMiddleware({
 *   routes: ['/api/webhook', '/api/scheduler/*'],
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With custom error handling
 * export default defineAnlyonMiddleware({
 *   routes: ['/api/webhook'],
 *   signingSecret: process.env.MY_SECRET,
 *   onError: (error, event) => {
 *     console.error('Verification failed:', error.message)
 *   }
 * })
 * ```
 */
export function defineAnlyonMiddleware(
  config: MiddlewareConfig = {}
): (event: H3Event) => Promise<void> {
  const {
    signingSecret = getSigningSecret(),
    clockTolerance = 300,
    expectedEnvironmentId,
    routes = [],
    onError,
  } = config;

  if (!signingSecret) {
    throw new Error(
      'Signing secret is required. Set ANLYON_SIGNING_SECRET environment variable or pass signingSecret option.'
    );
  }

  const receiver = new WebCryptoReceiver({
    signingSecret,
    clockTolerance,
    expectedEnvironmentId,
  });

  return async (event: H3Event): Promise<void> => {
    if (routes.length > 0 && !matchesRoute(event.path, routes)) {
      return;
    }

    const body = await readRawBody(event);
    const signature = getHeader(event, 'anlyon-signature');

    try {
      await receiver.verifyOrThrow({
        signature,
        body,
      });

      event.context.anlyonVerifiedBody = body;
      event.context.anlyonVerified = true;
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        if (onError) {
          await onError(error, event);
        }
        sendError(event, 'Invalid signature', 401);
        return;
      }
      throw error;
    }
  };
}

/**
 * Verify signature wrapper for event handlers.
 *
 * Use this to wrap individual handlers instead of using middleware.
 *
 * @param handler - The handler to wrap
 * @param config - Configuration options
 * @returns Wrapped handler
 *
 * @example
 * ```typescript
 * // server/api/webhook.post.ts
 * import { verifySignature } from '@anlyonhq/sdk/h3'
 *
 * export default verifySignature(async (event) => {
 *   const body = await readBody(event)
 *   return { ok: true }
 * })
 * ```
 */
export function verifySignature<T>(
  handler: (event: H3Event) => T | Promise<T>,
  config: Omit<MiddlewareConfig, 'routes'> = {}
): (event: H3Event) => Promise<T | void> {
  const {
    signingSecret = getSigningSecret(),
    clockTolerance = 300,
    expectedEnvironmentId,
    onError,
  } = config;

  if (!signingSecret) {
    throw new Error(
      'Signing secret is required. Set ANLYON_SIGNING_SECRET environment variable or pass signingSecret option.'
    );
  }

  const receiver = new WebCryptoReceiver({
    signingSecret,
    clockTolerance,
    expectedEnvironmentId,
  });

  return async (event: H3Event): Promise<T | void> => {
    const body = await readRawBody(event);
    const signature = getHeader(event, 'anlyon-signature');

    try {
      await receiver.verifyOrThrow({
        signature,
        body,
      });
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        if (onError) {
          await onError(error, event);
        }
        sendError(event, error.message, 401);
        return;
      }
      throw error;
    }

    event.context.anlyonVerifiedBody = body;

    return handler(event);
  };
}

export { WebCryptoReceiver, SignatureVerificationError };
