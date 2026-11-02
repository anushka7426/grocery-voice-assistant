// Work out WHAT a product is from the text read off its pack.
//   brand      - matched against a list of common Indian grocery brands
//   categories - words like oil, oats, namkeen, biscuit
//   title      - the biggest, most confident lines of text on the pack
// Matching tolerates OCR slips (missing letters, no spaces between words).
// Nothing here is a verified identity; the app says "looks like".

// Common brands on Indian shelves (names only). Extend freely.
const BRANDS = [
  "Haldiram's", "Bikaji", "Bikano", "Kurkure", "Lay's", "Bingo", "Uncle Chipps", "Parle", "Parle-G", "Britannia",
  "Sunfeast", "Mom's Magic", "Good Day", "Marie Gold", "Bourbon", "Oreo", "Cadbury", "Dairy Milk", "Nestle", "Maggi",
  "KitKat", "Munch", "Amul", "Mother Dairy", "Nandini", "Aavin", "Patanjali", "Dabur", "Himalaya", "Tata", "Tata Salt",
  "Tata Tea", "Tata Sampann", "Aashirvaad", "Fortune", "Saffola", "Sundrop", "Dhara", "Parachute", "Nutrela",
  "Kellogg's", "Quaker", "Yippee", "Top Ramen", "Knorr", "Kissan", "MTR", "Gits", "Everest", "MDH", "Catch", "Badshah",
  "Brooke Bond", "Red Label", "Taj Mahal", "Wagh Bakri", "Lipton", "Typhoo", "Nescafe", "Bru", "Sunrise", "Horlicks",
  "Bournvita", "Boost", "Complan", "Real", "Tropicana", "Paper Boat", "Frooti", "Maaza", "Slice", "Appy", "Coca-Cola",
  "Pepsi", "Thums Up", "Sprite", "Limca", "Fanta", "Mirinda", "7UP", "Bisleri", "Kinley", "Aquafina", "Pillsbury",
  "Weikfield", "Del Monte", "Mapro", "Jivo", "Organic India", "Too Yumm", "Balaji", "Cornitos", "Act II", "Pringles",
  "Doritos", "Ferrero", "Nutella", "Snickers", "Colgate", "Pepsodent", "Closeup", "Sensodyne", "Lifebuoy", "Dettol",
  "Lux", "Dove", "Pears", "Santoor", "Cinthol", "Medimix", "Hamam", "Vim", "Surf Excel", "Ariel", "Tide", "Rin", "Wheel",
  "Comfort", "Harpic", "Lizol", "Godrej", "Clinic Plus", "Sunsilk", "Head & Shoulders", "Pantene", "Tresemme", "Vatika",
  "Indulekha", "Vaseline", "Nivea", "Ponds", "Garnier", "Lakme", "Johnson's", "Mamaearth", "Whisper", "Stayfree",
  "Pampers", "Safeguard", "Kolson", "Tapal", "Shezan", "Peek Freans", "Bisconni", "Meezan", "Supreme", "Fresher",
  "Gold Winner", "Engine", "Kachi Ghani", "Emami", "Zandu", "Vicks", "Eno", "Hajmola", "Pass Pass", "Kwality Walls",
  "Cornetto", "Magnum", "Vadilal", "Baskin Robbins", "Cream Bell", "Britannia Treat", "Hide & Seek", "Monaco", "Krackjack",
  "Tiger", "Unibic", "Priyagold", "Anmol", "Kissan", "Heinz", "Veeba", "Dr Oetker", "Funfoods", "Chings", "Ching's",
  "Smith & Jones", "Wai Wai", "Saffola Gold", "Sundrop Heart", "Gemini", "Postman", "Freedom", "Rajdhani", "India Gate",
  "Daawat", "Kohinoor", "Lal Qilla", "Fortune Rice", "Aashirvaad Atta", "Pillsbury Atta", "Annapurna", "Nature Fresh",
];

// [display, words that signal it]; a category matches when any signal is found
const CATEGORIES = [
  ["coconut oil", ["coconutoil"]], ["mustard oil", ["mustardoil", "kachighani"]], ["sunflower oil", ["sunfloweroil"]],
  ["groundnut oil", ["groundnutoil", "peanutoil"]], ["olive oil", ["oliveoil"]], ["cooking oil", ["refinedoil", "cookingoil", "vegetableoil"]],
  ["oats", ["oats"]], ["namkeen", ["namkeen"]], ["bhujia", ["bhujia"]], ["biscuits", ["biscuit", "cookies", "cracker"]],
  ["noodles", ["noodles"]], ["tea", ["teabags", "chai", "tea"]], ["coffee", ["coffee"]], ["soap", ["soap"]],
  ["shampoo", ["shampoo"]], ["toothpaste", ["toothpaste", "dentalcream"]], ["chips", ["chips", "wafers"]],
  ["masala", ["masala"]], ["atta", ["atta", "wholewheat"]], ["rice", ["basmati", "rice"]], ["dal", ["dal", "lentil"]],
  ["ghee", ["ghee"]], ["butter", ["butter"]], ["milk", ["milk"]], ["juice", ["juice", "nectar"]],
  ["detergent", ["detergent", "washingpowder"]], ["salt", ["saltiodised", "iodisedsalt"]], ["sugar", ["sugar"]],
  ["jam", ["jam"]], ["ketchup", ["ketchup"]], ["pickle", ["pickle", "achar"]], ["chocolate", ["chocolate"]],
  ["cornflakes", ["cornflakes", "muesli"]], ["honey", ["honey"]], ["lotion", ["lotion"]], ["cream", ["cream"]],
  ["papad", ["papad"]], ["sauce", ["sauce"]], ["spices", ["spice"]], ["snack", ["snack"]],
];

