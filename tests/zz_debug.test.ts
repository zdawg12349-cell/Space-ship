import { it } from 'vitest';
import { flyAscent } from './helpers';
declare const process: { env: Record<string, string | undefined> };
it('debug', () => { flyAscent(process.env.VID ?? 'kestrel_heavy', Number(process.env.ALT ?? 250000), 1500, { log: true }); });
