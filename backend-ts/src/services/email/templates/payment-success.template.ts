import { baseTemplate } from './base.template';

interface PaymentSuccessTemplateParams {
  adminName: string;
  planName: string;
  busCount: number;
  amount: string;
  currency: string;
  expiryDate: string;
}

export const paymentSuccessTemplate = (params: PaymentSuccessTemplateParams): string => {
  const { adminName, planName, busCount, amount, currency, expiryDate } = params;

  const content = `
    <div style="text-align: center; margin-bottom: 24px;">
      <span style="font-size: 48px; line-height: 1;">&#10003;</span>
    </div>
    <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #1a1a2e; line-height: 1.3; text-align: center;">Payment Successful &#x2713;</h1>
    <p style="margin: 0 0 8px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Hi ${adminName}, your payment has been received successfully.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 20px 0;">
      <tr>
        <td style="background-color: #f0f4ff; border-radius: 8px; padding: 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">Plan</td>
              <td style="padding: 6px 0; font-size: 14px; color: #1a1a2e; font-weight: 600; text-align: right;">${planName}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">Buses</td>
              <td style="padding: 6px 0; font-size: 14px; color: #1a1a2e; font-weight: 600; text-align: right;">${busCount}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">Amount</td>
              <td style="padding: 6px 0; font-size: 14px; color: #1a1a2e; font-weight: 600; text-align: right;">${currency} ${amount}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">Valid Until</td>
              <td style="padding: 6px 0; font-size: 14px; color: #1a1a2e; font-weight: 600; text-align: right;">${expiryDate}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <p style="margin: 0 0 24px 0; font-size: 16px; color: #1a1a2e; line-height: 1.6;">
      Thank you for choosing NavixGo!
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
      <tr>
        <td align="center">
          <a href="#" target="_blank" style="display: inline-block; padding: 14px 32px; background-color: #1e43b8; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Go to Dashboard</a>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate({
    title: 'Payment Successful - NavixGo',
    preheader: `Your payment of ${currency} ${amount} for ${planName} was successful.`,
    content,
  });
};
