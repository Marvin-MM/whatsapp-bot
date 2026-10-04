'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { authClient } from './auth-client';

type Step = 'password' | 'totp' | 'backup';

const GENERIC_FAILURE = 'Sign-in failed. Check your details and try again.';

/**
 * Two-step sign-in: email + password, then a TOTP code (or a one-time backup code).
 * Error text is deliberately generic so it never reveals whether an email exists.
 */
export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function finish() {
    router.replace(next);
    router.refresh();
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { data, error: failure } = await authClient.signIn.email({ email, password });
      if (failure || !data) {
        setError(failure?.status === 429 ? 'Too many attempts. Wait 15 minutes and try again.' : GENERIC_FAILURE);
        return;
      }
      if ('twoFactorRedirect' in data && data.twoFactorRedirect) {
        setStep('totp');
        return;
      }
      finish();
    } catch {
      setError(GENERIC_FAILURE);
    } finally {
      setPending(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const trimmed = code.replace(/\s+/g, '');
      const { error: failure } =
        step === 'backup'
          ? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
          : await authClient.twoFactor.verifyTotp({ code: trimmed });
      if (failure) {
        setError(failure.status === 429 ? 'Too many attempts. Wait 15 minutes and try again.' : 'That code was not accepted.');
        return;
      }
      finish();
    } catch {
      setError('That code was not accepted.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      {notice ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          {notice}
        </p>
      ) : null}

      {step === 'password' ? (
        <form onSubmit={submitPassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Signing in…' : 'Continue'}
          </Button>
        </form>
      ) : (
        <form onSubmit={submitCode} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">{step === 'backup' ? 'Backup code' : '6-digit code from your authenticator app'}</Label>
            <Input
              id="code"
              autoComplete="one-time-code"
              inputMode={step === 'backup' ? 'text' : 'numeric'}
              autoFocus
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Verifying…' : 'Sign in'}
          </Button>
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground underline underline-offset-4"
            onClick={() => {
              setCode('');
              setError(null);
              setStep(step === 'backup' ? 'totp' : 'backup');
            }}
          >
            {step === 'backup' ? 'Use my authenticator app instead' : 'Use a backup code instead'}
          </button>
        </form>
      )}
    </div>
  );
}
