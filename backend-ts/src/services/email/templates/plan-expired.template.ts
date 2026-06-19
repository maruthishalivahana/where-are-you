import { baseTemplate } from './base.template';

interface PlanExpiredTemplateParams {
  adminName: string;
  organizationName: string;
  expiredPlanName: string;
  renewUrl?: string;
}

export const planExpiredTemplate = (params: PlanExpiredTemplateParams): string => {
  const { adminName, organizationName, expiredPlanName, renewUrl = '#' } = params;

  const content = `
    <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #1a1a2e; line-height: 1.3;">Your plan has expired</h1>
    <p style="margin: 0 0 8px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Hi ${adminName},
    </p>
    <p style="margin: 0 0 16px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      The <strong>${expiredPlanName}</strong> plan for <strong>${organizationName}</strong> has expired. Your buses and tracking features are now inactive.
    </p>
    <p style="margin: 0 0 24px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Renew your plan to continue using NavixGo.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
      <tr>
        <td align="center">
          <a href="${renewUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; background-color: #1e43b8; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Renew Plan</a>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate({
    title: 'Your Plan Has Expired - NavixGo',
    preheader: `Your ${expiredPlanName} plan for ${organizationName} has expired.`,
    content,
  });
};
