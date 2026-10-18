// Check your email settings:   npm run test-mail            logs in to your SMTP server (sends nothing)
//                              npm run test-mail you@example.com   …and sends a real test email to that address
import { ENV } from './core.js';
import { mailConfig, checkSmtp, sendMail } from './mail.js';

const to = process.argv[2];
const cfg = mailConfig();
if (!cfg) {
  console.error('\n  SMTP_HOST is not set, so Orate has no mail server to use.\n  Open .env and make sure the SMTP_… lines do not start with "#" (see README → "Email verification").\n');
  process.exit(1);
}
console.log(`\n  Mail server: ${cfg.host}:${cfg.port} (${cfg.secure ? 'TLS' : 'STARTTLS'}) · login: ${cfg.user || '(none)'} · sender: ${cfg.fromHeader}`);
try {
  await checkSmtp();
  console.log('  ✓ Connected, encrypted and logged in — the mail server accepted these settings.');
  if (to) {
    await sendMail({ to, subject: 'Orate test email', text: 'If you can read this, Orate can send email. 🎉\n', html: '<p>If you can read this, <b>Orate can send email</b>. 🎉</p>' });
    console.log(`  ✓ Test email sent to ${to} (check spam too).`);
  } else console.log('  (Nothing was sent. Add an address to send a real test:  npm run test-mail you@example.com)');
  console.log('');
  process.exit(0);
} catch (e) {
  console.error(`  ✗ ${e.message}\n`);
  if (/535|Username and Password not accepted|AUTH/i.test(e.message)) console.error('  → The login was refused. With Gmail you need an *app password* (not your normal password); 2-Step Verification must be on.\n');
  else if (/timed out|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(e.message)) console.error('  → Could not reach the mail server. Check SMTP_HOST / SMTP_PORT, your internet connection and any firewall (try port 465 with SMTP_SECURE=true).\n');
  process.exit(1);
}
void ENV;
