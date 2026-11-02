// Turns a product record into speech, and answers follow-up questions.
// Missing data is reported as "not available".

const sentence = (s) => (/[.!?]$/.test(s) ? s : s + ".");

export function summary(p) {
  const out = [p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase())
    ? `${p.brand} ${p.name}` : p.name];
  if (p.quantity) out.push(`Pack size ${p.quantity}`);
  if (p.mrp) out.push(`Price ${p.mrp} rupees`);
  if (p.diet === "vegetarian") out.push("Marked vegetarian in the database");
  else if (p.diet === "non-vegetarian") out.push("Warning: this product is marked non-vegetarian");
  out.push("Say nutrition, vegetarian, price, or repeat, for more");
  return out.map(sentence).join(" ");
}

export function answer(intent, p) {
  switch (intent) {
    case "nutrition": {
      const n = p.nutrition;
      if (!n) return "Nutrition information is not available for this product.";
      const bits = [];
      if (n.energy_kcal !== null) bits.push(`${n.energy_kcal} kilocalories`);
      if (n.carbs !== null) bits.push(`${n.carbs} grams carbohydrate`);
      if (n.sugars !== null) bits.push(`${n.sugars} grams sugar`);
      if (n.fat !== null) bits.push(`${n.fat} grams fat`);
      if (n.proteins !== null) bits.push(`${n.proteins} grams protein`);
      if (n.salt !== null) bits.push(`${n.salt} grams salt`);
      return `Per 100 grams: ${bits.join(", ")}.`;
    }
    case "diet":
      if (p.diet === "vegetarian") return "The database marks this product vegetarian. Check the green dot on the pack to confirm.";
      if (p.diet === "non-vegetarian") return "The database marks this product non-vegetarian.";
      return "Vegetarian status is not available for this product. Check the green or brown dot on the pack.";
    case "size":
      return p.quantity ? `Pack size ${p.quantity}.` : "Pack size is not available.";
    case "price":
      return p.mrp
        ? `Price ${p.mrp} rupees, as saved. Prices change, so check the shelf label.`
        : "Price is not saved for this product. Say read label to hear the M R P printed on the pack.";
    case "name":
      return sentence(summary(p).split(". ")[0]);
    case "repeat":
      return summary(p);
    default:
      return null;
  }
}

// Order matters: the first rule that matches wins.
const RULES = [
  ["price", /price|cost|\bmrp\b|rupee|how much (money|does)/],
  ["nutrition", /nutri|calor|sugar|\bfat\b|protein|\bsalt\b|carb|energy|healthy/],
  ["diet", /\bveg|non.?veg|meat/],
  ["size", /size|quantity|weight|grams|how (much|big)/],
  ["repeat", /repeat|again|say that|what is this|what's this/],
];
export function parseIntent(text) {
  const t = text.toLowerCase();
  for (const [intent, re] of RULES) if (re.test(t)) return intent;
  return null;
}
