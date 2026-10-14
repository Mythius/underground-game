// Achievements: a path through the game for new players, in the order worth learning it. The next
// one shows under the leaderboard; clicking it says how to do it. Each is earned once per account.

export const ACHIEVEMENTS = [
  { id: 'walk', icon: '🚶', name: 'Find your feet', how: 'Walk around with WASD (on a phone, the left stick). Hold Shift to sprint — it uses stamina.' },
  { id: 'pickpocket', icon: '🤏', name: 'Rob your first person', how: 'Sneak up behind someone and tap F to pick their pocket. From behind they won\'t notice — but if anyone sees, they call the Militsiya.' },
  { id: 'shop', icon: '🛒', name: 'Corner shop', how: 'Walk up to a shopkeeper behind the counter in a shop and press E to buy some food.' },
  { id: 'eat', icon: '🍞', name: 'A bite to eat', how: 'Pick the food in your hotbar (keys 1–5, or tap it) and press E to eat it. Food heals you.' },
  { id: 'bank', icon: '🏦', name: 'Safe as houses', how: 'The cash you carry is dropped when you die; money in the bank is safe. Go to an ATM or a bank teller, press E and deposit your cash.' },
  { id: 'drive', icon: '🚗', name: 'Learn to drive', how: 'Walk up to a car and press E to get in. W/S to drive and brake, A/D to steer, Shift to drift, C for the lights. Other people\'s cars are locked — buying your own is the honest way.' },
  { id: 'work', icon: '⛏️', name: 'Honest labour', how: 'Go to a work site (the mine, the logging camp or the farm). Borrow a tool from the foreman, click rocks, trees or wheat to gather, then sell your haul back to the foreman.' },
  { id: 'job', icon: '📦', name: 'Delivery run', how: 'Press J (☰ → Jobs on a phone) for the job board. Accept a job, pick up the cargo where it says and deliver it before time runs out.' },
  { id: 'fish', icon: '🎣', name: 'Gone fishing', how: 'Buy a fishing rod at a shop, stand at the water\'s edge, hold the rod and click to cast. When a fish bites, pull it in as it tires.' },
  { id: 'sell', icon: '💰', name: 'Buy low, sell high', how: 'Markets buy and sell goods. Press E at a market and sell something you carry. Goods fetch more where they\'re scarce.' },
  { id: 'process', icon: '⚙️', name: 'Make something', how: 'Bring raw goods (ore, logs, wheat…) to a factory in town and press E to process them into something worth more, for a small fee.' },
  { id: 'buy_car', icon: '🚙', name: 'Wheels of your own', how: 'Visit the car dealership, press E, and buy a car with money from your bank. It\'s locked to everyone but you.' },
  { id: 'rob', icon: '🔫', name: 'Stick \'em up', how: 'Hold F at an ATM, a shop till or a bank teller to rob it. The alarm goes off at once, so be ready to run.' },
  { id: 'escape', icon: '🏃', name: 'Lose the Militsiya', how: 'When you\'re wanted (stars at the top), get out of sight: hide in a dumpster (E), under a tree, or inside a building until they give up the search.' },
  { id: 'property', icon: '🏠', name: 'A place of your own', how: 'Press B (☰ → Property on a phone) near a home to buy it, or rent a flat or a garage box. Furnish it with cabinets to store things.' },
  { id: 'factory', icon: '🏭', name: 'Captain of industry', how: 'Buy a warehouse (E at its door) and build a factory inside with machines and belts — or buy a whole work site from its foreman.' },
  { id: 'vodka', icon: '🍾', name: 'Moonshine', how: 'Put a still in your warehouse (or a shack out in the woods, where the Militsiya notice less) and feed it wheat. Every batch of vodka adds heat — too much and they raid you.' },
  { id: 'counterfeit', icon: '💸', name: 'Printing money', how: 'Build a printing press in your warehouse or shack and feed it plastic to print fake rubles. Worth far more than vodka, and draws more heat.' },
  { id: 'blackguns', icon: '🔫', name: 'Gunsmith', how: 'Build a gunsmith bench in your warehouse or shack and feed it steel and parts to make unregistered pistols. Sell them boxed, or take one up (E) and use it.' },
  { id: 'smuggler', icon: '🕶️', name: 'The back door', how: 'Take your contraband to the man in the leather jacket outside the train station, press E and sell it. He buys anything illegal, any time, no questions asked.' },
  { id: 'hire', icon: '🕴️', name: 'Hired help', how: 'Go to the БАР and hire a goon to follow you, a guard for your property, or a hitman.' },
  { id: 'team', icon: '👥', name: 'Strength in numbers', how: 'Press T (or the 👥 Team button) and invite another player to your team, or accept their invite.' },
  { id: 'rich', icon: '💎', name: 'Tycoon', how: 'Get 10,000 ₽ in the bank. Factories, work sites and trade make the real money.' },
];

const IDS = new Set(ACHIEVEMENTS.map((a) => a.id));
export const RICH = 10000; // bank balance for 'rich'
const WALK = 500; // how far from where you appeared counts as finding your feet

const DONE_WHAT = {
  work_haul: 'work', job_deliver: 'job', buycar: 'buy_car', sell: 'sell', under: 'sell', black_sell: 'smuggler', process: 'process',
  wh_buy: 'factory', work_buy: 'factory', home_buy: 'property', home_rent: 'property', hire_goon: 'hire', hire_guard: 'hire', hire_hitman: 'hire',
};
const POLICE_KIND = { fish_caught: 'fish', stole: 'pickpocket', robbed: 'rob', lost_you: 'escape' };

/** The achievement a message on its way to a player means they've earned, if any. */
export function fromMessage(msg) {
  switch (msg.t) {
    case 'bought': return 'shop';
    case 'banked': return msg.action === 'deposit' ? 'bank' : null;
    case 'done': return DONE_WHAT[msg.what] ?? null;
    case 'police': return POLICE_KIND[msg.kind] ?? null;
    case 'team': return msg.members?.length > 1 ? 'team' : null;
    default: return null;
  }
}

/** The achievements player p has earned just by how things stand (checked now and then). */
export function fromState(p) {
  const got = [];
  if (!p.alive) return got;
  p.achStart ??= { x: p.x, y: p.y };
  if (Math.hypot(p.x - p.achStart.x, p.y - p.achStart.y) > WALK) got.push('walk');
  if (p.vehicle?.driver === p && Math.abs(p.vehicle.speed ?? 0) > 150) got.push('drive');
  if ((p.account?.bank ?? 0) >= RICH) got.push('rich');
  for (const good of p.account?.madeIllegal ?? []) got.push(good); // (marked by the warehouse that made it)
  return got;
}

/** Marks `id` earned on the account. True if it's new. */
export function earn(account, id) {
  if (!account || !IDS.has(id)) return false;
  account.achievements ??= [];
  if (account.achievements.includes(id)) return false;
  account.achievements.push(id);
  return true;
}
