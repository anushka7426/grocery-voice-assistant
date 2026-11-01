// Turns a product record into speech, and answers follow-up questions.
// Safety rule: missing data is reported as "not available", never as "none".

const sentence = (s) => (/[.!?]$/.test(s) ? s : s + ".");

export function summary(p) {
  const out = [p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase())
    ? `${p.brand} ${p.name}` : p.name];
  if (p.quantity) out.push(`Pack size ${p.quantity}`);
  if (p.diet === "vegetarian") out.push("Marked vegetarian in the database");
  else if (p.diet === "non-vegetarian") out.push("Warning: contains non-vegetarian ingredients");
  if (p.allergens && p.allergens.length) out.push(`Contains allergens: ${p.allergens.join(", ")}`);
  out.push("Say ingredients, allergens, nutrition, or repeat, for more");
  return out.map(sentence).join(" ");
}

export function answer(intent, p) {
  switch (intent) {
    case "ingredients":
      return p.ingredients
        ? sentence(`Ingredients: ${p.ingredients}`)
        : "Ingredients are not available for this product. Please check the pack.";
    case "allergens": {
      if (p.allergens === null || p.allergens === undefined)
        return "Allergen information is not available for this product. Please check the pack. Do not assume it is allergen free.";
      const a = p.allergens.length
        ? `Contains allergens: ${p.allergens.join(", ")}.`
        : "No allergens are listed in the database, but the data may be incomplete. Please check the pack if you have an allergy.";
      const t = p.traces && p.traces.length ? ` May contain traces of ${p.traces.join(", ")}.` : "";
      return a + t;
    }
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
      return "Price is not in the product database. Say read label to hear the M R P printed on the pack.";
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
  ["allergens", /allerg|gluten|milk|dairy|soy|wheat|\begg|peanut|\bnuts?\b/],
  ["price", /price|cost|\bmrp\b|rupee|how much (money|does)/],
  ["ingredients", /ingredient|made of|contain|what is in|what's in/],
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
