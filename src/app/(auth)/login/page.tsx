import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { safeRedirectPath } from '@/lib/safe-redirect';

export const metadata: Metadata = { title: 'Sign in' };

const NOTICES: Record<string, string> = {
  two_factor_required:
    'This account has no authenticator set up, so it cannot open the dashboard. Run "pnpm seed:owner --reset" on the server to enroll one.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const notice = error ? NOTICES[error] : undefined;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>WhatsApp Assistant</CardTitle>
          <CardDescription>Sign in with your password and an authenticator code.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={safeRedirectPath(next)} notice={notice} />
        </CardContent>
      </Card>
    </main>
  );
}
