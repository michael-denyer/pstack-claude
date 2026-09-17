const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
let outbox;
function sendInvite({ allowed, recipient }) {
  if (!allowed) {
    if (process.env.MUTATE_DENIAL === '1') outbox.push({ to: recipient });
    return { status: 'denied' };
  }
  outbox.push({ to: recipient });
  return { status: 'sent' };
}
beforeEach(() => {
  outbox = [];
  sendInvite({ allowed: false, recipient: 'test@example.invalid' });
});
test('denied invitation sends no email', () => {
  assert.deepEqual(outbox, []);
});
