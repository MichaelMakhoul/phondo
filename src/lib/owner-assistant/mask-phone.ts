// SCRUM-586: how the lockout email refers to the number that tripped the PIN
// lock. Last three digits only — recognisable to the owner, useless to anyone
// else reading the inbox. Pure; never throws.
export function maskPhoneForOwner(e164: string): string {
  const digits = String(e164 ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "an unknown number";
  const last3 = digits.slice(-3);
  // AU mobile (+614… or national 04…) → the national shape owners recognise.
  if (/^(61)?4\d{8}$/.test(digits.replace(/^0/, ""))) return `04xx xxx ${last3}`;
  return `+${"x".repeat(digits.length - 3)}${last3}`;
}
