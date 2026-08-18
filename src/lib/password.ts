import bcrypt from "bcryptjs";

// Single source of truth for bcrypt cost — was previously hardcoded as `12`
// independently in the register and reset-password routes, which risks the
// two drifting out of sync if this is ever tuned.
const BCRYPT_COST_FACTOR = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
