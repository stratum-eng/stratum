/**
 * Email Templates for Stratum
 *
 * Provides HTML and plain text email templates for various auth flows.
 */

import { escapeHtml } from "../utils/html";

export interface MagicLinkEmailData {
  magicLink: string;
  email: string;
}

/**
 * Validate URL scheme to prevent javascript: and other dangerous protocols
 * Only allows http: and https: schemes
 */
function validateUrl(url: string): { isValid: boolean; safeUrl: string } {
  try {
    const parsed = new URL(url);
    const allowedSchemes = ["http:", "https:"];

    if (!allowedSchemes.includes(parsed.protocol)) {
      console.warn(`Invalid URL scheme detected: ${parsed.protocol}`);
      return { isValid: false, safeUrl: "#" };
    }

    return { isValid: true, safeUrl: url };
  } catch {
    // Invalid URL format
    console.warn(`Invalid URL format: ${url}`);
    return { isValid: false, safeUrl: "#" };
  }
}

/**
 * Magic link email template with Stratum branding
 */
export function getMagicLinkEmail(data: MagicLinkEmailData): {
  subject: string;
  text: string;
  html: string;
} {
  const { magicLink, email } = data;

  // Validate URL scheme to prevent javascript: and other dangerous protocols
  const { isValid, safeUrl: validatedMagicLink } = validateUrl(magicLink);
  if (!isValid) {
    console.warn("Invalid magic link URL detected, using fallback");
  }

  // Escape values for HTML to prevent XSS
  const safeMagicLink = escapeHtml(validatedMagicLink);
  const safeEmail = escapeHtml(email);

  const subject = "Sign in to Stratum";

  const text = `Hi there,

Click the link below to sign in to Stratum:

${magicLink}

This link will expire in 15 minutes and can only be used once.

If you didn't request this sign-in link, you can safely ignore this email. No one will be able to access your account without this link.

--
Stratum
Your code management platform`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${subject}</title>
  <style>
    /* Reset styles */
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; }
    
    /* Reset */
    body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }
    
    /* Responsive */
    @media screen and (max-width: 600px) {
      .container { width: 100% !important; max-width: 100% !important; }
      .content { padding: 20px !important; }
      .button { width: 100% !important; }
    }
    
    /* Dark mode support */
    @media (prefers-color-scheme: dark) {
      .email-wrapper { background-color: #1a1a1a !important; }
      .email-content { background-color: #0f0f0f !important; }
      .text-primary { color: #e5e5e5 !important; }
      .text-secondary { color: #a0a0a0 !important; }
      .button { background-color: #3b82f6 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #0f0f0f;" bgcolor="#0f0f0f">
  <!-- Preview text -->
  <div style="display: none; max-height: 0; overflow: hidden;">
    Sign in to Stratum - Click the magic link to access your account
  </div>
  
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" class="email-wrapper">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="container" style="max-width: 600px; width: 100%;">
          
          <!-- Header with Logo -->
          <tr>
            <td align="center" style="padding-bottom: 30px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="font-size: 28px; font-weight: 700; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -0.5px;">
                    stratum
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Main Content Card -->
          <tr>
            <td class="email-content" style="background-color: #1a1a1a; border-radius: 12px; overflow: hidden; border: 1px solid #333;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td class="content" style="padding: 40px;">
                    
                    <!-- Greeting -->
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td class="text-primary" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 20px; font-weight: 600; color: #e5e5e5; padding-bottom: 16px;">
                          Hi there,
                        </td>
                      </tr>
                      <tr>
                        <td class="text-secondary" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 16px; line-height: 1.6; color: #a0a0a0; padding-bottom: 32px;">
                          Click the button below to sign in to your Stratum account. This link will expire in <strong style="color: #e5e5e5;">15 minutes</strong> and can only be used once.
                        </td>
                      </tr>
                    </table>
                    
                    <!-- CTA Button -->
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td align="center" style="padding-bottom: 32px;">
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0" class="button-wrapper">
                            <tr>
                              <td class="button" style="background-color: #3b82f6; border-radius: 8px; text-align: center;">
                                <a href="${safeMagicLink}" style="display: inline-block; padding: 16px 32px; color: #ffffff; text-decoration: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 16px; font-weight: 600; border-radius: 8px;">
                                  Sign in to Stratum
                                </a>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                    
                    <!-- Fallback Link -->
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td class="text-secondary" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #808080; padding-bottom: 16px;">
                          If the button doesn't work, copy and paste this link into your browser:
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 32px; word-break: break-all;">
                          <a href="${safeMagicLink}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; color: #3b82f6; text-decoration: underline;">
                            ${safeMagicLink}
                          </a>
                        </td>
                      </tr>
                    </table>
                    
                    <!-- Security Note -->
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #2a1f1f; border-radius: 8px; border-left: 4px solid #ef4444;">
                      <tr>
                        <td style="padding: 16px;">
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                            <tr>
                              <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #fca5a5;">
                                <strong style="color: #ef4444;">Didn't request this?</strong><br>
                                If you didn't request this sign-in link, you can safely ignore this email. No one will be able to access your account without this link.
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                    
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 30px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td class="text-secondary" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; color: #666; text-align: center;">
                    <strong style="color: #888;">Stratum</strong><br>
                    Your code management platform
                  </td>
                </tr>
                <tr>
                  <td style="padding-top: 16px; text-align: center;">
                    <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; color: #555;">
                      Sent to ${safeEmail}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * Generic email template wrapper with Stratum branding
 * TODO: Use this for future email templates (notifications, invites, etc.)
 * Currently exported but unused - will be used when adding new email types
 */
export function wrapEmail(content: { title: string; body: string }): string {
  const { title, body } = content;

  // Escape title to prevent XSS (body is expected to be safe HTML)
  const safeTitle = escapeHtml(title);
  // Note: body is intentionally NOT escaped - callers must provide safe HTML

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    @media screen and (max-width: 600px) {
      .container { width: 100% !important; }
    }
    @media (prefers-color-scheme: dark) {
      .email-wrapper { background-color: #1a1a1a !important; }
      .email-content { background-color: #0f0f0f !important; }
      .text-primary { color: #e5e5e5 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #0f0f0f;" bgcolor="#0f0f0f">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="container" style="max-width: 600px; width: 100%;">
          <tr>
            <td align="center" style="padding-bottom: 30px; font-size: 28px; font-weight: 700; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
              stratum
            </td>
          </tr>
          <tr>
            <td style="background-color: #1a1a1a; border-radius: 12px; border: 1px solid #333; padding: 40px;">
              ${body}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top: 30px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; color: #666;">
              <strong style="color: #888;">Stratum</strong><br>
              Your code management platform
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
