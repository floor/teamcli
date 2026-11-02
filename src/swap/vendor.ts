// Moving a seat to another vendor of the same CLI through the profile's own vendor table: the
// vendor's env words, its credential item and its model ids come from the adapter, so the store's
// naming stays there and no launcher script is written. The seat's launch line is rewritten in
// place — its own wrapper prefix and its non-vendor assignments kept — and the credential is
// proven present before the row is written. A machine whose store cannot answer, or a line this
// version cannot read, refuses rather than guessing.

import type { Seat } from '../file/types.ts';
import { addCommandFor, type CredentialProbe } from '../profiles/credentials.ts';
import { assignmentWordName, launchWithVendorWords, type Profile, type VendorBlock } from '../profiles/profile.ts';
import type { ModelRecipe } from './rule.ts';

/** The part of a seat the move reads: its own line, and the account it names. */
export type VendorSeat = Pick<Seat, 'name' | 'cli' | 'vendor' | 'launch' | 'account'>;

export type VendorPlan =
  | { ok: true; recipe: ModelRecipe }
  | { ok: false; why: string; repair: string | null };

/** The vendor a name picks from the profile's table, whatever its case, or null: a name outside
 *  the table is not a vendor move and falls to the donor route. */
export function vendorTargetOf(profile: Profile | null, name: string): VendorBlock | null {
  if (profile === null) return null;
  const wanted = name.trim().toLowerCase();
  return profile.vendors.find((vendor) => vendor.name.toLowerCase() === wanted) ?? null;
}

/** One vendor env word with the item and the model id filled in. */
function filled(word: string, vendor: VendorBlock, modelId: string): string {
  return word.replaceAll('{credential}', vendor.credential).replaceAll('{model}', modelId);
}

/**
 * The recipe that moves this seat to `vendorName`'s `modelId`: the same CLI, the vendor's own
 * words, and the seat's row fields. The model is resolved first, then the line, then the
 * credential — so an unknown model or an unprovable line refuses before the machine is asked
 * anything. An absent credential names the item and its one-time add command; a store that did
 * not answer refuses in plain words. Neither prompt, and neither reads a secret.
 */
export function planVendorSwap(
  profile: Profile,
  seat: VendorSeat,
  vendorName: string,
  modelId: string,
  probe: CredentialProbe,
): VendorPlan {
  const vendor = vendorTargetOf(profile, vendorName);
  if (vendor === null) {
    return { ok: false, why: `this CLI's profile offers no vendor "${vendorName}"`, repair: null };
  }
  const model = vendor.models.find((entry) => entry.id === modelId);
  if (model === undefined) {
    const offered = vendor.models.map((entry) => entry.id).join(', ') || 'none';
    return { ok: false, why: `${vendor.name} offers no model "${modelId}"; it offers ${offered}`, repair: null };
  }
  const credentials = profile.credentials;
  if (credentials === null) {
    return { ok: false, why: "this CLI's profile declares vendors without a credential check", repair: null };
  }
  const words = vendor.env.map((word) => filled(word, vendor, model.id));
  // A word that sets a variable any vendor of this CLI sets belongs to the vendor the line was
  // written for; every other leading assignment is the seat's own and is kept as written.
  const replaced = new Set<string>();
  for (const other of profile.vendors) {
    for (const word of other.env) {
      const name = assignmentWordName(filled(word, other, model.id));
      if (name !== null) replaced.add(name);
    }
  }
  const written = launchWithVendorWords(profile, seat.launch, {
    words,
    replaced: [...replaced],
    option: profile.modelFlag('', '').option,
    modelId: model.id,
  });
  if (!written.ok) return { ok: false, why: written.why, repair: null };
  const state = probe(vendor.credential);
  if (state === 'absent') {
    const add = addCommandFor(credentials, vendor.credential);
    return {
      ok: false,
      why:
        `this machine holds no "${vendor.credential}" item for the vendor "${vendor.name}"; ` +
        'add it once with the command below, which asks the store for the secret itself, so ' +
        `nothing is typed here and nothing is read from stdin:\n\n  ${add}`,
      repair: add,
    };
  }
  if (state === 'unavailable') {
    return {
      ok: false,
      why:
        `this machine's credential store could not be read while looking for "${vendor.credential}"; ` +
        'whether it holds the item is not knowable, so the swap is refused rather than guessing',
      repair: null,
    };
  }
  return {
    ok: true,
    recipe: {
      cli: profile.cli,
      vendor: vendor.name,
      model: model.model,
      version: model.version,
      display: model.display,
      launch: written.launch,
      ...(seat.account === vendor.name ? { account: seat.account } : {}),
    },
  };
}
