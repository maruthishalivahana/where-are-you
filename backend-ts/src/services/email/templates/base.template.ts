interface BaseTemplateParams {
  title: string;
  preheader?: string;
  content: string;
}

export const baseTemplate = (params: BaseTemplateParams): string => {
  const { title, preheader, content } = params;
  const currentYear = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; width: 100%; background-color: #f4f4f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">
  ${preheader ? `<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${preheader}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0; padding: 0; background-color: #f4f4f7;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; margin: 0 auto;">
          <!-- Header -->
          <tr>
            <td style="background-color: #1e43b8; padding: 28px 40px; text-align: center; border-radius: 12px 12px 0 0;">
              <span style="font-size: 28px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">NavixGo</span>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="background-color: #ffffff; padding: 40px 40px 32px 40px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #ffffff; padding: 0 40px 32px 40px; border-radius: 0 0 12px 12px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-top: 1px solid #e5e7eb; padding-top: 24px; text-align: center;">
                    <p style="margin: 0 0 8px 0; font-size: 13px; color: #6b7280; line-height: 1.5;"> &copy; ${currentYear} NavixGo. All rights reserved.</p>
                    <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">This is an automated email. Please do not reply.</p>
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
};
