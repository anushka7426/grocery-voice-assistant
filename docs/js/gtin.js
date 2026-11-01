// Barcode helpers: checksum validation and normalisation.

export function gtinValid(code) {
  if (!/^\d+$/.test(code)) return false;
  if (![8, 12, 13].includes(code.length)) return false;
  const d = code.split("").map(Number);
  const check = d.pop();
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    // weights 3,1,3,1... counted from the digit next to the check digit
    sum += d[d.length - 1 - i] * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

// UPC-A is EAN-13 with a leading zero; store everything as EAN-13 where possible.
export function normalise(code) {
  return code.length === 12 ? "0" + code : code;
}

export function isIndian(code) {
  return code.startsWith("890");
}
