import { toValue } from '../../yaml.ts';
import type { Section } from './section.ts';
import { GROK_COMMAND_DENY_VALUES } from '../../settings/grok-command-deny.ts';

const declaration = {
  type: 'object',
  required: ['value', 'setter', 'date', 'kind', 'generation', 'signature'],
  properties: {
    value: {},
    setter: { type: 'string' },
    date: { type: 'string' },
    expiry: { type: ['string', 'null'] },
    kind: { enum: ['enforced', 'advised'] },
    target: { type: 'string' },
    generation: { type: 'integer', minimum: 1 },
    signature: { type: 'string' },
  },
  additionalProperties: false,
};

/**
 * The team-level owner `policies:` section (Kernel amendment 02 §2.12).
 *
 * Non-owner in the section list (`owner: false`) so `OWNER_SECTIONS` in `src/approve/fingerprint.ts`
 * keeps its 18-entry approval digest order; owner authority is enforced per entry via Ed25519
 * signatures under `POLICY_DOMAIN` (`team-policy-v1\n`) checked fresh by `readTeamPolicySource`.
 */
export const policies: Section = {
  name: 'policies',
  owner: false,
  after: [],
  validate(entry) {
    if (!entry) return null;
    return toValue(entry.value);
  },
  schema: {
    type: 'object',
    properties: {
      'grok-command-deny': {
        ...declaration,
        properties: {
          ...declaration.properties,
          value: { enum: GROK_COMMAND_DENY_VALUES },
        },
        $comment: 'team scope only; off by default; denies git or git and test runs for Grok seats',
      },
    },
    additionalProperties: declaration,
    $comment: 'owner-signed team-level policy declarations (Kernel amendment 02 §2.12)',
  },
};
