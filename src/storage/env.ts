// The one process.env read point for R2, mirroring src/db/runtime.ts's
// DATABASE_URL pattern and src/auth/env.ts's SESSION_SECRET pattern.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. See .env.example.`);
  }
  return value;
}

export const R2_ACCOUNT_ID = required("R2_ACCOUNT_ID");
export const R2_ACCESS_KEY_ID = required("R2_ACCESS_KEY_ID");
export const R2_SECRET_ACCESS_KEY = required("R2_SECRET_ACCESS_KEY");
export const R2_BUCKET_NAME = required("R2_BUCKET_NAME");
