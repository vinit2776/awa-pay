import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <span className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <span className="grid size-6 place-items-center rounded-md bg-accent text-[13px] text-accent-ink">a</span>
          awa-pay
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <LoginForm />
        <p className="text-xs text-ink-3">On a shared device? Sign out from your name in the top bar when you&apos;re done.</p>
      </div>
    </div>
  );
}
