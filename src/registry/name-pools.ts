// The built-in name pools a team draws seat nicknames from when a seat has none
// (src/registry/names.ts:autoNamePlan). A pool is read in its written order, so the same registry
// always hands out the same next name. Every entry is a nickname the team file can hold: letters
// only, never `lead` or `daemon`.

/** Short names from Greek myth: heroes, seers, nymphs, muses, titans and gods. */
const GREEK_MYTH = [
  'Perseus', 'Jason', 'Orpheus', 'Heracles', 'Pollux', 'Telemachus', 'Aeneas', 'Meleager', 'Peleus', 'Paris',
  'Hecuba', 'Andromache', 'Helen', 'Medea', 'Phaedra', 'Antigone', 'Electra', 'Iphigenia', 'Alcestis', 'Andromeda',
  'Danae', 'Europa', 'Leda', 'Psyche', 'Niobe', 'Arachne', 'Callisto', 'Daphne', 'Echo', 'Galatea',
  'Leander', 'Pyramus', 'Thisbe', 'Narcissus', 'Hyacinth', 'Adonis', 'Endymion', 'Ganymede', 'Tithonus', 'Actaeon',
  'Midas', 'Sisyphus', 'Tantalus', 'Ixion', 'Manto', 'Sibyl', 'Chiron', 'Asclepius', 'Hygieia', 'Panacea',
  'Calypso', 'Circe', 'Arethusa', 'Maia', 'Merope', 'Alcyone', 'Sterope', 'Taygete', 'Celaeno', 'Aegle',
  'Syrinx', 'Oenone', 'Eurydice', 'Euterpe', 'Melpomene', 'Apollo', 'Artemis', 'Poseidon', 'Hades', 'Demeter',
  'Persephone', 'Ares', 'Aphrodite', 'Dionysus', 'Eros', 'Hebe', 'Eos', 'Selene', 'Helios', 'Nyx',
  'Gaia', 'Cronus', 'Rhea', 'Hyperion', 'Theia', 'Phoebe', 'Tethys', 'Oceanus', 'Coeus', 'Crius',
  'Iapetus', 'Leto', 'Dione', 'Pan', 'Proteus', 'Nereus', 'Thetis', 'Amphitrite', 'Aeolus', 'Boreas',
  'Zephyrus', 'Notus', 'Eurus', 'Hecate', 'Morpheus', 'Hypnos', 'Nemesis', 'Tyche', 'Astraea', 'Hesperus',
  'Phosphorus', 'Linus', 'Musaeus', 'Arion', 'Aegeus', 'Aethra', 'Agave', 'Alcmene', 'Althaea', 'Amalthea',
  'Anchises', 'Antiope', 'Arete', 'Asterion', 'Astyanax', 'Auge', 'Autolycus', 'Baucis', 'Philemon', 'Briseis',
  'Byblis', 'Caeneus', 'Canace', 'Chloris', 'Chryseis', 'Clytie', 'Creusa', 'Cyane', 'Deianira', 'Dryope',
  'Eidothea', 'Elpenor', 'Erigone', 'Eumaeus', 'Euphemus', 'Evadne', 'Glauce', 'Halcyon', 'Harmonia', 'Hermione',
] as const;

/** The pools by the word `names.pool` names them. */
export const NAME_POOLS: Readonly<Record<string, readonly string[]>> = {
  'greek-myth': GREEK_MYTH,
};

/** The pool a team draws from when its entity writes no `names.pool` word. */
export const NAME_POOL_DEFAULT = 'greek-myth';
