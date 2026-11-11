// A small in-memory rate limit for the routes that spend AI credits. The hosted demo is public, so
// without this anyone could run up the OpenAI bill. Per instance, which is enough for one free host.

const hits = new Map<string, number[]>();

export function rateLimited(request: Request, bucket: string, perMinute = Number(process.env.AI_RATE_PER_MINUTE ?? 20)) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  // A daily ceiling across everyone, as a backstop.
  const dayKey = `${bucket}:day:${new Date().toISOString().slice(0, 10)}`;
  const day = (hits.get(dayKey)?.[0] ?? 0) + 1;
  hits.set(dayKey, [day]);
  return recent.length > perMinute || day > Number(process.env.AI_DAILY_LIMIT ?? 2000);
}
