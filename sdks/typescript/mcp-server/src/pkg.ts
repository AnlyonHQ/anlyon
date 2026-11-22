/**
 * Single source for the server name/version  read from package.json at
 * runtime so the version can never drift from what's published.
 * Works from both src/ (dev) and dist/ (build): ../package.json resolves to
 * the package root in either case.
 */

import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const SERVER_NAME = 'anlyon-mcp';
export const SERVER_VERSION = pkg.version;
