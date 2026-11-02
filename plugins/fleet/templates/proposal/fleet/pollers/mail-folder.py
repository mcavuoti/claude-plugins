#!/usr/bin/env python3
"""A sample poller for fleet's intake: each mail file (.eml) dropped in a folder becomes an item in the project's
inbox (<project>/.claude/fleet/inbox/<source>/), and the mail file moves to the folder's done/. It never calls Claude
and holds no credentials: whatever saves the mail files (a mail client's rule, fetchmail, an export) is outside it.

    python3 mail-folder.py <folder of .eml files> <project folder> [source]

Run it every few minutes from launchd, cron or a systemd timer, for example (crontab):

    */5 * * * * /usr/bin/python3 /path/to/project/.claude/fleet/pollers/mail-folder.py /path/to/saved-mail /path/to/project mail

The sender counts as verified only when the receiving server's Authentication-Results header says dmarc=pass for the
From address's domain; any other mail is unverified (a From line alone can be forged). fleet's sweeper reads each item
once with one model call, writes the record and routes it: see "Mail, chat and other inputs" in fleet's README.
"""
import email
import email.policy
import json
import os
import re
import sys
from pathlib import Path


def verified(msg, sender):
    domain = sender.rsplit('@', 1)[-1].lower() if '@' in sender else ''
    for ar in msg.get_all('Authentication-Results') or []:
        text = str(ar).lower()
        if re.search(r'\bdmarc=pass\b', text) and domain and re.search(r'header\.from=' + re.escape(domain) + r'\b', text):
            return True
    return False


def item_of(path, source):
    with open(path, 'rb') as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)
    sender = email.utils.parseaddr(str(msg.get('From', '')))
    body = msg.get_body(preferencelist=('plain', 'html'))
    text = body.get_content() if body is not None else ''
    return {
        'itemFormat': 1,
        'source': source,
        'sourceRef': str(msg.get('Message-ID', '')).strip() or path.name,
        'receivedAt': str(msg.get('Date', '')),
        'from': sender[1],
        'fromName': sender[0],
        'to': [a for _, a in email.utils.getaddresses([str(x) for x in msg.get_all('To') or []])],
        'subject': str(msg.get('Subject', '')),
        'body': text[:32768],
        'attachments': [p.get_filename() for p in msg.iter_attachments() if p.get_filename()],
        'senderAuth': 'verified' if verified(msg, sender[1]) else 'unverified',
    }


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    folder, project = Path(sys.argv[1]), Path(sys.argv[2])
    source = sys.argv[3] if len(sys.argv) > 3 else 'mail'
    inbox = project / '.claude/fleet/inbox' / source
    if not (project / '.claude/fleet/config.json').is_file():
        sys.exit(f'{project} has no .claude/fleet/ (run /fleet init there)')
    inbox.mkdir(parents=True, exist_ok=True)
    (folder / 'done').mkdir(exist_ok=True)
    dropped = 0
    for path in sorted(folder.glob('*.eml')):
        try:
            item = item_of(path, source)
        except Exception as e:  # a mail it can't read stays where it is, said once a run
            print(f'{path}: {e}', file=sys.stderr)
            continue
        # The item appears whole: written aside, then renamed into the inbox
        name = re.sub(r'[^A-Za-z0-9._-]+', '-', path.stem)[:80] + '.json'
        tmp = inbox / f'.{name}.tmp'
        tmp.write_text(json.dumps(item, indent=2) + '\n')
        os.replace(tmp, inbox / name)
        path.rename(folder / 'done' / path.name)
        dropped += 1
    if dropped:
        # fleet's sessions watch this file: the sweeper reads the new items within seconds
        (project / '.claude/fleet/inbox/latest').write_text(f'{dropped}\n')
    print(f'{dropped} item(s) dropped in {inbox}')


if __name__ == '__main__':
    main()
