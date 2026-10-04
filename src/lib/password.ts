import bcrypt from "bcryptjs";

// Single source of truth for bcrypt cost — was previously hardcoded as `12`
// independently in the register and reset-password routes, which risks the
// two drifting out of sync if this is ever tuned.
const BCRYPT_COST_FACTOR = 12;

// Real hash computed lazily, used only for timing parity on password-less accounts.
let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  // Google-only accounts have no password; still burn a compare so timing
  // doesn't reveal which accounts are password-less.
  if (!hash) {
    dummyHash ??= hashPassword("timing-parity");
    await bcrypt.compare(password, await dummyHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}
