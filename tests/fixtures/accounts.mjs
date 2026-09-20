// Fictional test-only accounts. Production starts with no accounts.
export const ACCOUNT_PRESETS = Object.freeze([
  { id: 'private-gmail', provider: 'google', label: 'Private Gmail', email: 'personal@example.com', host: 'imap.gmail.com', port: 993 },
  { id: 'bv-gmail', provider: 'google', label: 'ExampleCompany', email: 'billing@example.com', host: 'imap.gmail.com', port: 993 },
  { id: 'business-imap', provider: 'imap', label: 'Example Software Solutions', email: 'business@example.com', host: 'imap.example.com', port: 993 },
  { id: 'private-outlook', provider: 'microsoft', label: 'Private Hotmail', email: 'personal-outlook@example.com', host: 'outlook.office365.com', port: 993 }
]);
