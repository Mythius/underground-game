import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// What NPCs say, in speech bubbles over their heads. Every kind of line has built-in defaults (here);
// the dialogue editor (next to the sound editor, admin password) replaces any of them, and the
// replacements are kept in data/dialogue.json. Clients fetch GET /dialogue and pick a line at random.

export const DIALOGUE_FILE = fileURLToPath(new URL('../data/dialogue.json', import.meta.url));
const MAX_LINES = 40;
const MAX_CHARS = 90;

/** The catalogue: groups of line kinds, each with when it's said and its built-in lines. */
export const DIALOGUE = [
  { group: 'Townsfolk', kinds: [
    { id: 'greet', name: 'Greeting', note: 'Sometimes, as you walk past.', lines: ['Privet.', 'Good day.', 'Zdravstvuyte.', 'Cold one today.', 'Watch where you walk.', 'Got a light?', 'Spare a few roubles?', 'Hm.'] },
    { id: 'chatter', name: 'Chatter', note: 'Now and then, to nobody in particular.', lines: ['Bread went up again…', 'They still haven\'t paid my pension.', 'My cousin\'s selling jeans, cheap.', 'Where is that bus?', 'Everything costs dollars now.', 'Did you see the match?', 'Such times, such times.'] },
    { id: 'fight', name: 'Attacked — fighting back', note: 'You hit or shot them and they swing their purse at you.', lines: ['Hooligan!', 'Get away from me!', 'Take that!', 'Shame on you!', 'I\'ll show you!'] },
    { id: 'robbed', name: 'Robbed — caught you', note: 'They felt you lift their wallet (pickpocketing from the front) and come at you.', lines: ['Thief! Give it back!', 'My wallet! You!', 'I saw that, you crook!', 'Pickpocket! Hey!'] },
    { id: 'flee', name: 'Running away', note: 'Running for the Militsiya after a fight or a crime.', lines: ['Militsiya! Help!', 'Help! Robbery!', 'Somebody call the police!', 'Murderer!'] },
  ] },
  { group: 'Shopkeepers & traders', kinds: [
    { id: 'shop', name: 'Shopkeeper — hello', note: 'You walk up to a shop counter.', lines: ['Welcome! Bread is fresh today.', 'What will it be?', 'Hello, come in.', 'Cash only.'] },
    { id: 'teller', name: 'Bank teller — hello', lines: ['Next, please.', 'Passbook?', 'The bank is open.'] },
    { id: 'market', name: 'Market trader — hello', lines: ['Buying and selling, come look.', 'Good prices today.', 'What have you got for me?'] },
    { id: 'factory', name: 'Factory clerk — hello', lines: ['You want something made? Bring the materials.', 'Talk business.'] },
    { id: 'gunshop', name: 'Gun store — hello', lines: ['Looking for protection?', 'No questions asked.'] },
    { id: 'barman', name: 'Barman — hello', lines: ['What\'ll it be?', 'Need a problem solved?', 'I know some people.', 'Vodka? Or business?'] },
    { id: 'dealer', name: 'Car dealer — hello', lines: ['Fine cars, almost new!', 'Come, take a look.'] },
    { id: 'warden', name: 'Prison warden — hello', note: 'You walk up to the gatehouse counter at the prison camp.', lines: ['Name and number.', 'The boiler is hungry. So dig.', 'Visiting hours are whenever I say.', 'Bail is paid in cash. Or from the bank, if you must.', 'Nobody leaves without my say-so.'] },
    { id: 'station', name: 'Freight clerk — hello', lines: ['The train is late. As always.', 'Freight? I can arrange it.'] },
    { id: 'smuggler', name: 'Smuggler — hello', lines: ['…You didn\'t see me.', 'Psst. Got something special.'] },
    { id: 'bye', name: 'Goodbye (any of them)', note: 'You walk away from a counter.', lines: ['Come again.', 'All the best.', 'Poka.', 'Goodbye.'] },
    { id: 'robShop', name: 'Shopkeeper — being robbed', note: 'While you empty their till (hold F).', lines: ['Take it, take it! Just don\'t shoot!', 'Please, I have a family!', 'The Militsiya will hear of this!', 'Here — it\'s all there is!'] },
    { id: 'robBank', name: 'Bank teller — being robbed', note: 'While you rob the bank (hold F).', lines: ['Don\'t hurt anyone!', 'The alarm is already ringing!', 'Take the money and go!', 'You won\'t get far.'] },
  ] },
  { group: 'Underground', kinds: [
    { id: 'miner', name: 'Old miner — muttering', note: 'The old miner in his cave underground, as you walk up and every so often while you stay near: mostly nonsense.', lines: [
      'Mrrh… the seam, the seam goes sideways, sideways under the bread…', 'Kha-kha-kha. Tuesday. It was a Tuesday down here once.', 'Brrm brrm, little cart, where do you go, nowhere, nowhere…',
      'Zhh. Zhhhh. The rock hums if you listen. You don\'t listen.', 'Shhh, the canary\'s asleep. Canary\'s been asleep since \'71.', 'Glub. Glub glub. Hehe.',
      'Ninety-four… ninety-five… lost count of the props again.', 'Mmh, gold, gold, the colour of soup, the colour of soup…', 'Krr-tak, krr-tak, that\'s the pick talking, not me.',
      'They took the lift up and never sent it down. Rude.', 'Hnnh? Who\'s that? You\'re not Kolya. Kolya had a moustache.', 'Lamp oil, lamp oil, lamp oil…',
    ] },
    { id: 'minerFlood', name: 'Old miner — screaming about the flood', note: 'Now and then, out of nowhere, he screams about the flood.', lines: [
      'THE WATER! THE WATER\'S COMING UP THE SHAFT!', 'SHUT THE BULKHEAD! SHUT IT! THEY\'RE STILL DOWN THERE!', 'IT\'S IN THE LOWER GALLERY! RUN! RUN!',
      'I HEARD THEM KNOCKING ON THE OTHER SIDE! FOR THREE DAYS!', 'THE PUMPS! WHO TURNED OFF THE PUMPS?!', 'DON\'T GO DOWN TO NINE! NINE IS UNDER WATER!',
    ] },
    { id: 'homeless', name: 'Homeless — muttering (Russian only)', note: 'The homeless underground, as you walk by and now and then while you\'re near. They speak only Russian.', lines: [
      'Эх, жизнь моя жестянка…', 'Мелочи не найдётся, браток?', 'Чего уставился?', 'Иди, иди своей дорогой.', 'Холодно тут… холодно…',
      'Это моё место. Моё!', 'Водочки бы сейчас…', 'Ходят тут всякие…', 'Сигаретки не будет?', 'Раньше я инженером был. Инженером!',
      'Крысы тоже люди. Почти.', 'Не смотри на меня так.',
    ] },
    { id: 'homelessFight', name: 'Homeless — attacking (Russian only)', note: 'A homeless man coming at you with his knife.', lines: [
      'Стой, сука!', 'Зарежу!', 'Куда собрался?!', 'Иди сюда!', 'Кошелёк давай!', 'Убью, гад!', 'Не уйдёшь!', 'Моё! Всё моё!',
    ] },
    { id: 'minerLend', name: 'Old miner — lending his pickaxe', note: 'When he hands you his pickaxe (E).', lines: ['Take it, take it. Bring it back. BRING IT BACK.', 'Hit the shiny bits. Not your foot. Hehe.', 'My pick. Mine. Yours a little while.', 'Gold sleeps in the walls. Wake it gently.'] },
  ] },
  { group: 'Militsiya', kinds: [
    { id: 'police', name: 'Front desk — hello', note: 'You walk up to the desk officer at a МИЛИЦИЯ station (apply to join here).', lines: ['Want to serve? Fill in the form.', 'Documents?', 'The Militsiya is hiring.', 'Next.'] },
    { id: 'prisonGuard', name: 'Prison guard', note: 'You walk past a guard patrolling inside the wire.', lines: ['Keep moving, zek.', 'Back to the coal face.', 'The coal won\'t dig itself.', 'Eyes down.', 'Hands where I can see them.'] },
    { id: 'mike', name: 'Mike (prison guard) — escape hints', note: 'The guard named Mike, inside the wire: a hint when you walk up, and more while you stay near him. (The camp is turned differently on every map, so no north/south.)', lines: [
      'Psst. Name\'s Mike. I never told you any of this.',
      'See the grey concrete patch in the inner fence? It\'s soft. A pickaxe goes through it.',
      'Dig at the concrete only when no guard is facing you. Get seen and it\'s filled in again.',
      'About forty swings gets you through that concrete. Count them.',
      'We carry the outer door\'s key on our belts. Come up from BEHIND and press F.',
      'Try for a key face to face and you\'ll be shovelling extra coal. Behind, always behind.',
      'The outer door won\'t pick. Only a key opens it. Use it with E.',
      'Holes get bricked up and doors swing shut quick. Go the moment you\'re through.',
      'We walk the same loop all day. Watch which way we face, then move.',
      'Past the wire the tower boys shoot anyone wanted. Run straight and don\'t stop.',
      'You\'re only free once the towers can\'t reach you. Fall before that and you\'re back here.',
      'At night your cell door locks, but it can be picked. Hold F. Quietly.',
      'Run, and the warden keeps whatever he\'s holding for you. Gone for good.',
      'Got friends? At night they can pick a cell lock for you too.',
      'Or just dig your coal. Slower, but nobody shoots at you.',
    ] },
    { id: 'copIdle', name: 'On patrol', note: 'You walk past a cop while you\'re not wanted.', lines: ['Documents, please.', 'Move along.', 'Keep it quiet.'] },
    { id: 'copWanted', name: 'Chasing you', note: 'While you\'re wanted and they can see you.', lines: ['Stop! Militsiya!', 'Hands where I can see them!', 'Halt!', 'You\'re under arrest!'] },
    { id: 'copArrest', name: 'Arresting you', note: 'While the arrest bar fills (get away to stop it).', lines: ['Don\'t move!', 'Hands behind your back!', 'You\'re coming with us.', 'Stop resisting!', 'Got you now.'] },
  ] },
  { group: 'Work sites & the camp', kinds: [
    { id: 'worker', name: 'Site hand', note: 'You walk past a hand working a farm, lumberyard or mine.', lines: ['Hard work, honest pay. Well — work, anyway.', 'Mind the blade.', 'Another load for the foreman.', 'The truck comes when it comes.'] },
    { id: 'convict', name: 'Convict', note: 'You walk past one of the big convicts at the prison camp.', lines: ['What are you looking at?', 'Keep digging, new fish.', 'Ten years for a sack of potatoes…', 'Stay out of my way.'] },
    { id: 'convictFight', name: 'Convict — fighting', note: 'You hit a convict and he comes at you with his fists.', lines: ['You picked the wrong zek!', 'I\'ll break you in half!', 'Big mistake, fish.'] },
    { id: 'cook', name: 'Camp cook', note: 'You walk up to the kitchen hatch.', lines: ['Slop. Take it or leave it.', 'One bowl. ONE.', 'It\'s got meat in it. Probably.', 'Bell rings, you eat. Not before.'] },
  ] },
  { group: 'Hired muscle', kinds: [
    { id: 'goon', name: 'Your goon', note: 'Now and then, while following you.', lines: ['Right behind you, boss.', 'Anyone gives you trouble…', 'Quiet today.', 'Say the word, boss.'] },
    { id: 'guard', name: 'Building guard', note: 'Someone walks up to the building they guard.', lines: ['Private property.', 'Keep walking.', 'Nobody gets in.', 'Not one step closer.'] },
    { id: 'hitman', name: 'Hitman taking aim', note: 'A hitman lining up his shot (the red laser).', lines: ['Nothing personal.', 'Hold still…', 'Contract\'s a contract.'] },
  ] },
  { group: 'Gangsters', kinds: [
    { id: 'gangster', name: 'Gangster — hello', note: 'You walk up to a gangster (he buys vodka: E to sell).', lines: ['Got any vodka? I pay well.', 'Vodka, friend? Good money.', 'You selling? I\'m buying.', 'Keep walking… unless you have vodka.'] },
    { id: 'gangsterHoldup', name: 'Gangster — hold-up', note: 'A gangster holding you up at gunpoint.', lines: ['Wallet. Now.', 'Hands up. Don\'t be a hero.', 'Easy… give it here.', 'Nobody moves, nobody gets hurt.'] },
  ] },
  { group: 'The governor\'s residence', kinds: [
    { id: 'governor', name: 'Governor', note: 'You walk up to the governor, and now and then while you\'re near him.', lines: ['Wipe your feet. This marble is Italian.', 'You smell of the bus. Stand downwind.', 'I don\'t shake hands. Not with voters.', 'Ah, a peasant. How quaint.', 'Do you know who I am? Everyone knows who I am.', 'My shuba cost more than your whole street.', 'The budget? Spent. On what? Don\'t ask.', 'I was elected. Mostly.', 'Don\'t touch the fountain. It\'s French.', 'Bow a little. A little more. Good.', 'I brought caviar to the people. I ate it, but I brought it.', 'My dacha has a dacha.', 'Roads? I fly over them.', 'Poverty is a choice. I chose not to.', 'Is that a TRACKSUIT? In MY driveway?', 'My poodle has a bodyguard. Two, actually.', 'The pensions are coming. Next year. Every year.', 'I don\'t do queues. Queues do me.', 'Run along. I\'m counting things.', 'This chain? A gift from a grateful nation. Allegedly.'] },
    { id: 'governorFight', name: 'Governor — attacked', note: 'Someone hurt the household and he\'s fighting back.', lines: ['Guards! GUARDS! A commoner touched me!', 'You\'ll never work in this oblast again!', 'Do you know what this shuba COST?!', 'Not the face! I have a photo op!', 'I\'ll have you paving roads in Siberia!', 'My lawyers will eat your grandchildren!', 'This is an assassination! On ME! How dare you!', 'Somebody shoot him, I\'m paying for it!'] },
    { id: 'inspector', name: 'Tax inspector', note: 'You walk up to the inspector, and now and then while you\'re near him (at home or at your factory).', lines: ['Tax inspection. Smile, it\'s deductible.', 'Receipts. All of them. Even the emotional ones.', 'I can smell undeclared income. It smells like you.', 'Your aura is underreported.', 'I audited my own mother. Twice.', 'Is that a new hat? Taxable.', 'I see a still. I see a fine. I see a promotion.', 'Everything is income if you squint.', 'I dream in spreadsheets. Red ones.', 'Breathing is free. For now. I\'m drafting the form.', 'Form 27-B, stamped in triplicate, or we have a problem.', 'Do you keep cash in your mattress? Asking for the State.', 'I once fined a dog. He knew what he did.', 'My Uzi is also registered. Unlike your vodka.', 'Nobody escapes the inspector. Not even the governor. Shh.', 'Lovely factory. Be a shame if it were… audited.'] },
    { id: 'inspectorFight', name: 'Tax inspector — attacked', note: 'Someone hurt the household and he\'s fighting back.', lines: ['Assaulting an official! That\'s a fine AND a fine!', 'Penalty! PENALTY! Compound interest!', 'I\'ll audit you into the afterlife!', 'You\'re going straight into the red column!', 'Shooting back is NOT tax deductible!', 'Late payment! VERY late payment!', 'I\'m itemising every bullet!'] },
  ] },
];
const KINDS = new Map(DIALOGUE.flatMap((g) => g.kinds).map((k) => [k.id, k]));

/** Cleans what the editor sends: one line per entry, no control characters, trimmed, not too long or too many. */
function clean(lines) {
  if (!Array.isArray(lines)) return null;
  const out = lines
    .filter((l) => typeof l === 'string')
    .map((l) => l.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LINES);
  return out.length ? out : null;
}

export class DialogueStore {
  constructor(file = DIALOGUE_FILE) {
    this.file = file;
    try {
      this.custom = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      this.custom = {}; // kind -> [lines]
    }
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.custom, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** What the client needs: the catalogue (with defaults) and the replacements. */
  list() {
    const custom = Object.fromEntries(Object.entries(this.custom).filter(([k]) => KINDS.has(k)));
    return { groups: DIALOGUE, custom };
  }

  /** Replace `kind`'s lines. Returns an error string, or null. */
  set(kind, lines) {
    if (!KINDS.has(kind)) return 'unknown kind of line';
    const ok = clean(lines);
    if (!ok) return 'give it at least one line';
    this.custom[kind] = ok;
    this.#save();
    return null;
  }

  /** Back to the built-in lines. */
  reset(kind) {
    if (!KINDS.has(kind)) return 'unknown kind of line';
    delete this.custom[kind];
    this.#save();
    return null;
  }
}
