"""Owner operation of the private processing API. Default: read-only status.

No email text or credentials leave the homeserver through this helper. The
--enable-gemini flag records explicit owner consent; use only after that consent.
--start enables continuing IMAP changes; --preview only analyzes a bounded sample.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable-gemini', action='store_true')
    parser.add_argument('--tender-immediate', action='store_true')
    parser.add_argument('--max-actions', type=int, help='Cap attempted organizer moves until limits are reconfigured (read flags are separate)')
    parser.add_argument('--max-classifications', type=int, help='Cap successful classifications until limits are reconfigured')
    parser.add_argument('--clear-limits', action='store_true', help='Remove pilot limits for continuing processing')
    action = parser.add_mutually_exclusive_group()
    for name in ('start', 'pause', 'preview'):
        action.add_argument('--' + name, action='store_true')
    return parser.parse_args()

def remote(args):
    spec = importlib.util.spec_from_file_location('acceptance', str(Path(os.environ.get("MAILHARBOR_INSTALL_DIR", str(Path.home() / "MailHarbor"))) / "scripts/verify-unified-mail.py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    module.ALLOWED_REQUESTS = {('POST', '/api/session'), ('DELETE', '/api/session'), ('GET', '/api/mail/processing/status')}
    if args.enable_gemini or args.tender_immediate or args.max_actions is not None or args.max_classifications is not None or args.clear_limits:
        module.ALLOWED_REQUESTS.add(('POST', '/api/mail/processing/settings'))
    if args.start or args.pause or args.preview:
        module.ALLOWED_REQUESTS.add(('POST', '/api/mail/processing'))
    client = module.Client()
    try:
        client.login()
        settings = {}
        if args.enable_gemini: settings['providerConsent'] = True
        if args.tender_immediate: settings.update(tenderGraceDays=0, tenderGraceMonths=None)
        if args.clear_limits: settings.update(maxActions=None, maxClassifications=None)
        if args.max_actions is not None: settings['maxActions'] = args.max_actions
        if args.max_classifications is not None: settings['maxClassifications'] = args.max_classifications
        if settings: client.json('/api/mail/processing/settings', 'POST', settings)
        for action in ('start', 'pause', 'preview'):
            if getattr(args, action): client.json('/api/mail/processing', 'POST', {'action': action})
        data = client.json('/api/mail/processing/status')
        print(json.dumps({name: data.get(name) for name in ('enabled', 'running', 'workerState', 'phase', 'providerConsent', 'tenderConfigured', 'mode', 'batchSize', 'counts', 'coverage', 'reasonCounts', 'migration', 'metrics', 'pilot', 'lastProgressAt', 'accounts', 'retryAt', 'pauseReason', 'lastRun', 'recentErrors', 'preview')}))
    finally:
        client.logout()

if __name__ == '__main__':
    args = arguments()
    if sys.platform == 'linux':
        try: remote(args)
        except Exception as error:
            print(json.dumps({'error': type(error).__name__})); sys.exit(1)
    else:
        sys.exit("Run this helper as the service owner on the Linux server.")
