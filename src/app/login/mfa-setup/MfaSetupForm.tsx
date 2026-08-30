"use client";

import Link from "next/link";
import { useActionState } from "react";
import { confirmMfaSetup } from "./actions";

export function MfaSetupForm() {
  const [state, formAction, pending] = useActionState(confirmMfaSetup, undefined);

  if (state && "backupCodes" in state) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-4">
        <p className="text-sm font-medium">
          Save these backup codes somewhere safe. Each works once, if you lose access to your
          authenticator.
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded bg-zinc-100 p-4 font-mono text-sm dark:bg-zinc-900">
          {state.backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <Link
          href="/"
          className="rounded bg-black px-4 py-2 text-center font-medium text-white dark:bg-white dark:text-black"
        >
          Continue to awa-pay
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="code" className="text-sm font-medium">
          6-digit code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </div>
      {state?.error && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-black px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
      >
        {pending ? "Confirming…" : "Confirm"}
      </button>
    </form>
  );
}
