// Flow checks: the payee verification steps end to end, on the in-memory store with simulated
// PayPal and no AI (run with `npm run test:engine`; keys in the environment are ignored).

import assert from 'node:assert/strict';

for (const k of ['OPENAI_API_KEY', 'AG_STUDIO_OPENAI_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) delete process.env[k];

async function main() {
  const { SCENARIOS } = await import('../lib/preflight/seed');
  const { resetStore, store } = await import('../lib/preflight/store');
  const { answerCode, answerVerification, createReview, rejectSender } = await import('../lib/preflight/service');
  const { inbox } = await import('../lib/preflight/snapshot');
  const text = (id: string) => SCENARIOS.find((s) => s.id === id)!.text;
  const maria = async () => {
    resetStore();
    const review = await createReview({ text: text('hacked-payee') });
    const item = review.items.find((i) => i.name === 'Maria Lopez')!;
    return { review, item, token: inbox().find((m) => m.rowId === item.rowId)!.token };
  };

  // Hacked payee mailbox: the scammer's "Yes" sends nothing; a code goes to the phone on file.
  let { item, token } = await maria();
  let res = await answerVerification(token, 'yes');
  assert.ok('needsCode' in res && res.needsCode, 'email yes on new details must ask for a code');
  assert.equal(item.state, 'held');
  assert.ok(inbox()[0].sms?.text.includes(item.phoneCode!), 'the code is in the text to the phone on file');
  await answerVerification(token, 'no');
  assert.equal(item.state, 'denied');
  assert.equal(store().payees.find((p) => p.id === 'maria')!.email.endsWith('@gmail.com'), false, 'payee details unchanged');
  console.log('✓ hacked payee mailbox: email Yes sends nothing, "Not me" on the phone stops it');

  // Three wrong codes stop it as fraud.
  ({ item, token } = await maria());
  await answerVerification(token, 'yes');
  for (let i = 0; i < 3; i++) await answerCode(token, '000000').catch(() => undefined);
  assert.equal(item.state, 'denied');
  console.log('✓ three wrong codes stop the payout');

  // The real payee: email Yes + the right code sends it and trusts the new details.
  ({ item, token } = await maria());
  await answerVerification(token, 'yes');
  await answerCode(token, item.phoneCode!);
  assert.equal(item.state, 'sent');
  assert.equal(store().payees.find((p) => p.id === 'maria')!.email, 'maria.lopez.pay@gmail.com');
  console.log('✓ genuine change: email Yes + the code sends it, and the new details become trusted');

  // Same account, bigger amount (inflated invoice): an email Yes alone is enough.
  resetStore();
  const review = await createReview({ text: text('inflated') });
  const james = review.items.find((i) => i.name === 'James Chen')!;
  res = await answerVerification(inbox().find((m) => m.rowId === james.rowId)!.token, 'yes');
  assert.ok(!('needsCode' in res));
  assert.equal(james.state, 'sent');
  console.log('✓ unchanged account: email Yes is enough');

  // Fake sender confirmed fake: every payout in the request is stopped, nothing goes to PayPal.
  resetStore();
  const fake = await createReview({ text: text('fake-sender') });
  rejectSender(fake.id);
  assert.ok(fake.items.every((i) => i.state === 'denied' && !i.paypal));
  assert.equal(inbox().length, 0, 'no payee checks left waiting');
  console.log('✓ fake sender rejected: all 6 payouts stopped, nothing sent');

  // The CSV scenario goes through the CSV parser, not the email one.
  resetStore();
  const csv = await createReview({ text: text('csv') });
  assert.equal(csv.items.map((i) => `${i.name.split(' ')[0]}:${i.state}`).join(' '), 'Priya:clear James:clear Tom:warn Aisha:clear Diego:clear Maria:clear');
  console.log('✓ CSV scenario: Tom warned, the rest clear');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
