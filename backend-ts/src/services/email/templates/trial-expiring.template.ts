import { baseTemplate } from './base.template';

interface TrialExpiringTemplateParams {
  adminName: string;
  organizationName: string;
  daysRemaining: number;
  upgradeUrl?: string;
}

export const trialExpiringTemplate = (params: TrialExpiringTemplateParams): string => {
  const { adminName, organizationName, daysRemaining, upgradeUrl = '#' } = params;

  const dayLabel = daysRemaining === 1 ? 'day' : 'days';

  const content = `
    <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #1a1a2e; line-height: 1.3;">Your trial expires in ${daysRemaining} ${dayLabel}</h1>
    <p style="margin: 0 0 8px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Hi ${adminName},
    </p>
    <p style="margin: 0 0 24px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Your free trial for <strong>${organizationName}</strong> is ending soon. Upgrade now to keep your tracking running without interruption.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
      <tr>
        <td align="center">
          <a href="${upgradeUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; background-color: #f59e0b; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Upgrade Now</a>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate({
    title: 'Your Trial is Expiring Soon - NavixGo',
    preheader: `Only ${daysRemaining} ${dayLabel} left on your NavixGo trial.`,
    content,
  });
};
