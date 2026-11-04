import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { TeamFile } from '../types.ts';
import { measureSchema, DURATION, PERCENT, SIZE } from './units.ts';
import type { Section } from './section.ts';

export const machine: Section = {
  name: 'machine',
  owner: true,
  after: [],
  validate(entry, ctx) {
    return readMachine(entry, ctx.check);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      load_start: { type: 'number', exclusiveMinimum: 0 },
      load_max: { type: 'number', exclusiveMinimum: 0 },
      memory_start: measureSchema(PERCENT),
      memory_min: measureSchema(PERCENT),
      disk_min: measureSchema(SIZE),
      swap_free_min: { ...measureSchema(SIZE), deprecated: true },
      swap_growth_max: measureSchema(SIZE),
      swap_growth_window: measureSchema(DURATION),
    },
  },
};

function readMachine(entry: YamlEntry | undefined, check: Check): TeamFile['machine'] {
  const fields = check.fields(entry?.value, 'machine', [
    'load_start', 'load_max', 'memory_start', 'memory_min', 'disk_min', 'swap_free_min', 'swap_growth_max', 'swap_growth_window',
  ]);
  // `swap_free_min` is read and carried unchanged, and ignored by every limit: it set the
  // floor for the retired `swap-free` watch check and the launch serializer, and free swap
  // decides nothing now. It stays in the record shape because the canonical team record is
  // frozen and approvals are signed over it — dropping the field would move signed records
  // and the `machine` fingerprint. `team check` names it deprecated, with its repair.
  const retired = fields.get('swap_free_min');
  if (retired !== undefined) {
    check.deprecations.push({
      line: retired.line,
      message: '`machine.swap_free_min` is deprecated: free swap is not reported and never serializes a launch',
      repair: 'remove swap_free_min from machine: in {file}; swap growth and memory pressure keep their limits',
    });
  }
  return {
    loadStart: check.number(fields.get('load_start'), 'machine.load_start') ?? 3,
    loadMax: check.number(fields.get('load_max'), 'machine.load_max') ?? 6,
    memoryStart: check.measure(fields.get('memory_start'), 'machine.memory_start', PERCENT, '25%') ?? 25,
    memoryMin: check.measure(fields.get('memory_min'), 'machine.memory_min', PERCENT, '15%') ?? 15,
    diskMin: check.measure(fields.get('disk_min'), 'machine.disk_min', SIZE, '10GB') ?? 10e9,
    swapFreeMin: check.measure(fields.get('swap_free_min'), 'machine.swap_free_min', SIZE, '2GB') ?? 2e9,
    swapGrowthMax: check.measure(fields.get('swap_growth_max'), 'machine.swap_growth_max', SIZE, '1GB') ?? 1e9,
    swapGrowthWindow: check.measure(fields.get('swap_growth_window'), 'machine.swap_growth_window', DURATION, '10m') ?? 600,
  };
}
