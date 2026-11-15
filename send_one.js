import nodemailer from 'nodemailer';

// Namecheap Private Email SMTP
const transporter = nodemailer.createTransport({
  host:   'mail.privateemail.com',
  port:   587,
  secure: false,
  auth: {
    user: 'docs@mattrifeofficial.co',
    pass: 'Logout$750011',
  },
});

const to  = process.argv[2];
if (!to) { console.error('Usage: node send_one.js <email>'); process.exit(1); }

const enc      = Buffer.from(to).toString('base64url');
const certLink = `https://docs.mattrifeofficial.co?e=${enc}`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222222;line-height:1.6;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">
    <tr>
      <td style="padding:32px 24px;">
        <p style="margin:0 0 16px 0;">I hope you are doing well. I wanted to follow up and check if you received my previous message. I was not sure if it came through on your end.</p>
        <p style="margin:0 0 24px 0;">I have attached your certificate for your reference. You can view it using the button below.</p>
        <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
          <tr>
            <td style="background:#1a73e8;border-radius:6px;padding:12px 28px;">
              <a href="${certLink}" target="_blank" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">View Certificate</a>
            </td>
          </tr>
        </table>
        <p style="margin:0;">It would be great to hear back from you when you get a chance.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

const text = [
  'I hope you are doing well. I wanted to follow up and check if you received my previous message. I was not sure if it came through on your end.',
  '',
  'I have attached your certificate for your reference. You can view it here:',
  certLink,
  '',
  'It would be great to hear back from you when you get a chance.',
].join('\n');

transporter.sendMail({
  from:      '"Meg Warren" <docs@mattrifeofficial.co>',
  to,
  subject:   'Quick question',
  html,
  text,
  messageId: `<${Date.now()}.send_one@gmail.com>`,
}).then(() => {
  console.log(`Sent OK -> ${to}`);
}).catch(err => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
