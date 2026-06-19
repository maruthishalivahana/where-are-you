import { baseTemplate } from './base.template';

interface PaymentFailedTemplateParams {
  adminName: string;
  planName: string;
  reason?: string;
  retryUrl?: string;
}

export const paymentFailedTemplate = (params: PaymentFailedTemplateParams): string => {
  const { adminName, planName, reason, retryUrl = '#' } = params;

  const reasonBlock = reason
    ? `<p style="margin: 0 0 16px 0; font-size: 14px; color: #6b7280; line-height: 1.6;"><strong style="color: #1a1a2e;">Reason:</strong> ${reason}</p>`
    : '';

  const content = `
    <div style="text-align: center; margin-bottom: 16px;">
      <span style="display: inline-block; width: 48px; height: 48px; line-height: 48px; border-radius: 50%; background-color: #fef2f2; color: #ef4444; font-size: 24px; font-weight: 700;">!</span>
    </div>
    <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #ef4444; line-height: 1.3; text-align: center;">Payment Failed</h1>
    <p style="margin: 0 0 16px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Hi ${adminName}, your payment for <strong>${planName}</strong> could not be processed.
    </p>
    ${reasonBlock}
    <p style="margin: 0 0 24px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Please try again or contact support.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
      <tr>
        <td align="center">
          <a href="${retryUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; background-color: #ef4444; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Retry Payment</a>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate({
    title: 'Payment Failed - NavixGo',
    preheader: `Your payment for ${planName} could not be processed.`,
    content,
  });
};
