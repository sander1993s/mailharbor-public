/** Account definitions are supplied by the server; a fresh installation is empty. */
export function createAccountSetup({root, api, refresh, describeError}) {
  let catalog = [];
  const form = document.createElement('form');
  const heading = document.createElement('h2'); heading.textContent = 'Add an email account';
  const fields = new Map();
  function field(name, title, type = 'text', options) {
    const label = document.createElement('label'); label.className = 'field';
    const text = document.createElement('span'); text.textContent = title;
    const input = document.createElement(options ? 'select' : 'input');
    input.name = name; if (!options) input.type = type;
    if (options) for (const [value, title] of options) {
      const option = document.createElement('option'); option.value = value; option.textContent = title; input.append(option);
    }
    input.autocomplete = type === 'email' ? 'email' : 'off';
    label.append(text, input); fields.set(name, input); return label;
  }
  const provider = field('provider', 'Email provider', 'text', []);
  const email = field('email', 'Email address', 'email'); fields.get('email').required = true;
  const label = field('label', 'Account name (optional)'); fields.get('label').maxLength = 80;
  const username = field('username', 'IMAP username (optional; defaults to email)');
  const help = document.createElement('p'); help.className = 'fineprint';
  const custom = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Server settings'; custom.append(summary);
  const settings = document.createElement('div'); settings.className = 'provider-form';
  for (const kind of ['incoming', 'smtp']) {
    settings.append(field(`${kind}Host`, `${kind === 'incoming' ? 'IMAP' : 'SMTP'} host`),
      field(`${kind}Port`, `${kind === 'incoming' ? 'IMAP' : 'SMTP'} port`, 'number'),
      field(`${kind}Security`, `${kind === 'incoming' ? 'IMAP' : 'SMTP'} encryption`, 'text', [['tls', 'TLS'], ['starttls', 'STARTTLS (required)']]));
    fields.get(`${kind}Port`).min = '1'; fields.get(`${kind}Port`).max = '65535';
  }
  settings.append(field('smtpUsername', 'SMTP username (optional; defaults to email)'));
  const bridge = document.createElement('div');
  bridge.append(field('allowLocalBridge', 'Allow a local Proton Mail Bridge on this server', 'checkbox'));
  const certLabel = document.createElement('label'); certLabel.className = 'field';
  const certTitle = document.createElement('span'); certTitle.textContent = 'Bridge TLS certificate (PEM export)';
  const certificate = document.createElement('textarea'); certificate.rows = 5; certificate.maxLength = 16384;
  certLabel.append(certTitle, certificate); bridge.append(certLabel); settings.append(bridge); custom.append(settings);
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'primary'; submit.textContent = 'Add account';
  const feedback = document.createElement('p'); feedback.className = 'feedback'; feedback.setAttribute('role', 'status');
  form.append(heading, provider, email, label, username, help, custom, submit, feedback); root.replaceChildren(form);
  function selected() { return catalog.find(item => item.id === fields.get('provider').value); }
  function change() {
    const value = selected(); if (!value) return;
    help.textContent = value.help || '';
    for (const kind of ['incoming', 'smtp']) for (const [suffix, key] of [['Host', 'host'], ['Port', 'port'], ['Security', 'security']]) {
      const input = fields.get(`${kind}${suffix}`);
      input.value = value[kind]?.[key] ?? (key === 'security' ? 'tls' : '');
      input.disabled = key === 'security' && !value.custom;
      input.readOnly = key !== 'security' && !value.custom;
      input.required = Boolean(value.custom);
    }
    bridge.hidden = !value.localBridge;
    certificate.required = Boolean(value.localBridge);
    fields.get('allowLocalBridge').required = Boolean(value.localBridge);
    fields.get('allowLocalBridge').checked = false; certificate.value = '';
    custom.open = Boolean(value.custom || value.localBridge);
  }
  fields.get('provider').addEventListener('change', change);
  form.addEventListener('submit', async event => {
    event.preventDefault(); const value = selected(); if (!value) return;
    const body = {provider: value.id, email: fields.get('email').value.trim()};
    for (const name of ['label', 'username']) if (fields.get(name).value.trim()) body[name] = fields.get(name).value.trim();
    for (const kind of ['incoming', 'smtp']) {
      const host = fields.get(`${kind}Host`).value.trim().toLowerCase();
      if (host) body[kind] = {host, port: Number(fields.get(`${kind}Port`).value), security: fields.get(`${kind}Security`).value};
    }
    if (fields.get('smtpUsername').value.trim()) body.smtp = {...body.smtp, username: fields.get('smtpUsername').value.trim()};
    if (value.localBridge) { body.allowLocalBridge = fields.get('allowLocalBridge').checked; body.tlsCertificate = certificate.value.trim(); }
    submit.disabled = true; feedback.textContent = 'Adding account…';
    try {
      await api('/api/accounts', {method: 'POST', body});
      form.reset(); change(); await refresh();
      feedback.textContent = 'Account added. Connect it below to finish setup.';
    } catch (error) { feedback.textContent = describeError(error); }
    finally { submit.disabled = !catalog.length; }
  });
  return {update(values) {
    const previous = fields.get('provider').value;
    catalog = Array.isArray(values) ? values : [];
    fields.get('provider').replaceChildren();
    for (const item of catalog) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; fields.get('provider').append(option); }
    if (catalog.some(item => item.id === previous)) fields.get('provider').value = previous;
    if (!previous || !catalog.some(item => item.id === previous)) change(); submit.disabled = !catalog.length;
  }};
}
