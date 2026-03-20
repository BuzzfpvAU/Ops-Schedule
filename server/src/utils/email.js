import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

export async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  if (!resend) {
    console.log(`[DEV] Password reset link for ${email}: ${resetUrl}`);
    return { success: true, dev: true };
  }

  const { data, error } = await resend.emails.send({
    from: 'Ops Schedule <noreply@' + (process.env.RESEND_DOMAIN || 'resend.dev') + '>',
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
    console.error('Failed to send reset email:', error);
    throw new Error('Failed to send reset email');
  }

  return { success: true };
}

export function isEmailConfigured() {
  return !!resend;
}
