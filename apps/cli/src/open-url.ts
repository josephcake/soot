import { spawn } from 'node:child_process';

/**
 * Open a URL in the user's browser. Used only by `soot dashboard --open` (never by default):
 * the platform's own opener, no shell, detached.
 */
export function openInBrowser(url: string, warn: (line: string) => void): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['explorer.exe', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
    child.on('error', (error) => {
      warn(`soot: could not open a browser (${error.message}); open ${url} yourself`);
    });
    child.unref();
  } catch (error) {
    warn(`soot: could not open a browser (${(error as Error).message}); open ${url} yourself`);
  }
}
