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
      swap_free_min: measureSchema(SIZE),
      swap_growth_max: measureSchema(SIZE),
      swap_growth_window: measureSchema(DURATION),
    },
  },
};

function readMachine(entry: YamlEntry | undefined, check: Check): TeamFile['machine'] {
  const fields = check.fields(entry?.value, 'machine', [
    'load_start', 'load_max', 'memory_start', 'memory_min', 'disk_min', 'swap_free_min', 'swap_growth_max', 'swap_growth_window',
  ]);
  // Load per core and free memory are the primary guards. Free swap is a floor: 100MB when unset.
  return {
    loadStart: check.number(fields.get('load_start'), 'machine.load_start') ?? 3,
    loadMax: check.number(fields.get('load_max'), 'machine.load_max') ?? 6,
    memoryStart: check.measure(fields.get('memory_start'), 'machine.memory_start', PERCENT, '25%') ?? 25,
    memoryMin: check.measure(fields.get('memory_min'), 'machine.memory_min', PERCENT, '15%') ?? 15,
    diskMin: check.measure(fields.get('disk_min'), 'machine.disk_min', SIZE, '10GB') ?? 10e9,
    swapFreeMin: check.measure(fields.get('swap_free_min'), 'machine.swap_free_min', SIZE, '100MB') ?? 100e6,
    swapGrowthMax: check.measure(fields.get('swap_growth_max'), 'machine.swap_growth_max', SIZE, '1GB') ?? 1e9,
    swapGrowthWindow: check.measure(fields.get('swap_growth_window'), 'machine.swap_growth_window', DURATION, '10m') ?? 600,
  };
}
