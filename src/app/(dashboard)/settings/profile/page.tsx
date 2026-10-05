import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { ProfileEditor } from '@/components/settings/profile-editor';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getDb } from '@/lib/db';
import { settings } from '@/lib/db/schema';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Business profile' };

export default async function ProfilePage() {
  await requireOwnerPage();
  const [prefs] = await getDb().select({ ownerName: settings.ownerName, businessName: settings.businessName, businessProfile: settings.businessProfile }).from(settings).where(eq(settings.id, 1)).limit(1);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Business profile</CardTitle>
        <CardDescription>What the assistant is allowed to say about your business. It is the only source of prices, stock, hours and policies: anything not written here becomes a placeholder you fill in.</CardDescription>
      </CardHeader>
      <CardContent>
        <ProfileEditor ownerName={prefs?.ownerName ?? ''} businessName={prefs?.businessName ?? ''} businessProfile={prefs?.businessProfile ?? ''} />
      </CardContent>
    </Card>
  );
}