// lines that are boilerplate, not product names
const NOISE = /(cut|tear|here|fssai|lic|mfd|mfg|batch|best\s*before|use\s*by|expiry|net\s*(qty|quantity|wt|weight)|customer|consumer|care|ingredients|nutrition|storage|keep|store|veg|marketed|manufactured|address|www|\.com|mrp|incl|taxes|price|barcode|recycle|pack\b|^only$|^tm$|^new$|\bltd\b|limited|\bpvt\b|private|industries|\bindia\b|manufactur|company)/i;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Smallest edit distance between `pat` and any substring of `text` (Sellers). */
function fuzzyFind(pat, text, maxEdits) {
  const m = pat.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let best = Infinity, bestEnd = -1;
  for (let j = 1; j <= text.length; j++) {
    const cur = [0];
    for (let i = 1; i <= m; i++) {
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (pat[i - 1] === text[j - 1] ? 0 : 1));
    }
    if (cur[m] < best) { best = cur[m]; bestEnd = j; }
    prev = cur;
  }
  return best <= maxEdits ? { edits: best, end: bestEnd } : null;
}

const allowed = (len) => (len <= 4 ? 0 : len <= 8 ? 1 : 2);

/**
 * @param {{text:string, conf:number, h:number}[]} lines  from the text reader, reading order
 * @returns {{brand:string, categories:string[], title:string, name:string}}
 */
export function identify(lines) {
  const good = lines.filter((l) => l.text && l.conf >= 0.5);
  // concatenated normalised text with a map from character to line index
  let joined = "";
  const owner = [];
  good.forEach((l, i) => { const n = norm(l.text); joined += n; for (let k = 0; k < n.length; k++) owner.push(i); });

  // ---- brand
  let brand = null;
  for (const b of BRANDS) {
    const nb = norm(b);
    if (nb.length < 3) continue;
    let hit = null;
    if (nb.length <= 4) {
      // short names are too easy to match by accident: need a line that is basically just the brand
      const i = good.findIndex((l) => { const n = norm(l.text); return n === nb || (n.startsWith(nb) && n.length <= nb.length + 4 && l.conf >= 0.8); });
      if (i >= 0) hit = { edits: 0, end: 0, line: i };
    } else {
      const f = fuzzyFind(nb, joined, allowed(nb.length));
      if (f) hit = { ...f, line: owner[Math.min(f.end - 1, owner.length - 1)] };
    }
    if (!hit) continue;
    const size = good[hit.line]?.h || 0;
    const score = size - hit.edits * 1000;          // fewer edits first, then the bigger lettering
    if (!brand || score > brand.score) brand = { name: b, score, line: hit.line };
  }

  // ---- categories: whole words, or long signals anywhere (the text has no reliable spaces)
  const words = new Set(good.flatMap((l) => l.text.toLowerCase().match(/[a-z0-9]+/g) || []));
  const categories = [];
  for (const [label, signals] of CATEGORIES) {
    if (signals.some((sig) => words.has(sig) || (sig.length >= 7 && joined.includes(sig)))) categories.push(label);
    if (categories.length >= 2) break;
  }

  // ---- title: the biggest confident non-boilerplate lines, shown in reading order
  const titleIdx = good
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.conf >= 0.7 && !NOISE.test(l.text) && /[A-Za-z]{3,}/.test(l.text) && !/^[\d\W]+$/.test(l.text) && !/\d{3,}/.test(l.text))
    .sort((a, b) => b.l.h - a.l.h)
    .slice(0, 4)
    .map(({ i }) => i)
    .sort((a, b) => a - b);
  const brandNorm = brand ? norm(brand.name) : "";
  const titleLines = titleIdx
    .map((i) => good[i].text.replace(/^[\W_]+|[\W_]+$/g, "").trim())
    .filter((t) => t && (!brandNorm || !brandNorm.includes(norm(t)) || norm(t).length > brandNorm.length));
  const title = titleLines.join(" ");

  const nameParts = [];
  if (brand) nameParts.push(brand.name);
  if (title) nameParts.push(title);
  return { brand: brand ? brand.name : "", categories, title, name: nameParts.join(" ").slice(0, 80) };
}
