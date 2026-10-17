#!/usr/bin/env python3
"""Private daily integrity snapshots. Baseline changes are always explicit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

WATCH = ('etc/passwd', 'etc/group', 'etc/shadow', 'etc/gshadow', 'etc/sudoers',
         'etc/sudoers.d', 'etc/ssh', 'etc/cron.d', 'etc/crontab', 'etc/cron.daily',
         'etc/cron.hourly', 'var/spool/cron', 'etc/systemd/system',
         'usr/lib/systemd/system', 'etc/ld.so.preload', 'etc/rc.local',
         'etc/profile', 'etc/profile.d', 'etc/bash.bashrc', 'root/.bashrc', 'root/.profile',
         'etc/nginx', 'etc/nftables.conf', 'etc/nftables.d', 'etc/sysctl.conf', 'etc/sysctl.d',
         'etc/fail2ban', 'usr/local/sbin/sp-integrity-check.sh', 'usr/local/sbin/sp-integrity-check.py',
         'usr/lib/nginx/modules', 'usr/local/lib/stronghold-hardening',
         'opt/Stronghold-Protocol/geoip/GeoLite2-Country.mmdb', 'root/gen-nft.py',
         'usr/local/lib/stronghold-browser-gate', 'etc/stronghold/browser-gate.env', 'etc/letsencrypt')
PRUNE = {'proc', 'sys', 'dev', 'run', 'var/lib/docker', 'var/lib/containers', 'var/lib/stronghold-hardening'}


def fingerprint(file):
    info = file.lstat()
    value = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
    if file.is_symlink():
        value['symlink'] = os.readlink(file)  # Do not follow a changed link outside the watched tree.
    elif file.is_file():
        digest = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(65536), b''):
                digest.update(block)
        value['sha256'] = digest.hexdigest()
    return value


def snapshot(root):
    files, privileged = {}, {}
    for relative in WATCH:
        target = root / relative
        if not target.exists() and not target.is_symlink():
            files[relative] = None
            continue
        paths = [target]
        if target.is_dir() and not target.is_symlink():
            paths.extend(target.rglob('*'))
        for file in paths:
            if file.is_file() or file.is_symlink():
                files[str(file.relative_to(root))] = fingerprint(file)
    passwd = root / 'etc/passwd'
    uid0, homes = [], [root / 'root', root / 'home']
    if passwd.exists():
        for line in passwd.read_text(errors='replace').splitlines():
            fields = line.split(':')
            if len(fields) >= 7:
                if fields[2] == '0':
                    uid0.append(fields[0])
                home = Path(fields[5].lstrip('/'))
                if '..' not in home.parts and str(home) not in ('', '.'):
                    homes.append(root / home)
    for home in set(homes):
        for relative in ('.ssh/authorized_keys', '.ssh/authorized_keys2', '.bashrc', '.profile'):
            target = home / relative
            if target.exists() or target.is_symlink():
                files[str(target.relative_to(root))] = fingerprint(target)
    # SUID/SGID on this filesystem only; mounted containers and transient kernel trees are excluded.
    device = root.stat().st_dev
    def walk_error(error):
        raise error

    for directory, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        current = Path(directory)
        dirs[:] = [name for name in dirs if str((current / name).relative_to(root)).replace('\\', '/') not in PRUNE
                   and not (current / name).is_symlink() and (current / name).stat().st_dev == device]
        for name in names:
            file = current / name
            try:
                info = file.lstat()
            except FileNotFoundError:
                continue  # Unwatched transient files can disappear during the filesystem scan.
            if stat.S_ISREG(info.st_mode) and info.st_mode & (stat.S_ISUID | stat.S_ISGID):
                privileged[str(file.relative_to(root))] = fingerprint(file)
    return {'version': 1, 'uid0': sorted(uid0), 'files': files, 'privileged': privileged}


def write_private(file, value):
    temporary = file.with_name(file.name + '.tmp')
    with temporary.open('w', encoding='utf8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(file)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--init', action='store_true', help='Explicitly create/replace a trusted baseline')
    parser.add_argument('--root', type=Path, default=Path('/'), help='Fixture root for offline validation')
    parser.add_argument('--state', type=Path, default=Path('/var/lib/stronghold-hardening/integrity'))
    args = parser.parse_args()
    root, state = args.root.resolve(), args.state.resolve()
    if root == Path('/') and hasattr(os, 'geteuid') and os.geteuid() != 0:
        parser.error('root is required to read the host integrity inputs')
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(state, 0o700)
    # Prevent cron/manual overlap without third-party dependencies.
    lock = (state / 'check.lock').open('a')
    if os.name == 'posix':
        import fcntl
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Integrity check already running')
            return 0
    current = snapshot(root)
    baseline = state / 'baseline.json'
    if args.init:
        write_private(baseline, current)
        print('Trusted baseline written; initialization is not a malware scan or proof of a clean host.')
        return 0
    if not baseline.exists():
        raise RuntimeError('No baseline; inspect the host, then explicitly run --init')
    before = json.loads(baseline.read_text(encoding='utf8'))
    if before.get('version') != 1:
        raise RuntimeError('Unsupported integrity baseline version')
    write_private(state / 'latest.json', current)
    changes = []
    if before.get('uid0') != current['uid0']:
        changes.append('UID0 account list changed')
    for category in ('files', 'privileged'):
        old, new = before.get(category, {}), current[category]
        for name in sorted(old.keys() | new.keys()):
            if old.get(name) != new.get(name):
                changes.append(f'{category}: {name}')
    report = '\n'.join(changes) if changes else 'Integrity snapshot unchanged'
    (state / 'last-report.txt').write_text(report + '\n', encoding='utf8')
    os.chmod(state / 'last-report.txt', 0o600)
    print(report)
    if changes and os.name == 'posix':
        subprocess.run(['logger', '-p', 'authpriv.warning', '-t', 'sp-integrity',
                        f'{len(changes)} integrity changes; inspect {state / "last-report.txt"}'], check=False)
    return 1 if changes else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'Integrity check failed: {error}', file=sys.stderr)
        if os.name == 'posix':
            subprocess.run(['logger', '-p', 'authpriv.err', '-t', 'sp-integrity', 'Integrity check failed; inspect cron output'], check=False)
        sys.exit(2)
