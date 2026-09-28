import { z } from 'zod';
import { runConfigSchema } from '../src/runConfigSchema.js';
import * as cf from '../src/configFile.js';
try {
  const js = z.toJSONSchema(runConfigSchema, { io: 'input', unrepresentable: 'any' });
  console.log('runConfig OK', JSON.stringify(js).slice(0, 200));
} catch (e) { console.log('runConfig FAIL', String(e).slice(0, 500)); }
const mod = cf as unknown as Record<string, unknown>;
console.log('configFile exports:', Object.keys(mod).join(','));
