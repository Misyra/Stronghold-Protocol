#!/usr/bin/env python3
"""Render (do not apply) the strict CN input gate from a global Country MMDB."""
import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import os
import maxminddb


def networks(reader, family):
    """Walk prefix boundaries, including missing records; works with Debian's older reader."""
    address_type = ipaddress.IPv4Address if family == 4 else ipaddress.IPv6Address
    bits = 32 if family == 4 else 128
    address, steps, result = 0, 0, []
    while address < 1 << bits:
        record, prefix = reader.get_with_prefix_len(str(address_type(address)))
        if not isinstance(prefix, int) or not 0 <= prefix <= bits:
            raise ValueError('Invalid MMDB prefix length')
        block = 1 << (bits - prefix)
        if record and record.get('country', {}).get('iso_code') == 'CN':
            result.append(ipaddress.ip_network((address_type(address), prefix), strict=False))
        address = (address // block + 1) * block
        steps += 1
        if steps > 4000000:
            raise ValueError('MMDB traversal limit exceeded')
    return list(ipaddress.collapse_addresses(result))


def render(database, template, required_ip=None):
    with maxminddb.open_database(str(database)) as reader:
        metadata = reader.metadata()
        if metadata.ip_version != 6 or 'Country' not in metadata.database_type:
            raise ValueError('A global IPv4+IPv6 Country database is required')
        v4, v6 = networks(reader, 4), networks(reader, 6)
        if len(v4) < 100 or not v6:
            raise ValueError('Refusing an unexpectedly small CN allowlist')
        probes = {'114.114.114.114': True, '223.5.5.5': True, '240e::1': True,
                  '8.8.8.8': False, '60.249.21.30': False, '1.36.0.1': False,
                  '203.0.113.9': False, '2001:db8::1': False,
                  '2001:4860:4860::8888': False, '172.16.0.42': False}
        if required_ip:
            probes[str(ipaddress.ip_address(required_ip))] = True
        for text, expected in probes.items():
            address = ipaddress.ip_address(text)
            listed = any(address in net for net in (v4 if address.version == 4 else v6))
            record = reader.get(text)
            classified = bool(record and record.get('country', {}).get('iso_code') == 'CN')
            if listed != expected or classified != expected:
                raise ValueError(f'Country allowlist validation failed: {text}')
        # Verify range endpoints as well: address-family aliases must not widen a prefix.
        for network in v4 + v6:
            for address in (network.network_address, network.broadcast_address):
                record = reader.get(str(address))
                if not record or record.get('country', {}).get('iso_code') != 'CN':
                    raise ValueError(f'Country prefix boundary validation failed: {network}')
    sha = hashlib.sha256(database.read_bytes()).hexdigest()
    output = '# MMDB sha256: ' + sha + '\n' + template.read_text()
    output = output.replace('__CN4__', ', '.join(map(str, v4))).replace('__CN6__', ', '.join(map(str, v6)))
    if '__CN' in output:
        raise ValueError('Unrendered country set')
    return output, {'sha256': sha, 'ipv4_networks': len(v4), 'ipv6_networks': len(v6)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--require-ip', help='Current SSH peer must classify as CN before deployment')
    args = parser.parse_args()
    output, summary = render(args.db, Path(__file__).with_name('sp-country-input.nft.example'), args.require_ip)
    temporary = args.output.with_name(args.output.name + '.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        stream.write(output)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(args.output)
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
