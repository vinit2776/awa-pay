"use client";

import { useActionState } from "react";
import { verifyMfa } from "./actions";

export function MfaForm() {
  const [state, formAction, pending] = useActionState(verifyMfa, undefined);

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="code" className="text-sm font-medium">
          6-digit code (or a backup code)
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
        {pending ? "Verifying…" : "Verify"}
      </button>
    </form>
  );
}
