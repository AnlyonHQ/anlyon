import { spawn } from 'node:child_process';

/**
 * Best-effort: open the system browser. The URL is always printed as well, so a
 * failure here only costs a copy-paste. The URL goes in argv to a launcher, not a
 * shell, so it is never interpreted.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
