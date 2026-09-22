/**
 * The business behind JobProfitAI, in one place so the site footer, the
 * legal pages and every email show the same name and postal address.
 *
 * The postal address is required in commercial email (CAN-SPAM), and it is
 * where legal notices can be sent. Change it here and everywhere follows.
 */
export const COMPANY_LEGAL_NAME = "PWL Solutions LLC";
export const COMPANY_MAILING_ADDRESS_LINES = ["PO Box 955", "Shelbyville, IN 46176"] as const;
/** "PO Box 955, Shelbyville, IN 46176" */
export const COMPANY_MAILING_ADDRESS = COMPANY_MAILING_ADDRESS_LINES.join(", ");
