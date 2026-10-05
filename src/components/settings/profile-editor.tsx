'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveBusinessProfile } from '@/actions/profile';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { MarkdownPreview } from './markdown-preview';

const MAX = 8000;

export function ProfileEditor({ ownerName, businessName, businessProfile }: { ownerName: string; businessName: string; businessProfile: string }) {
  const router = useRouter();
  const [owner, setOwner] = useState(ownerName);
  const [business, setBusiness] = useState(businessName);
  const [profile, setProfile] = useState(businessProfile);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [pending, startTransition] = useTransition();
  const dirty = owner !== ownerName || business !== businessName || profile !== businessProfile;

  const save = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await saveBusinessProfile({ ownerName: owner, businessName: business, businessProfile: profile });
      if (result.ok) {
        setMessage({ tone: 'ok', text: 'Saved. New drafts use this profile.' });
        router.refresh();
      } else {
        const first = Object.values(result.error.fieldErrors ?? {}).flat()[0];
        setMessage({ tone: 'error', text: first ?? result.error.message });
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="owner-name">Your name (as you sign off)</Label>
          <Input id="owner-name" value={owner} onChange={(event) => setOwner(event.target.value)} maxLength={80} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="business-name">Business name</Label>
          <Input id="business-name" value={business} onChange={(event) => setBusiness(event.target.value)} maxLength={80} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="business-profile">Business profile</Label>
          <div role="tablist" aria-label="Profile view" className="flex gap-1 text-sm lg:hidden">
            {(['write', 'preview'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`rounded-md px-3 py-1 ${tab === value ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
              >
                {value === 'write' ? 'Write' : 'Preview'}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          This is the <strong>only</strong> place the assistant may take prices, stock, delivery, opening hours and policies from. Anything not written here
          becomes a <code className="text-xs">[[placeholder]]</code> in the draft that you must fill in before it can be sent. Simple formatting works:{' '}
          <code className="text-xs"># heading</code>, <code className="text-xs">- list</code>, <code className="text-xs">**bold**</code>.
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className={tab === 'write' ? 'block' : 'hidden lg:block'}>
            <textarea
              id="business-profile"
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
              rows={14}
              className="min-h-64 w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-sm"
              placeholder={'## Prices\n- Blue dress: UGX 50,000\n\n## Delivery\n- Kampala: UGX 5,000, same day before 3pm'}
            />
            <p className={`mt-1 text-xs ${profile.length > MAX ? 'text-destructive' : 'text-muted-foreground'}`}>
              {profile.length}/{MAX}
            </p>
          </div>
          <div className={tab === 'preview' ? 'block' : 'hidden lg:block'}>
            <div className="min-h-64 rounded-md border border-border bg-card p-3" aria-label="Preview of the profile">
              <MarkdownPreview source={profile} />
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={pending || !dirty}>
          {pending ? 'Saving…' : 'Save profile'}
        </Button>
        {message ? (
          <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-success'}>
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
