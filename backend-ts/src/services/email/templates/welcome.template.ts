import { baseTemplate } from './base.template';

interface WelcomeTemplateParams {
  adminName: string;
  organizationName: string;
  loginUrl?: string;
}

export const welcomeTemplate = (params: WelcomeTemplateParams): string => {
  const { adminName, organizationName, loginUrl = '#' } = params;

  const content = `
    <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #1a1a2e; line-height: 1.3;">Welcome to NavixGo, ${adminName}!</h1>
    <p style="margin: 0 0 24px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Your organization <strong>${organizationName}</strong> has been successfully created. You can now set up your buses, routes, and drivers.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
      <tr>
        <td align="center">
          <a href="${loginUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; background-color: #1e43b8; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Go to Dashboard</a>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate({
    title: 'Welcome to NavixGo',
    preheader: `Welcome aboard, ${adminName}! Your organization is ready.`,
    content,
  });
};
