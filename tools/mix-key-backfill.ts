import { KEY_LIBRARY_VERSION } from '../mix/src/keyDetection.ts';
import { backfillKeys } from '../mix/electron/keyBackfill.ts';
import type { Library } from '../mix/src/openflow.ts';

const args = process.argv.slice(2);
if (args.some(arg => !['--run', '--reanalyze', '--help'].includes(arg))) throw new Error('Use --run, --reanalyze, or --help');
if (args.includes('--help')) {
  console.log('node tools/mix-key-backfill.ts [--run] [--reanalyze]\nRequires npm run dev:mix. Default previews; --run saves original-song key detection.\nExisting results (including Unknown) are skipped unless --reanalyze.\nBass stems are not required. Ctrl+C stops after the current song.');
} else {
  let stopped = false;
  const stop = () => { stopped = true; console.log('Stopping after the current song; completed results remain saved.'); };
  process.on('SIGINT', stop);
  async function invoke<T>(channel: string, args: unknown[] = []): Promise<T> {
    const response = await fetch('http://127.0.0.1:9673/reach/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: `openflow:${channel}`, args }),
    });
    const body = await response.json() as { value: T; says?: string };
    if (!response.ok) throw new Error(body.says || `App request failed (${response.status})`);
    return body.value;
  }
  try {
    const result = await backfillKeys({
      read: () => invoke<Library>('library'),
      busy: async () => !!await invoke('key-experiments-busy'),
      analyze: async id => {if(await invoke('key-version')!==KEY_LIBRARY_VERSION)throw new Error('Restart the desktop app for original-song key detection');return invoke<Library>('key-analyze', [id]);},
    }, { run: args.includes('--run'), reanalyze: args.includes('--reanalyze'), stopped: () => stopped, report: console.log });
    process.exitCode = result.stopped ? 130 : result.failed ? 1 : 0;
  } catch (error) {
    console.error(String(error)); process.exitCode = 1;
  } finally { process.off('SIGINT', stop); }
}
