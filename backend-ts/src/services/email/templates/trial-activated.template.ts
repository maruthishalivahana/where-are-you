import { baseTemplate } from './base.template';

interface TrialActivatedTemplateParams {
  adminName: string;
  organizationName: string;
  busLimit: number;
  expiryDate: string;
}

export const trialActivatedTemplate = (params: TrialActivatedTemplateParams): string => {
  const { adminName, organizationName, busLimit, expiryDate } = params;

  const content = `
    <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #1a1a2e; line-height: 1.3;">Your free trial is active!</h1>
    <p style="margin: 0 0 8px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Hi ${adminName}, great news! Your free trial for <strong>${organizationName}</strong> is now active.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 20px 0;">
      <tr>
        <td style="background-color: #f0f4ff; border-radius: 8px; padding: 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding: 4px 0; font-size: 14px; color: #6b7280;">Plan</td>
              <td style="padding: 4px 0; font-size: 14px; color: #1a1a2e; font-weight: 600; text-align: right;">Free Trial (7 days)</td>
            </tr>
            <tr>
              <td style="padding: 4px 0; font-size: 14px; color: #6b7280;">Bus Limit</td>
              <td style="padding: 4px 0; font-size: 14px; color: #1a1a2e; font-weight: 600; text-align: right;">${busLimit}</td>
            </tr>
            <tr>
              <td style="padding: 4px 0; font-size: 14px; color: #6b7280;">Expires</td>
              <td style="padding: 4px 0; font-size: 14px; color: #1a1a2e; font-weight: 600; text-align: right;">${expiryDate}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <p style="margin: 0 0 24px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Start adding your buses and routes to get the most out of your trial period.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
      <tr>
        <td align="center">
          <a href="#" target="_blank" style="display: inline-block; padding: 14px 32px; background-color: #1e43b8; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Set Up Your Fleet</a>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate({
    title: 'Your Free Trial is Active - NavixGo',
    preheader: `Your 7-day free trial for ${organizationName} is now active.`,
    content,
  });
};
