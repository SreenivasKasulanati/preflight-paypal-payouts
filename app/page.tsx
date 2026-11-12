import type { Metadata } from 'next';
import { connection } from 'next/server';
import { aiEnabled, aiModels } from '@/lib/ai';
import { SCENARIOS } from '@/lib/preflight/seed';
import { PreflightApp } from './preflight/preflight-app';

export const metadata: Metadata = { title: 'Preflight for PayPal Payouts' };

export default async function Home() {
  await connection();
  // Only model ids reach the browser; the OpenAI key stays on the server (lib/ai.ts).
  return (
    <PreflightApp
      licenseKey={process.env.AG_STUDIO}
      aiModels={aiEnabled() ? aiModels() : undefined}
      scenarios={SCENARIOS}
    />
  );
}
