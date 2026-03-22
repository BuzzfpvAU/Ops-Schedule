import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

// Resend free tier: use onboarding@resend.dev (only sends to account owner's email)
// Production: set RESEND_DOMAIN to a verified domain (e.g. taskz.id) to send to any email
const FROM_ADDRESS = process.env.RESEND_DOMAIN
  ? `Ops Schedule <Schedule@${process.env.RESEND_DOMAIN}>`
  : 'Ops Schedule <onboarding@resend.dev>';

export async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${APP_URL}/?token=${token}`;

  if (!resend) {
    console.log(`[DEV] Password reset link for ${email}: ${resetUrl}`);
    return { success: true, dev: true };
  }

  console.log(`Sending password reset email to ${email} from ${FROM_ADDRESS}`);

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: email,
    subject: 'Reset your Ops Schedule password',
    html: `
      <h2>Password Reset</h2>
      <p>Click the link below to reset your password. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#4A6CF7;color:#fff;text-decoration:none;border-radius:6px;">Reset Password</a></p>
      <p>If you didn't request this, ignore this email.</p>
    `,
  });

  if (error) {
    console.error('Resend API error:', JSON.stringify(error));
    throw new Error(`Failed to send reset email: ${error.message || JSON.stringify(error)}`);
  }

  console.log('Reset email sent successfully:', JSON.stringify(data));
  return { success: true };
}

export async function sendViewerAccessEmail(recipientEmail) {
  const loginUrl = APP_URL;

  if (!resend) {
    console.log(`[DEV] Viewer access email for ${recipientEmail}: Login at ${loginUrl} with view@auav.com.au / rh2FpFcU34xvDs`);
    return { success: true, dev: true };
  }

  console.log(`Sending viewer access email to ${recipientEmail} from ${FROM_ADDRESS}`);

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: recipientEmail,
    subject: 'Ops Schedule — View Access',
    html: `
      <h2>Ops Schedule — View Access</h2>
      <p>You've been given view-only access to the Ops Schedule.</p>
      <p><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
      <p><strong>Email:</strong> view@auav.com.au</p>
      <p><strong>Password:</strong> rh2FpFcU34xvDs</p>
      <p><a href="${loginUrl}" style="display:inline-block;padding:10px 20px;background:#4A6CF7;color:#fff;text-decoration:none;border-radius:6px;">Open Ops Schedule</a></p>
    `,
  });

  if (error) {
    console.error('Resend API error:', JSON.stringify(error));
    throw new Error(`Failed to send viewer access email: ${error.message || JSON.stringify(error)}`);
  }

  console.log('Viewer access email sent successfully:', JSON.stringify(data));
  return { success: true };
}

export function isEmailConfigured() {
  return !!resend;
}
