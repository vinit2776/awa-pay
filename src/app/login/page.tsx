import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4">
      <h1 className="text-2xl font-semibold">Sign in to awa-pay</h1>
      <LoginForm />
    </div>
  );
}
